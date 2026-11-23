/** Install affordance (PM-12): an "Install app" menu item where the browser offers one (`beforeinstallprompt`), and a how-to for iOS Safari
 *  (no prompt API there). Nothing is shown unasked, nothing touches the network. Rules: docs/features/privacy-network.md. */
import { useSyncExternalStore } from "react";

/** The event Chromium fires when the app is installable (not in the DOM lib typings). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallKind = "prompt" | "ios" | null;

export interface InstallEnv { hasPrompt: boolean; standalone: boolean; ios: boolean; desktopApp: boolean }

/** What the menu offers: the native prompt when the browser gave one, the iOS how-to on iPhone/iPad browsers, nothing when already installed or inside the desktop app. */
export function installKind(e: InstallEnv): InstallKind {
  if (e.standalone || e.desktopApp) return null;
  if (e.hasPrompt) return "prompt";
  return e.ios ? "ios" : null;
}

/** iPhone, iPad and iPadOS (which reports as a Mac with a touch screen). */
export function isIos(ua: string, platform: string, touchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && touchPoints > 1);
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Start listening (call once at startup). Keeps the event so the menu can use it later; prevents the browser's own mini-bar so nothing nags. */
export function watchInstallPrompt(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; emit(); });
  target.addEventListener("appinstalled", () => { deferred = null; emit(); });
}

function standalone(): boolean {
  try { return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true; } catch { return false; }
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const snapshot = () => deferred;

/** Reactive: what to offer now, plus `prompt()` to run the browser's install dialog. `desktopApp` = running inside the Tauri shell. */
export function useInstall(desktopApp: boolean): { kind: InstallKind; prompt(): Promise<boolean> } {
  const ev = useSyncExternalStore(subscribe, snapshot, () => null);
  const kind = installKind({ hasPrompt: ev !== null, standalone: standalone(), ios: isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints), desktopApp });
  return {
    kind,
    async prompt() {
      const e = deferred;
      if (!e) return false;
      deferred = null; // an event can be used once
      emit();
      await e.prompt();
      return (await e.userChoice).outcome === "accepted";
    },
  };
}
