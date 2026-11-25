/** Command palette logic (M2-041): which commands the palette offers and in what order. Pure; the dialog is `Palette.tsx`. */
import { COMMANDS, type CommandDef } from "./registry";

/** The event the palette sends: `detail` is a `Command`. The timeline canvas listens and runs it (it forwards what it cannot do itself). */
export const COMMAND_EVENT = "overcut:command";
/** Asks the app to open the palette (the `palette` command, Ctrl/Cmd+K). */
export const PALETTE_EVENT = "overcut:palette";

export const RECENT_MAX = 8;

/** What the palette lists: every command except the player's own keys (the preview panel owns those) and the palette itself. */
export const PALETTE_COMMANDS: readonly CommandDef[] = COMMANDS.filter((d) => d.context !== "transport" && d.command.c !== "palette");

/** Words typed so far must ALL appear (any order, any case) in the label. */
const matches = (label: string, q: string): boolean => {
  const l = label.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => l.includes(w));
};

/** Commands matching `query`, best first. Empty query: recently used first (most recent first), then the rest in registry order.
 *  With a query: labels that start with it, then the other matches; recent ones lead inside each group. */
export function searchCommands(query: string, label: (id: string) => string, recent: readonly string[], all: readonly CommandDef[] = PALETTE_COMMANDS): CommandDef[] {
  const q = query.trim();
  const rank = (d: CommandDef) => { const i = recent.indexOf(d.id); return i < 0 ? recent.length : i; };
  const base = all.map((d, order) => ({ d, order, name: label(d.id) })).filter((x) => matches(x.name, q));
  const starts = (x: { name: string }) => (q && x.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1);
  base.sort((a, b) => (q ? starts(a) - starts(b) : 0) || rank(a.d) - rank(b.d) || a.order - b.order);
  return base.map((x) => x.d);
}

/** Recents after running `id`: it moves to the front, no duplicates, capped. */
export const pushRecent = (recent: readonly string[], id: string): string[] => [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);

const KEY = "overcut.palette.recent";
export function loadRecent(): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : []; } catch { return []; }
}
export function saveRecent(recent: readonly string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(recent)); } catch { /* storage unavailable: recents just do not persist */ }
}
