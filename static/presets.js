// 出張ルート表 自動化ツール — よく使うルートのプリセット
// 関東圏（HQ_NAMEを起点・終点に自動で追加）と地方（主要駅発、本社なし）を分けて定義。
//
// 地名だけだと同名の別地点（例:「姉ヶ崎」が岩手県の岬にヒットする等）に
// 誤ってジオコーディングされることがあるため、各停留地に都道府県のヒントを持たせ、
// 地図検索用の住所には自動でその都道府県名を補って精度を上げている。
(function () {
  "use strict";

  const HQ_NAME = "本社（ミーナアサヒビル）";
  const HQ_ADDRESS = "千葉県市川市南八幡3-6-18";

  // 店舗マスタに無い、共通の起点・経由地（本社など）
  const WAYPOINTS = [
    { name: HQ_NAME, full_address: HQ_ADDRESS, hours_display: "", corp: "本社" },
  ];

  // stops は文字列（プリセットの pref を使う）か、[名前, 都道府県] の配列（個別指定）
  function normalizeStops(stops, defaultPref) {
    return stops.map((s) => (Array.isArray(s) ? { name: s[0], pref: s[1] } : { name: s, pref: defaultPref }));
  }

  const KANTO_PRESETS = [
    { key: "chiba1", label: "千葉①", pref: "千葉県", stops: ["幕張南口", "稲毛海岸", "八幡宿", "五井東", "姉ヶ崎", "ライフガーデン茂原", "大網", "誉田", "四街道もねの里", "四街道", "都賀駅"] },
    { key: "chiba2", label: "千葉②", pref: "千葉県", stops: ["八街", "成田富里", "成田美郷台", "成田駅前", "公津の杜", "佐倉", "佐倉ユーカリが丘", "志津", "勝田台", "八千代"] },
    { key: "saitama_kawagoe", label: "埼玉・川越", pref: "埼玉県", stops: ["朝霞エキナカ", "朝霞南口", "みずほ台", "志木", "ふじみ野", "川越クレアモール", "霞が関", "新狭山", "狭山ヶ丘"] },
    { key: "tonai1", label: "都内方面①", pref: "東京都", stops: ["わかば", "小岩", "立石", "北千住", "十条銀座", "東十条", "川口"] },
    { key: "kanagawa", label: "神奈川", pref: "神奈川県", stops: ["淵野辺", "町田", "鴨居", "元住吉"] },
    { key: "shimousa", label: "下総・船橋・本八幡・市川", pref: "千葉県", note: "徒歩・電車ルート", stops: ["船橋", "下総北口", "下総駅前", "市川南口", "さくら", "げんき", "京成八幡駅前", "本八幡駅", "本八幡南口"] },
    { key: "tonai2", label: "都内方面②", pref: "東京都", stops: ["瑞江", "新橋", "池袋", "大山", "上板橋", "下赤塚"] },
    {
      key: "noda_ibaraki", label: "野田・茨城方面", pref: "千葉県",
      stops: [["守谷", "茨城県"], ["みらい平", "茨城県"], "川間", "梅郷", "東深井", "初石", "おおたか", "柏の葉", "六実", "二和", "鎌ヶ谷"],
    },
    { key: "joban", label: "常磐", pref: "千葉県", stops: ["馬橋", "北小金南口", "新松戸", "南流山", "豊四季中央", "豊四季", "南柏", "柏南口", "柏駅東口", "我孫子駅前", "天王台駅", "六実", "二和", "鎌ヶ谷"] },
  ];

  const CHIHOU_PRESETS = [
    { key: "miyagi", label: "宮城", pref: "宮城県", stops: ["仙台駅", "名取", "長町南", "陸前高砂", "北仙台", "南仙台"] },
    { key: "okinawa", label: "沖縄", pref: "沖縄県", stops: ["那覇空港", "宜野湾", "あわせ", "浦添", "あじゃ"] },
    { key: "shizuoka", label: "静岡", pref: "静岡県", stops: ["新静岡", "石田", "新浜松", "菊川", "安倍川"] },
    { key: "okayama", label: "岡山", pref: "岡山県", stops: ["岡山", "倉敷", "花尻"] },
    { key: "aichi", label: "愛知", pref: "愛知県", stops: ["千種本山", "池下", "中村公園", "一宮"] },
    { key: "fukuoka", label: "福岡", pref: "福岡県", stops: ["井尻", "西新"] },
    { key: "fukushima", label: "福島", pref: "福島県", stops: ["若葉町", "郡山西口"] },
    { key: "niigata", label: "新潟", pref: "新潟県", stops: ["新潟こうど", "新潟松崎", "亀田", "寺尾東", "関屋"] },
    { key: "nagano", label: "長野", pref: "長野県", stops: ["長野"] },
    { key: "hokkaido", label: "北海道", pref: "北海道", stops: ["琴似駅前", "琴似本通り", "北円山", "手稲", "新道東", "南平岸", "千歳", "恵庭"] },
  ];

  [...KANTO_PRESETS, ...CHIHOU_PRESETS].forEach((p) => {
    p.stops = normalizeStops(p.stops, p.pref);
  });

  window.ROUTE_PRESETS = {
    HQ_NAME,
    HQ_ADDRESS,
    WAYPOINTS,
    KANTO_PRESETS,
    CHIHOU_PRESETS,
  };
})();
