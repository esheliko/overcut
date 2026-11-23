import type { Editing, EditOutcome, Engine, Op, Recovery } from "../types";
import type { Project } from "../model.generated";
import { StorageError, crc32, decode, encode, toStorageError, type ProjectStorage } from "./storage";

export const PROJECT_FILE = "project.overcut";
export const JOURNAL_FILE = "journal.jsonl";
export const CHECKPOINT_FILE = "checkpoint.json";
/** The commit log of recovered edits the user chose to discard ("Undo recovery"), kept so nothing is ever lost silently. */
export const DISCARDED_FILE = "discarded.jsonl";

/** What the UI shows after an automatic recovery. */
export interface RecoveryNote {
  /** Edits (and undos/redos) restored. */
  replayed: number;
  /** Log lines that could not be restored (a torn last write: normally 0 or 1). */
  dropped: number;
  /** Undo reaches back to the start of the crashed session. */
  fullHistory: boolean;
}

export type SaveStatus = "saved" | "saving" | "error";

export interface SessionOptions {
  /** Makes the project for a storage that has none yet. */
  createProject(): Project;
  /** Write a checkpoint this long after the last edit (0 disables; default 3000 ms). */
  checkpointIdleMs?: number;
  /** ...and after this many commit records (default 500). */
  checkpointEvery?: number;
  /** Called on every status change: `error` carries the user-facing `StorageError`. Edits stay in memory and are retried until written. */
  onStatus?(status: SaveStatus, error?: StorageError): void;
  /** Asks the browser not to evict the project's storage (`navigator.storage.persist`); called once, when a project is first created. */
  onFirstProject?(): void;
}

export interface OpenedSession {
  session: ProjectSession;
  project: Project;
  /** Set when the previous session ended without a clean save and its edits were restored. */
  recovered: RecoveryNote | null;
}

const baseId = (bytes: Uint8Array) => `${crc32(bytes).toString(16)}:${bytes.length}`;
const headerLine = (base: string) => `${JSON.stringify({ header: 1, base })}\n`;

/** Splits a stored journal into its base id and the commit-log text after the header line. */
function splitJournal(text: string): { base: string; log: string } | null {
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  try {
    const h = JSON.parse(text.slice(0, nl)) as { header?: unknown; base?: unknown };
    return h.header === 1 && typeof h.base === "string" ? { base: h.base, log: text.slice(nl + 1) } : null;
  } catch {
    return null;
  }
}

/**
 * Opens a project from `storage` and keeps it durable (`docs/features/persistence.md`).
 *
 * Files: `project.overcut` = the project as the session began (the last clean save); `journal.jsonl` = a header naming that base, then every
 * commit record since, appended after each edit; `checkpoint.json` = a periodic full snapshot (fallback when the log is damaged).
 * A journal with records on open means the last session did not end cleanly: it is replayed over the base, undo history included.
 */
export async function openProjectSession(engine: Engine, storage: ProjectStorage, opts: SessionOptions): Promise<OpenedSession> {
  let bytes = await storage.read(PROJECT_FILE);
  if (!bytes) {
    bytes = await engine.saveProject(opts.createProject());
    await storage.writeAtomic(PROJECT_FILE, bytes);
    opts.onFirstProject?.();
  }
  const base = baseId(bytes);
  const checkpointRaw = await storage.read(CHECKPOINT_FILE);
  const cp = checkpointRaw ? splitJournal(decode(checkpointRaw)) : null; // same "<header>\n<body>" layout
  const checkpoint = cp && cp.base === base ? cp.log : null;
  const journalRaw = await storage.read(JOURNAL_FILE);
  const journal = journalRaw ? splitJournal(decode(journalRaw)) : null;

  let opened: Awaited<ReturnType<Engine["openProject"]>> | null = null;
  let openError: unknown;
  try {
    opened = await engine.openProject(bytes);
  } catch (e) {
    openError = e;
  }
  const log = journal && journal.base === base ? journal.log : "";
  let project: Project;
  let recovered: RecoveryNote | null = null;
  let rec: Recovery | null = null;
  if (log.trim() !== "" || (!opened && checkpoint)) {
    // The last session left edits behind: rebuild from base + log (and the checkpoint when the log is damaged).
    rec = await engine.editing.recover(opened?.project ?? null, checkpoint, log);
    project = await engine.editing.project();
    if (rec.replayed > 0) recovered = { replayed: rec.replayed, dropped: rec.dropped, fullHistory: rec.fullHistory };
  } else {
    if (!opened) throw openError;
    project = opened.project;
    await engine.editing.open(project);
    if (journalRaw || checkpointRaw) await Promise.all([storage.remove(JOURNAL_FILE), storage.remove(CHECKPOINT_FILE)]); // stale: from before a completed clean save
  }
  const session = new ProjectSession(engine, storage, opts, bytes, opened?.project ?? null, opened?.readOnly ?? false);
  if (rec) {
    if (journal && journal.base === base) await session.adoptRecoveredLog(rec, decode(journalRaw!));
    else await Promise.all([storage.remove(JOURNAL_FILE)]); // recovered from a checkpoint alone: start a fresh journal on the next edit
  }
  return { session, project, recovered };
}

