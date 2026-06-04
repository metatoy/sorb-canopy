# CLAUDE.md — sorb-canopy

Part of the **Sorb** polyrepo under the **Metatoy** org (local base
`workspace/metatoy/`). Siblings: `sorb-core`, `sorb-seed`, `sorb-leaf`,
`sorb-juice`, `sorb-demo`, `sorb-cloud`.

## What this is

`@sorb/canopy` — the **Figma plugin**. Previews proposed design tokens in
your app via the `sorb-juice` bridge, and inserts captured geometry with bound
Figma Variables. The canopy = your app's foliage seen in Figma (the design-side
view; `sorb-leaf` is the dev-side view). Open repo, but **not an npm package** —
Figma loads `code.js` + `ui.html` directly (`private: true` is just an npm guard).

## Hard rules

- **JavaScript only — never TypeScript.** No build step.
- **Figma plugin sandbox:** `catch (e)` never `catch {}`; avoid object spread in
  `code.js`; `figma.*` only on the main thread, never in the UI iframe.
- The displayed plugin **name is "Sorb"** (manifest) — a working wordmark. The
  *final* product wordmark (Sorblink vs Sorb) is **counsel-gated** before public
  store listing (`sorb-branding.md` §7); update the manifest name then. Keep the
  Figma plugin **`id` unchanged** — it's the registered plugin identity.
- **Commit/push only when asked.** If on the default branch, branch first.
