import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createDesktopApi, baseName, h264Percent, mimeOfPath, parseH264Failure, type PathFile } from "../../packages/engine-client/src/desktop";
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

test("enable H.264: progress events reach the caller and stop afterwards; the download is one explicit command", async () => {
  const shell = fakeShell({});
  const inner = shell.invoke as unknown as (c: string, a?: unknown) => Promise<unknown>;
  const invoke = (async (cmd: string, args?: unknown) => {
    if (cmd !== "desktop_enable_h264") return inner(cmd, args);
    shell.calls.push(cmd);
    shell.handlers.get("overcut://h264-progress")?.({ payload: { done: 500, total: 1000 } });
    return undefined;
  }) as never;
  const api = createDesktopApi(invoke, shell.listen);
  const seen: number[] = [];
  await api.enableH264((p) => seen.push(h264Percent(p) ?? -1));
  assert.deepEqual(seen, [50]);
  assert.equal(shell.handlers.size, 0, "the progress listener is removed when the download ends");
  assert.deepEqual(shell.calls.filter((c) => c === "desktop_enable_h264"), ["desktop_enable_h264"]);
  assert.equal(h264Percent({ done: 5, total: null }), null);
  assert.equal(h264Percent({ done: 2000, total: 1000 }), 100);
});

test("enable H.264: failures come back typed (offline, checksum, cancelled) and unknown ones do not crash the parser", async () => {
  const shell = fakeShell({});
  for (const code of ["offline", "checksum", "cancelled", "io"]) {
    const invoke = (async () => {
      throw JSON.stringify({ code, message: `m-${code}` });
    }) as never;
    await assert.rejects(createDesktopApi(invoke, shell.listen).enableH264(), (e: unknown) => (e as { code?: string }).code === code && (e as Error).message === `m-${code}`);
  }
  assert.equal(parseH264Failure("Command desktop_enable_h264 not found").code, "unknown");
  assert.equal(parseH264Failure(new Error('{"code":"nope","message":"x"}')).code, "unknown");
  assert.equal(parseH264Failure(JSON.stringify({ code: "busy", message: "b" })).code, "busy");
});

test("cancel is one command, usable while the download runs", async () => {
  const shell = fakeShell({});
  const inner = shell.invoke as unknown as (c: string, a?: unknown) => Promise<unknown>;
  const invoke = (async (cmd: string, args?: unknown) => (cmd === "desktop_cancel_h264" ? void shell.calls.push(cmd) : inner(cmd, args))) as never;
  await createDesktopApi(invoke, shell.listen).cancelH264();
  assert.deepEqual(shell.calls, ["desktop_cancel_h264"]);
});

test("the one optional download host is listed as desktop-only, never as a web host, and matches the Rust downloader", () => {
  const allow = JSON.parse(readFileSync("config/network-allowlist.json", "utf8")) as { hosts: string[]; desktopOnlyHosts: string[] };
  assert.deepEqual(allow.hosts, []);
  assert.deepEqual(allow.desktopOnlyHosts, ["ciscobinary.openh264.org"]);
  const rust = readFileSync("apps/desktop/native-media/src/openh264.rs", "utf8");
  assert.match(rust, /pub const HOST: &str = "ciscobinary\.openh264\.org";/);
  // The web smoke test reads only `hosts`: a desktop-only host does not widen what the web build may contact.
  assert.doesNotMatch(readFileSync("tests/smoke/network.spec.ts", "utf8"), /desktopOnlyHosts/);
});

test("files the app was launched with come back once as path files; a later launch is announced by an event", async () => {
  const sh = fakeShell({ "/d/film.overcut": new Uint8Array(4), "/d/a.mp4": new Uint8Array(9) });
  const queue = ["/d/film.overcut", "/d/a.mp4", "/d/gone.mp4"];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => (cmd === "desktop_launch_files" ? queue.splice(0) : (sh.invoke as (c: string, a?: Record<string, unknown>) => Promise<unknown>)(cmd, args))) as never;
  const api = createDesktopApi(invoke, sh.listen);
  assert.deepEqual((await api.launchFiles()).map((f) => f.name), ["film.overcut", "a.mp4"]);
  assert.deepEqual(await api.launchFiles(), []);
  let fired = 0;
  const off = await api.onOpen(() => { fired++; });
  sh.handlers.get("overcut://open")!({ payload: null });
  off();
  assert.equal(sh.handlers.has("overcut://open"), false);
  assert.equal(fired, 1);
});
