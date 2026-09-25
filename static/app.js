// 出張ルート表 自動化ツール — フロントエンド
(function () {
  "use strict";

  let hospitals = [];
  let hospitalsByName = new Map();
  const driveCache = new Map(); // "origin||destination" -> result or {error}

  let trip = {
    title: "出張ルート表",
    days: [emptyDay()],
  };

  function startTime() {
    return (window.ROUTE_PRESETS && window.ROUTE_PRESETS.START_TIME) || "9:00";
  }

  function clinicStay() {
    return (window.ROUTE_PRESETS && window.ROUTE_PRESETS.CLINIC_STAY) || "0:15";
  }

  function emptyDay() {
    // 1日の起点は既定で9:00出発。ここを変えると以降の時刻がすべて自動で計算し直される。
    const first = emptyStop();
    first.departure = startTime();
    return { date: "", memo: "", stops: [first] };
  }

  function emptyStop() {
    return {
      id: cryptoId(),
      place: "",
      address: "",
      arrival: "",
      stay: "",
      departure: "",
      arrivalManual: false,
      departureManual: false,
      // ここに入っている車移動時間・徒歩時間は「前の行からこの行まで」の移動を表す。
      // 画面上は1行上にずらして「この行から次の行まで」として表示している（recalcOneのコメント参照）。
      driveMode: "car", // "car" | "walk"
      driveMinutes: null,
      driveKm: null,
      driveManual: false, // 手入力で上書きした場合、自動再計算では上書きしない
      driveError: "",
      pending: false,
      hours: "",
      corp: "",
      checks: { review: false, blog: false, payment: false, stock: false, rese: false, inquiry: false },
      note: "",
    };
  }

  function cryptoId() {
    return "s" + Math.random().toString(36).slice(2, 10);
  }

  // ---------- データ読み込み ----------
  async function loadHospitals() {
    try {
      const res = await fetch("/api/hospitals");
      hospitals = await res.json();
      hospitalsByName = new Map(hospitals.map((h) => [h.name, h]));

      // 店舗マスタに無い共通の起点（本社など）を検索対象に追加
      const waypoints = (window.ROUTE_PRESETS && window.ROUTE_PRESETS.WAYPOINTS) || [];
      waypoints.forEach((w) => hospitalsByName.set(w.name, w));

      const list = document.getElementById("hospital-list");
      const names = hospitals.map((h) => h.name).concat(waypoints.map((w) => w.name));
      list.innerHTML = names.map((n) => `<option value="${escapeAttr(n)}"></option>`).join("");
    } catch (e) {
      console.error("店舗マスタの取得に失敗しました", e);
    }
  }

  // 院名・地名から住所／営業時間／法人名を補完する（手入力・プリセット読み込み共通）
  // geocodeHint: マスタに無い地名の場合、地図検索の精度を上げるために付け足す都道府県名など
  function applyPlaceLookup(stop, geocodeHint) {
    const hit = hospitalsByName.get(stop.place.trim());
    if (hit) {
      stop.address = hit.full_address;
      stop.hours = hit.hours_display;
      stop.corp = hit.corp;
      // 院に入ったときの滞在時間は15分固定（本社・駅などの経由地は対象外）
      if (!hit.isWaypoint && !stop.stay.trim()) stop.stay = clinicStay();
    } else if (stop.place.trim() && !stop.address.trim()) {
      stop.address = geocodeHint ? `${geocodeHint}${stop.place.trim()}` : stop.place.trim();
      stop.hours = "";
      stop.corp = "";
    }
  }

  // ---------- 時刻の自動計算（H:MM文字列 <-> 分） ----------
  function parseHM(s) {
    const m = /^(\d{1,3}):([0-5]\d)$/.exec((s || "").trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function formatHM(totalMinutes) {
    const mins = Math.round(totalMinutes);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  // 前の行の出発時間＋車移動時間から到着時間を、到着時間＋滞在時間から出発時間を自動計算する。
  // 手入力（arrivalManual/departureManual）されたセルは上書きしない。
  function applyTimesForStop(dayIdx, stopIdx) {
    const day = trip.days[dayIdx];
    const stop = day.stops[stopIdx];
    const prev = stopIdx > 0 ? day.stops[stopIdx - 1] : null;

    if (prev && !stop.arrivalManual && stop.driveMinutes != null) {
      const prevDep = parseHM(prev.departure);
      if (prevDep != null) stop.arrival = formatHM(prevDep + stop.driveMinutes);
    }
    if (!stop.departureManual) {
      const arr = parseHM(stop.arrival);
      const stay = parseHM(stop.stay);
      if (arr != null && stay != null) stop.departure = formatHM(arr + stay);
    }
  }

  function cascadeDay(dayIdx, fromStopIdx) {
    const day = trip.days[dayIdx];
    for (let i = fromStopIdx; i < day.stops.length; i++) {
      applyTimesForStop(dayIdx, i);
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  // ---------- 描画 ----------
  const daysEl = document.getElementById("days");
  const dayTpl = document.getElementById("dayTemplate");
  const stopTpl = document.getElementById("stopTemplate");

  function renderAll() {
    daysEl.innerHTML = "";
    trip.days.forEach((day, dayIdx) => {
      daysEl.appendChild(renderDay(day, dayIdx));
    });
  }

  // renderAll()は行の増減など構造が変わるときだけ使う。
  // 車移動時間の自動計算のように行の数が変わらない更新はこちらを使う。
  // DOM要素を作り直さないので、日付やメモなど他の欄を編集中でも消えたりフォーカスが外れたりしない。
  function refreshValues() {
    const dayCards = daysEl.querySelectorAll(".day-card");
    trip.days.forEach((day, dayIdx) => {
      const dayCard = dayCards[dayIdx];
      if (!dayCard) return;
      const rows = dayCard.querySelectorAll(".stop-row");
      day.stops.forEach((stop, stopIdx) => {
        const row = rows[stopIdx];
        if (!row) return;
        refreshRowValues(row, day, stopIdx);
      });
    });
  }

  function refreshRowValues(row, day, stopIdx) {
    const stop = day.stops[stopIdx];
    const setIfNotFocused = (el, value) => {
      if (document.activeElement !== el) el.value = value;
    };
    setIfNotFocused(row.querySelector(".f-arrival"), stop.arrival);
    setIfNotFocused(row.querySelector(".f-stay"), stop.stay);
    setIfNotFocused(row.querySelector(".f-departure"), stop.departure);
    row.querySelector(".f-hours").textContent = stop.hours || "—";
    row.querySelector(".f-corp").textContent = stop.corp || "—";
    updateDriveCell(row, day.stops[stopIdx + 1] || null);
  }

  function renderDay(day, dayIdx) {
    const node = dayTpl.content.firstElementChild.cloneNode(true);
    const dateInput = node.querySelector(".day-date");
    const memoInput = node.querySelector(".day-memo");
    dateInput.value = day.date;
    memoInput.value = day.memo;
    dateInput.addEventListener("input", () => (day.date = dateInput.value));
    memoInput.addEventListener("input", () => (day.memo = memoInput.value));

    const removeBtn = node.querySelector(".day-remove");
    removeBtn.addEventListener("click", () => {
      if (trip.days.length <= 1) {
        alert("最後の1日は削除できません。");
        return;
      }
      if (confirm("この日の行程をすべて削除しますか？")) {
        trip.days.splice(dayIdx, 1);
        renderAll();
      }
    });

    const tbody = node.querySelector(".stop-body");
    day.stops.forEach((stop, stopIdx) => {
      tbody.appendChild(renderStop(day, dayIdx, stop, stopIdx));
    });

    node.querySelector(".add-stop").addEventListener("click", () => {
      day.stops.push(emptyStop());
      renderAll();
    });

    return node;
  }

  // 車移動時間は同じ日の中だけで計算する。
  // 日の1行目は出発地点（本社・主要駅・ホテルなど）なので、
  // 前日の最後からの移動時間（新幹線・飛行機の区間）は出さない。
  function getPreviousStop(dayIdx, stopIdx) {
    if (stopIdx === 0) return null;
    return trip.days[dayIdx].stops[stopIdx - 1];
  }

  function renderStop(day, dayIdx, stop, stopIdx) {
    const node = stopTpl.content.firstElementChild.cloneNode(true);

    const placeEl = node.querySelector(".f-place");
    const addressEl = node.querySelector(".f-address");
    const arrivalEl = node.querySelector(".f-arrival");
    const stayEl = node.querySelector(".f-stay");
    const departureEl = node.querySelector(".f-departure");
    const hoursEl = node.querySelector(".f-hours");
    const corpEl = node.querySelector(".f-corp");
    const noteEl = node.querySelector(".f-note");

    placeEl.value = stop.place;
    addressEl.value = stop.address;
    arrivalEl.value = stop.arrival;
    stayEl.value = stop.stay;
    departureEl.value = stop.departure;
    noteEl.value = stop.note;
    hoursEl.textContent = stop.hours || "—";
    corpEl.textContent = stop.corp || "—";
    updateDriveCell(node, day.stops[stopIdx + 1] || null);

    node.querySelectorAll(".f-check").forEach((cb) => {
      const key = cb.dataset.key;
      cb.checked = !!stop.checks[key];
      cb.addEventListener("change", () => (stop.checks[key] = cb.checked));
    });

    placeEl.addEventListener("change", () => {
      stop.place = placeEl.value;
      applyPlaceLookup(stop);
      addressEl.value = stop.address;
      hoursEl.textContent = stop.hours || "—";
      corpEl.textContent = stop.corp || "—";
      recalcAround(dayIdx, stopIdx);
    });

    addressEl.addEventListener("change", () => {
      stop.address = addressEl.value;
      recalcAround(dayIdx, stopIdx);
    });

    arrivalEl.addEventListener("change", () => {
      stop.arrival = arrivalEl.value;
      stop.arrivalManual = arrivalEl.value.trim() !== "";
      cascadeDay(dayIdx, stopIdx);
      refreshValues();
    });
    stayEl.addEventListener("change", () => {
      stop.stay = stayEl.value;
      cascadeDay(dayIdx, stopIdx);
      refreshValues();
    });
    departureEl.addEventListener("change", () => {
      stop.departure = departureEl.value;
      stop.departureManual = departureEl.value.trim() !== "";
      cascadeDay(dayIdx, stopIdx);
      refreshValues();
    });
    noteEl.addEventListener("input", () => (stop.note = noteEl.value));

    // 車移動時間・徒歩時間はこの行ではなく「次の行」のデータを表示・編集する
    // （出発＋移動時間＝次の行の到着、として読めるように1行ずらしている）
    const driveModeEl = node.querySelector(".f-drive-mode");
    const driveTimeEl = node.querySelector(".f-drive-time");
    const driveRefreshBtn = node.querySelector(".f-drive-refresh");

    driveModeEl.addEventListener("change", () => {
      const next = day.stops[stopIdx + 1];
      if (!next) return;
      next.driveMode = driveModeEl.value;
      next.driveManual = false;
      recalcOne(dayIdx, stopIdx + 1, true);
    });

    driveTimeEl.addEventListener("change", () => {
      const next = day.stops[stopIdx + 1];
      if (!next) return;
      const mins = parseHM(driveTimeEl.value);
      if (mins == null) {
        // 空にしたら自動計算に戻す
        next.driveManual = false;
        recalcOne(dayIdx, stopIdx + 1, true);
      } else {
        next.driveManual = true;
        next.driveMinutes = mins;
        next.driveKm = null;
        next.driveError = "";
        cascadeDay(dayIdx, stopIdx + 1);
        refreshValues();
      }
    });

    driveRefreshBtn.addEventListener("click", () => {
      const next = day.stops[stopIdx + 1];
      if (!next) return;
      recalcOne(dayIdx, stopIdx + 1, true);
    });

    node.querySelector(".move-up").addEventListener("click", () => {
      if (stopIdx === 0) return;
      const arr = day.stops;
      [arr[stopIdx - 1], arr[stopIdx]] = [arr[stopIdx], arr[stopIdx - 1]];
      renderAll();
      recalcAllDriveTimes();
    });
    node.querySelector(".move-down").addEventListener("click", () => {
      if (stopIdx === day.stops.length - 1) return;
      const arr = day.stops;
      [arr[stopIdx + 1], arr[stopIdx]] = [arr[stopIdx], arr[stopIdx + 1]];
      renderAll();
      recalcAllDriveTimes();
    });
    node.querySelector(".remove-stop").addEventListener("click", () => {
      day.stops.splice(stopIdx, 1);
      if (day.stops.length === 0) day.stops.push(emptyStop());
      renderAll();
      recalcAllDriveTimes();
    });

    return node;
  }

  // rowは「stopIdx番目の行」、nextStopは「stopIdx+1番目のstop」（無ければ最終行）。
  // 車移動時間・徒歩時間はnextStop側のデータを表示する（①出発＋移動時間＝次の到着、に揃えるため）。
  function updateDriveCell(row, nextStop) {
    const modeEl = row.querySelector(".f-drive-mode");
    const timeEl = row.querySelector(".f-drive-time");
    const kmEl = row.querySelector(".f-drive-km");
    const errorEl = row.querySelector(".f-drive-error");
    const refreshBtn = row.querySelector(".f-drive-refresh");
    const focused = document.activeElement;

    if (!nextStop) {
      modeEl.disabled = true;
      timeEl.disabled = true;
      timeEl.placeholder = "";
      if (focused !== timeEl) timeEl.value = "";
      kmEl.textContent = "";
      errorEl.textContent = "";
      errorEl.hidden = true;
      refreshBtn.disabled = true;
      return;
    }

    modeEl.disabled = false;
    timeEl.disabled = false;
    refreshBtn.disabled = false;
    if (focused !== modeEl) modeEl.value = nextStop.driveMode || "car";

    if (nextStop.pending) {
      timeEl.placeholder = "計算中…";
      if (focused !== timeEl) timeEl.value = "";
      kmEl.textContent = "";
    } else {
      timeEl.placeholder = "h:mm";
      if (focused !== timeEl) {
        timeEl.value = nextStop.driveMinutes != null ? formatHM(nextStop.driveMinutes) : "";
      }
      kmEl.textContent = nextStop.driveKm != null ? `(${nextStop.driveKm}km)` : "";
    }

    if (nextStop.driveError) {
      errorEl.textContent = nextStop.driveError;
      errorEl.hidden = false;
    } else {
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
  }

  // 車移動時間の表示用テキストを作る（Excel出力でも同じ並びを使う）
  function formatDriveDisplay(stop) {
    if (!stop) return "";
    if (stop.driveError) return stop.driveError;
    if (stop.driveMinutes != null) {
      return formatHM(stop.driveMinutes) + (stop.driveKm != null ? `（${stop.driveKm}km）` : "");
    }
    return "";
  }

  // ---------- 車移動時間／徒歩時間の自動計算 ----------
  async function recalcOne(dayIdx, stopIdx, force) {
    const day = trip.days[dayIdx];
    const stop = day.stops[stopIdx];
    const prev = getPreviousStop(dayIdx, stopIdx);

    // 手入力で上書きされている場合、明示的な再計算（🔄・モード変更）以外では自動上書きしない
    if (stop.driveManual && !force) return;
    stop.driveManual = false;

    if (!prev || !prev.address.trim() || !stop.address.trim()) {
      stop.driveMinutes = null;
      stop.driveKm = null;
      stop.driveError = "";
      cascadeDay(dayIdx, stopIdx);
      refreshValues();
      return;
    }

    const mode = stop.driveMode || "car";
    const key = prev.address.trim() + "||" + stop.address.trim() + "||" + mode;
    if (!force && driveCache.has(key)) {
      applyDriveResult(stop, driveCache.get(key));
      cascadeDay(dayIdx, stopIdx);
      refreshValues();
      return;
    }

    stop.pending = true;
    stop.driveError = "";
    refreshValues();

    try {
      const url = `/api/drivetime?origin=${encodeURIComponent(prev.address)}&destination=${encodeURIComponent(stop.address)}&mode=${encodeURIComponent(mode)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || "取得に失敗しました");
      }
      const data = await res.json();
      driveCache.set(key, data);
      applyDriveResult(stop, data);
    } catch (e) {
      stop.driveMinutes = null;
      stop.driveKm = null;
      stop.driveError = String(e.message || e).slice(0, 60);
    }
    stop.pending = false;
    cascadeDay(dayIdx, stopIdx);
    refreshValues();
  }

  function applyDriveResult(stop, data) {
    stop.driveMinutes = data.duration_sec / 60;
    stop.driveKm = data.distance_km;
    stop.driveError = "";
  }

  function recalcAround(dayIdx, stopIdx) {
    recalcOne(dayIdx, stopIdx, false);
    // 次の行は「このstopが前の訪問地」になるため再計算
    if (stopIdx + 1 < trip.days[dayIdx].stops.length) {
      recalcOne(dayIdx, stopIdx + 1, false);
    }
  }

  async function recalcAllDriveTimes() {
    for (let d = 0; d < trip.days.length; d++) {
      for (let s = 1; s < trip.days[d].stops.length; s++) {
        await recalcOne(d, s, false);
      }
    }
  }

  // ---------- ツールバー ----------
  document.getElementById("tripTitle").addEventListener("input", (e) => (trip.title = e.target.value));

  document.getElementById("btnAddDay").addEventListener("click", () => {
    trip.days.push(emptyDay());
    renderAll();
  });

  document.getElementById("btnRecalcAll").addEventListener("click", () => {
    driveCache.clear();
    recalcAllDriveTimes();
  });

  document.getElementById("btnSaveJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(trip, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${trip.title || "出張ルート表"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btnLoad").addEventListener("click", () => {
    document.getElementById("fileInput").click();
  });
  document.getElementById("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const loaded = JSON.parse(text);
      if (!loaded || !Array.isArray(loaded.days)) throw new Error("形式が正しくありません");
      trip = loaded;
      renderAll();
      document.getElementById("tripTitle").value = trip.title || "出張ルート表";
    } catch (err) {
      alert("読み込みに失敗しました: " + err.message);
    } finally {
      e.target.value = "";
    }
  });

  document.getElementById("btnExportExcel").addEventListener("click", exportExcel);

  // ---------- ルートプリセット ----------
  function populatePresetSelect() {
    const presets = window.ROUTE_PRESETS;
    if (!presets) return;
    const kantoGroup = document.getElementById("presetGroupKanto");
    const chihouGroup = document.getElementById("presetGroupChihou");
    presets.KANTO_PRESETS.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = "kanto:" + p.key;
      opt.textContent = p.label + (p.note ? `（${p.note}）` : "");
      kantoGroup.appendChild(opt);
    });
    presets.CHIHOU_PRESETS.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = "chihou:" + p.key;
      opt.textContent = p.label;
      chihouGroup.appendChild(opt);
    });
    const brandGroup = document.getElementById("presetGroupBrand");
    (presets.BRAND_PRESETS || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = "brand:" + p.key;
      opt.textContent = p.label;
      brandGroup.appendChild(opt);
    });
  }

  function findPreset(value) {
    if (!value) return null;
    const [region, key] = value.split(":");
    const presets = window.ROUTE_PRESETS;
    const list =
      region === "kanto" ? presets.KANTO_PRESETS : region === "brand" ? presets.BRAND_PRESETS : presets.CHIHOU_PRESETS;
    const preset = list.find((p) => p.key === key);
    return preset ? { ...preset, region } : null;
  }

  // address を渡した場合は地図検索用の住所を固定する（主要駅など、名前だけでは誤検索されるもの）
  function buildStopFromName(name, pref, address) {
    const stop = emptyStop();
    stop.place = name;
    if (address) stop.address = address;
    applyPlaceLookup(stop, pref);
    return stop;
  }

  document.getElementById("btnLoadPreset").addEventListener("click", () => {
    const select = document.getElementById("presetSelect");
    const preset = findPreset(select.value);
    if (!preset) {
      alert("ルートを選択してください。");
      return;
    }

    // 関東圏は本社を起点・終点に、地方は主要駅を起点に自動で置く
    // start が無いプリセット（ブランドごとの一覧など）は、1件目の院からそのまま始める
    const entries =
      preset.region === "kanto"
        ? [
            { name: window.ROUTE_PRESETS.HQ_NAME, pref: "" },
            ...preset.stops,
            { name: window.ROUTE_PRESETS.HQ_NAME, pref: "" },
          ]
        : preset.start
          ? [{ name: preset.start.name, pref: preset.pref, address: preset.start.address }, ...preset.stops]
          : [...preset.stops];

    const stops = entries.map((e) => buildStopFromName(e.name, e.pref, e.address));
    stops[0].departure = startTime(); // 起点は9:00出発。以降は自動計算で埋まる
    stops[0].stay = "";

    const day = {
      date: "",
      memo: preset.label + (preset.note ? `（${preset.note}）` : ""),
      stops,
    };
    trip.days.push(day);
    cascadeDay(trip.days.length - 1, 0);
    renderAll();
    recalcAllDriveTimes();
  });

  populatePresetSelect();

  function exportExcel() {
    const header = [
      "日付", "院名・行動内容", "住所", "到着", "滞在", "出発", "車移動時間",
      "営業時間", "法人名", "口コミ", "ブログ", "入金", "棚卸", "レセ", "問合せ", "備考",
    ];
    const rows = [header];
    trip.days.forEach((day) => {
      rows.push([`${day.date || ""} ${day.memo || ""}`.trim()]);
      day.stops.forEach((s, i) => {
        rows.push([
          "",
          s.place,
          s.address,
          s.arrival,
          s.stay,
          s.departure,
          formatDriveDisplay(day.stops[i + 1]),
          s.hours,
          s.corp,
          s.checks.review ? "済" : "",
          s.checks.blog ? "済" : "",
          s.checks.payment ? "済" : "",
          s.checks.stock ? "済" : "",
          s.checks.rese ? "済" : "",
          s.checks.inquiry ? "済" : "",
          s.note,
        ]);
      });
      rows.push([]);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = header.map((_, i) => ({ wch: i === 1 ? 22 : i === 2 ? 26 : i === 7 ? 34 : 12 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "出張ルート表");
    XLSX.writeFile(wb, `${trip.title || "出張ルート表"}.xlsx`);
  }

  // ---------- 起動 ----------
  (async function init() {
    await loadHospitals();
    renderAll();
  })();
})();
