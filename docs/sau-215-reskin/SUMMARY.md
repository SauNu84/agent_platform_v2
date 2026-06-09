# SAU-215 — Re-skin POC to the ToughTongue visual system

**Parent:** SAU-214 · **Type:** P1 visual-system pass (no IA or behavior change)

## What changed

Token-driven re-skin of `app/src/app/globals.css` from the dark theme to the
ToughTongue visual system. All chrome restyles from `:root` alone — class names,
routes, and data are unchanged.

| Aspect      | Before (dark)                  | After (ToughTongue)                                  |
|-------------|--------------------------------|------------------------------------------------------|
| Surface     | `#0b0d12` dark                 | `#ffffff` light + **dotted-grid** canvas             |
| Type        | sans-serif everywhere          | **monospace** headings / nav / prompts; sans body    |
| Accent      | blue `#5b8cff`                 | **cyan** `#06b6d4`                                   |
| Borders     | dark `#262c38`                 | subtle hairline `#e6e8ec`                            |
| Badges      | uniform gray                   | **category palette**: Sales=orange, Productivity=blue, Training=green, Hiring=purple |

The only non-CSS change: `library/page.tsx` adds a presentation-only
`categoryClass()` helper that maps the existing `role` facet to a palette class
(known category names map directly; other facets get a stable palette colour).
No data or routing change.

## Acceptance — all met

- **Typecheck:** clean (`tsc --noEmit`)
- **Lint:** clean (`next lint` — no warnings/errors)
- **Tests:** 51/51 pass (unchanged — tests are domain/compiler logic, CSS-independent)
- **Prod build:** green (`next build` compiled successfully, 9/9 pages)
- **Live smoke:** all 11 routes return 200 (zero-infra dev / in-memory seed)
- **Visual diff:** see `screens/` — light / monospace / cyan / dotted-grid feel matches the reference

## Screenshots

`screens/before-*.png` (dark) vs `screens/after-*.png` (ToughTongue) for
`home`, `library`, `scenario-detail`, `courses`.

Reproduce: `node docs/sau-215-reskin/shot.mjs` (helper uses headless Chrome /
Playwright against a local `npm run dev` on port 3210).
