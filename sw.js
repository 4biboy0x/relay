const CACHE_NAME = "relay-images-v1";
const MAX_CACHE_ENTRIES = 300;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith("relay-images-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET"
    || request.destination !== "image"
    || request.headers.has("Range")) return;

  const requestUrl = new URL(request.url);
  const isSameOriginUpload = requestUrl.origin === self.location.origin
    && requestUrl.pathname.startsWith("/uploads/");
  const isSignedStorageObject = [...requestUrl.searchParams.keys()]
    .some((name) => name.toLowerCase().startsWith("x-amz-"));
  if (!isSameOriginUpload && !isSignedStorageObject) return;

  const cacheUrl = new URL(requestUrl);
  for (const name of [...cacheUrl.searchParams.keys()]) {
    if (name.toLowerCase().startsWith("x-amz-")) cacheUrl.searchParams.delete(name);
  }
  const cacheKey = new Request(cacheUrl.href, { method: "GET" });

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.status === 200 || response.type === "opaque") {
      event.waitUntil((async () => {
        await cache.put(cacheKey, response.clone());
        const keys = await cache.keys();
        const excess = keys.length - MAX_CACHE_ENTRIES;
        if (excess > 0) {
          await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
        }
      })());
    }
    return response;
  })());
});
