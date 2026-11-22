/** @jsxRuntime automatic */
import type { ElementType, ReactNode } from "react";

/** Text for assistive tech only (labels for icon buttons, extra context). Styled by `.visually-hidden` in styles.css. */
export function VisuallyHidden({ children, as: Tag = "span" }: { children: ReactNode; as?: ElementType }) {
  return <Tag className="visually-hidden">{children}</Tag>;
}
