# Today Capture Animation Plan

## Goal

Make `/today` the stable parent surface for home, full-check capture, and single-issue capture so cards do not drift between separately rendered views. Start and Done should feel like portions of one screen moving, not navigation between different screens.

## Architecture

- Keep `/today` as the ordinary user flow location.
- Treat capture as an embedded region inside `<today-view>`.
- Keep `/check` and `/problem` available as compatibility routes, but do not use them from the home primary buttons.
- Render completed problem cards from backend-backed task/card data.
- Render local session data only for transient upload/analyzing/no-problem placeholders.
- Use one shared analysis card renderer for new and older cards. Card age/status only changes tone and placement.

## View Regions

`<today-view>` owns four persistent regions:

- Home header region: site title, settings/comment controls, summary, and primary buttons.
- Capture region: embedded full-check or single-issue capture flow.
- New results region: backend cards under three hours old, plus pending local placeholders.
- Older results region: backend cards over three hours old or no longer in the new state, with status filter.

## Modes

Use mode classes on the root home element:

- `home--view`
- `home--entering-capture`
- `home--capture`
- `home--leaving-capture`

Use a separate capture flow flag for `perimeter` vs `single-problem`.

## Start Animation

When the user taps `Start a full check` or `Flag a single issue`:

1. Prepare the requested capture session.
2. Keep existing results mounted during the transition.
3. Fade the header region out.
4. Slide visible cards down.
5. Hide the card stack after the slide if there are no new cards to keep visible.
6. Mount the capture component.
7. Slide capture in from above.
8. Set mode to `home--capture`.

## Done Animation

When embedded capture dispatches completion:

1. Keep capture mounted for the exit animation.
2. Refresh backend-backed task/card data.
3. Slide capture upward and fade it.
4. Reveal new cards and older cards in their correct buckets.
5. Slide cards upward into the home position.
6. Fade the header region back in.
7. Unmount capture after the transition finishes.

## Card Buckets

- `pending`: local session upload/analyzing placeholders only.
- `new`: backend task cards less than three hours old.
- `older`: backend task cards older than three hours or moved out of new status.
- `in_progress`, `resolved`, `archived`: filtered older/task states.

The divider appears only between new and older sections.

## Motion Rules

- Prefer CSS transitions on `opacity` and `transform`.
- JS only toggles mode classes and waits for the transition duration.
- Honor `prefers-reduced-motion` by reducing transition duration to near-zero.
- Avoid layout-shifting animation of dimensions; regions remain mounted during motion and then hide with `display` only after state settles.

## Implementation Steps

1. Add the plan document.
2. Update `<today-view>` to keep a stable shell and track capture mode internally.
3. Embed `<perimeter-check embedded>` and `<problem-report embedded>` from the same capture region.
4. Change Start buttons to transition into embedded capture instead of navigating.
5. Change embedded capture completion to dispatch events consumed by `<today-view>`.
6. Add CSS mode transitions for header, capture, and result stacks.
7. Keep completed cards backend-backed and shared through `analysis-results.templates.js`.
8. Verify with focused tests, typecheck, and format check.