export class ProjectSession {
  private flushing: Promise<void> = Promise.resolve();
  private unwritten = "";
  private headerWritten = false;
  private needRepair = false;
  private sinceCheckpoint = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private edits = 0;
  private _status: SaveStatus = "saved";
  private _error: StorageError | undefined;
  /** Cost of the most recent journal append (ms) and how many there have been, for the performance notes in the docs. */
  readonly stats = { appends: 0, lastAppendMs: 0, maxAppendMs: 0 };
  readonly editing: Editing;

  constructor(
    private readonly engine: Engine,
    private readonly storage: ProjectStorage,
    private readonly opts: SessionOptions,
    private baseBytes: Uint8Array,
    private baseProject: Project | null,
    readonly readOnly: boolean,
  ) {
    const e = engine.editing;
    const after = async <T extends EditOutcome>(p: Promise<T>): Promise<T> => {
      if (this.closed) throw new Error("the project is closed");
      const out = await p;
      if (out.changed) {
        this.edits += 1;
        this.schedule();
      }
      return out;
    };
    this.editing = {
      ...e,
      apply: (ops: Op | Op[], coalesce?: number) => after(e.apply(ops, coalesce)),
      undo: () => after(e.undo()),
      redo: () => after(e.redo()),
    };
  }

  /** How many edits (including undo and redo) this session has made: automatic versions are taken only when it moved. */
  get editCount(): number {
    return this.edits;
  }

  /** The project as it is now, as `.overcut` bytes (a version snapshot, an export). Does not touch the saved base or the journal. */
  async snapshot(): Promise<Uint8Array> {
    return this.engine.saveProject(await this.engine.editing.project(), this.baseBytes);
  }

  get status(): SaveStatus {
    return this._status;
  }
  get error(): StorageError | undefined {
    return this._error;
  }

  private setStatus(s: SaveStatus, err?: StorageError) {
    this._status = s;
    this._error = err;
    this.opts.onStatus?.(s, err);
  }

  /** Called by the open path after a recovery: cuts the journal to header + the records that were restored (dropping a torn tail), so new appends follow whole lines. */
  async adoptRecoveredLog(rec: Recovery, journalText: string): Promise<void> {
    const nl = journalText.indexOf("\n") + 1;
    let end = nl;
    for (let i = 0, at = nl; i < rec.replayed; i++) {
      const next = journalText.indexOf("\n", at);
      end = next < 0 ? journalText.length : next + 1;
      at = end;
    }
    await this.storage.truncate(JOURNAL_FILE, encode(journalText.slice(0, end)).length);
    this.headerWritten = true;
    this.sinceCheckpoint = rec.replayed;
  }

  private schedule() {
    this.setStatus("saving");
    this.flushing = this.flushing.then(() => this.flushOnce());
  }

