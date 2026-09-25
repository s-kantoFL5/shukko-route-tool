# -*- coding: utf-8 -*-
"""
出張ルート表 自動化ツール

院名・地名を入力すると、②店舗マスタから住所・営業時間・法人名を自動補完し、
OpenStreetMap（Nominatim + OSRM）を使って前の訪問地からの車移動時間を自動計算する。
"""
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

with open(BASE_DIR / "data" / "hospitals.json", encoding="utf-8") as f:
    HOSPITALS = json.load(f)

app = FastAPI(title="出張ルート表 自動化ツール")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{}"
# Nominatimの利用ポリシー上、連絡先が分かるUser-Agentを付与する
USER_AGENT = "shukko-route-tool/1.0 (internal business-trip planner for a Japanese clinic chain)"

_geocode_cache: dict[str, Optional[dict]] = {}
_drivetime_cache: dict[str, dict] = {}
_last_nominatim_call = 0.0
_lock = threading.Lock()


class MapServiceError(Exception):
    """地図サービス(Nominatim/OSRM)そのものに接続できない場合のエラー。
    住所が「見つからない」場合とは区別して扱う。"""


def _address_variants(address: str) -> list[str]:
    """番地までの住所はNominatim(OSM)でヒットしないことが多いため、
    だんだん粗くした候補を順に試す。

    例）宮城県名取市手倉田字堰根 388
        → 宮城県名取市手倉田字堰根 → 宮城県名取市手倉田
    例）千葉県市川市南八幡 3-6-18
        → 千葉県市川市南八幡3丁目 → 千葉県市川市南八幡

    市区町村までしか絞れない場合は候補に入れない。数kmずれた時間が
    それらしく表示されるより、見つからないと出したほうが安全なため。
    """
    variants = [address]

    # 「◯-◯-◯」形式は「◯丁目」に丸める
    m = re.search(r"(\d+)-\d+(?:-\d+)?\s*$", address)
    if m:
        prefix = address[: m.start()].rstrip()
        variants.append(f"{prefix}{m.group(1)}丁目")
        variants.append(prefix)

    # 末尾の番地（数字・ハイフン）を落とす
    trimmed = re.sub(r"[\s　]*[\d\-－‐]+[\s　]*$", "", address).rstrip()
    if trimmed:
        variants.append(trimmed)

        # 「字◯◯」以降を落とす（例: 手倉田字堰根 → 手倉田）
        aza = re.search(r"[\s　]*字", trimmed)
        if aza:
            variants.append(trimmed[: aza.start()].rstrip())

    # 重複を除きつつ順序は維持する
    seen: set[str] = set()
    ordered: list[str] = []
    for v in variants:
        v = v.strip()
        if v and v not in seen:
            seen.add(v)
            ordered.append(v)
    return ordered


# OpenStreetMapに登録が無い・別地点に当たってしまう住所を、確認済みの検索語に差し替える。
# 表示用の住所（②店舗マスタ）はそのままで、地図検索だけを置き換える。
GEOCODE_OVERRIDES = {
    "長野県長野市高田 1758": "長野県長野市高田南長野",  # MEGAドン・キホーテ長野高田院
    "大阪府大阪市淀川区三国本町 3": "阪急三国駅",  # 三国エキナカ接骨院（阪急三国駅2F）
}

_PREF_RE = re.compile(r"^(北海道|東京都|京都府|大阪府|.{2,3}県)")
_CITY_RE = re.compile(r"^([^\s　0-9]{1,6}?[市区町村])")


def _area_token(query: str) -> Optional[str]:
    """住所から市区町村名を取り出す（例: 長野県長野市高田 → 長野市）。"""
    without_pref = _PREF_RE.sub("", query.strip())
    m = _CITY_RE.search(without_pref)
    return m.group(1) if m else None


def _looks_like_same_area(query: str, display_name: str) -> bool:
    """検索結果が同じ市区町村かを確認する。

    番地まで一致しないとき、Nominatimは遠く離れた同名らしき場所を返すことがある
    （例: 長野県長野市高田 → 飯田市の高校）。市区町村が違う結果は採用しない。
    """
    token = _area_token(query)
    if not token:
        return True  # 市区町村を含まない検索語（駅名・空港名など）は判定しない
    return token in display_name


