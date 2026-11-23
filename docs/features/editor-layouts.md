# Editor layouts (M1-030, UX-01)

One component set, five deliberate arrangements. The shell (`.editor`) is a CSS **size container**; `styles.css` re-arranges `.workspace` with `@container editor (...)`, so the layout follows the space the app really has (split view, foldable, embedded), not the window. `src/layout/profiles.ts` holds the same breakpoints and `profileFor(w, h)`; `useShellProfile` observes the shell and sets `data-profile` on `.editor` (used by React for what CSS cannot do: docked vs sheet tool panel, details column, compact top bar).

## Profiles
| Profile | Shell size | Arrangement |
|---|---|---|
| phone-portrait | < 720 px wide | preview / timeline / tool bar (bottom); tool panel is a bottom sheet; details via the Edit tool |
| phone-landscape | landscape, height <= 500, width <= 1000 | slim tool rail (left) \| preview over timeline; tool panel is a side drawer over the preview; compact top bar and lanes |
| tablet | 720-1099 wide | rail \| docked tool panel \| preview, timeline full width below; portrait gives the preview more height and a narrower panel |
| desktop | >= 1100 wide | rail \| tool panel \| preview \| details, timeline full width below |
| ultrawide | >= 1900 wide and >= 2:1 | desktop plus wider side panels (360 / 380) and a taller timeline |

The preview transport bar stacks (time + ratio over controls) when the preview itself is narrower than 640 px (`@container stage`), whatever the profile.

## Rules
- No horizontal page scroll from 320 px up; touch targets >= 44 px (tool bar and rail buttons, transport); safe-area insets on the shell, the landscape drawer, sheets and toasts; no hover-only controls.
- Profile is derived from the shell size, never from the user agent.
- The landscape threshold (height <= 500, width <= 1000) keeps a short desktop window (e.g. 1280x480) a desktop layout.

## Edge cases
- Resizing across a profile boundary keeps UI state (tool, zoom); only the arrangement changes. A sheet left open on a phone is simply docked on a tablet.
- 667x375 phones (below 720 wide) are landscape, not portrait.
- Foldables: unfolded inner screens land in tablet/desktop; folding re-runs the observer.
- Gaps: no dual-screen hinge-aware layout (see issue backlog), no user-resizable panels yet.

## Test plan
- `tests/unit/layout-profiles.test.ts`: `profileFor` for common devices and every breakpoint edge; CSS container queries match `BREAKPOINTS`; the grid is only re-arranged in container queries; safe-area insets present.
- `tests/smoke/smoke.spec.ts` ("layout profile ..."): seven viewports (320x568, 390x844, 844x390, 820x1180, 1024x768, 1280x800, 3440x1440): `data-profile`, preview / timeline / tools inside the viewport and not overlapping, inspector only >= desktop, docked panel vs sheet, landscape drawer, tool buttons >= 44 px, no horizontal overflow.
- Visual: `node scripts/shot.mjs "/" --w <w> --h <h>` per profile (screenshots in the PR).
