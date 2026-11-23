/** Where a project's files live. Backends: OPFS and IndexedDB (browsers, `persist/web-storage.ts`), the project folder (Tauri), memory (tests). */
export interface ProjectStorage {
  readonly kind: "opfs" | "idb" | "folder" | "memory";
  /** The file's bytes, or null when it does not exist. */
  read(name: string): Promise<Uint8Array | null>;
  /** Replaces the file atomically: after a crash at any point a reader sees the old content or the new, never a mix. */
  writeAtomic(name: string, bytes: Uint8Array): Promise<void>;
  /** Appends; durable (flushed) when the promise resolves. A crash can only tear the end of what was being appended. */
  append(name: string, bytes: Uint8Array): Promise<void>;
  /** Cuts an appended file down to `size` bytes (drops a torn tail). Does nothing when it is already that short. */
  truncate(name: string, size: number): Promise<void>;
  remove(name: string): Promise<void>;
}

export type StorageErrorCode = "quota" | "permission" | "unavailable" | "locked" | "io";

/** A storage failure with a message fit for the user. Edits are never dropped silently: the session surfaces this and keeps retrying. */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "StorageError";
  }
}

const MESSAGES: Record<StorageErrorCode, string> = {
  quota: "This device is out of storage space, so your changes are not being saved. Free some space (or export your project) and try again.",
  permission: "OverCut is not allowed to save here, so your changes are not being saved. Check the browser's site storage permission or the folder's permissions.",
  unavailable: "Saving is not available in this browser (private mode or blocked storage), so your changes will be lost when you close this tab.",
  locked: "This project is open in another tab or window. Close it there first.",
  io: "Saving failed, so your latest changes may not be stored.",
};

/** Maps whatever a browser or the Tauri shell threw to a `StorageError` (DOMException names, Tauri `{code,message}` JSON, Node errno). */
export function toStorageError(thrown: unknown): StorageError {
  if (thrown instanceof StorageError) return thrown;
  const name = thrown && typeof thrown === "object" && "name" in thrown ? String((thrown as { name: unknown }).name) : "";
  let text = thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : String(thrown);
  let code: StorageErrorCode = "io";
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && typeof (v as { code?: unknown }).code === "string") {
      const c = (v as { code: string }).code;
      if (c === "quota" || c === "permission") code = c;
      text = String((v as { message?: unknown }).message ?? text);
    }
  } catch {
    /* plain text */
  }
  const errno = thrown && typeof thrown === "object" && "code" in thrown ? String((thrown as { code: unknown }).code) : "";
  if (name === "QuotaExceededError" || errno === "ENOSPC" || /quota|no space|disk full/i.test(text)) code = "quota";
  else if (name === "NotAllowedError" || name === "SecurityError" || errno === "EACCES" || errno === "EPERM") code = "permission";
  else if (name === "NotSupportedError" || name === "InvalidStateError") code = code === "io" ? "unavailable" : code;
  return new StorageError(code, `${MESSAGES[code]} (${text})`, thrown);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE), for slot checksums and for naming the base a commit log belongs to. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
export const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const SLOT_MAGIC = 0x4f435331; // "OCS1"
const SLOT_HEADER = 16;

/**
 * Atomic replace for stores without an atomic rename (OPFS in browsers that lack `move()`): two slots, each `magic, generation, length,
 * crc32, payload`. A write goes to the slot that does NOT hold the newest valid copy, so a crash mid-write only damages the older one;
 * a read returns the valid slot with the highest generation. Used by every non-native backend that cannot replace a file in one step.
 */
export function packSlot(generation: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(SLOT_HEADER + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SLOT_MAGIC);
  dv.setUint32(4, generation >>> 0);
  dv.setUint32(8, payload.length);
  dv.setUint32(12, crc32(payload));
  out.set(payload, SLOT_HEADER);
  return out;
}

export function unpackSlot(bytes: Uint8Array | null): { generation: number; payload: Uint8Array } | null {
  if (!bytes || bytes.length < SLOT_HEADER) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== SLOT_MAGIC) return null;
  const len = dv.getUint32(8);
  if (SLOT_HEADER + len > bytes.length) return null;
  const payload = bytes.subarray(SLOT_HEADER, SLOT_HEADER + len);
  return crc32(payload) === dv.getUint32(12) ? { generation: dv.getUint32(4), payload } : null;
}

/** Raw two-file primitive the slot scheme runs on (a backend supplies plain, non-atomic read/overwrite). */
export interface RawFiles {
  read(name: string): Promise<Uint8Array | null>;
  overwrite(name: string, bytes: Uint8Array): Promise<void>;
  append(name: string, bytes: Uint8Array): Promise<void>;
  truncate(name: string, size: number): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Builds a `ProjectStorage` from raw files using two-slot atomic replace. Names `x` are stored as `x.0` and `x.1`; appended logs are stored plainly. */
export function slotStorage(kind: ProjectStorage["kind"], raw: RawFiles): ProjectStorage {
  const newest = async (name: string) => {
    const [a, b] = await Promise.all([raw.read(`${name}.0`), raw.read(`${name}.1`)]);
    const sa = unpackSlot(a);
    const sb = unpackSlot(b);
    if (sa && sb) return sa.generation >= sb.generation ? { slot: 0, ...sa } : { slot: 1, ...sb };
    if (sa) return { slot: 0, ...sa };
    if (sb) return { slot: 1, ...sb };
    return null;
  };
  return {
    kind,
    async read(name) {
      // a name is either replaced atomically or appended to, never both: the slots win when present, else the appended log
      return (await newest(name))?.payload ?? (await raw.read(`${name}.log`));
    },
    async writeAtomic(name, bytes) {
      const cur = await newest(name);
      const slot = cur ? 1 - cur.slot : 0;
      await raw.overwrite(`${name}.${slot}`, packSlot((cur?.generation ?? 0) + 1, bytes));
    },
    append: (name, bytes) => raw.append(`${name}.log`, bytes),
    truncate: (name, size) => raw.truncate(`${name}.log`, size),
    remove: async (name) => {
      await Promise.all([raw.remove(`${name}.0`), raw.remove(`${name}.1`), raw.remove(`${name}.log`)]);
    },
  };
}
