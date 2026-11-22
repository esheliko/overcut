// Runs the S3 encode spike headless in Chromium, then verifies A/V sync with verify.mjs.
// Usage: node spikes/s3-encode/run.mjs --codec h264|vp9|av1 --container mp4|webm [--seconds 300] [--cancel-after 2]
//        [--acodec auto|aac|opus] [--vbitrate 8000000] [--hw no-preference|prefer-software|prefer-hardware]
import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { verify } from "./verify.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
await mkdir(join(dir, "out"), { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
    if (req.method === "POST" && p.startsWith("/out/")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const f = join(dir, "out", p.slice(5).replace(/[^\w.-]/g, "_"));
      if (req.headers["x-append"] === "1") await appendFile(f, Buffer.concat(chunks)); else await writeFile(f, Buffer.concat(chunks));
      return res.writeHead(200).end("ok");
    }
    const body = await readFile(join(dir, p));
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;

const cfg = {
  codec: arg("codec", "h264"), container: arg("container", "mp4"), seconds: +arg("seconds", "300"),
  width: 1920, height: 1080, fps: 30, vbitrate: +arg("vbitrate", "8000000"), abitrate: 128000,
  hw: arg("hw", "no-preference"), acodecPref: arg("acodec", "auto"),
};
const cancelAfter = +arg("cancel-after", "0");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: arg("flags") ? arg("flags").split(";") : [] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("pageerror", e));
await page.goto(`http://localhost:${port}/`);
const nCores = await page.evaluate(() => navigator.hardwareConcurrency);
await page.evaluate((c) => window.__start(c), cfg);
if (cancelAfter) {
  await page.waitForTimeout(cancelAfter * 1000);
  await page.evaluate(() => window.__cancel());
}
await page.waitForFunction(() => window.__result, null, { timeout: 0, polling: 1000 });
const r = await page.evaluate(() => ({ ...window.__result, cancelAt: window.__cancelAt, perfNow: performance.now() }));
const progress = await page.evaluate(() => window.__progress.length);
const version = browser.version();
await browser.close(); server.close();
r.browser = `Chromium ${version} headless (${nCores} logical cores, no GPU)`;
r.progressEvents = progress;
if (r.type === "done" && r.uploadOk && arg("verify", "1") === "1") r.sync = await verify(join(dir, "out", r.name), cfg.seconds);
console.log(JSON.stringify(r, null, 2));
await writeFile(join(dir, "out", `result-${cfg.codec}-${cfg.container}-${cfg.seconds}s${cancelAfter ? "-cancel" : ""}.json`), JSON.stringify(r, null, 2));
