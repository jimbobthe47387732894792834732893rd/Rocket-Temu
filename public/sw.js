// Rocket Temu service worker: keeps the game on the phone so it opens instantly and bot matches work offline.
// The page itself is fetched fresh whenever there's a connection (so updates show up), with the saved copy as backup.
const CACHE = "rocket-temu-17a8091e50";
const ASSETS = ["/", "/three.min.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/three-addons/shaders/CopyShader.js", "/three-addons/shaders/LuminosityHighPassShader.js", "/three-addons/postprocessing/EffectComposer.js", "/three-addons/postprocessing/RenderPass.js", "/three-addons/postprocessing/ShaderPass.js", "/three-addons/postprocessing/UnrealBloomPass.js", "/three-addons/environments/RoomEnvironment.js"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname === "/ws" || url.pathname === "/health") return;
  if (req.mode === "navigate" || url.pathname === "/") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); return res; })
      .catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
