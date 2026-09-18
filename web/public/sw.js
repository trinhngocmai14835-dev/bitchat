const CACHE_NAME = "bitchat-pwa-v12";
const BASE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const SERVICE_WORKER_PATH = `${BASE_PATH}/sw.js`;
const RELAY_PATH_PREFIX = `${BASE_PATH}/relay`;
const APP_SHELL = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/manifest.webmanifest`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname === SERVICE_WORKER_PATH) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  // Poll responses must never be cached: an empty first poll would otherwise
  // hide later messages from the relay forever on that device.
  if (requestUrl.pathname === RELAY_PATH_PREFIX || requestUrl.pathname.startsWith(`${RELAY_PATH_PREFIX}/`)) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  // Always load the newest HTML after a deployment. The app shell remains
  // available from cache as an offline fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).catch(() => caches.match(`${BASE_PATH}/index.html`)),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    })),
  );
});
