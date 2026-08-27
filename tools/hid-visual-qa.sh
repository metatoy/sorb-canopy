#!/usr/bin/env bash
#
# hid-visual-qa.sh — Standalone HID visual-QA harness for the Sorb Figma plugin (sorb-canopy).
#
# Plugin-UX U2, workstream 0.
#
# WHY HID (and not Accessibility / AppleScript UI scripting):
#   The sorb-canopy plugin UI is a Chromium webview rendered inside Figma desktop.
#   That webview is OPAQUE to macOS Accessibility — AX queries against it HANG.
#   So this harness cannot inspect or drive elements by role/label. Instead it:
#     * drives the plugin with SYNTHETIC HID mouse clicks via CGEventPost, and
#     * captures results with `screencapture -R<region>` region screenshots.
#   Reference technique: project memory `figma-plugin-ax-opaque-hid-clicks`
#   (complements `radius-binding-test-resume`).
#
#   Keyboard input only reaches the plugin document when a NATIVE Figma surface
#   has focus; mouse clicks reach the webview fine. This harness therefore only
#   uses mouse events — no synthetic typing.
#
# macOS ONLY. Requires, granted to the TERMINAL APP running this script:
#   * Screen Recording   (System Settings → Privacy & Security → Screen Recording)
#   * Accessibility      (System Settings → Privacy & Security → Accessibility)
# Without both, screenshots come back black and/or CGEventPost clicks are dropped.
#
# Dependency-free: bash + python3 (system, uses ctypes + ApplicationServices) +
# the built-in `screencapture`. No brew, no pip. ImageMagick is OPTIONAL (diff only).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# CONFIG BLOCK — calibrate these once, then reuse.
# ---------------------------------------------------------------------------
#
# WIN_X / WIN_Y = the ABSOLUTE screen coordinates (in points, top-left origin)
# of the TOP-LEFT corner of the plugin window's *content* area (the webview),
# NOT the Figma app window. This is the one value you must calibrate per machine
# / per plugin position.
#
# HOW TO CALIBRATE (one-time, founder eyeballs it):
#   1. Open Figma desktop, run the Sorb plugin so its 475×560 window is visible.
#   2. Run:  ./hid-visual-qa.sh find
#      That writes a full-screen screenshot to $OUTDIR/_find-fullscreen.png.
#   3. Open that PNG in Preview. Hover the crosshair (or use Tools → Show
#      Inspector, or ⌘-drag a selection) to read the pixel coordinate of the
#      TOP-LEFT corner of the plugin's content region (just below its title bar).
#   4. Divide those pixel coordinates by DISPLAY_SCALE to get points, then set
#      WIN_X / WIN_Y below. On a 1:1 display (scale=1) pixels == points.
#   Tip: the plugin content is exactly WIN_W×WIN_H points; use the bottom-right
#   corner as a sanity check (BR = WIN_X+WIN_W, WIN_Y+WIN_H).
#
# The plugin window is a FIXED size: code.js calls
#   figma.showUI(__html__, { width: 475, height: 560 })
# so WIN_W/WIN_H should not need changing.
#
WIN_X="${SORB_QA_WIN_X:-900}"     # <-- CALIBRATE: absolute x (points) of plugin content top-left
WIN_Y="${SORB_QA_WIN_Y:-300}"     # <-- CALIBRATE: absolute y (points) of plugin content top-left
WIN_W="${SORB_QA_WIN_W:-475}"     # fixed logical width  (figma.showUI width)
WIN_H="${SORB_QA_WIN_H:-560}"     # fixed logical height (figma.showUI height)

# Reference setup: 2560×1440 at 1:1. On a Retina/HiDPI display set this to 2.
DISPLAY_SCALE="${SORB_QA_SCALE:-1}"

# Output directory for screenshots.
OUTDIR="${SORB_QA_OUTDIR:-./.qa-screens}"

