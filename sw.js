const CACHE_NAME = "relay-images-v2";
const SHELL_CACHE_NAME = "relay-shell-v1";
const MAX_CACHE_ENTRIES = 300;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE_NAME);
    await Promise.allSettled([
      cache.add(new Request("/", { cache: "reload" })),
      cache.add(new Request("/offline.html", { cache: "reload" })),
    ]);
    await self.skipWaiting();
  })());
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
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && new URL(request.url).origin === self.location.origin) {
          const cache = await caches.open(SHELL_CACHE_NAME);
          const requestPath = new URL(request.url).pathname;
          if (requestPath === "/" || requestPath.endsWith(".html")) {
            await cache.put(requestPath === "/" ? "/" : request, response.clone());
          }
        }
        return response;
      } catch {
        const cache = await caches.open(SHELL_CACHE_NAME);
        const cachedRequest = await cache.match(request);
        if (cachedRequest) return cachedRequest;
        const appShell = await cache.match("/");
        if (appShell) return appShell;
        const offlinePage = await cache.match("/offline.html");
        if (offlinePage) return offlinePage;
        return new Response("You’re offline. Reconnect and try again.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })());
    return;
  }

  if (request.destination !== "image" || request.headers.has("Range")) return;

  const requestUrl = new URL(request.url);
  const isSameOriginUpload = requestUrl.origin === self.location.origin
    && requestUrl.pathname.startsWith("/uploads/");
  const isSignedStorageObject = requestUrl.protocol === "https:"
    && requestUrl.searchParams.has("X-Amz-Algorithm")
    && requestUrl.searchParams.has("X-Amz-Credential")
    && requestUrl.searchParams.has("X-Amz-Signature");
  if (!isSameOriginUpload && !isSignedStorageObject) return;

  const cacheUrl = new URL(requestUrl);
  for (const name of [...cacheUrl.searchParams.keys()]) {
    if (name.toLowerCase().startsWith("x-amz-")) cacheUrl.searchParams.delete(name);
  }
  const cacheKey = new Request(cacheUrl.href, { method: "GET" });

  event.respondWith((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (error) {
      console.warn("Image cache is unavailable; using the network.", error);
      return fetch(request);
    }

    const response = await fetch(request);
    if (response.status === 200 || response.type === "opaque") {
      event.waitUntil((async () => {
        try {
          await cache.put(cacheKey, response.clone());
          const keys = await cache.keys();
          const excess = keys.length - MAX_CACHE_ENTRIES;
          if (excess > 0) {
            await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
          }
        } catch (error) {
          console.warn("Could not save an image in the service-worker cache.", error);
        }
      })());
    }
    return response;
  })());
});