  private async flushOnce(): Promise<void> {
    try {
      this.unwritten += await this.engine.editing.takeLog();
      if (this.unwritten === "" && !this.needRepair) {
        if (this._status !== "saved") this.setStatus("saved");
        return;
      }
      const t0 = performance.now();
      const records = this.unwritten.split("\n").length - 1;
      if (this.needRepair) {
        // A failed append may have left a torn line: cut back to the last whole line before appending again.
        const cur = await this.storage.read(JOURNAL_FILE);
        const text = cur ? decode(cur) : "";
        await this.storage.truncate(JOURNAL_FILE, encode(text.slice(0, text.lastIndexOf("\n") + 1)).length);
        this.needRepair = false;
        this.headerWritten = text.indexOf("\n") >= 0;
      }
      try {
        // The journal is append-only: the header (which base the records belong to) goes out with the first records.
        const head = this.headerWritten ? "" : headerLine(baseId(this.baseBytes));
        await this.storage.append(JOURNAL_FILE, encode(head + this.unwritten));
        this.headerWritten = true;
      } catch (e) {
        this.needRepair = true;
        throw e;
      }
      this.unwritten = "";
      this.sinceCheckpoint += records;
      const ms = performance.now() - t0;
      this.stats.appends += 1;
      this.stats.lastAppendMs = ms;
      this.stats.maxAppendMs = Math.max(this.stats.maxAppendMs, ms);
      this.setStatus("saved");
      this.armCheckpoint();
    } catch (e) {
      // Nothing is dropped: the records stay in `unwritten` and go out with the next flush; the UI is told right now.
      this.setStatus("error", toStorageError(e));
      this.retryLater();
    }
  }

  private retryLater() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.schedule(), 2000);
  }

  private armCheckpoint() {
    const idle = this.opts.checkpointIdleMs ?? 3000;
    if (idle <= 0 || this.sinceCheckpoint === 0) return;
    clearTimeout(this.timer);
    if (this.sinceCheckpoint >= (this.opts.checkpointEvery ?? 500)) {
      void this.checkpoint().catch(() => undefined);
      return;
    }
    this.timer = setTimeout(() => void this.checkpoint().catch(() => undefined), idle);
  }

  /** Resolves once every edit made so far is in durable storage (or rejects with why it is not). This is what "acknowledged" means. */
  async whenDurable(): Promise<void> {
    let p: Promise<void>;
    do {
      p = this.flushing;
      await p;
    } while (p !== this.flushing);
    if (this._status === "error" && this._error) throw this._error;
  }

  /** Writes a full snapshot (atomic). Cheap fallback so recovery never depends on replaying a long log. */
  async checkpoint(): Promise<void> {
    if (this.closed || this.readOnly) return;
    await this.whenDurable();
    const cp = await this.engine.editing.checkpoint();
    await this.storage.writeAtomic(CHECKPOINT_FILE, encode(headerLine(baseId(this.baseBytes)) + cp));
    this.sinceCheckpoint = 0;
  }

  /** The user chose "Undo recovery": back to the last clean save. The discarded edits are kept in `discarded.jsonl`, never deleted silently. */
  async undoRecovery(): Promise<Project> {
    if (!this.baseProject) throw new Error("the project as last saved is not available");
    await this.whenDurable();
    const j = await this.storage.read(JOURNAL_FILE);
    if (j) await this.storage.writeAtomic(DISCARDED_FILE, j);
    await Promise.all([this.storage.remove(JOURNAL_FILE), this.storage.remove(CHECKPOINT_FILE)]);
    await this.engine.editing.open(this.baseProject);
    this.headerWritten = false;
    this.sinceCheckpoint = 0;
    this.unwritten = "";
    return this.baseProject;
  }

  /** Clean end of the session: the current state becomes the saved project, then the log and checkpoint are deleted (in that order: a crash in between leaves a stale log that the next open recognises and discards). */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.whenDurable().catch(() => undefined);
    clearTimeout(this.timer);
    this.closed = true;
    if (this.readOnly) return;
    if (this.unwritten !== "") throw this._error ?? new StorageError("io", "Some changes could not be saved.");
    const bytes = await this.engine.saveProject(await this.engine.editing.project(), this.baseBytes);
    await this.storage.writeAtomic(PROJECT_FILE, bytes);
    this.baseBytes = bytes;
    await Promise.all([this.storage.remove(JOURNAL_FILE), this.storage.remove(CHECKPOINT_FILE)]);
  }
}
