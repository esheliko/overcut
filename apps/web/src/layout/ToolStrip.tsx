import { useMemo } from "react";
import { COMMAND_EVENT } from "../commands/palette";
import type { Command } from "../commands/registry";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { speedTarget } from "../inspector/speedModel";
import { useProjectStore, useStore } from "../store/projectStore";
import { requestDetails, stripTools, type StripId } from "./toolStrip";

type Props = {
  /** The Media tool's sheet is open. */
  mediaOpen: boolean;
  /** The Edit (Details) sheet is open. */
  editOpen: boolean;
  /** Which Details tab the open sheet shows, so the button that opened it is the one highlighted (Edit, Speed or Crop). */
  editTab?: "video" | "speed" | "crop";
  onMedia(): void;
  onEdit(): void;
  onCanvas(): void;
  /** Whether "add as overlay" can run (a project is open). */
  canOverlay: boolean;
};

const send = (c: Command) => window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: c }));

/** The phone's bottom tool strip, CapCut style: icon above label, scrolls sideways, every target 44 px or more. With nothing selected it holds the global tools;
 *  with a clip selected it switches to that clip's tools and the first one steps back out (clears the selection). */
export function ToolStrip({ mediaOpen, editOpen, editTab = "video", onMedia, onEdit, onCanvas, canOverlay }: Props) {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const linked = useMemo(() => {
    const seq = project?.sequences[0];
    return !!seq && seq.tracks.some((tr) => tr.clips.some((c) => selection.has(c.id) && c.link));
  }, [project, selection]);
  const tools = stripTools({ count: selection.size, linked, overlay: canOverlay });
  const still = selection.size > 0 && (speedTarget(project, selection)?.still ?? false);
  const act: Record<StripId, () => void> = {
    media: onMedia,
    // Edit always opens the Video tab (never whatever Speed or Crop left behind); tapping it again closes the sheet.
    edit: () => { if (editOpen && editTab === "video") onEdit(); else requestDetails({ tab: "video" }); },
    canvas: onCanvas,
    overlay: () => send({ c: "addMedia", overlay: true }),
    split: () => send({ c: "split" }),
    back: () => store.setSelection(new Set()),
    speed: () => requestDetails({ tab: "speed" }),
    crop: () => requestDetails({ tab: "video", focus: "crop" }),
    duplicate: () => send({ c: "duplicate" }),
    delete: () => send({ c: "delete" }),
    detach: () => send({ c: "unlink" }),
    keyframe: () => send({ c: "keyframe" }),
  };
  return (
    <nav className="tools tool-strip" aria-label={t("tools.nav")} data-mode={selection.size > 0 ? "clip" : "global"} data-testid="tool-strip">
      {tools.map((x) => (
        <button key={x.id} className={x.iconOnly ? "tool tool-back" : "tool"} data-testid={`strip-${x.id}`}
          aria-pressed={x.id === "media" ? mediaOpen : x.id === "edit" ? editOpen && editTab === "video" : x.id === "speed" ? editOpen && editTab === "speed" : x.id === "crop" ? editOpen && editTab === "crop" : undefined}
          disabled={x.id === "speed" && still} aria-label={x.short || x.iconOnly ? t(x.label) : undefined} title={x.iconOnly ? t(x.label) : undefined} onClick={act[x.id]}>
          <Icon name={x.icon} size={24} />
          {!x.iconOnly && <span>{t(x.short ?? x.label)}</span>}
        </button>
      ))}
    </nav>
  );
}
