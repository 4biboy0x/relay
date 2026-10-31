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
    `<meta name="relay-api-base" content="${escapedApiUrl}" />`,
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
  `<meta name="relay-giphy-api-key" content="${escapedGiphyApiKey}" />`,
);
fs.writeFileSync(stagingHtml, "<!doctype html><html><head><title>Relay</title></head><body></body></html>");

const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [viteCli, "build", "--config", "vite.config.js"], {
  cwd: root,
  stdio: "inherit",
});
if (result.status === 0) {
  fs.writeFileSync(outputHtml, html);
  fs.copyFileSync(path.join(root, "realtime-demo.html"), outputDemoHtml);
  fs.cpSync(path.join(root, "assets"), path.join(root, "dist", "assets"), { recursive: true });
  fs.rmSync(path.join(root, "dist", ".vite-src"), { recursive: true, force: true });
}
fs.rmSync(stagingDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
