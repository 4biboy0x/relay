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
const apiUrl = process.env.VITE_API_URL;

if (!sourceFile) throw new Error("Relay frontend HTML file was not found");
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
let html = fs.readFileSync(sourceFile, "utf8");
if (apiUrl) {
  const escapedApiUrl = apiUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  html = html.replace(
    '<meta name="relay-api-base" content="/api" />',
    `<meta name="relay-api-base" content="${escapedApiUrl}" />`,
  );
}
fs.writeFileSync(stagingHtml, "<!doctype html><html><head><title>Relay</title></head><body></body></html>");

const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [viteCli, "build", "--config", "vite.config.js"], {
  cwd: root,
  stdio: "inherit",
});
if (result.status === 0) {
  fs.writeFileSync(outputHtml, html);
  fs.rmSync(path.join(root, "dist", ".vite-src"), { recursive: true, force: true });
}
fs.rmSync(stagingDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