# Pause (seconds) after a click before the next action, to let the UI settle.
SETTLE="${SORB_QA_SETTLE:-0.6}"

# ---------------------------------------------------------------------------
# APPROXIMATE CLICK TARGETS — window-relative points (origin = plugin content
# top-left). DERIVED FROM THE 475×560 "Direction A" layout, NOT measured against
# a running build. Re-check against `find`/`shot intro` output and adjust.
#
#   * header ~40px tall, spans the top.
#   * "?" help affordance at top-right of header  ~ (455, 20).
#   * account-first intro (2026-08-26): the primary orange "Sign in to connect"
#     card sits mid-panel (~y=248 at 475-wide); a small "Have an org key? Paste
#     it instead" link + a collapsed "Advanced setup" disclosure (self-host /
#     invites / manual bridge) sit below it. RE-CALIBRATE Y against `shot intro`.
#   * tabs row sits below the status bar ~ y=95, left-aligned, order
#     Tokens / Components / Settings starting ~ x=20 with ~90px spacing.
# ---------------------------------------------------------------------------
HELP_X=455; HELP_Y=20            # "?" help / re-open intro (top-right header)

# Primary account path — the orange "Sign in to connect" card (opens browser → poll).
INTRO_SIGNIN_X=237; INTRO_SIGNIN_Y=248     # "Sign in to connect" card (re-calibrate via `shot intro`)

TAB_TOKENS_X=45;  TAB_TOKENS_Y=95          # Tokens tab
TAB_COMPONENTS_X=140; TAB_COMPONENTS_Y=95  # Components tab
TAB_SETTINGS_X=245; TAB_SETTINGS_Y=95      # Settings tab

# ---------------------------------------------------------------------------
# Derived absolute-region values for screencapture (-R x,y,w,h in POINTS).
# ---------------------------------------------------------------------------
REGION_X="$WIN_X"
REGION_Y="$WIN_Y"
REGION_W="$WIN_W"
REGION_H="$WIN_H"

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

err() { printf 'hid-visual-qa: %s\n' "$*" >&2; }

require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    err "this harness is macOS-only (needs CGEventPost + screencapture)."
    exit 2
  fi
}

ensure_outdir() {
  if ! mkdir -p "$OUTDIR"; then
    err "could not create output dir: $OUTDIR"
    exit 1
  fi
}

# click <rel_x> <rel_y>
# Coordinates are window-relative POINTS; converted to absolute screen points.
# CGEventPost consumes GLOBAL display points (top-left origin), so scale does not
# multiply here — scale only matters when reading pixel coords out of a screenshot.
click() {
  local rel_x="$1" rel_y="$2"
  if [ -z "${rel_x:-}" ] || [ -z "${rel_y:-}" ]; then
    err "click requires <x> <y> (window-relative points)"
    return 1
  fi
  local abs_x abs_y
  abs_x=$(( WIN_X + rel_x ))
  abs_y=$(( WIN_Y + rel_y ))

  # Drive CGEventPost via a self-contained python3 block (ctypes → ApplicationServices).
  # No pip installs required; ApplicationServices ships with macOS.
  ABS_X="$abs_x" ABS_Y="$abs_y" python3 - <<'PY'
import ctypes, os, sys

try:
    x = float(os.environ["ABS_X"])
    y = float(os.environ["ABS_Y"])
except (KeyError, ValueError) as e:
    sys.stderr.write("hid-visual-qa: bad click coordinates: %s\n" % e)
    sys.exit(1)

try:
    AS = ctypes.cdll.LoadLibrary(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    )
except OSError as e:
    sys.stderr.write("hid-visual-qa: cannot load ApplicationServices: %s\n" % e)
    sys.exit(1)

# CGPoint is two doubles; pass by value.
class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

# Constants from CGEventTypes.h
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp   = 2
kCGMouseButtonLeft    = 0
kCGHIDEventTap        = 0

AS.CGEventCreateMouseEvent.restype  = ctypes.c_void_p
AS.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                       CGPoint, ctypes.c_uint32]
AS.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
AS.CFRelease.argtypes   = [ctypes.c_void_p]

