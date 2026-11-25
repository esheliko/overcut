import { useEffect, useState } from "react";

/**
 * Focus goes back to the control that opened a dialog when the dialog closes (Esc, its close button, or a finished action).
 * The opener is read at mount, before the dialog takes focus. If it has left the page meanwhile, focus stays where the browser puts it.
 */
export function useReturnFocus(): void {
  const [opener] = useState<HTMLElement | null>(() => {
    const a = typeof document === "undefined" ? null : document.activeElement;
    return a instanceof HTMLElement && a !== document.body ? a : null;
  });
  useEffect(() => () => {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [opener]);
}
