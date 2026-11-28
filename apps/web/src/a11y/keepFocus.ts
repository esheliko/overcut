/**
 * Focus survives its own button going away. A button that the action it just ran turns off (Delete once nothing is selected, Redo at the end of the
 * history, a field's Reset at its default) takes keyboard focus with it: the browser drops focus on <body> and a keyboard or screen-reader user starts again
 * from the top. This hands focus to the nearest sensible control instead (WCAG 2.4.3 Focus Order; an a11y r12 finding).
 *
 * Only acts when ALL of these hold: the control that had focus is now disabled or gone, focus is on <body>, and the user pressed a key or clicked less
 * than a second ago (so it never steals focus from somebody who moved on). The target: the timeline canvas for the timeline toolbar; otherwise the
 * next enabled control of the same group (`toolbar`, a field row, a form, a dialog or a panel).
 */
const GROUPS = '[data-testid="tl-bar"], .insp-field, .insp-row, [role="toolbar"], [role="group"], form, dialog, section';
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

export function fallbackFor(lost: HTMLElement | null, group: HTMLElement | null): HTMLElement | null {
  if (!group || !group.isConnected) return null;
  if (group.matches('[data-testid="tl-bar"]')) return group.closest("section")?.querySelector<HTMLElement>('[data-testid="timeline-canvas"]') ?? null;
  const all = [...group.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e !== lost && e.getClientRects().length > 0);
  if (all.length === 0) return null;
  // the control that follows where the lost one was, else the one before it
  if (lost && lost.isConnected) return all.find((e) => lost.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) ?? all[all.length - 1]!;
  return all[0]!;
}

export function installKeepFocus(doc: Document = document): () => void {
  let last: HTMLElement | null = null;
  let group: HTMLElement | null = null;
  let actedAt = -Infinity;
  const now = () => performance.now();
  const onIn = (e: FocusEvent) => {
    last = e.target instanceof HTMLElement ? e.target : null;
    group = last?.closest<HTMLElement>('[data-testid="tl-bar"]') ?? last?.closest<HTMLElement>(GROUPS) ?? null; // anything in the timeline toolbar hands over to the canvas, the place the user works next
  };
  const acted = () => { actedAt = now(); };
  let queued = false;
  const check = () => {
    queued = false;
    if (!last || now() - actedAt > 1000) return;
    const gone = !last.isConnected || (last as HTMLButtonElement).disabled === true;
    if (!gone || (doc.activeElement && doc.activeElement !== doc.body)) return;
    const target = fallbackFor(last, group);
    if (target) { target.focus({ preventScroll: true }); last = target; }
  };
  const mo = new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(check); } });
  mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
  doc.addEventListener("focusin", onIn, true);
  doc.addEventListener("keydown", acted, true);
  doc.addEventListener("click", acted, true);
  return () => { mo.disconnect(); doc.removeEventListener("focusin", onIn, true); doc.removeEventListener("keydown", acted, true); doc.removeEventListener("click", acted, true); };
}
