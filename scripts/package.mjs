#!/usr/bin/env node
// scripts/package.mjs — build the curated plugin zip a designer imports into
// Figma desktop (Plugins → Development → Import plugin from manifest…).
//
//   node scripts/package.mjs                 # → dist/sorb-figma-plugin.zip
//   node scripts/package.mjs --tag v1.4.0    # also asserts the tag == v<package.json version>
//
// Writes dist/sorb-figma-plugin.zip (the stable name the GitHub Release serves
// at …/releases/latest/download/sorb-figma-plugin.zip) plus a versioned copy
// dist/sorb-figma-plugin-v<version>.zip. The zip contains EXACTLY the files
// Figma loads (manifest.json, code.js, ui.html, lib/token-mapping.js,
// icons/*.svg) — no tests, tools, specs, community assets, .DS_Store or
// __MACOSX folders — and every entry is a relative path rooted at the zip
// top level, so `manifest.json`'s `main` / `ui` resolve after a plain unzip.
//
// Uses the system `zip` (present on macOS + ubuntu-latest); no npm deps.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const STABLE_NAME = "sorb-figma-plugin.zip";

// The exact allowlist. Add a file here (and to manifest/ui.html) deliberately —
// nothing else is ever shipped.
const FIXED_FILES = ["manifest.json", "code.js", "ui.html", "lib/token-mapping.js"];
const GLOB_DIRS = [{ dir: "icons", ext: ".svg" }];

function fail(msg) {
  console.error(`✗ package: ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const expectedTag = `v${pkg.version}`;

const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
if (tagIdx !== -1) {
  const tag = args[tagIdx + 1];
  if (!tag) fail("--tag needs a value, e.g. --tag v1.4.0");
  if (tag !== expectedTag) {
    fail(`tag ${tag} does not match package.json version ${pkg.version} (expected ${expectedTag}). Bump package.json or re-tag.`);
  }
}

// Resolve the file list and verify every entry exists before zipping.
const files = [];
for (const f of FIXED_FILES) {
  if (!existsSync(join(ROOT, f))) fail(`required file missing: ${f}`);
  files.push(f);
}
for (const { dir, ext } of GLOB_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) fail(`required directory missing: ${dir}/`);
  const entries = readdirSync(abs)
    .filter((e) => e.endsWith(ext) && statSync(join(abs, e)).isFile())
    .sort();
  if (!entries.length) fail(`no ${ext} files found in ${dir}/`);
  for (const e of entries) files.push(`${dir}/${e}`);
}

// Sanity: the manifest's entry points must be inside the zip.
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
for (const key of ["main", "ui"]) {
  if (!files.includes(manifest[key])) fail(`manifest.json "${key}": "${manifest[key]}" is not in the packaged file list`);
}

// Fresh dist/ every run so stale versioned zips never linger.
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const stable = join(DIST, STABLE_NAME);
// -X: no extra file attributes (no macOS resource forks / __MACOSX); -D: no
// directory entries; paths are given relative to ROOT so the archive is flat.
const zip = spawnSync("zip", ["-q", "-X", "-D", stable, ...files], { cwd: ROOT, stdio: "inherit" });
if (zip.error) fail(`could not run \`zip\` (${zip.error.message}) — install Info-ZIP (present on macOS and ubuntu-latest)`);
if (zip.status !== 0) fail(`zip exited with ${zip.status}`);

const versioned = join(DIST, `sorb-figma-plugin-${expectedTag}.zip`);
copyFileSync(stable, versioned);

const kb = (statSync(stable).size / 1024).toFixed(1);
console.log(`✓ package: ${files.length} files → ${relative(ROOT, stable)} (${kb} KB) + ${relative(ROOT, versioned)}`);
for (const f of files) console.log(`    ${f}`);
