import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Modal } from "../ProjectDialogs";
import { formatDuration, iconForKind } from "./plan";
import type { BinItem } from "./useMediaBin";

/**
 * "Add as overlay": the bin's pictures and videos as a thumbnail grid. The person chooses what goes on the new track above; nothing is ever picked
 * for them (UX r15, DESK-5 / PHONE-4). Sound has no picture to lay over another, so it is not offered.
 */
export function OverlayPicker({ items, onPick, onClose }: { items: readonly BinItem[]; onPick(id: string): void; onClose(): void }) {
  const { t } = useI18n();
  const choices = items.filter((i) => i.status === "ready" && i.kind !== "audio");
  return (
    <Modal title={t("overlay.title")} titleId="overlay-title" testId="overlay-picker" onClose={onClose}>
      <p className="export-note">{t("overlay.hint")}</p>
      {choices.length === 0 ? <p className="export-note" data-testid="overlay-none">{t("overlay.none")}</p> : (
        <ul className="overlay-grid" aria-label={t("overlay.title")}>
          {choices.map((i) => (
            <li key={i.id}>
              <button className="overlay-tile" onClick={() => onPick(i.id)} aria-label={t("overlay.use", { name: i.name })} data-testid="overlay-choice">
                <span className="overlay-thumb" aria-hidden="true">
                  {i.poster ? <img src={i.poster} alt="" draggable={false} /> : <Icon name={iconForKind(i.kind)} size={22} />}
                  {i.kind !== "image" && <span className="bin-dur">{formatDuration(i.durationTicks)}</span>}
                </span>
                <span className="overlay-name">{i.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
