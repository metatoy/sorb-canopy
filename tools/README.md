# sorb-canopy · HID visual-QA harness

`hid-visual-qa.sh` — a standalone, dependency-free harness for **headless-style
visual QA of the Sorb Figma plugin** (sorb-canopy). Plugin-UX **U2, workstream 0**.

It drives the running plugin with synthetic mouse clicks and captures the plugin
window as PNG region screenshots, so a run produces a reproducible set of state
screenshots (`intro`, `tokens-working`, `tab-components`, `tab-settings`,
`help-reopen`) that verify the U2 checkpoint:

> **fresh install → account-first intro (Sign in to connect + Advanced setup) → sign-in→poll → token view.**

## Why HID clicks instead of Accessibility / UI scripting

The plugin UI (`ui.html`) renders inside a **Chromium webview** hosted by Figma
desktop. That webview is **opaque to macOS Accessibility** — AX queries against
it *hang*, so we cannot find or drive elements by role/label, and normal
AppleScript "UI scripting" is out.

So this harness uses low-level **HID** instead:

- **Clicks** are posted with `CGEventPost` (via a small self-contained `python3`
  block using `ctypes` + `ApplicationServices` — no pip/brew). Clicks reach the
  webview fine.
- **Screenshots** use the built-in `screencapture -R<x,y,w,h>` to grab exactly
  the plugin window region.

Reference: project memory `figma-plugin-ax-opaque-hid-clicks` (complements
`radius-binding-test-resume`).

> **Keyboard caveat:** synthetic keystrokes only reach the plugin *document* when
> a **native Figma surface** has focus, not the webview. This harness therefore
> uses **mouse events only** — no synthetic typing.

## Requirements

- **macOS only** (needs `CGEventPost` + `screencapture`).
- **Figma desktop** with the Sorb plugin imported and running.
- The terminal app that runs the script must be granted, in
  **System Settings → Privacy & Security**:
  - **Screen Recording** (else screenshots come back black), and
  - **Accessibility** (else `CGEventPost` clicks are silently dropped).
- No brew, no pip. Uses system `bash`, `python3`, `screencapture`. ImageMagick is
  **optional** and only used by `diff` (skipped gracefully if absent).

## Import the plugin into Figma (one time)

1. Open **Figma desktop**.
2. Menu: **Plugins → Development → Import plugin from manifest…**
3. Select `sorb-canopy/manifest.json`.
4. Run it via **Plugins → Development → Sorb**. The window opens at a fixed
   **475×560** logical points (set by `figma.showUI(..., { width: 475, height: 560 })`
   in `code.js`).

## One-time calibration: the window origin

The only value you must set per machine / per window position is the plugin
window's **content top-left corner** in absolute screen points (`WIN_X`, `WIN_Y`).

1. With the plugin window visible, run:

   ```sh
   ./hid-visual-qa.sh find
   ```

   This writes `./.qa-screens/_find-fullscreen.png`.

2. Open that PNG in **Preview**. Read the pixel coordinate of the **top-left
   corner of the plugin content area** (just below its title bar). Preview shows
   the cursor coordinate in the toolbar / Tools → Show Inspector, or ⌘-drag a
   selection to read its origin.

3. Divide those pixels by `DISPLAY_SCALE` to get **points** (on a 1:1 display,
   scale = 1, so pixels == points). Set them either by editing the **CONFIG
   block** at the top of the script, or via env:

   ```sh
   SORB_QA_WIN_X=912 SORB_QA_WIN_Y=318 ./hid-visual-qa.sh capture
   ```

   Sanity check: the plugin content is exactly **475×560** points, so the
   bottom-right corner should land at `(WIN_X+475, WIN_Y+560)`.

Reference setup in the source config: a **2560×1440 display at 1:1** (scale = 1).
On a HiDPI/Retina display set `SORB_QA_SCALE=2`.

## Run sequence

```sh
cd sorb-canopy/tools
chmod +x hid-visual-qa.sh          # already executable in the repo

# 1. Import + run the plugin in Figma (see above), leave the window open.
# 2. Calibrate the origin once:
./hid-visual-qa.sh find            # → read WIN_X/WIN_Y off .qa-screens/_find-fullscreen.png
# 3. Capture the full U2 state set:
SORB_QA_WIN_X=<x> SORB_QA_WIN_Y=<y> ./hid-visual-qa.sh capture
# → .qa-screens/{intro,intro-connect-click,tokens-working,tab-components,tab-settings,help-reopen}.png
```

### Other subcommands

```sh
./hid-visual-qa.sh shot my-state          # capture just the window region
./hid-visual-qa.sh click 237 330          # click at window-relative point (x,y)
./hid-visual-qa.sh diff a.png b.png out.png  # optional ImageMagick diff
./hid-visual-qa.sh help                   # usage + current config
```

## Approximate click targets (adjust after first run)

The click coordinates in the `capture` sequence are **approximate**, derived from
the 475×560 **Direction A** layout, **not** measured against a running build:

| Target | Window-relative point | Notes |
|---|---|---|
| `?` help / reopen intro | (455, 20) | top-right of the ~40px header |
| "Sign in to connect" card | (237, 248) | primary account card (opens browser → poll); re-calibrate via `shot intro` |
| Tokens tab | (45, 95) | tabs row below the status bar, left-aligned |
| Components tab | (140, 95) | ~90px spacing |
| Settings tab | (245, 95) | |

If a shot lands on the wrong control, recalibrate `WIN_X`/`WIN_Y` first, then
nudge the `*_X`/`*_Y` variables near the top of the script.

## Scope / safety

- This directory is **tooling only**. It does not touch `ui.html`, `code.js`, or
  `manifest.json`, and adds no runtime dependency to the plugin.
- `.qa-screens/` output is disposable; it is not intended to be committed.
- Errors are explicit (missing permissions, failed `screencapture`, bad coords);
  the only intentional soft-fail is `diff` when ImageMagick is absent.
