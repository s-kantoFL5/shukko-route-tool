# -*- coding: utf-8 -*-
"""店舗マスタなどの決まった住所の緯度経度を、あらかじめ1回だけ調べて保存する。

出張ルート表アプリは Nominatim（OpenStreetMap）で住所→緯度経度を調べているが、
毎回問い合わせるとアクセス制限（429）に掛かる。住所は基本的に変わらないので、
この結果を data/geocode.json に保存してアプリに同梱し、実行時の問い合わせを無くす。

使い方（院を追加・住所変更したときだけ実行する）:
    python tools/build_geocache.py
"""
import json
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

import app  # noqa: E402  アプリ本体のジオコーディング処理をそのまま使う

CACHE_PATH = BASE_DIR / "data" / "geocode.json"


def collect_addresses() -> list[str]:
    """キャッシュしておきたい住所を集める（店舗マスタ＋本社＋地方の起点駅）。"""
    addresses = [h["full_address"] for h in app.HOSPITALS]

    presets_js = (BASE_DIR / "static" / "presets.js").read_text(encoding="utf-8")

    # HQ_ADDRESS と start: { ..., address: "..." } を presets.js から拾う
    import re

    hq = re.search(r'HQ_ADDRESS\s*=\s*"([^"]+)"', presets_js)
    if hq:
        addresses.append(hq.group(1))
    addresses.extend(re.findall(r'address:\s*"([^"]+)"', presets_js))

    seen, ordered = set(), []
    for a in addresses:
        a = a.strip()
        if a and a not in seen:
            seen.add(a)
            ordered.append(a)
    return ordered


def main() -> None:
    cache = {}
    if CACHE_PATH.exists():
        cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))

    addresses = collect_addresses()
    print(f"対象: {len(addresses)}件（うちキャッシュ済み {sum(1 for a in addresses if a in cache)}件）")

    missing = [a for a in addresses if a not in cache]
    for i, address in enumerate(missing, 1):
        result = app.geocode(address)
        if result:
            cache[address] = result
            print(f"[{i}/{len(missing)}] OK   {address} -> {result['display_name']}")
        else:
            print(f"[{i}/{len(missing)}] 見つからず {address}")
        time.sleep(0.2)  # app.geocode 側でも1.1秒間隔を守っている

    CACHE_PATH.write_text(
        json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8"
    )
    found = sum(1 for a in addresses if a in cache)
    print(f"\n保存しました: {CACHE_PATH}")
    print(f"解決できた住所: {found}/{len(addresses)}件")
    for a in addresses:
        if a not in cache:
            print(f"  未解決: {a}")


if __name__ == "__main__":
    main()
