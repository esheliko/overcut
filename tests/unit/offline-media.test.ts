import test from "node:test";
import assert from "node:assert/strict";
import { MediaCache, MemoryStore } from "../../apps/web/src/media/cache";
import type { MediaHost } from "../../apps/web/src/media/host";
import { WaveformService } from "../../apps/web/src/media/waveform";

const media = { id: "m", kind: "audio" as const, name: "m", uri: "fs:m", hash: "h1" };

test("waveforms: media offline at first request stays in error until invalidated, then is extracted again", async () => {
  let offline = true, asked = 0, released = 0;
  const host: MediaHost = {
    async audioFormat() { asked++; if (offline) throw new Error("media is offline"); return null; },
    async readAudio() { return new Int16Array(0); },
    async thumbnail() { throw new Error("unused"); },
    async release() { released++; },
  };
  const svc = new WaveformService({ peaks: {} } as never, host, new MediaCache(new MemoryStore()));
  const first = svc.request(media);
  await svc.idle();
  assert.equal(first.status, "error");
  assert.equal(svc.request(media), first, "no automatic retry: the placeholder stays");
  assert.equal(asked, 1);

  offline = false; // relinked
  svc.invalidate(media.id);
  const again = svc.request(media);
  assert.notEqual(again, first);
  await svc.idle();
  assert.equal(asked, 2, "the host was asked again");
  assert.notEqual(again.status, "error");
  assert.equal(released, 0);
});
