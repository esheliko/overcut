/** Which copy the New / Open confirm shows: with a persistence session a copy of the current project is kept in Versions first; without storage nothing is kept. */
export function confirmBodyKey(what: "new" | "open", hasSession: boolean): string {
  return hasSession ? `project.${what}.body` : `project.${what}.bodyUnsaved`;
}

/** How long an info toast stays: about 2.5 s, a little longer for long text, at most 4 s. Toasts with an action (Undo) use `ACTION_TOAST_MS`. */
export function toastDuration(text: string): number {
  return Math.min(4000, 2500 + Math.max(0, text.length - 30) * 25);
}
export const ACTION_TOAST_MS = 5000;
