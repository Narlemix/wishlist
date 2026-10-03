const CACHE = "wishlist-v1";

/** Сразу активирует новую версию. */
self.addEventListener("install", () => self.skipWaiting());

/** Берёт управление открытыми страницами. */
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/** Сеть в приоритете, копия из кеша только без интернета. */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key))
  );
});