pt = CGPoint(x, y)

def post(evt_type):
    evt = AS.CGEventCreateMouseEvent(None, evt_type, pt, kCGMouseButtonLeft)
    if not evt:
        sys.stderr.write("hid-visual-qa: CGEventCreateMouseEvent returned NULL\n")
        sys.exit(1)
    try:
        AS.CGEventPost(kCGHIDEventTap, evt)
    finally:
        AS.CFRelease(evt)

# Move-then-press: post a move so the webview registers hover under the cursor,
# then a down/up pair.
post(5)  # kCGEventMouseMoved
post(kCGEventLeftMouseDown)
post(kCGEventLeftMouseUp)
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    err "click at abs ($abs_x,$abs_y) failed (rc=$rc). Check Accessibility permission."
    return "$rc"
  fi
  return 0
}

# shot <name> — capture exactly the plugin window region to $OUTDIR/<name>.png
shot() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    err "shot requires <name>"
    return 1
  fi
  ensure_outdir
  local out="$OUTDIR/$name.png"
  # -R x,y,w,h : capture a rectangular region (points). -x : no capture sound.
  if ! screencapture -R"${REGION_X},${REGION_Y},${REGION_W},${REGION_H}" -x "$out"; then
    err "screencapture failed for '$name'. Check Screen Recording permission."
    return 1
  fi
  printf 'shot: %s\n' "$out"
  return 0
}

