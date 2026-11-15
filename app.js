"use strict";
// My Address Finder v0.5 — v0.4 navigation preserved; one-tap clipboard paste.
const $ = (id) => document.getElementById(id);
const postcodeInput = $("postcode");
const statusBox = $("status");
const meta = $("meta");
const resultsBox = $("results");
const searchBtn = $("search-btn");
const retryWrap = $("retry-wrap");
const uprnInput = $("uprn");
const uprnBtn = $("uprn-btn");
const uprnPasteBtn = $("uprn-paste-btn");
const uprnStatusBox = $("uprn-status");
const uprnResultBox = $("uprn-result");
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
let lastPostcode = "";
let lastCoords = null;
let serverIndex = 0;
let controller = null;
let uprnController = null;

function normalisePostcode(input) {
  const pc = String(input || "").toUpperCase().replace(/\s+/g, "").trim();
  if (!/^(GIR0AA|[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2})$/.test(pc)) return null;
  return pc.slice(0, -3) + " " + pc.slice(-3);
}
function setStatus(message, kind = "") {
  statusBox.textContent = message;
  statusBox.className = "status" + (kind ? " " + kind : "");
}
function setUprnStatus(message, kind = "") {
  uprnStatusBox.textContent = message;
  uprnStatusBox.className = "status" + (kind ? " " + kind : "");
}
function mapsUrl(address, point) {
  // A point represents an OS / OSM property location, not a confirmed entrance.
  const dest = point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    ? `${point.lat},${point.lon}` : address;
  return "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + encodeURIComponent(dest);
}
function cleanValue(value) { return String(value ?? "").trim(); }
function makeLink(text, url, className = "link-button") {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = url;
  a.className = className;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function showResults(records, postcode) {
  resultsBox.replaceChildren();
  if (!records.length) {
    setStatus("Няма намерени адреси с този postcode в OpenStreetMap. Това НЕ означава, че къщите не съществуват. Използвай FindMyAddress или търсене по UPRN.", "error");
    return;
  }
  meta.textContent = `Открити ${records.length} адреса · само наличните в OpenStreetMap`;
  meta.classList.remove("hidden");
  setStatus("Резултатите са от OpenStreetMap и може да са непълни. Избери адрес за Google Maps.", "good");
  for (const r of records) {
    const item = makeLink("", mapsUrl(r.name + ", " + r.line + ", " + postcode + ", UK", r.point), "address");
    item.setAttribute("aria-label", "Навигация до " + r.name + " в Google Maps");
    const details = document.createElement("div"); details.className = "address-info";
    const title = document.createElement("div"); title.className = "address-title";
    title.textContent = r.name;
    const sub = document.createElement("div"); sub.className = "address-sub";
    sub.textContent = r.line;
    details.append(title, sub);
    const go = document.createElement("span"); go.className = "go"; go.textContent = "Maps ↗";
    item.append(details, go); resultsBox.append(item);
  }
}
function parseAddresses(elements, postcode) {
  const found = new Map();
  const norm = (s) => String(s || "").toUpperCase().replace(/\s/g, "");
  for (const obj of Array.isArray(elements) ? elements : []) {
    const t = obj.tags || {};
    if (norm(t["addr:postcode"]) !== norm(postcode)) continue;
    const number = cleanValue(t["addr:housenumber"]);
    const houseName = cleanValue(t["addr:housename"]);
    const flat = cleanValue(t["addr:unit"] || t["addr:flats"]);
    if (!number && !houseName && !flat) continue;
    const house = [flat, number, houseName].filter(Boolean).join(" · ");
    const street = cleanValue(t["addr:street"] || t["addr:place"]);
    const name = house + (street ? " · " + street : "");
    const town = cleanValue(t["addr:city"] || t["addr:suburb"] || t["addr:hamlet"]);
    const key = name.toLocaleLowerCase("en-GB");
    const coord = obj.center || obj;
    const lat = Number(coord.lat), lon = Number(coord.lon);
    const point = Number.isFinite(lat) && Number.isFinite(lon) ? {lat,lon} : null;
    if (!found.has(key) || (point && !found.get(key).point)) {
      found.set(key, {name, line: [town,postcode].filter(Boolean).join(" · "), point});
    }
  }
  return [...found.values()].sort((a,b) => a.name.localeCompare(b.name,"en-GB",{numeric:true,sensitivity:"base"}));
}
function createQuery(postcode, coords) {
  // Validated postcode, so user text can't inject Overpass query statements.
  const pattern = postcode.replace(" ", " ?");
  return `[out:json][timeout:18];nwr["addr:postcode"~"^${pattern}$",i](around:850,${coords.latitude},${coords.longitude});out center tags;`;
}
async function jsonResponse(url, opts, signal) {
  const response = await fetch(url, {...opts, signal, cache:"no-store"});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function doSearch(useBackup = false) {
  const postcode = normalisePostcode(postcodeInput.value);
  if (!postcode) { setStatus("Въведи пълен UK postcode, например TF10 7AB.","error");postcodeInput.focus();return; }
  postcodeInput.value = postcode;
  if (controller) controller.abort();
  controller = new AbortController();
  const active = controller;
  const timeout = setTimeout(() => active.abort(), 26000);
  searchBtn.disabled = true;
  retryWrap.classList.add("hidden");
  meta.classList.add("hidden");
  resultsBox.replaceChildren();
  setStatus("Проверявам postcode и търся адресите в OpenStreetMap…");
  try {
    if (!useBackup || lastPostcode !== postcode || !lastCoords) {
      const info = await jsonResponse("https://api.postcodes.io/postcodes/" + encodeURIComponent(postcode.replace(" ","")), {}, active.signal);
      if (!info.result || !Number.isFinite(info.result.latitude) || !Number.isFinite(info.result.longitude)) {
        throw new Error("POSTCODE_NOT_FOUND");
      }
      lastCoords = info.result;
    }
    lastPostcode = postcode;
    if (!useBackup) serverIndex = 0;
    const query = createQuery(postcode, lastCoords);
    const data = await jsonResponse(SERVERS[serverIndex] + "?data=" + encodeURIComponent(query), {}, active.signal);
    if (data.remark) throw new Error("OVERPASS_BUSY");
    showResults(parseAddresses(data.elements, postcode), postcode);
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("Търсенето отне твърде дълго. Опитай друг сървър или FindMyAddress.","error");
    } else if (err.message === "POSTCODE_NOT_FOUND" || err.message === "HTTP 404") {
      setStatus("Postcode не е намерен. Провери дали е написан правилно.","error");
    } else {
      setStatus("Не успях да заредя адресите (" + (err.message === "OVERPASS_BUSY" ? "сървърът е натоварен" : "мрежа или публичен API") + "). Опитай друг сървър или FindMyAddress.","error");
    }
    retryWrap.classList.remove("hidden");
  } finally {
    clearTimeout(timeout);
    if (controller === active) { controller = null; searchBtn.disabled = false; }
  }
}
function validUprn(value) {
  // Official UPRN numeric identifier, 1–12 digits; no leading zero.
  return /^[1-9][0-9]{0,11}$/.test(value);
}
function extractUprn(text) {
  // Accept a bare number or a single FindMyAddress-style "UPRN: 123456" line.
  // Do not guess from arbitrary text containing other numbers.
  const match = String(text || "").trim().match(/^(?:UPRN\s*[:#-]?\s*)?([1-9][0-9]{0,11})$/i);
  return match ? match[1] : null;
}
// The official OS Open UPRN data is republished via these public APIs.
// First try direct API requests. A third-party proxy is used ONLY when the direct
// browser requests fail (e.g. missing CORS response headers).
// This is a public GET: do not send private tokens or passwords through a proxy.
const UPRN_PROVIDERS = [
  {name:"uprns.io", url: uprn => `https://api.uprns.io/uprns/${uprn}`},
  {name:"UPRN.org.uk", url: uprn => `https://uprn.org.uk/uprns/${uprn}.json`}
];
const CORS_PROXY = "https://proxy.cors.dev/";
const uprnDebug = $("uprn-debug");
const uprnLog = $("uprn-log");

function verifiedCoordinates(data, uprn) {
  if (!data || String(data.uprn) !== uprn) throw new Error("INVALID_RECORD");
  const lat = Number(data.latitude), lon = Number(data.longitude);
  if (data.latitude == null || data.longitude == null ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < 49.5 || lat > 61 || lon < -9 || lon > 2.5) throw new Error("NO_COORDS");
  return {lat, lon};
}
function errorLabel(error) {
  const m = String(error && error.message || "UNKNOWN");
  if (m === "TIMEOUT") return "няма отговор навреме";
  if (m === "NETWORK_CORS") return "блокирана заявка (CORS/мрежа)";
  if (m === "INVALID_RECORD") return "грешен UPRN в отговора";
  if (m === "NO_COORDS") return "няма точни координати";
  if (m === "BAD_JSON") return "невалиден JSON отговор";
  if (m.startsWith("HTTP_")) return "HTTP " + m.slice(5);
  return "неизвестна грешка";
}
async function tryUprnProvider(provider, uprn, signal, viaProxy, details) {
  const url = (viaProxy ? CORS_PROXY : "") + provider.url(uprn);
  const timeoutController = new AbortController();
  const cancel = () => timeoutController.abort();
  signal.addEventListener("abort", cancel, {once:true});
  const timer = setTimeout(() => timeoutController.abort(), viaProxy ? 9500 : 4500);
  let error;
  try {
    const response = await fetch(url, {
      method:"GET", mode:"cors", credentials:"omit", cache:"no-store", signal: timeoutController.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("BAD_JSON"); }
    const point = verifiedCoordinates(data,uprn);
    details.push(`${viaProxy ? "Резервно" : "Директно"} · ${provider.name}: OK`);
    return {point,provider:viaProxy ? provider.name + " (резервна връзка)" : provider.name};
  } catch (err) {
    error = timeoutController.signal.aborted && !signal.aborted ? new Error("TIMEOUT") :
      (err && err.name === "TypeError") ? new Error("NETWORK_CORS") : err;
    details.push(`${viaProxy ? "Резервно" : "Директно"} · ${provider.name}: ${errorLabel(error)}`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
function attemptGroup(uprn, signal, viaProxy, details) {
  return Promise.any(UPRN_PROVIDERS.map(p => tryUprnProvider(p,uprn,signal,viaProxy,details)));
}
function showUprnFailure(uprn, problems, details) {
  uprnResultBox.classList.remove("hidden");
  uprnResultBox.replaceChildren(
    makeLink("Провери UPRN в сайта uprns.io ↗",`https://uprns.io/uprns/${uprn}`,"secondary link-button secondary-link")
  );
  const categories = problems.map(e => e?.message || "UNKNOWN");
  if (categories.length > 0 && categories.every(x=>x === "HTTP_404")) {
    setUprnStatus("UPRN не е намерен в източниците. Провери дали номерът е актуален във FindMyAddress.","error");
  } else if (categories.includes("NO_COORDS")) {
    setUprnStatus("Намерена е информация, но липсват проверени координати. Няма да отварям приблизителна точка.","error");
  } else {
    setUprnStatus("Не успях да получа координати нито директно, нито чрез резервната връзка. Виж подробностите по-долу.","error");
  }
  uprnLog.textContent = details.join("\n");
  uprnDebug.classList.remove("hidden");
}
async function lookupUprn() {
  const uprn = uprnInput.value.trim();
  if (uprnController) uprnController.abort();
  uprnResultBox.replaceChildren(); uprnResultBox.classList.add("hidden");
  uprnDebug.classList.add("hidden"); uprnDebug.open = false; uprnLog.textContent = "";
  if (!validUprn(uprn)) {
    setUprnStatus("Въведи UPRN от 1 до 12 цифри, без букви или интервали.","error");
    uprnInput.focus(); return;
  }
  const active = new AbortController();
  uprnController = active;
  uprnBtn.disabled = true;
  const details = [];
  let problems = [];
  setUprnStatus("Намирам точните координати… Google Maps ще се отвори автоматично.");
  try {
    let found;
    try {
      found = await attemptGroup(uprn,active.signal,false,details);
    } catch (err) {
      problems = err instanceof AggregateError ? err.errors : [err];
      if (active.signal.aborted) return;
      setUprnStatus("Първата връзка не успя. Опитвам резервен начин автоматично…");
      // The anonymous proxy sees the requested UPRN; make that transparent in the UI.
      try {
        found = await attemptGroup(uprn,active.signal,true,details);
      } catch (err2) {
        problems = problems.concat(err2 instanceof AggregateError ? err2.errors : [err2]);
      }
    }
    if (uprnController !== active || active.signal.aborted || uprnInput.value.trim() !== uprn) return;
    if (found) {
      const destination = mapsUrl("",found.point);
      setUprnStatus(`Координатите са намерени чрез ${found.provider}. Отварям Google Maps…`,"good");
      // When Android prevents a delayed app switch, leave a single manual fallback.
      uprnResultBox.classList.remove("hidden");
      uprnResultBox.replaceChildren(makeLink("Отвори Google Maps ↗", destination, "link-button maps-main"));
      window.location.assign(destination);
    } else {
      showUprnFailure(uprn,problems,details);
    }
  } finally {
    if (uprnController === active) {
      active.abort(); uprnController = null; uprnBtn.disabled = false;
    }
  }
}
$("search-form").addEventListener("submit", (event) => {event.preventDefault();doSearch();});
$("retry-btn").addEventListener("click", () => {serverIndex = (serverIndex + 1) % SERVERS.length;doSearch(true);});
$("uprn-form").addEventListener("submit", (event) => {event.preventDefault();lookupUprn();});
// A complete UPRN pasted from FindMyAddress starts lookup immediately.
// Manual typing remains safe: press Enter / Към Google Maps when finished.
uprnInput.addEventListener("paste", event => {
  const uprn = extractUprn(event.clipboardData?.getData("text"));
  if (!uprn) return;
  event.preventDefault();
  uprnInput.value = uprn;
  lookupUprn();
});
// Clipboard read requires HTTPS and a real user gesture. It may be blocked
// by Android browser permissions; normal long-press -> Paste still works.
uprnPasteBtn.addEventListener("click", async () => {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
    uprnInput.focus();
    setUprnStatus("Телефонът не разрешава директно поставяне. Задръж полето и избери „Постави“ — търсенето ще започне автоматично.");
    return;
  }
  try {
    const copied = await navigator.clipboard.readText();
    const uprn = extractUprn(copied);
    if (!uprn) {
      setUprnStatus("В clipboard няма валиден UPRN. Копирай само номера (или „UPRN: номер“) от FindMyAddress.", "error");
      return;
    }
    uprnInput.value = uprn;
    lookupUprn();
  } catch (_) {
    uprnInput.focus();
    setUprnStatus("Браузърът не предостави достъп до clipboard. Задръж полето и избери „Постави“ — приложението ще потърси автоматично.");
  }
});
uprnInput.addEventListener("input", () => {
  // Never display directions for an old UPRN after the user changes the input.
  if (uprnController) { uprnController.abort(); uprnController = null; uprnBtn.disabled = false; }
  uprnResultBox.replaceChildren(); uprnResultBox.classList.add("hidden");
  setUprnStatus("Готово за търсене по UPRN.");
});
$("manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const address = $("manual-address").value.trim();
  if (!address) return;
  const pc = normalisePostcode(postcodeInput.value);
  window.open(mapsUrl([address,pc,"UK"].filter(Boolean).join(", "),null),"_blank","noopener,noreferrer");
});
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
