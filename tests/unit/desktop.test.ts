import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopApi, baseName, mimeOfPath, type PathFile } from "../../packages/engine-client/src/desktop";
import { fingerprintFile } from "../../packages/engine-client/src/media";
import { canOfferH264Download, desktopFormats } from "../../apps/web/src/export/model";

/** A fake disk: path -> bytes, read through the same shape as `desktop_read_range`. */
function fakeShell(files: Record<string, Uint8Array>, picked: string[] = []) {
  const calls: string[] = [];
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "desktop_file_size") {
      const f = files[args!.path as string];
      if (!f) throw new Error("no such file");
      return f.length;
    }
    if (cmd === "desktop_read_range") {
      const f = files[args!.path as string]!;
      const o = args!.offset as number;
      return f.slice(o, o + (args!.len as number)).buffer;
    }
    if (cmd === "desktop_pick_media") return picked;
    if (cmd === "desktop_codecs") return JSON.stringify({ h264: "none", webm: false, canEnableH264: false });
    throw new Error(`unexpected ${cmd}`);
  }) as never;
  const listen = (async (event: string, h: (e: { payload: unknown }) => void) => {
    handlers.set(event, h);
    return () => handlers.delete(event);
  }) as never;
  return { invoke, listen, calls, handlers };
}

test("a picked file stays on disk: name, size, type and path come from the path, bytes only on request", async () => {
  const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);
  const sh = fakeShell({ "/v/My Clip.MP4": bytes }, ["/v/My Clip.MP4", "/v/gone.mp4"]);
  const api = createDesktopApi(sh.invoke, sh.listen);
  const files = await api.pickMedia();
  assert.equal(files.length, 1, "a path that vanished is skipped");
  const f = files[0]! as PathFile;
  assert.equal(f.name, "My Clip.MP4");
  assert.equal(f.type, "video/mp4");
  assert.equal(f.size, 300_000);
  assert.equal(f.path, "/v/My Clip.MP4");
  assert.deepEqual(sh.calls.filter((c) => c === "desktop_read_range"), [], "nothing read yet");
  assert.deepEqual(new Uint8Array(await f.slice(10, 14).arrayBuffer()), bytes.slice(10, 14));
  assert.deepEqual(new Uint8Array(await f.slice(-3).arrayBuffer()), bytes.slice(-3));
  assert.equal(f.slice(5, 5).size, 0);
});

test("the import fingerprint reads only the two ends of a path file", async () => {
  const bytes = Uint8Array.from({ length: 500_000 }, (_, i) => (i * 7) % 256);
  const sh = fakeShell({ "/v/a.mov": bytes });
  const f = (await createDesktopApi(sh.invoke, sh.listen).fileAt("/v/a.mov"))!;
  let seen: { size: number; first: number; last: number } | undefined;
  const fp = await fingerprintFile({ fingerprintMedia: async (size, first, last) => ((seen = { size, first: first.length, last: last.length }), "fp") }, f);
  assert.equal(fp, "fp");
  assert.deepEqual(seen, { size: 500_000, first: 65_536, last: 65_536 });
  assert.equal(sh.calls.filter((c) => c === "desktop_read_range").length, 2);
});

test("dropped paths become files and the hover state is forwarded; unsubscribing stops both", async () => {
  const sh = fakeShell({ "/d/x.wav": new Uint8Array(10) });
  const api = createDesktopApi(sh.invoke, sh.listen);
  const got: string[][] = [];
  const hover: boolean[] = [];
  const off = await api.onDrop((files) => got.push(files.map((f) => f.name)), (o) => hover.push(o));
  sh.handlers.get("overcut://drag")!({ payload: true });
  sh.handlers.get("overcut://drop")!({ payload: ["/d/x.wav", "/d/missing.wav"] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hover, [true]);
  assert.deepEqual(got, [["x.wav"]]);
  off();
  assert.equal(sh.handlers.size, 0);
});

test("names and types come from the path on either separator", () => {
  assert.equal(baseName("C:\\Users\\me\\Videos\\clip.mkv"), "clip.mkv");
  assert.equal(mimeOfPath("/a/b.FLAC"), "audio/flac");
  assert.equal(mimeOfPath("/a/b.xyz"), "");
});

test("without an H.264 encoder the offline WebM is the default, and MP4 comes only with an explicit enable", () => {
  const none = { h264: "none", webm: true, canEnableH264: true } as const;
  assert.equal(desktopFormats(none).auto, "webm-vp9");
  assert.deepEqual(desktopFormats(none).options.map((o) => o.id), ["webm-vp9"]);
  assert.equal(canOfferH264Download(none), true);
  for (const h264 of ["hardware", "software"] as const) {
    const c = { h264, webm: true, canEnableH264: true };
    assert.equal(desktopFormats(c).auto, "mp4-h264");
    assert.equal(canOfferH264Download(c), false);
  }
  // This build: no WebM writer and no downloader yet: nothing is offered that cannot be made.
  const today = { h264: "none", webm: false, canEnableH264: false } as const;
  assert.deepEqual(desktopFormats(today), { options: [], auto: null });
  assert.equal(canOfferH264Download(today), false);
});
