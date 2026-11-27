/** Which copy the New / Open confirm shows: with a persistence session a copy of the current project is kept in Versions first; without storage nothing is kept. */
export function confirmBodyKey(what: "new" | "open", hasSession: boolean): string {
  return hasSession ? `project.${what}.body` : `project.${what}.bodyUnsaved`;
}

/** How long an info toast stays: 3 s, a little longer for long text, at most 5 s (the range the UX checklist asks for). Toasts with an action (Undo) use `ACTION_TOAST_MS`; failures do not time out at all (`failure-note`). */
export function toastDuration(text: string): number {
  return Math.min(5000, 3000 + Math.max(0, text.length - 30) * 25);
}
export const ACTION_TOAST_MS = 5000;
