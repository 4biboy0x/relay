const SITE_URL = "https://relay-4vm.pages.dev";
const DEFAULT_TITLE = "Relay — Social";
const DEFAULT_DESCRIPTION = "Relay is a social platform to share posts, discover public content, watch Reels, and connect through private messaging.";
const DEFAULT_IMAGE = SITE_URL + "/assets/relay-social-preview.png";
const PAGE_CACHE_SECONDS = 300;
const SITEMAP_CACHE_SECONDS = 600;
const MAX_SITEMAP_URLS = 50000;
const MAX_SITEMAP_PAGES = 40;

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}
function cleanText(value, max = 155) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}
function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
}
function mediaHttpUrl(value, apiBase) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const apiOrigin = apiBase ? new URL(apiBase).origin : SITE_URL;
    const url = new URL(value, apiOrigin);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
function safeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
function imageMime(value) {
  const path = String(value || "").split(/[?#]/, 1)[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".avif")) return "image/avif";
  if (/\.(jpe?g)$/.test(path)) return "image/jpeg";
  return "";
}
function durationIso(milliseconds) {
  const ms = Number(milliseconds);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return "PT" + (hours ? hours + "H" : "") + (minutes ? minutes + "M" : "") + remainder + "S";
}
function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}
function jsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029",
  })[character]);
}
function getMetaContent(html, name) {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp('<meta\\s+name=["\\']' + escaped + '["\\']\\s+content=["\\']([^"\\']*)["\\']', "i"));
  return match ? match[1] : "";
}
async function getShell(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") throw new Error("Cloudflare Pages ASSETS binding is unavailable");
  const response = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { method: "GET" }));
  if (!response.ok) throw new Error("Could not load dist/index.html from ASSETS");
  return await response.text();
}
function getApiBase(shell, request, env) {
  const configured = String(env.RELAY_API_BASE_URL || getMetaContent(shell, "relay-api-base") || "").trim();
  if (!configured) return "";
  try {
    const url = new URL(configured, request.url);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.href.replace(/\/+$/, "");
  } catch { return ""; }
}
async function fetchApiJson(apiBase, pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Relay API timeout"), 3000);
  try {
    const response = await fetch(apiBase + pathname, { method: "GET", headers: { Accept: "application/json" }, redirect: "follow", signal: controller.signal });
    if (response.status === 404 || response.status === 410) return { status: 404, data: null };
    if (!response.ok) return { status: response.status, data: null };
    return { status: response.status, data: await response.json() };
  } finally { clearTimeout(timer); }
}
function setHeadTag(html, matcher, tag) {
  return html.replace(matcher, "").replace(/<\/head>/i, tag + "\n</head>");
}
function injectMetadata(shell, page) {
  const title = cleanText(page.title || DEFAULT_TITLE, 70) || DEFAULT_TITLE;
  const description = cleanText(page.description || DEFAULT_DESCRIPTION, 155) || DEFAULT_DESCRIPTION;
  const canonical = SITE_URL + page.path;
  const image = safeHttpUrl(page.image) || DEFAULT_IMAGE;
  let html = shell.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, "<title>" + htmlEscape(title) + "</title>");
  html = setHeadTag(html, /<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '<link rel="canonical" href="' + htmlEscape(canonical) + '">');
  html = html.replace(/<meta\s+property=["\x27]og:image:(?:width|height|type)["\x27][^>]*>/gi, "");
  const meta = [
    ["name", "description", description], ["property", "og:type", page.ogType || "article"],
    ["property", "og:site_name", "Relay"], ["property", "og:title", title],
    ["property", "og:description", description], ["property", "og:url", canonical],
    ["property", "og:image", image],
    ...(page.imageWidth ? [["property", "og:image:width", String(page.imageWidth)]] : []),
    ...(page.imageHeight ? [["property", "og:image:height", String(page.imageHeight)]] : []),
    ["property", "og:image:alt", title],
    ...(imageMime(image) ? [["property", "og:image:type", imageMime(image)]] : []),
    ["name", "twitter:card", "summary_large_image"], ["name", "twitter:title", title],
    ["name", "twitter:description", description], ["name", "twitter:image", image], ["name", "twitter:image:alt", title],
  ];
  for (const [attribute, key, value] of meta) {
    if (value == null || value === "") continue;
    const escapedKey = key.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    const matcher = new RegExp('<meta\\s+' + attribute + '=["\\']' + escapedKey + '["\\'][^>]*>', "gi");
    html = setHeadTag(html, matcher, '<meta ' + attribute + '="' + htmlEscape(key) + '" content="' + htmlEscape(value) + '">');
  }
  const graph = [
    { "@type": "Organization", "@id": SITE_URL + "/#organization", name: "Relay", url: SITE_URL },
    { "@type": "WebSite", "@id": SITE_URL + "/#website", name: "Relay", url: SITE_URL, inLanguage: "en", publisher: { "@id": SITE_URL + "/#organization" } },
    page.structuredData,
  ].filter(Boolean);
  html = html.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
  html = setHeadTag(html, /<meta\s+name=["']robots["'][^>]*>/gi, '<meta name="robots" content="index,follow,max-image-preview:large">');
  html = setHeadTag(html, /<meta\s+name=["']theme-color["'][^>]*>/gi, '<meta name="theme-color" content="#ffffff">');
  html = setHeadTag(html, /<meta\s+property=["']og:locale["'][^>]*>/gi, '<meta property="og:locale" content="en_US">');
  html = setHeadTag(html, /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '<script type="application/ld+json">' + jsonForScript({ "@context": "https://schema.org", "@graph": graph }) + "</script>");
  const readable = '<section id="relay-seo-content" aria-label="Public content" style="max-width:600px;margin:12px auto 20px;padding:12px 16px;font:14px/1.6 system-ui,sans-serif;color:inherit"><h1 style="font-size:18px;margin:0 0 6px">' + htmlEscape(page.heading || title) + '</h1><p style="margin:0">' + htmlEscape(page.readable || description) + "</p></section>";
  return html.replace(/<body\b[^>]*>/i, (tag) => tag + "\n" + readable);
}
async function loadCached(key, loader) {
  const cache = caches.default;
  const cacheRequest = new Request(key, { method: "GET" });
  try { const cached = await cache.match(cacheRequest); if (cached) return cached; } catch {}
  const response = await loader();
  if (response.ok && response.headers.get("Cache-Control")?.includes("public")) {
    try { await cache.put(cacheRequest, response.clone()); } catch {}
  }
  return response;
}
async function shellResponse(request, env, page, status = 200, cacheSeconds = PAGE_CACHE_SECONDS) {
  const shell = await getShell(request, env);
  const fallback = { path: "/", title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, image: DEFAULT_IMAGE, imageWidth: 1200, imageHeight: 630, ogType: "website", structuredData: null, heading: "Relay — Social", readable: "Explore public posts, profiles, Reels, and Topics on Relay." };
  return new Response(injectMetadata(shell, page || fallback), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": status === 200 && page ? "public, max-age=60, s-maxage=" + cacheSeconds + ", stale-while-revalidate=600" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
async function notFoundResponse(request, env) {
  try {
    const asset = await env.ASSETS.fetch(new Request(new URL("/404.html", request.url)));
    if (asset.ok) return new Response(asset.body, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {}
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
async function publicPage(request, env, pathInfo) {
  const url = new URL(request.url);
  const publicPath = pathInfo.type === "profile" ? "/@" + pathInfo.handle
    : pathInfo.type === "reel" ? "/reel/" + pathInfo.id.toLowerCase()
    : pathInfo.type === "topic" ? "/topic/" + pathInfo.slug
    : "/post/" + pathInfo.id;
  return loadCached(SITE_URL + publicPath, async () => {
    try {
      const shell = await getShell(request, env);
      const apiBase = getApiBase(shell, request, env);
      if (!apiBase) return shellResponse(request, env, null);
      let page;
      if (pathInfo.type === "post") {
        const result = await fetchApiJson(apiBase, "/posts/" + encodeURIComponent(pathInfo.id));
        if (result.status === 404 || result.status === 400) return notFoundResponse(request, env);
        if (!result.data) return shellResponse(request, env, null);
        const post = result.data;
        if (post.deletedAt) return notFoundResponse(request, env);
        const author = post.author || {};
        const body = cleanText(post.body, 1000);
        const authorName = cleanText(author.displayName || author.handle || "Relay user", 80);
        const createdAt = safeDate(post.createdAt);
        const firstImage = mediaHttpUrl(Array.isArray(post.mediaUrls) ? post.mediaUrls[0] : post.mediaUrl, apiBase);
        const readable = [authorName + (author.handle ? " (@" + cleanText(author.handle, 30) + ")" : ""), body, createdAt ? "Posted " + createdAt : ""].filter(Boolean).join(" — ");
        page = { path: publicPath, title: authorName + " on Relay", description: cleanText(body || ("A public post by " + authorName + " on Relay."), 155), heading: "Post by " + authorName, readable, image: firstImage || DEFAULT_IMAGE, ...(!firstImage ? { imageWidth: 1200, imageHeight: 630 } : {}), ogType: "article",
          structuredData: { "@type": "SocialMediaPosting", headline: cleanText(body, 200), articleBody: body, datePublished: createdAt || undefined, dateModified: safeDate(post.updatedAt) || undefined, author: { "@type": "Person", name: authorName, ...(author.handle ? { alternateName: "@" + cleanText(author.handle, 30) } : {}) }, url: SITE_URL + publicPath, ...(firstImage ? { image: firstImage } : {}) } };
      } else if (pathInfo.type === "profile") {
        const result = await fetchApiJson(apiBase, "/users/" + encodeURIComponent(pathInfo.handle));
        if (result.status === 404) return notFoundResponse(request, env);
        if (!result.data) return shellResponse(request, env, null);
        const user = result.data;
        const displayName = cleanText(user.displayName || user.handle, 80);
        const handle = cleanText(user.handle, 30);
        const bio = cleanText(user.bio, 280);
        const avatar = mediaHttpUrl(user.avatarUrl, apiBase);
        const createdAt = safeDate(user.createdAt);
        page = { path: publicPath, title: displayName + " (@" + handle + ") on Relay", description: cleanText(bio || ("Public profile of " + displayName + " on Relay."), 155), heading: displayName + (handle ? " · @" + handle : ""), readable: [displayName, handle ? "@" + handle : "", bio, createdAt ? "Joined " + createdAt : ""].filter(Boolean).join(" — "), image: avatar || DEFAULT_IMAGE, ...(!avatar ? { imageWidth: 1200, imageHeight: 630 } : {}), ogType: "profile",
          structuredData: { "@type": "ProfilePage", url: SITE_URL + publicPath, ...(createdAt ? { dateCreated: createdAt } : {}), mainEntity: { "@type": "Person", name: displayName, ...(handle ? { alternateName: "@" + handle } : {}), ...(bio ? { description: bio } : {}), ...(avatar ? { image: avatar } : {}) } } };
      } else if (pathInfo.type === "reel") {
        const result = await fetchApiJson(apiBase, "/reels/" + encodeURIComponent(pathInfo.id));
        if (result.status === 404) return notFoundResponse(request, env);
        if (!result.data) return shellResponse(request, env, null);
        const reel = result.data;
        if (reel.status !== "READY" || reel.deletedAt) return notFoundResponse(request, env);
        const author = reel.author || {};
        const displayName = cleanText(author.displayName || author.handle || "Relay user", 80);
        const caption = cleanText(reel.caption, 280);
        const poster = mediaHttpUrl(reel.posterUrl, apiBase);
        const duration = durationIso(reel.durationMs);
        const publishedAt = safeDate(reel.publishedAt || reel.createdAt);
        page = { path: publicPath, title: (caption || "Reel") + " — " + displayName + " on Relay", description: cleanText(caption || ("A Reel by " + displayName + " on Relay."), 155), heading: caption || "Reel by " + displayName, readable: [displayName, caption, publishedAt ? "Published " + publishedAt : "", duration ? "Duration " + duration : ""].filter(Boolean).join(" — "), image: poster || DEFAULT_IMAGE, ...(!poster ? { imageWidth: 1200, imageHeight: 630 } : {}), ogType: "video.other",
          structuredData: poster && duration ? { "@type": "VideoObject", name: caption || "Reel by " + displayName, description: cleanText(caption || ("A Reel by " + displayName + " on Relay."), 155), thumbnailUrl: [poster], uploadDate: publishedAt || undefined, duration, url: SITE_URL + publicPath } : null };
      } else {
        const [topicResult, postsResult] = await Promise.all([fetchApiJson(apiBase, "/topics"), fetchApiJson(apiBase, "/topics/" + encodeURIComponent(pathInfo.slug) + "/posts?limit=10")]);
        if (topicResult.status === 404 || postsResult.status === 404) return notFoundResponse(request, env);
        if (!topicResult.data || !postsResult.data) return shellResponse(request, env, null);
        const topic = (topicResult.data.items || []).find((item) => item.slug === pathInfo.slug);
        if (!topic) return notFoundResponse(request, env);
        const posts = Array.isArray(postsResult.data.items) ? postsResult.data.items : [];
        const topicName = cleanText(topic.name || topic.slug, 60);
        const sample = posts.slice(0, 3).map((post) => [cleanText(post.author?.displayName || post.author?.handle, 80), cleanText(post.body, 280), safeDate(post.createdAt)].filter(Boolean).join(": ")).filter(Boolean).join(" — ");
        const topicDescription = cleanText("Public posts about " + topicName + " on Relay.", 155);
        page = { path: publicPath, title: topicName + " — Topic on Relay", description: topicDescription, heading: topicName, readable: [topicName, sample].filter(Boolean).join(" — "), image: DEFAULT_IMAGE, imageWidth: 1200, imageHeight: 630, ogType: "website",
          structuredData: { "@type": "CollectionPage", name: topicName, description: topicDescription, url: SITE_URL + publicPath, mainEntity: { "@type": "ItemList", itemListElement: posts.slice(0, 10).map((post, index) => ({ "@type": "ListItem", position: index + 1, url: SITE_URL + "/post/" + encodeURIComponent(post.id) })) } } };
      }
      return shellResponse(request, env, page);
    } catch {
      try { return await shellResponse(request, env, null); }
      catch { return new Response("Relay is temporarily unavailable.", { status: 503, headers: { "Cache-Control": "no-store" } }); }
    }
  });
}
function sitemapXml(urls) {
  const entries = urls.slice(0, MAX_SITEMAP_URLS).map((item) => "<url><loc>" + xmlEscape(item.loc) + "</loc>" + (item.lastmod ? "<lastmod>" + xmlEscape(item.lastmod) + "</lastmod>" : "") + "</url>").join("");
  return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + entries + "</urlset>";
}
async function collectPaged(apiBase, endpoint, limit, mapItem) {
  const urls = [];
  let cursor = "";
  let pages = 0;
  let truncated = false;
  do {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const result = await fetchApiJson(apiBase, endpoint + (endpoint.includes("?") ? "&" : "?") + query.toString());
    if (!result.data) throw new Error("Sitemap source API did not return a usable page");
    for (const item of (Array.isArray(result.data.items) ? result.data.items : [])) {
      const mapped = mapItem(item);
      if (mapped) urls.push(mapped);
      if (urls.length >= MAX_SITEMAP_URLS) { truncated = Boolean(result.data.nextCursor); break; }
    }
    cursor = result.data.nextCursor || "";
    pages += 1;
  } while (cursor && pages < MAX_SITEMAP_PAGES && urls.length < MAX_SITEMAP_URLS);
  if (cursor && pages >= MAX_SITEMAP_PAGES) truncated = true;
  return { urls, truncated };
}
async function sitemapResponse(request, env, kind) {
  return loadCached(SITE_URL + "/__relay-sitemap-cache/" + kind, async () => {
    try {
      const shell = await getShell(request, env);
      const apiBase = getApiBase(shell, request, env);
      if (!apiBase) return new Response("Sitemap API configuration is missing", { status: 503 });
      let result;
      if (kind === "topics") {
        const response = await fetchApiJson(apiBase, "/topics");
        if (!response.data) return new Response("Topic index unavailable", { status: 503 });
        result = { urls: (response.data.items || []).map((topic) => ({ loc: SITE_URL + "/topic/" + encodeURIComponent(topic.slug) })).slice(0, MAX_SITEMAP_URLS), truncated: false };
      } else if (kind === "posts") {
        result = await collectPaged(apiBase, "/feed?feed=for-you", 50, (post) => post?.id ? ({ loc: SITE_URL + "/post/" + encodeURIComponent(post.id), lastmod: safeDate(post.updatedAt) }) : null);
      } else if (kind === "profiles") {
        result = await collectPaged(apiBase, "/explore", 50, (user) => user?.handle ? ({ loc: SITE_URL + "/@" + encodeURIComponent(user.handle), lastmod: safeDate(user.updatedAt) }) : null);
      } else {
        result = await collectPaged(apiBase, "/reels/feed", 20, (reel) => reel?.id && reel.status === "READY" ? ({ loc: SITE_URL + "/reel/" + encodeURIComponent(reel.id) }) : null);
      }
      const headers = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=" + SITEMAP_CACHE_SECONDS + ", stale-while-revalidate=1800" };
      if (result.truncated) headers["X-Relay-Sitemap-Truncated"] = "true";
      return new Response(sitemapXml(result.urls), { status: 200, headers });
    } catch { return new Response("Sitemap temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store" } }); }
  });
}
async function sitemapIndex() {
  const kinds = ["posts", "profiles", "reels", "topics"];
  const body = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + kinds.map((kind) => "<sitemap><loc>" + SITE_URL + "/sitemap-" + kind + ".xml</loc></sitemap>").join("") + "</sitemapindex>";
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=1800" } });
}
export async function onRequest(context) {
  const { request, env, next } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  const url = new URL(request.url);
  if (url.pathname === "/sitemap.xml") return sitemapIndex();
  const sitemapMatch = url.pathname.match(/^\/sitemap-(posts|profiles|reels|topics)\.xml$/);
  if (sitemapMatch) return sitemapResponse(request, env, sitemapMatch[1]);
  let match = url.pathname.match(/^\/post\/([A-Za-z0-9_-]{8,64})\/?$/);
  if (match) return publicPage(request, env, { type: "post", id: match[1] });
  match = url.pathname.match(/^\/@([a-zA-Z0-9_]{3,30})\/?$/);
  if (match) return publicPage(request, env, { type: "profile", handle: match[1].toLowerCase() });
  match = url.pathname.match(/^\/reel\/([0-9a-f-]{36})\/?$/i);
  if (match) return publicPage(request, env, { type: "reel", id: match[1] });
  match = url.pathname.match(/^\/topic\/([a-z0-9-]{2,40})\/?$/);
  if (match) return publicPage(request, env, { type: "topic", slug: match[1] });
  return next();
}
