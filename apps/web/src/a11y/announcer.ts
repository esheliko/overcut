/** Live-region announcer: `announce("Saved")` is read by screen readers without moving focus. */
export type Priority = "polite" | "assertive";
export type Region = { setText: (text: string) => void };

export type Announcer = {
  announce: (message: string, priority?: Priority) => void;
  clear: () => void;
};

/**
 * Core logic over abstract regions (testable without a DOM). The region is cleared first and filled on the next
 * tick, and a repeated identical message alternates a trailing no-break space, so assistive tech re-announces it.
 */
export function createAnnouncer(regions: Record<Priority, Region>, defer: (fn: () => void) => void = (fn) => void setTimeout(fn, 50)): Announcer {
  const flip: Record<Priority, boolean> = { polite: false, assertive: false };
  const last: Record<Priority, string> = { polite: "", assertive: "" };
  return {
    announce(message, priority = "polite") {
      if (!message.trim()) return;
      const region = regions[priority];
      const again = message === last[priority];
      last[priority] = message;
      flip[priority] = again ? !flip[priority] : false;
      region.setText("");
      defer(() => region.setText(flip[priority] ? `${message}\u00a0` : message));
    },
    clear() {
      regions.polite.setText("");
      regions.assertive.setText("");
      last.polite = last.assertive = "";
    },
  };
}

/** Mount two visually hidden live regions on `doc.body` and return an announcer bound to them. */
export function mountAnnouncer(doc: Document = document): Announcer {
  const make = (priority: Priority): Region => {
    const el = doc.createElement("div");
    el.className = "visually-hidden";
    el.setAttribute("role", priority === "assertive" ? "alert" : "status");
    el.setAttribute("aria-live", priority);
    el.setAttribute("aria-atomic", "true");
    el.dataset.announcer = priority;
    doc.body.appendChild(el);
    return { setText: (text) => { el.textContent = text; } };
  };
  return createAnnouncer({ polite: make("polite"), assertive: make("assertive") });
}

let shared: Announcer | null = null;
/** The app-wide announcer, mounted on first use. */
export function announce(message: string, priority?: Priority): void {
  shared ??= mountAnnouncer();
  shared.announce(message, priority);
}
