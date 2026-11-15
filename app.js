"use strict";
// My Address Finder v0.3 — one-action UPRN to Google Maps, two open-data sources.
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
// Independent providers of OS Open UPRN coordinates (no key, no signup).
// A public API may be unreachable or block cross-origin requests from GitHub Pages.
const UPRN_PROVIDERS = [
  {name: "uprns.io", url: uprn => `https://api.uprns.io/uprns/${uprn}`},
  {name: "UPRN.org.uk", url: uprn => `https://uprn.org.uk/uprns/${uprn}.json`}
];
function verifiedCoordinates(data, uprn) {
  if (!data || String(data.uprn) !== uprn) throw new Error("INVALID_RECORD");
  const lat = Number(data.latitude);
  const lon = Number(data.longitude);
  // Strict GB bounding box: never start navigation from an unverified/absent point.
  if (data.latitude === null || data.longitude === null ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < 49.5 || lat > 61 || lon < -9 || lon > 2.5) {
    throw new Error("NO_COORDS");
  }
  return {lat, lon};
}
async function tryUprnProvider(provider, uprn, signal) {
  const response = await fetch(provider.url(uprn), {method:"GET", mode:"cors", credentials:"omit", cache:"no-store", signal});
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const data = await response.json();
  return {point: verifiedCoordinates(data,uprn),provider:provider.name};
}
function showUprnError(uprn, errors) {
  const reasons = errors.map(e => e && e.message || "network");
  if (reasons.length && reasons.every(v => v === "HTTP_404")) {
    setUprnStatus("UPRN не е намерен в двата публични източника. Провери номера във FindMyAddress.", "error");
  } else if (reasons.includes("NO_COORDS")) {
    setUprnStatus("Не са получени проверени координати за този UPRN. Не отварям приблизителен адрес.", "error");
  } else {
    setUprnStatus("Двата публични източника не върнаха координати (връзка, CORS или временен проблем). Google Maps не може да използва само UPRN.", "error");
  }
  uprnResultBox.classList.remove("hidden");
  uprnResultBox.replaceChildren(
    makeLink("Провери имота в uprns.io ↗", `https://uprns.io/uprns/${uprn}`, "secondary link-button secondary-link"),
    makeLink("Провери имота в UPRN.org.uk ↗", `https://uprn.org.uk/uprns/${uprn}`, "secondary link-button secondary-link")
  );
}
async function lookupUprn() {
  const uprn = uprnInput.value.trim();
  if (uprnController) uprnController.abort();
  uprnResultBox.replaceChildren();
  uprnResultBox.classList.add("hidden");
  if (!validUprn(uprn)) {
    setUprnStatus("Въведи UPRN от 1 до 12 цифри, без букви или интервали.", "error");
    uprnInput.focus();
    return;
  }
  const active = new AbortController();
  uprnController = active;
  const timer = setTimeout(() => active.abort(), 10000);
  uprnBtn.disabled = true;
  setUprnStatus("Намирам координатите и ще отворя Google Maps автоматично…");
  try {
    // Take the first verified point; the other service remains a fallback.
    const found = await Promise.any(UPRN_PROVIDERS.map(provider => tryUprnProvider(provider,uprn,active.signal)));
    if (uprnController !== active || active.signal.aborted || uprnInput.value.trim() !== uprn) return;
    clearTimeout(timer);
    active.abort();
    setUprnStatus(`Намерено чрез ${found.provider}. Отварям Google Maps…`, "good");
    // Retain a link for browsers that refuse automatic external-app switching.
    uprnResultBox.classList.remove("hidden");
    uprnResultBox.replaceChildren(makeLink("Отвори Google Maps ↗", mapsUrl("",found.point),"link-button maps-main"));
    // One tap (or paste) starts the whole process. No second click is needed on success.
    window.location.assign(mapsUrl("",found.point));
  } catch(err) {
    if (uprnController !== active) return;
    if (active.signal.aborted) {
      setUprnStatus("Източниците не отговориха навреме. Опитай отново, когато имаш добра връзка.", "error");
      uprnResultBox.classList.remove("hidden");
      uprnResultBox.replaceChildren(makeLink("Провери имота в uprns.io ↗",`https://uprns.io/uprns/${uprn}`,"secondary link-button secondary-link"));
    } else {
      showUprnError(uprn,err instanceof AggregateError ? err.errors : [err]);
    }
  } finally {
    clearTimeout(timer);
    if (uprnController === active) {uprnController=null;uprnBtn.disabled=false;}
  }
}
$("search-form").addEventListener("submit", (event) => {event.preventDefault();doSearch();});
$("retry-btn").addEventListener("click", () => {serverIndex = (serverIndex + 1) % SERVERS.length;doSearch(true);});
$("uprn-form").addEventListener("submit", (event) => {event.preventDefault();lookupUprn();});
// A complete UPRN pasted from FindMyAddress starts lookup immediately.
// Manual typing remains safe: press Enter / Намери when finished.
uprnInput.addEventListener("paste", event => {
  const value = (event.clipboardData?.getData("text") || "").trim();
  if (!validUprn(value)) return;
  event.preventDefault();
  uprnInput.value = value;
  lookupUprn();
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