def _geocode_query(query: str) -> Optional[dict]:
    """Nominatimへの実際の問い合わせ（1req/秒に制限、リトライなし）。"""
    global _last_nominatim_call
    with _lock:
        wait = 1.1 - (time.time() - _last_nominatim_call)
        if wait > 0:
            time.sleep(wait)
        try:
            resp = requests.get(
                NOMINATIM_URL,
                params={"q": query, "format": "json", "limit": 1, "countrycodes": "jp"},
                headers={"User-Agent": USER_AGENT},
                timeout=10,
            )
            _last_nominatim_call = time.time()
            resp.raise_for_status()
            results = resp.json()
        except requests.exceptions.RequestException as exc:
            raise MapServiceError(
                f"OpenStreetMap(Nominatim)に接続できませんでした（社内ネットワークやファイアウォール、"
                f"プロキシ設定が原因の可能性があります）。詳細: {exc}"
            ) from exc

    if not results:
        return None

    display_name = results[0].get("display_name", query)
    if not _looks_like_same_area(query, display_name):
        return None

    return {
        "lat": float(results[0]["lat"]),
        "lon": float(results[0]["lon"]),
        "display_name": display_name,
    }


def geocode(address: str) -> Optional[dict]:
    """住所・院名・地名などの文字列から緯度経度を取得する。
    番地レベルで見つからない場合は「◯丁目」までに丸めて再試行する。"""
    address = (address or "").strip()
    if not address:
        return None
    if address in _geocode_cache:
        return _geocode_cache[address]

    lookup = GEOCODE_OVERRIDES.get(address, address)

    value = None
    for variant in _address_variants(lookup):
        value = _geocode_query(variant)  # MapServiceError はここで呼び出し元へ伝播させる
        if value:
            break

    _geocode_cache[address] = value
    return value


def format_duration(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int(round((seconds % 3600) / 60))
    if m == 60:
        h += 1
        m = 0
    return f"{h}:{m:02d}"


@app.get("/", response_class=HTMLResponse)
async def index():
    return (TEMPLATES_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/hospitals")
async def api_hospitals():
    return HOSPITALS


@app.get("/api/drivetime")
async def api_drivetime(origin: str, destination: str):
    origin = (origin or "").strip()
    destination = (destination or "").strip()
    if not origin or not destination:
        raise HTTPException(400, "origin, destination は必須です")

    cache_key = f"{origin}__{destination}"
    if cache_key in _drivetime_cache:
        return _drivetime_cache[cache_key]

    try:
        o = geocode(origin)
        if not o:
            raise HTTPException(404, f"出発地が見つかりませんでした: {origin}")
        d = geocode(destination)
        if not d:
            raise HTTPException(404, f"到着地が見つかりませんでした: {destination}")
    except MapServiceError as exc:
        raise HTTPException(502, str(exc)) from exc

    coords = f"{o['lon']},{o['lat']};{d['lon']},{d['lat']}"
    try:
        resp = requests.get(OSRM_URL.format(coords), params={"overview": "false"}, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as exc:
        raise HTTPException(
            502,
            f"OSRM(ルート計算サービス)に接続できませんでした（社内ネットワークやファイアウォール、"
            f"プロキシ設定が原因の可能性があります）。詳細: {exc}",
        ) from exc

    if data.get("code") != "Ok" or not data.get("routes"):
        raise HTTPException(404, "ルートが見つかりませんでした（車で移動できない経路の可能性があります）")

    route = data["routes"][0]
    result = {
        "duration_sec": route["duration"],
        "duration_text": format_duration(route["duration"]),
        "distance_km": round(route["distance"] / 1000, 1),
        "origin_resolved": o["display_name"],
        "destination_resolved": d["display_name"],
    }
    _drivetime_cache[cache_key] = result
    return result


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8766))
    uvicorn.run(app, host="0.0.0.0", port=port)
