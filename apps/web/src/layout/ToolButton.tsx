import { useId, type MouseEvent } from "react";
import { Icon, type IconName } from "../icons";

type Props = {
  icon: IconName;
  /** The accessible name and the tooltip's title. */
  label: string;
  /** The shortcut, shown as a keycap in the tooltip. */
  keys?: string;
  /** Why it cannot run now: the button stays in place, really disabled, and the tooltip says why. */
  reason?: string;
  disabled?: boolean;
  pressed?: boolean;
  /** A visible text under (strip) or beside the icon; the toolbar's icons carry none. */
  text?: string;
  size?: number;
  className?: string;
  testid?: string;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  /** For menu buttons. */
  menu?: { open: boolean };
  /** The tool-switch buttons mark their tool here. */
  dataTool?: string;
};

/** One toolbar button with a tooltip (name, shortcut keycap, or the reason it is unavailable). The tooltip sits on the wrapper, so a disabled button still shows why.
 *  Hover and keyboard focus show it (desktop only; a touch screen has no hover and the strip shows labels instead). */
export function ToolButton({ icon, label, keys, reason, disabled, pressed, text, size = 20, className, testid, onClick, menu, dataTool }: Props) {
  const why = useId();
  return (
    <span className="tb">
      <button type="button" className={className ? `icon-btn tb-btn ${className}` : "icon-btn tb-btn"} aria-label={label} aria-pressed={pressed} aria-haspopup={menu ? "menu" : undefined} aria-expanded={menu ? menu.open : undefined}
        aria-describedby={disabled && reason ? why : undefined} disabled={disabled} data-testid={testid} data-tool={dataTool} onClick={onClick}>
        <Icon name={icon} size={size} />
        {menu && <Icon name="chevronDown" size={12} className="tb-caret" />}
        {text && <span className="tb-text">{text}</span>}
      </button>
      <span className="tb-tip" aria-hidden="true">{disabled && reason ? <>{label}<small>{reason}</small></> : <>{label}{keys && <kbd>{keys}</kbd>}</>}</span>
      {disabled && reason && <span id={why} className="sr-only">{reason}</span>}
    </span>
  );
}