settle() {
  # bash `sleep` accepts fractional seconds on macOS.
  sleep "$SETTLE" || true
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

# find — full-screen screenshot so the founder can read off the window origin.
cmd_find() {
  ensure_outdir
  local out="$OUTDIR/_find-fullscreen.png"
  if ! screencapture -x "$out"; then
    err "full-screen screencapture failed. Check Screen Recording permission."
    return 1
  fi
  cat <<EOF
Wrote full-screen screenshot: $out

Open it in Preview and read the pixel coordinate of the TOP-LEFT corner of the
plugin's CONTENT area (just below its title bar). Divide by DISPLAY_SCALE
(currently $DISPLAY_SCALE) to get points, then set:
    WIN_X=<x>  WIN_Y=<y>
either by editing this script's CONFIG block or via env:
    SORB_QA_WIN_X=<x> SORB_QA_WIN_Y=<y> ./hid-visual-qa.sh capture
Sanity check: the plugin content is exactly ${WIN_W}x${WIN_H} points.
EOF
}

# capture — run the full U2 verify sequence.
# U2 checkpoint (2026-08-26): fresh install → account-first intro (primary
# "Sign in to connect" + collapsed "Advanced setup") → sign-in→poll → token view.
cmd_capture() {
  cat <<EOF
Running U2 capture sequence.
  window origin : ($WIN_X,$WIN_Y)   size: ${WIN_W}x${WIN_H}   scale: $DISPLAY_SCALE
  output dir    : $OUTDIR
NOTE: click targets are APPROXIMATE (475x560 Direction A layout). If a shot is
off, recalibrate WIN_X/WIN_Y and/or the *_X/*_Y target vars near the top.
EOF
  ensure_outdir

  # 1) The account-first intro (first-open surface).
  shot intro
  settle

  # 2) Click "Sign in to connect" → opens browser + starts polling.
  #    (Full connect needs a real browser sign-in; this verifies the card + waiting state.)
  click "$INTRO_SIGNIN_X" "$INTRO_SIGNIN_Y"
  settle
  shot intro-connect-click   # optional: state immediately after the click
  settle
  shot tokens-working        # the working token view

  # 3) Components tab.
  click "$TAB_COMPONENTS_X" "$TAB_COMPONENTS_Y"
  settle
  shot tab-components

  # 4) Settings tab.
  click "$TAB_SETTINGS_X" "$TAB_SETTINGS_Y"
  settle
  shot tab-settings

  # Return to Tokens so the header "?" is in its intro-triggering context, then
  # 5) reopen the intro via the "?" help affordance.
  click "$TAB_TOKENS_X" "$TAB_TOKENS_Y"
  settle
  click "$HELP_X" "$HELP_Y"
  settle
  shot help-reopen

  printf '\nU2 capture complete. Screens in: %s\n' "$OUTDIR"
}

# diff <a.png> <b.png> [out.png] — optional, degrades gracefully if no ImageMagick.
cmd_diff() {
  local a="${1:-}" b="${2:-}" out="${3:-$OUTDIR/_diff.png}"
  if [ -z "$a" ] || [ -z "$b" ]; then
    err "diff requires <a.png> <b.png> [out.png]"
    return 1
  fi
  if [ ! -f "$a" ] || [ ! -f "$b" ]; then
    err "diff: one or both inputs missing ($a, $b)"
    return 1
  fi
  local magick=""
  if command -v magick >/dev/null 2>&1; then
    magick="magick compare"
  elif command -v compare >/dev/null 2>&1; then
    magick="compare"
  fi
  if [ -z "$magick" ]; then
    err "ImageMagick not found (magick/compare) — skipping visual diff. Compare manually: $a vs $b"
    return 0   # never hard-fail on a missing optional tool
  fi
  # `compare` exits non-zero when images differ; that is expected, not an error.
  if $magick "$a" "$b" "$out"; then
    printf 'diff: images identical → %s\n' "$out"
  else
    printf 'diff: images differ → %s\n' "$out"
  fi
  return 0
}

usage() {
  cat <<EOF
hid-visual-qa.sh — HID visual-QA harness for the Sorb Figma plugin (sorb-canopy).

macOS only. Drives the AX-opaque plugin webview with CGEventPost mouse clicks
and captures with screencapture region shots. Grant the terminal app both
Screen Recording AND Accessibility permissions first.

USAGE:
  ./hid-visual-qa.sh find              Full-screen shot to calibrate the window origin.
  ./hid-visual-qa.sh capture           Run the full U2 verify sequence (intro → tokens → tabs → help).
  ./hid-visual-qa.sh shot <name>       Capture just the plugin window region to \$OUTDIR/<name>.png.
  ./hid-visual-qa.sh click <x> <y>     Click at window-relative point (x,y).
  ./hid-visual-qa.sh diff <a> <b> [o]  Optional ImageMagick visual diff (skips gracefully if absent).
  ./hid-visual-qa.sh help|--help|-h    This message.

CALIBRATION (one-time): run 'find', read the plugin content top-left corner off
the screenshot, set WIN_X/WIN_Y in the CONFIG block (or via SORB_QA_WIN_X/Y env).

ENV OVERRIDES:
  SORB_QA_WIN_X SORB_QA_WIN_Y   plugin content origin (points)
  SORB_QA_WIN_W SORB_QA_WIN_H   window size (default 475x560, fixed by code.js)
  SORB_QA_SCALE                 display scale (default 1; use 2 for HiDPI)
  SORB_QA_OUTDIR                output dir (default ./.qa-screens)
  SORB_QA_SETTLE                per-step settle seconds (default 0.6)

Current config: origin=($WIN_X,$WIN_Y) size=${WIN_W}x${WIN_H} scale=$DISPLAY_SCALE outdir=$OUTDIR
EOF
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
main() {
  require_macos
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    find)    cmd_find ;;
    capture) cmd_capture ;;
    shot)    shot "$@" ;;
    click)   click "$@" ;;
    diff)    cmd_diff "$@" ;;
    help|--help|-h) usage ;;
    *)
      err "unknown subcommand: $cmd"
      usage
      exit 64
      ;;
  esac
}

main "$@"
