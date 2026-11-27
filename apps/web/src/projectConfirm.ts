/** Which copy the New / Open confirm shows: with a persistence session a copy of the current project is kept in Versions first; without storage nothing is kept. */
export function confirmBodyKey(what: "new" | "open", hasSession: boolean): string {
  return hasSession ? `project.${what}.body` : `project.${what}.bodyUnsaved`;
}

/** How long an info toast stays: 3 s, a little longer for long text, at most 5 s (a11y r12: was 2.5 to 4 s). Toasts with an action (Undo) use `ACTION_TOAST_MS`; failures stay until dismissed (App.tsx). */
export function toastDuration(text: string): number {
  return Math.min(5000, 3000 + Math.max(0, text.length - 30) * 25);
}
export const ACTION_TOAST_MS = 5000;
