"use strict";
// My Address Finder v0.2 — free open-data lookups; no private address database.
const $ = (id) => document.getElementById(id);
const postcodeInput = $("postcode");
const statusBox = $("status");
const meta = $("meta");
const resultsBox = $("results");
const searchBtn = $("search-btn");
const retryWrap = $("retry-wrap");
const uprnInput = $("uprn");
const uprnBtn = $("uprn-btn");
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
function addDetail(label, value, container) {
  if (!value && value !== 0) return;
  const row = document.createElement("div"); row.className = "data-row";
  const dt = document.createElement("span"); dt.className = "data-label"; dt.textContent = label;
  const dd = document.createElement("strong"); dd.className = "data-value"; dd.textContent = String(value);
  row.append(dt, dd); container.append(row);
}
function showUprnRecord(data, uprn) {
  uprnResultBox.replaceChildren();
  uprnResultBox.classList.remove("hidden");
  const title = document.createElement("h3"); title.textContent = "Имот UPRN " + uprn;
  const details = document.createElement("div"); details.className = "uprn-data";
  addDetail("Postcode", data.postcode, details);
  addDetail("Населено място", data.town, details);
  addDetail("Община", data.admin_district, details);
  addDetail("Държава", data.country, details);
  const lat = typeof data.latitude === "number" ? data.latitude : NaN;
  const lon = typeof data.longitude === "number" ? data.longitude : NaN;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  const note = document.createElement("p"); note.className = "hint important-note";
  uprnResultBox.append(title, details);
  if (hasCoords) {
    addDetail("GPS координати", `${lat.toFixed(6)}, ${lon.toFixed(6)}`, details);
    uprnResultBox.append(makeLink("Навигация с Google Maps ↗", mapsUrl("", {lat,lon}), "link-button maps-main"));
    note.textContent = "Навигацията е към точката на имота, не непременно към входа за автомобили. Провери маршрута преди пътуване.";
    setUprnStatus("UPRN е намерен. Можеш да отвориш GPS координатите в Google Maps.", "good");
  } else {
    note.textContent = "UPRN е намерен, но услугата не предостави GPS координати. Не е безопасно да насочвам Google Maps към приблизителен адрес.";
    setUprnStatus("UPRN е намерен, но няма координати за навигация.", "error");
  }
  uprnResultBox.append(makeLink("Виж данните в uprns.io ↗", "https://uprns.io/uprns/" + uprn, "secondary link-button secondary-link"));
  uprnResultBox.append(note);
}
async function lookupUprn() {
  const uprn = uprnInput.value.trim();
  uprnResultBox.replaceChildren();
  uprnResultBox.classList.add("hidden");
  if (!validUprn(uprn)) {
    setUprnStatus("UPRN трябва да съдържа от 1 до 12 цифри, без интервали или букви.", "error");
    uprnInput.focus();
    return;
  }
  if (uprnController) uprnController.abort();
  uprnController = new AbortController();
  const active = uprnController;
  const timer = setTimeout(() => active.abort(), 14000);
  uprnBtn.disabled = true;
  setUprnStatus("Проверявам UPRN в официалните отворени данни…");
  try {
    const data = await jsonResponse("https://api.uprns.io/uprns/" + uprn, {headers:{Accept:"application/json"}}, active.signal);
    // Be careful: a mismatched or malformed response must not direct a user elsewhere.
    if (!data || String(data.uprn) !== uprn) throw new Error("INVALID_RECORD");
    if (active.signal.aborted) return;
    showUprnRecord(data, uprn);
  } catch (err) {
    // A newer lookup or edited UPRN supersedes the old request.
    if (uprnController !== active) return;
    let message;
    if (err.name === "AbortError") message = "Търсенето отне твърде дълго. Провери връзката и опитай отново.";
    else if (err.message === "HTTP 404") message = "Този UPRN не е намерен в отворените данни. Провери цифрите във FindMyAddress.";
    else if (err.message === "HTTP 429") message = "Публичният API временно ограничава заявките. Опитай по-късно.";
    else if (err.message === "INVALID_RECORD") message = "Получените данни не съответстват на търсения UPRN. Не показвам навигация, за да избегнем грешен адрес.";
    else message = "Не успях да се свържа с UPRN услугата. Възможен е мрежов проблем или ограничение на браузъра.";
    setUprnStatus(message, "error");
    if (!active.signal.aborted) {
      uprnResultBox.classList.remove("hidden");
      uprnResultBox.append(makeLink("Провери UPRN директно в uprns.io ↗", "https://uprns.io/uprns/" + uprn, "secondary link-button secondary-link"));
    }
  } finally {
    clearTimeout(timer);
    if (uprnController === active) { uprnController = null; uprnBtn.disabled = false; }
  }
}
$("search-form").addEventListener("submit", (event) => {event.preventDefault();doSearch();});
$("retry-btn").addEventListener("click", () => {serverIndex = (serverIndex + 1) % SERVERS.length;doSearch(true);});
$("uprn-form").addEventListener("submit", (event) => {event.preventDefault();lookupUprn();});
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
