// v0.6: shell cache only; live UPRN/postcode requests are never intercepted.
// Query-versioned assets prevent old app.js/styles.css surviving GitHub Pages deploys.
const CACHE = "my-address-finder-shell-v0.7.0";
const SHELL = ["./", "./index.html", "./styles.css?v=0.6.0", "./app.js?v=0.6.0", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("my-address-finder-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  // Network-first keeps updates visible on Github Pages, cache is offline fallback.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const clone = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, clone)));
    }
    return response;
  }).catch(async () => {
    // Offline navigation with a query or a trailing slash falls back to our shell.
    return await caches.match(event.request) ||
      (event.request.mode === "navigate" ? await caches.match("./index.html") : undefined) ||
      Response.error();
  }));
});
