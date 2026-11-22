// Runs the S1 spike page headless in Chromium (Playwright) and prints/writes the JSON result.
// Usage: node spikes/s1-webcodecs/run.mjs [--clip clip-gop30] [--seeks 60] [--gpu swiftshader|default] [--out file]
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dir = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mp4": "video/mp4" };
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
    const body = await readFile(join(dir, p));
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;
const MODES = ["decodeOnly", "importExternalTexture", "copyExternalImageToTexture", "cpuUpload"];
const launchArgs = ["--enable-unsafe-webgpu"];
if (arg("gpu", "swiftshader") === "swiftshader") launchArgs.push("--enable-features=Vulkan", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader");
if (arg("flags")) launchArgs.push(...arg("flags").split(";"));
let result = null, version = "";
// one fresh browser + page per path: a failing GPU path must not poison the next one
for (const mode of MODES) {
  const browser = await chromium.launch({ args: launchArgs, executablePath: process.env.CHROMIUM_PATH });
  version = browser.version();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e));
  await page.goto(`http://localhost:${port}/?clip=${arg("clip", "clip-gop30")}&seeks=${arg("seeks", "60")}&mode=${mode}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 300000 });
  const r = await page.evaluate(() => window.__result);
  if (r.error) { console.error(mode, r.error); }
  result = result ? { ...result, paths: { ...result.paths, ...r.paths } } : r;
  await browser.close();
}
result.browser = `Chromium ${version} headless`;
console.log(JSON.stringify(result, null, 2));
if (arg("out")) await writeFile(arg("out"), JSON.stringify(result, null, 2));
server.close();
