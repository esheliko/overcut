/// Persistence Worker: owns the project's storage (OPFS sync access handles only exist in a Worker, and file I/O stays off the UI thread).
/// Protocol: the page sends `{id, cmd, ...}`; the worker answers `{id, ok: value}` or `{id, err: {code, message}}`. Requests run one at a time, in order.
import { openWebStorage } from "./web-storage";
import { toStorageError, type ProjectStorage } from "./storage";

type Request =
  | { id: number; cmd: "open"; project: string }
  | { id: number; cmd: "read" | "remove"; name: string }
  | { id: number; cmd: "writeAtomic" | "append"; name: string; bytes: Uint8Array }
  | { id: number; cmd: "truncate"; name: string; size: number };

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<Request>) => void) | null };
let storage: ProjectStorage | undefined;
let queue: Promise<void> = Promise.resolve();

async function handle(req: Request): Promise<unknown> {
  if (req.cmd === "open") {
    storage = await openWebStorage(req.project);
    return storage.kind;
  }
  if (!storage) throw new Error("storage not opened");
  switch (req.cmd) {
    case "read":
      return storage.read(req.name);
    case "remove":
      return storage.remove(req.name);
    case "truncate":
      return storage.truncate(req.name, req.size);
    case "writeAtomic":
      return storage.writeAtomic(req.name, req.bytes);
    case "append":
      return storage.append(req.name, req.bytes);
  }
}

ctx.onmessage = (e) => {
  const req = e.data;
  queue = queue.then(async () => {
    try {
      ctx.postMessage({ id: req.id, ok: await handle(req) });
    } catch (err) {
      const s = toStorageError(err);
      ctx.postMessage({ id: req.id, err: { code: s.code, message: s.message } });
    }
  });
};
