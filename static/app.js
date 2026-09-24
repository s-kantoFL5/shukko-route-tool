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

  function emptyDay() {
    return { date: "", memo: "", stops: [emptyStop()] };
  }

  function emptyStop() {
    return {
      id: cryptoId(),
      place: "",
      address: "",
      arrival: "",
      stay: "",
      departure: "",
      driveText: "",
      driveError: "",
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
    } else if (stop.place.trim() && !stop.address.trim()) {
      stop.address = geocodeHint ? `${geocodeHint}${stop.place.trim()}` : stop.place.trim();
      stop.hours = "";
      stop.corp = "";
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

  function flatIndex(dayIdx, stopIdx) {
    // 全日程を通したときの通し番号（前の訪問地を求めるため）
    let n = 0;
    for (let d = 0; d < dayIdx; d++) n += trip.days[d].stops.length;
    return n + stopIdx;
  }

  function flattenStops() {
    const flat = [];
    trip.days.forEach((day, dayIdx) => {
      day.stops.forEach((stop, stopIdx) => flat.push({ stop, dayIdx, stopIdx }));
    });
    return flat;
  }

  function getPreviousStop(dayIdx, stopIdx) {
    const flat = flattenStops();
    const idx = flatIndex(dayIdx, stopIdx);
    if (idx === 0) return null;
    return flat[idx - 1].stop;
  }

  function getNextStop(dayIdx, stopIdx) {
    const flat = flattenStops();
    const idx = flatIndex(dayIdx, stopIdx);
    if (idx >= flat.length - 1) return null;
    return flat[idx + 1].stop;
  }

  function renderStop(day, dayIdx, stop, stopIdx) {
    const node = stopTpl.content.firstElementChild.cloneNode(true);

    const placeEl = node.querySelector(".f-place");
    const addressEl = node.querySelector(".f-address");
    const arrivalEl = node.querySelector(".f-arrival");
    const stayEl = node.querySelector(".f-stay");
    const departureEl = node.querySelector(".f-departure");
    const driveTextEl = node.querySelector(".f-drive-text");
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
    setDriveDisplay(driveTextEl, stop);

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

    arrivalEl.addEventListener("input", () => (stop.arrival = arrivalEl.value));
    stayEl.addEventListener("input", () => (stop.stay = stayEl.value));
    departureEl.addEventListener("input", () => (stop.departure = departureEl.value));
    noteEl.addEventListener("input", () => (stop.note = noteEl.value));

    node.querySelector(".f-drive-refresh").addEventListener("click", () => recalcOne(dayIdx, stopIdx, true));

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

  function setDriveDisplay(el, stop) {
    if (stop.driveError) {
      el.textContent = stop.driveError;
      el.className = "f-drive-text error";
    } else if (stop.driveText) {
      el.textContent = stop.driveText;
      el.className = "f-drive-text";
    } else {
      el.textContent = "—";
      el.className = "f-drive-text";
    }
  }

  // ---------- 車移動時間の自動計算 ----------
  async function recalcOne(dayIdx, stopIdx, force) {
    const day = trip.days[dayIdx];
    const stop = day.stops[stopIdx];
    const prev = getPreviousStop(dayIdx, stopIdx);

    if (!prev || !prev.address.trim() || !stop.address.trim()) {
      stop.driveText = "";
      stop.driveError = "";
      renderAll();
      return;
    }

    const key = prev.address.trim() + "||" + stop.address.trim();
    if (!force && driveCache.has(key)) {
      applyDriveResult(stop, driveCache.get(key));
      renderAll();
      return;
    }

    stop.driveText = "計算中…";
    stop.driveError = "";
    renderAll();

    try {
      const url = `/api/drivetime?origin=${encodeURIComponent(prev.address)}&destination=${encodeURIComponent(stop.address)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || "取得に失敗しました");
      }
      const data = await res.json();
      driveCache.set(key, data);
      applyDriveResult(stop, data);
    } catch (e) {
      stop.driveText = "";
      stop.driveError = String(e.message || e).slice(0, 40);
    }
    renderAll();
  }

  function applyDriveResult(stop, data) {
    stop.driveText = `${data.duration_text}（${data.distance_km}km）`;
    stop.driveError = "";
  }

  function recalcAround(dayIdx, stopIdx) {
    recalcOne(dayIdx, stopIdx, false);
    const next = getNextStop(dayIdx, stopIdx);
    if (next) {
      // 次の行は「このstopが前の訪問地」になるため再計算
      const flat = flattenStops();
      const nextEntry = flat[flatIndex(dayIdx, stopIdx) + 1];
      if (nextEntry) recalcOne(nextEntry.dayIdx, nextEntry.stopIdx, false);
    }
  }

  async function recalcAllDriveTimes() {
    const flat = flattenStops();
    for (let i = 1; i < flat.length; i++) {
      await recalcOne(flat[i].dayIdx, flat[i].stopIdx, false);
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
  }

  function findPreset(value) {
    if (!value) return null;
    const [region, key] = value.split(":");
    const presets = window.ROUTE_PRESETS;
    const list = region === "kanto" ? presets.KANTO_PRESETS : presets.CHIHOU_PRESETS;
    const preset = list.find((p) => p.key === key);
    return preset ? { ...preset, region } : null;
  }

  function buildStopFromName(name, pref) {
    const stop = emptyStop();
    stop.place = name;
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

    const hq = { name: window.ROUTE_PRESETS.HQ_NAME, pref: "" };
    const entries = preset.region === "kanto" ? [hq, ...preset.stops, hq] : [...preset.stops];

    const day = {
      date: "",
      memo: preset.label + (preset.note ? `（${preset.note}）` : ""),
      stops: entries.map((e) => buildStopFromName(e.name, e.pref)),
    };
    trip.days.push(day);
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
      day.stops.forEach((s) => {
        rows.push([
          "",
          s.place,
          s.address,
          s.arrival,
          s.stay,
          s.departure,
          s.driveText || "",
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
