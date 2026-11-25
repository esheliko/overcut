/** Call before a dialog opens: returns a function that puts keyboard focus back on the element that had it (the button that opened the dialog).
 *  The native `dialog.close()` does this itself, but React runs the cleanup after the dialog is already out of the page, so it never happens. */
export function rememberFocus(): () => void {
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return () => { if (el && el.isConnected && el !== document.body) el.focus({ preventScroll: true }); };
}
