# @sorb/canopy

Sorb&trade; is a design-token bridge between Figma and your running app. This
is **the Sorb plugin (Canopy)** — the Figma side: it reads your file's
**Variables**, previews a proposed change live on your real components, and
lets you save the result back to your project. (Canopy: your app's foliage,
seen in Figma; `@sorb/leaf` is the same foliage on the dev side.)

It's plain `code.js` + `ui.html` — no build step, no bundler. Figma loads
both files directly.

Full docs: <https://www.sorbcloud.com/docs/figma-plugin>.

## Get the plugin

The plugin is **not on the Figma Community yet**. During the beta you load it
into **Figma desktop** as a development plugin — about three minutes, no
build step. (The browser version of Figma cannot import development
plugins.)

1. **Get the files** — either way gives you a folder with `manifest.json`,
   `code.js`, `ui.html`, `lib/` and `icons/`:
   - Download the curated zip from the latest GitHub Release —
     <https://github.com/metatoy/sorb-canopy/releases/latest/download/sorb-figma-plugin.zip> —
     and unzip it somewhere you won't delete (Figma re-reads the folder every
     time the plugin runs), **or**
   - `git clone https://github.com/metatoy/sorb-canopy.git`.
2. In Figma desktop, open any design file, then from the main menu choose
   **Plugins → Development → Import plugin from manifest…**
3. Select the `manifest.json` in that folder.
4. Run it from **Plugins → Development → Sorb**. The panel opens at
   **475 × 560** (`figma.showUI(__html__, { width: 475, height: 560 })` in
   `code.js`) on the front door: **Sign in to connect**, **See it without
   installing** (opens <https://try.sorbcloud.com>), and **Advanced setup**.

**Updating:** download the new zip and replace the folder's contents at the
same path — Figma picks the new files up the next time you run the plugin. If
you unzipped to a new location, repeat step 2–3; the plugin `id` in
`manifest.json` never changes, so Figma updates the existing Development
entry instead of adding a second one.

The zip is built by `npm run package` (`scripts/package.mjs`) and published
by `.github/workflows/release.yml` on every `v*` tag. Step-by-step with
troubleshooting: <https://www.sorbcloud.com/docs/figma-plugin/install>.

## How it's built

The plugin sandbox splits into two halves that only talk over `postMessage`
— the sandbox can't make network calls, and the iframe can't touch the
document:

| Part | Runs in | Can do | Cannot do |
|---|---|---|---|
| `code.js` | Figma's plugin sandbox (main thread) | `figma.*` — read/write Variables, insert nodes, `figma.openExternal` | Network requests |
| `ui.html` | An iframe | `fetch` — the bridge, the cloud | Any `figma.*` call |

This is also why sign-in works the way it does: the iframe can't open a
browser window, so it asks the main thread to (`figma.openExternal`), and it
can't receive an OAuth redirect, so the browser hands the result back through
a pairing-poll instead.

## Connect

Load the plugin (**Plugins → Development → Import plugin from manifest…**,
pick this folder's `manifest.json`, then run **Plugins → Development →
Sorb**) and the front door promotes one path:

1. Click **Sign in to connect**. The plugin generates a single-use pairing
   code, opens `app.sorbcloud.com/plugin-connect?code=…` in your system
   browser, and polls `GET /api/plugin-connect/poll?code=…` (~2s) while you
   sign in there.
2. The cloud resolves your org and its default project and mints a
   publishable key (`sorb_pk_…`); the poll hands the plugin that key plus the
   bridge and app URLs, and the plugin loads the tokens already committed to
   your project.

Everything else — an org key paste, a developer's handshake invite, manual
bridge entry, or local-bridge auto-discovery — lives under **Advanced setup**
on the front door and in Settings. None of it is needed on the hosted path;
it exists for self-hosting, headless/CI use, and the case where the designer
and developer are the same person. See the docs for the full walkthrough of
every fallback.

## The three views

- **Tokens** — the primary workspace: a searchable, editable list of your
  working token set, with a pinned CHANGED group for unsaved edits.
- **Components** — insert components captured by `sorb-seed capture` into
  Figma as native nodes with Figma Variable bindings applied automatically.
- **Settings** — your account (dashboard link, log out) and, under Advanced
  setup, the bridge/app/Storybook/GitHub/key fields.

## The loop

1. **Load from App** pulls the tokens your project has already committed
   (`GET /tokens/latest`), or **Sync from Figma now** re-collects from your
   Variables.
2. **Edit** a value inline; changed rows collect into the CHANGED group.
3. **Preview in app** opens your app with a live session (`?preview=<id>`),
   pushing edits as you type (`PUT /preview/{id}`, debounced ~250ms).
   Previews are ephemeral — nothing is written to your repo or your project
   until you save.
4. **Save to project&nbsp;&rarr;** persists the working set as a new
   versioned token set on your project (`POST /api/plugin/publish-tokens`,
   Bearer `sorb_pk_…` or a secret key — the plugin's own key is enough).
5. **Open PR** is a manual, clipboard-assisted flow: it reviews your changes
   in a diff drawer, then **Copy diff + open GitHub** copies the merged
   tokens to your clipboard and opens your configured GitHub file's web
   editor so you paste and submit the PR yourself. It's distinct from the
   fully automated dashboard/API pipeline
   (`POST /api/projects/:id/token-pr`) — see
   <https://www.sorbcloud.com/docs/cloud/token-pr>.

## Sync Variables into Figma (and the drift check)

**Sync Variables into Figma** (in the Tokens tab's &ctdot; menu) fetches the
resolved bindable token map (`GET /tokens/resolved`, generated by
`sorb-seed resolve`) and creates/updates Figma Variables in three
collections — Primitives, Semantic, Component. Idempotent: re-running
updates values without duplicating variables.

The same sync path also runs a **read-only drift check** in the background:
it exports this file's current Variables to the bridge
(`POST /tokens/figma`) and diffs them against the committed DTCG tokens
(`GET /verify/figma`), surfacing mismatches as a status-line warning. Neither
side is ever written by the check itself — the DTCG source stays canonical,
the Figma export is a mirror. (`POST /tokens/figma` needs a secret key; a
plugin connected with only a publishable key skips this check rather than
403ing.)

## Token mapping

- `COLOR` variables → hex (`#rrggbb`, or `#rrggbbaa` when alpha &lt; 1)
- `FLOAT` variables → `Npx` (and `0` stays `0`)
- `STRING` / `BOOLEAN` → as-is
- Grouped names like `color/primaryAction` flatten to the leaf
  (`primaryAction`) so they're valid CSS custom-property names.

Name your Figma Variables to match the token names your app consumes and the
preview flows straight through to `var(--primaryAction)`, etc.

## Manifest &amp; network access

Any origin the UI calls must be listed in `manifest.json`'s
`networkAccess.allowedDomains` (`["*"]` is fine for local development). The
page must be HTTPS-reachable if you open the app over HTTPS — the same
mixed-content rule as any `fetch` from an iframe.
