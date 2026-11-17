const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const stagingDir = path.join(root, ".vite-src");
const sourceFile = fs.readdirSync(root)
  .map((name) => path.join(root, name))
  .find((file) => path.basename(file).startsWith("Relay") && file.endsWith(".html"));
const stagingHtml = path.join(stagingDir, "index.html");
const outputHtml = path.join(root, "dist", "index.html");
const outputDemoHtml = path.join(root, "dist", "realtime-demo.html");
const apiUrl = process.env.VITE_API_URL;
const giphyApiKey = process.env.VITE_GIPHY_API_KEY || "";

if (!sourceFile) throw new Error("Relay frontend HTML file was not found");
if (process.env.NETLIFY === "true" && !apiUrl) {
  throw new Error("Set VITE_API_URL in Netlify to the deployed API base URL, including /api");
}
if (apiUrl) {
  const parsedApiUrl = new URL(apiUrl);
  if (!["http:", "https:"].includes(parsedApiUrl.protocol) || !parsedApiUrl.pathname.replace(/\/+$/, "").endsWith("/api")) {
    throw new Error("VITE_API_URL must be an http(s) URL ending in /api");
  }
}
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, "realtime-demo-client.js"), path.join(stagingDir, "realtime-demo-client.js"));
let html = fs.readFileSync(sourceFile, "utf8");
if (apiUrl) {
  const escapedApiUrl = apiUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  html = html.replace(
    '<meta name="relay-api-base" content="/api" />',
    '<meta name="relay-api-base" content="' + escapedApiUrl + '" />',
  );
}
const escapedGiphyApiKey = giphyApiKey.replace(/[&"<>]/g, (character) => ({
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
})[character]);
html = html.replace(
  '<meta name="relay-giphy-api-key" content="" />',
  '<meta name="relay-giphy-api-key" content="' + escapedGiphyApiKey + '" />',
);
html = html.replace(
  '<meta name="relay-production" content="false" />',
  '<meta name="relay-production" content="true" />',
);

const siteUrl = "https://relay-4vm.pages.dev";
const socialImageUrl = siteUrl + "/assets/relay-social-preview.svg";
const socialMetadata = [
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  '<link rel="canonical" href="https://relay-4vm.pages.dev/">',
  '<meta name="description" content="Relay is a modern social platform to share updates, discover content, watch Reels, and connect through real-time messaging.">',
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="Relay">',
  '<meta property="og:title" content="Relay — Social">',
  '<meta property="og:description" content="A modern space to connect, share, and discover. Explore posts, Reels, profiles, and real-time messaging on Relay.">',
  '<meta property="og:url" content="https://relay-4vm.pages.dev/">',
  '<meta property="og:image" content="' + socialImageUrl + '">',
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta property="og:image:type" content="image/svg+xml">',
  '<meta name="twitter:card" content="summary_large_image">',
  '<meta name="twitter:title" content="Relay — Social">',
  '<meta name="twitter:description" content="A modern space to connect, share, and discover. Explore posts, Reels, profiles, and real-time messaging on Relay.">',
  '<meta name="twitter:image" content="' + socialImageUrl + '">',
].join("\n  ");
const headMatch = html.match(/<head\b[^>]*>/i);
if (!headMatch) throw new Error("Could not inject Relay social metadata: HTML head element was not found");
html = html.replace(headMatch[0], headMatch[0] + "\n  " + socialMetadata);

fs.writeFileSync(stagingHtml, "<!doctype html><html><head><title>Relay</title></head><body></body></html>");

const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [viteCli, "build", "--config", "vite.config.js"], {
  cwd: root,
  stdio: "inherit",
});
if (result.status === 0) {
  fs.writeFileSync(outputHtml, html);
  fs.copyFileSync(path.join(root, "realtime-demo.html"), outputDemoHtml);
  fs.copyFileSync(path.join(root, "404.html"), path.join(root, "dist", "404.html"));
  fs.copyFileSync(path.join(root, "offline.html"), path.join(root, "dist", "offline.html"));
  fs.copyFileSync(path.join(root, "sw.js"), path.join(root, "dist", "sw.js"));
  fs.copyFileSync(path.join(root, "favicon.svg"), path.join(root, "dist", "favicon.svg"));
  fs.cpSync(path.join(root, "assets"), path.join(root, "dist", "assets"), { recursive: true });
  fs.rmSync(path.join(root, "dist", ".vite-src"), { recursive: true, force: true });
}
fs.rmSync(stagingDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
