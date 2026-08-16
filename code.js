// Sorb Figma plugin — main thread (sandbox).
//
// Has access to the Figma document API but NOT to the network. Its job is to
// read the file's local Variables, flatten them into Sorb's token shape
// ({ name: value }), and hand them to the UI iframe, which does the HTTP work.

figma.showUI(__html__, { width: 475, height: 560 });

// Durable settings live in figma.clientStorage on the main thread — the UI
// iframe's localStorage is NOT reliably kept across plugin reloads, so the
// handshake/connection setup would otherwise evaporate on hot-reload. Restore
// the saved blob and hand it to the UI, which hydrates before choosing its
// first screen. (postMessage queues until the UI is ready.)
figma.clientStorage.getAsync('sorb.settings')
  .then((data) => figma.ui.postMessage({ type: 'sorb-restore', data: data || {} }))
  .catch((e) => figma.ui.postMessage({ type: 'sorb-restore', data: {} }));

// ─── value conversion ───────────────────────────────────────────────────────

const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');

const rgbaToHex = ({ r, g, b, a = 1 }) => {
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return a < 1 ? `${hex}${toHex(a)}` : hex;
};

// Map a resolved Figma variable value to a CSS-ready token value.
const toTokenValue = (resolvedType, value) => {
  if (value == null) return '';
  switch (resolvedType) {
    case 'COLOR':
      return rgbaToHex(value);
    case 'FLOAT':
      // Most numeric tokens here are dimensions (radius/spacing). 0 stays 0.
      return value === 0 ? '0' : `${value}px`;
    default:
      return String(value); // STRING / BOOLEAN
  }
};

// Figma Variable names are grouped with "/" mirroring the DTCG path
// (e.g. "button/primary/bg/default"). The app reads the matching CSS custom
// property — the FULL kebab path (--button-primary-bg-default) — so map
// slashes → dashes. (Leaf-only would collide: every "*/bg/default".)
const toTokenName = (name) => name.split('/').map((s) => s.trim()).join('-');

// ─── token collection ───────────────────────────────────────────────────────

async function collectTokens() {
  const tokens = {};
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const defaultModeByCollection = {};
  for (const c of collections) defaultModeByCollection[c.id] = c.defaultModeId;

  const vars = await figma.variables.getLocalVariablesAsync();
  for (const v of vars) {
    const modeId = defaultModeByCollection[v.variableCollectionId];
    let value = v.valuesByMode[modeId];

    // Resolve one level of alias (e.g. semantic → primitive).
    if (value && value.type === 'VARIABLE_ALIAS') {
      const target = await figma.variables.getVariableByIdAsync(value.id);
      if (target) {
        const targetMode = defaultModeByCollection[target.variableCollectionId];
        value = target.valuesByMode[targetMode];
      }
    }

    tokens[toTokenName(v.name)] = toTokenValue(v.resolvedType, value);
  }
  return tokens;
}

// ─── resolved-map export (Figma Variables → the ResolvedToken[] shape) ───────
// Feeds POST /tokens/figma on the bridge (sorb-juice), which diffs it against
// GET /tokens/resolved at GET /verify/figma — the Figma-vs-DTCG reference
// check (FLS v0.5.0 P1). Unlike collectTokens() above (which collapses to a
// flat { cssVarName: value } map for the token editor), this keeps one entry
// per token: { id, cssVar, value, tier?, type }, the same shape
// GET /tokens/resolved already returns.
//
// tierFromCollectionName / figmaTypeToTokenType / toDottedId are pure (no
// figma.* calls) and are duplicated byte-for-byte in lib/token-mapping.js,
// which node:test exercises directly — the Figma plugin sandbox has no
// module loader and this repo has no build step (CLAUDE.md hard rule), so
// code.js can't require() that file. Keep the two copies in sync.

// One collection per tier so semantic can (later) alias primitive and component
// alias semantic — mirroring the DTCG ref graph. (Declared HERE, not next to
// syncVariables below: TIER_BY_COLLECTION_NAME reads it at module-load time,
// and a later `const` declaration is a TDZ ReferenceError that kills the whole
// plugin on load.)
const TIER_COLLECTION = { primitive: 'Primitives', semantic: 'Semantic', component: 'Component' };

const TIER_BY_COLLECTION_NAME = Object.keys(TIER_COLLECTION).reduce((acc, tier) => {
  acc[TIER_COLLECTION[tier]] = tier;
  return acc;
}, {});

// Figma Variable Collection name → DTCG tier, or undefined when the
// collection isn't one of Sorb's three tier collections (the exporter omits
// `tier` entirely for those, per the resolved-map contract).
const tierFromCollectionName = (name) => TIER_BY_COLLECTION_NAME[name];

// Dotted DTCG id form ("button.primary.bg.default") — the inverse of
// idToVarName (dots → slashes) used elsewhere in this file.
const toDottedId = (name) => name.split('/').join('.');

// Figma resolvedType (+ the already CSS-formatted value) → DTCG token `type`.
// FLOAT is 'dimension' when the formatted value carries a unit ("...px"),
// else 'number' (the FLOAT-0 case — toTokenValue renders that as bare "0").
const figmaTypeToTokenType = (resolvedType, cssValue) => {
  if (resolvedType === 'COLOR') return 'color';
  if (resolvedType === 'FLOAT') {
    return typeof cssValue === 'string' && cssValue.indexOf('px') !== -1 ? 'dimension' : 'number';
  }
  return 'string'; // STRING / BOOLEAN
};

// Same variable/alias walk as collectTokens(), but emits one resolved-map
// entry per Variable instead of collapsing into a flat map.
async function collectResolvedTokens() {
  const out = [];
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionNameById = {};
  const defaultModeByCollection = {};
  for (const c of collections) {
    collectionNameById[c.id] = c.name;
    defaultModeByCollection[c.id] = c.defaultModeId;
  }

  const vars = await figma.variables.getLocalVariablesAsync();
  for (const v of vars) {
    const modeId = defaultModeByCollection[v.variableCollectionId];
    let value = v.valuesByMode[modeId];

    // Resolve one level of alias (e.g. semantic → primitive) — same as collectTokens().
    if (value && value.type === 'VARIABLE_ALIAS') {
      const target = await figma.variables.getVariableByIdAsync(value.id);
      if (target) {
        const targetMode = defaultModeByCollection[target.variableCollectionId];
        value = target.valuesByMode[targetMode];
      }
    }

    const cssValue = toTokenValue(v.resolvedType, value);
    const entry = {
      id: toDottedId(v.name),
      cssVar: '--' + toTokenName(v.name),
      value: cssValue,
      type: figmaTypeToTokenType(v.resolvedType, cssValue),
    };
    const tier = tierFromCollectionName(collectionNameById[v.variableCollectionId]);
    if (tier) entry.tier = tier;
    out.push(entry);
  }
  return out;
}

// Envelope metadata wraps the token array for POST /tokens/figma. figma.fileKey
// requires nothing extra (no additional manifest permission) but guard it
// anyway — an access error should degrade to null, not throw.
async function exportVariablesArtifact() {
  const tokens = await collectResolvedTokens();
  let fileKey = null;
  try { fileKey = figma.fileKey || null; } catch (e) { fileKey = null; }
  return { fileKey: fileKey, exportedAt: new Date().toISOString(), tokens: tokens };
}

// ─── message bridge to the UI ────────────────────────────────────────────────

// Stable stringify (sorted keys) for cheap change-detection on the auto path.
function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  let s = '{';
  for (let i = 0; i < keys.length; i++) {
    if (i) s += ',';
    s += JSON.stringify(keys[i]) + ':' + JSON.stringify(obj[keys[i]]);
  }
  return s + '}';
}

let lastTokensJson = null;

// Manual / on-open send — always posts, tagging the `source` so the UI knows
// whether it may overwrite an edited editor.
async function sendTokens(source) {
  try {
    const tokens = await collectTokens();
    lastTokensJson = stableStringify(tokens);
    figma.ui.postMessage({ type: 'tokens', tokens, source: source || 'manual' });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: String(err) });
  }
}

// ─── auto-sync (poll while open; documentchange as accelerator) ───────────────
// Figma plugins only run while open, so this watches Variables for as long as
// the panel is up. Posts only when the collected set actually changes.
let _polling = false;
let _pollTimer = null;
let _docHandler = null;
let _debounce = null;
let _collecting = false;

async function autoCollect() {
  if (_collecting) return; // don't overlap async collects
  _collecting = true;
  try {
    const tokens = await collectTokens();
    const json = stableStringify(tokens);
    const changed = json !== lastTokensJson;              // compute BEFORE reassigning
    if (changed) {
      lastTokensJson = json;
      figma.ui.postMessage({ type: 'tokens', tokens, source: 'auto' });   // §2 payload unchanged
    }
    figma.ui.postMessage({ type: 'auto-freshness', ok: true, changed: changed, at: Date.now() });
  } catch (e) {
    figma.ui.postMessage({ type: 'auto-freshness', ok: false, error: String(e), at: Date.now() });
  } finally {
    _collecting = false;
  }
}

function startAutoPoll() {
  if (_polling) return;
  _polling = true;
  _pollTimer = setInterval(autoCollect, 1500);
  // documentchange is a best-effort accelerator: it fires for node/style edits
  // but not reliably for Variable values, and in dynamic-page mode it can throw
  // unless all pages are loaded — so guard it and lean on the poll as truth.
  _docHandler = function () {
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(autoCollect, 250);
  };
  try { figma.on('documentchange', _docHandler); } catch (e) { _docHandler = null; }
}

function stopAutoPoll() {
  _polling = false;
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_debounce) { clearTimeout(_debounce); _debounce = null; }
  if (_docHandler) { try { figma.off('documentchange', _docHandler); } catch (e) {} _docHandler = null; }
}

// ─── Variable sync (code → Figma) ────────────────────────────────────────────
// Create/update Figma Variables from the resolved bindable token map. Only the
// main thread can use the figma.variables API, so the UI hands us the list.

const hexToRgba = (hex) => {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 4) h = h.split('').map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return {
    r: n(0), g: n(2), b: n(4),
    a: h.length >= 8 ? n(6) : 1,
  };
};

// Map a resolved token value to a Figma variable type + value.
const toFigmaValue = (value) => {
  const v = String(value).trim();
  if (v === 'transparent') return { type: 'COLOR', value: { r: 0, g: 0, b: 0, a: 0 } };
  if (/^#([0-9a-fA-F]{3,8})$/.test(v)) return { type: 'COLOR', value: hexToRgba(v) };
  const num = v.match(/^(-?\d+(?:\.\d+)?)px$/) || v.match(/^(-?\d+(?:\.\d+)?)$/);
  if (num) return { type: 'FLOAT', value: parseFloat(num[1]) };
  return { type: 'STRING', value: v }; // shadows, 'none', etc.
};

// Variable names are the token `id` with dots → slashes, which Figma renders
// as nested groups. (TIER_COLLECTION itself is declared near the top of the
// file — TIER_BY_COLLECTION_NAME needs it at module-load time.)
const idToVarName = (id) => String(id).split('.').join('/');

async function syncVariables(tokens) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const colByName = {};
  const ensureCol = (name) => {
    if (colByName[name]) return colByName[name];
    let c = collections.find((x) => x.name === name);
    if (!c) { c = figma.variables.createVariableCollection(name); collections.push(c); }
    colByName[name] = c;
    return c;
  };

  // Index existing Variables by (collectionId, name) so re-sync updates in place.
  const existing = await figma.variables.getLocalVariablesAsync();
  const byKey = new Map();
  for (const v of existing) byKey.set(v.variableCollectionId + ' ' + v.name, v);

  const used = {};
  let created = 0, updated = 0, skipped = 0;
  for (const t of tokens) {
    const tier = t.tier || 'component';
    const colName = TIER_COLLECTION[tier] || 'Component';
    const col = ensureCol(colName);
    used[colName] = true;
    const name = idToVarName(t.id);
    const fv = toFigmaValue(t.value);
    const key = col.id + ' ' + name;
    let v = byKey.get(key);
    if (v && v.resolvedType !== fv.type) { skipped++; continue; } // type changed — leave it
    if (!v) { v = figma.variables.createVariable(name, col, fv.type); byKey.set(key, v); created++; }
    else updated++;
    // Single default mode holds the resolved value (MVP). Theme modes — and
    // true semantic→primitive aliasing — are a rename-free upgrade from here.
    v.setValueForMode(col.defaultModeId, fv.value);
  }
  return { created, updated, skipped, collection: Object.keys(used).join(', ') };
}

// ─── Variant lifecycle (sorb-seed variant add/deprecate → Figma Variables) ───
// Keep the Component-tier Variables in step as the CLI adds or retires token
// variants. Both reuse idToVarName + the Component collection name from the
// tier map above, so the Variable naming stays identical to syncVariables.

const COMPONENT_COLLECTION = TIER_COLLECTION.component; // 'Component'

// Find the Component collection, creating it if it doesn't exist yet.
async function ensureComponentCollection() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let col = collections.find((c) => c.name === COMPONENT_COLLECTION);
  if (!col) col = figma.variables.createVariableCollection(COMPONENT_COLLECTION);
  return col;
}

// Create a Component-tier Variable for each token in a newly-added variant,
// skipping any that already exist (keyed by the slash-path Variable name).
async function createVariantVariables(tokens) {
  const col = await ensureComponentCollection();
  const existing = await figma.variables.getLocalVariablesAsync();
  const existingNames = new Set();
  for (const v of existing) {
    if (v.variableCollectionId === col.id) existingNames.add(v.name);
  }
  let created = 0;
  for (const token of tokens) {
    const varName = idToVarName(token.id);
    if (existingNames.has(varName)) continue;
    try {
      figma.variables.createVariable(varName, col, 'STRING');
      existingNames.add(varName);
      created++;
    } catch (e) { console.warn('createVariantVar', varName, e); }
  }
  return { created };
}

// Prefix matching Component Variables with "[deprecated] " when a variant is
// retired. tokenIdPrefix is a dotted token-id path; Variable names use slashes,
// so map it through idToVarName before the substring match.
async function deprecateVariantVariables(tokenIdPrefix) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const col = collections.find((c) => c.name === COMPONENT_COLLECTION);
  if (!col) return { renamed: 0 };
  const prefix = idToVarName(tokenIdPrefix || '');
  const existing = await figma.variables.getLocalVariablesAsync();
  let renamed = 0;
  for (const v of existing) {
    if (v.variableCollectionId !== col.id) continue;
    if (v.name.indexOf(prefix) === -1) continue;
    if (v.name.indexOf('[deprecated] ') === 0) continue;
    try {
      v.name = '[deprecated] ' + v.name;
      renamed++;
    } catch (e) { console.warn('deprecateVariantVar', v.name, e); }
  }
  return { renamed };
}

// ─── Materialize a captured LayerNode → Figma nodes, binding tokens ──────────

// dotted token id → Variable, across the tier collections synced from code.
// The captured tree references tokens by id (e.g. "button.primary.bg.default");
// the Variable is named with slashes ("button/primary/bg/default"), so we key
// the map by the dotted form for direct lookup.
async function sorbVarMap() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const tierColIds = new Set(
    cols.filter((c) => c.name === 'Primitives' || c.name === 'Semantic' || c.name === 'Component')
      .map((c) => c.id),
  );
  const map = new Map();
  if (tierColIds.size) {
    const vars = await figma.variables.getLocalVariablesAsync();
    for (const v of vars) {
      if (tierColIds.has(v.variableCollectionId)) map.set(v.name.split('/').join('.'), v);
    }
  }
  return map;
}

// Infer a numeric weight + italic from a Figma style name ("Semi Bold Italic"…).
const STYLE_WEIGHT = [
  [/thin|hairline/i, 100], [/extra\s?light|ultra\s?light/i, 200], [/light/i, 300],
  [/medium/i, 500], [/semi\s?bold|demi\s?bold/i, 600],
  [/extra\s?bold|ultra\s?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700],
  [/regular|normal|book/i, 400],
];
const styleWeight = (style) => {
  for (const pair of STYLE_WEIGHT) if (pair[0].test(style)) return pair[1];
  return 400;
};
const styleIsItalic = (style) => /italic|oblique/i.test(style);

// family → [styles], loaded once (the font list can be large).
let _fontsByFamily = null;
async function fontsByFamily() {
  if (_fontsByFamily) return _fontsByFamily;
  const map = new Map();
  const list = await figma.listAvailableFontsAsync();
  for (const f of list) {
    const fam = f.fontName.family;
    if (!map.has(fam)) map.set(fam, []);
    map.get(fam).push(f.fontName.style);
  }
  _fontsByFamily = map;
  return map;
}

// Pick the available font whose style is closest to the target weight/italic,
// trying the captured family first, then sensible fallbacks. Preserves weight
// even when the exact family/style name isn't installed.
async function pickFont(family, weight, italic) {
  const byFam = await fontsByFamily();
  const want = weight || 400;
  for (const fam of [family, 'Inter', 'Roboto', 'Helvetica Neue', 'Arial']) {
    const styles = byFam.get(fam);
    if (!styles || !styles.length) continue;
    let cands = styles.filter((s) => styleIsItalic(s) === !!italic);
    if (!cands.length) cands = styles.slice();
    cands.sort((a, b) => Math.abs(styleWeight(a) - want) - Math.abs(styleWeight(b) - want));
    try { await figma.loadFontAsync({ family: fam, style: cands[0] }); return { family: fam, style: cands[0] }; }
    catch (e) {}
  }
  try { await figma.loadFontAsync({ family: 'Roboto', style: 'Regular' }); } catch (e) {}
  return { family: 'Roboto', style: 'Regular' };
}

const cleanPaint = (p) => ({
  type: 'SOLID',
  color: { r: p.color.r, g: p.color.g, b: p.color.b },
  opacity: p.opacity == null ? 1 : p.opacity,
});

const bindPaint = (paint, varMap, tokenName) => {
  const v = tokenName && varMap.get(tokenName);
  if (!v) return paint;
  try { return figma.variables.setBoundVariableForPaint(paint, 'color', v); } catch (e) { return paint; }
};

// Bind a node field (e.g. a corner-radius field) to a Variable, tolerating BOTH the
// modern setBoundVariable(field, Variable) and the legacy (field, variableId) signatures.
// Passing the form the running API doesn't accept throws — which is exactly how radius
// binding silently failed before (paints bind via the separate setBoundVariableForPaint,
// so they were unaffected). Returns true once a binding sticks.
const bindNodeVar = (node, field, v) => {
  if (!v) return false;
  try { node.setBoundVariable(field, v); return true; } catch (e) {
    try { node.setBoundVariable(field, v.id); return true; } catch (e2) { return false; }
  }
};

async function materialize(node, varMap) {
  const tokens = (node.sorb && node.sorb.tokens) || {};

  if (node.type === 'TEXT') {
    const t = figma.createText();
    t.fontName = await pickFont(node.fontFamily || 'Inter', node.fontWeight, node.italic);
    t.characters = node.characters || '';
    if (node.fontSize) t.fontSize = node.fontSize;
    if (node.letterSpacing != null) t.letterSpacing = { unit: 'PIXELS', value: node.letterSpacing };
    if (node.lineHeight) {
      t.lineHeight = node.lineHeight.unit === 'PIXELS'
        ? { unit: 'PIXELS', value: node.lineHeight.value }
        : { unit: 'AUTO' };
    }
    if (node.textAlign) t.textAlignHorizontal = node.textAlign;
    if (node.fills && node.fills[0]) t.fills = [bindPaint(cleanPaint(node.fills[0]), varMap, tokens.fill)];
    t.name = node.name || 'text';
    return t;
  }

  const f = figma.createFrame();
  f.name = node.name || 'frame';
  f.fills = node.fills && node.fills[0] ? [bindPaint(cleanPaint(node.fills[0]), varMap, tokens.fill)] : [];
  if (node.strokes && node.strokes[0]) {
    f.strokes = [bindPaint(cleanPaint(node.strokes[0]), varMap, tokens.stroke)];
    if (node.strokeWeight) f.strokeWeight = node.strokeWeight;
  }
  if (typeof node.cornerRadius === 'number') {
    f.cornerRadius = node.cornerRadius;
    const v = tokens.cornerRadius && varMap.get(tokens.cornerRadius);
    if (v) for (const field of ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']) {
      bindNodeVar(f, field, v);
    }
  } else if (Array.isArray(node.cornerRadius)) {
    const [tl, tr, br, bl] = node.cornerRadius;
    f.topLeftRadius = tl; f.topRightRadius = tr; f.bottomRightRadius = br; f.bottomLeftRadius = bl;
  }
  if (Array.isArray(node.effects) && node.effects.length) {
    f.effects = node.effects.map((e) => ({
      type: e.type, visible: true, blendMode: 'NORMAL',
      radius: e.radius || 0, spread: e.spread || 0,
      offset: e.offset || { x: 0, y: 0 },
      color: {
        r: e.color.color.r, g: e.color.color.g, b: e.color.color.b,
        a: e.color.opacity == null ? 1 : e.color.opacity,
      },
    }));
  }
  if (node.opacity != null) f.opacity = node.opacity;
  f.clipsContent = !!node.clipsContent;

  const auto = node.layout && node.layout.mode && node.layout.mode !== 'NONE';
  if (auto) {
    f.layoutMode = node.layout.mode;
    f.primaryAxisAlignItems = node.layout.primaryAxisAlign || 'MIN';
    f.counterAxisAlignItems = node.layout.counterAxisAlign || 'MIN';
    f.itemSpacing = node.layout.itemSpacing || 0;
    f.paddingTop = node.layout.paddingTop || 0;
    f.paddingRight = node.layout.paddingRight || 0;
    f.paddingBottom = node.layout.paddingBottom || 0;
    f.paddingLeft = node.layout.paddingLeft || 0;
    // A fresh frame defaults to 100x100, and an auto-layout frame ignores
    // resize() unless its sizing is FIXED — without this the captured size is
    // lost and e.g. a button renders ~square instead of its real 82x38.
    f.primaryAxisSizingMode = 'FIXED';
    f.counterAxisSizingMode = 'FIXED';
  }

  for (const child of node.children || []) {
    const c = await materialize(child, varMap);
    f.appendChild(c);
    if (!auto) { c.x = child.x || 0; c.y = child.y || 0; }
  }

  // Size every frame to its captured rect (auto-layout frames too, now FIXED).
  if (node.width && node.height) f.resize(node.width, node.height);
  return f;
}

async function insertNode(root) {
  const varMap = await sorbVarMap();
  const node = await materialize(root, varMap);
  figma.currentPage.appendChild(node);
  node.x = Math.round(figma.viewport.center.x - node.width / 2);
  node.y = Math.round(figma.viewport.center.y - node.height / 2);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

// ─── Storybook bulk insert: optional labels + wrapped-grid layout ────────────

// Wrap a materialised component in a named hug frame. The wrapper's NAME is the
// label (Figma renders it above the frame on canvas) — no caption text node, so
// it isn't duplicated. The wrapper also gives layoutGrid a stable, padded
// bounding box so rows don't collide.
function wrapWithLabel(el, label) {
  const wrapper = figma.createFrame();
  wrapper.name = label;
  wrapper.layoutMode = 'VERTICAL';
  wrapper.primaryAxisSizingMode = 'AUTO';
  wrapper.counterAxisSizingMode = 'AUTO';
  wrapper.paddingTop = 12; wrapper.paddingBottom = 12;
  wrapper.paddingLeft = 12; wrapper.paddingRight = 12;
  wrapper.fills = [];
  wrapper.clipsContent = false;
  el.name = 'component';            // neutral inner name so it isn't a second label
  wrapper.appendChild(el);
  return wrapper;
}

// Arrange the just-placed nodes left-to-right (wrapping at a max row width),
// then drop the whole group into empty space so successive inserts don't stack
// on top of each other or existing content: below all other page content if
// any exists, otherwise centered on the viewport.
// True rendered footprint of a node — uses absoluteBoundingBox so that
// content overflowing a frame (clipsContent:false) is counted, otherwise rows
// would be spaced by the too-small frame .height and items would overlap.
function footprint(n) {
  const b = n.absoluteBoundingBox;
  if (b && b.width && b.height) return { w: b.width, h: b.height };
  return { w: n.width || 0, h: n.height || 0 };
}

function layoutGrid(nodes) {
  const MAX_ROW = 1200, GAP_X = 40, GAP_Y = 72, GROUP_GAP = 96;
  let x = 0, y = 0, rowH = 0;
  for (const n of nodes) {
    const fp = footprint(n);
    if (x > 0 && x + fp.w > MAX_ROW) { x = 0; y += rowH + GAP_Y; rowH = 0; }
    n.x = x; n.y = y;
    x += fp.w + GAP_X;
    if (fp.h > rowH) rowH = fp.h;
  }

  // Bounds of the freshly laid-out group (origin-relative, true footprints).
  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
  for (const n of nodes) {
    const fp = footprint(n);
    if (n.x < gMinX) gMinX = n.x;
    if (n.y < gMinY) gMinY = n.y;
    if (n.x + fp.w > gMaxX) gMaxX = n.x + fp.w;
    if (n.y + fp.h > gMaxY) gMaxY = n.y + fp.h;
  }

  // Existing top-level content (excluding what we just inserted), true bounds.
  const isNew = new Set(nodes);
  let eMaxY = -Infinity, eMinX = Infinity;
  for (const c of figma.currentPage.children) {
    if (isNew.has(c)) continue;
    const b = c.absoluteBoundingBox || { x: c.x, y: c.y, width: c.width, height: c.height };
    if (b.y + b.height > eMaxY) eMaxY = b.y + b.height;
    if (b.x < eMinX) eMinX = b.x;
  }

  let targetX, targetY;
  if (eMaxY !== -Infinity) {
    // Drop below everything already on the page, left-aligned to it.
    targetX = eMinX;
    targetY = eMaxY + GROUP_GAP;
  } else {
    // Empty page → center on the viewport.
    targetX = figma.viewport.center.x - (gMaxX - gMinX) / 2;
    targetY = figma.viewport.center.y - (gMaxY - gMinY) / 2;
  }

  const dx = targetX - gMinX, dy = targetY - gMinY;
  for (const n of nodes) { n.x = Math.round(n.x + dx); n.y = Math.round(n.y + dy); }
}

// Walk an inserted node tree and tally which fields carry a bound Variable
// (e.g. { fills: 1, strokes: 1, topLeftRadius: 1, ... }), so the /verify
// self-report can prove token binding — not just geometry — from the bridge.
function collectBoundFields(node, acc) {
  const bv = node.boundVariables;
  if (bv) for (const k of Object.keys(bv)) acc[k] = (acc[k] || 0) + 1;
  const kids = node.children;
  if (kids) for (let i = 0; i < kids.length; i++) collectBoundFields(kids[i], acc);
  return acc;
}

// Insert N captured roots sequentially (font loads must not race), optionally
// labelled, then lay them out in a centered grid. Emits progress per item.
async function insertNodes(items, withLabels) {
  const varMap = await sorbVarMap();
  const placed = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let el = await materialize(item.node, varMap);
    if (withLabels) el = wrapWithLabel(el, item.label || 'Component');
    figma.currentPage.appendChild(el);
    placed.push(el);
    figma.ui.postMessage({ type: 'insert-progress', done: i + 1, total: items.length });
  }
  layoutGrid(placed);
  figma.currentPage.selection = placed;
  figma.viewport.scrollAndZoomIntoView(placed);
  // Self-report each inserted root's post-layout bbox + which fields actually carry a
  // bound Variable so the UI can POST it to the bridge /verify endpoint (main thread
  // has no fetch — the UI does it). The boundFields tally makes token binding
  // machine-assertable from /verify/latest, the same way bbox made geometry assertable.
  for (let i = 0; i < placed.length; i++) {
    try {
      const n = placed[i];
      const storyId = items[i] && items[i].storyId;
      if (!storyId) continue;
      const bbox = { width: n.width, height: n.height, x: n.x, y: n.y };
      const boundFields = collectBoundFields(n, {});
      figma.ui.postMessage({ type: 'sorb-verify', storyId: storyId, bbox: bbox, meta: { boundFields: boundFields } });
    } catch (e) {
      // verify reporting is best-effort — never let it break the insert
    }
  }
  return placed.length;
}

figma.ui.onmessage = (msg) => {
  if (msg.type === 'reload-tokens') sendTokens('manual');
  else if (msg.type === 'set-auto') { if (msg.enabled) startAutoPoll(); else stopAutoPoll(); }
  else if (msg.type === 'sync-variables') {
    syncVariables(msg.tokens)
      .then((r) => figma.ui.postMessage({
        type: 'sync-result',
        created: r.created, updated: r.updated, skipped: r.skipped, collection: r.collection,
      }))
      .catch((err) => figma.ui.postMessage({ type: 'error', message: String(err) }));
  }
  else if (msg.type === 'insert-node') {
    insertNode(msg.node)
      .then(() => figma.ui.postMessage({ type: 'insert-result', ok: true, count: 1 }))
      .catch((err) => figma.ui.postMessage({ type: 'error', message: String(err) }));
  }
  else if (msg.type === 'insert-nodes') {
    insertNodes(msg.items || [], !!msg.withLabels)
      .then((n) => figma.ui.postMessage({ type: 'insert-result', ok: true, count: n }))
      .catch((err) => figma.ui.postMessage({ type: 'error', message: String(err) }));
  }
  else if (msg.type === 'createVariantVariables') {
    // payload: { variantId: string, tokens: Array<{ id, cssVar, tier }> }
    createVariantVariables(msg.tokens || [])
      .then((r) => figma.ui.postMessage({ type: 'createVariantVariablesDone', count: r.created }))
      .catch((err) => figma.ui.postMessage({ type: 'error', message: String(err) }));
  }
  else if (msg.type === 'deprecateVariantVariables') {
    // payload: { variantId: string, tokenIdPrefix: string }
    deprecateVariantVariables(msg.tokenIdPrefix)
      .then((r) => figma.ui.postMessage({ type: 'deprecateVariantVariablesDone', count: r.renamed }))
      .catch((err) => figma.ui.postMessage({ type: 'error', message: String(err) }));
  }
  else if (msg.type === 'sorb-export-variables') {
    // "Export variables" action — collects this file's Variables as a
    // resolved-map artifact; the UI does the POST /tokens/figma (main thread
    // has no fetch).
    exportVariablesArtifact()
      .then((artifact) => figma.ui.postMessage({ type: 'sorb-export-result', ok: true, artifact: artifact }))
      .catch((err) => figma.ui.postMessage({ type: 'sorb-export-result', ok: false, error: String(err) }));
  }
  else if (msg.type === 'sorb-ui-ready') {
    // UI-requested restore. The eager send at startup can race the iframe load
    // (a postMessage before the UI listens is dropped) — replying to the UI's
    // own ready ping guarantees delivery; hydrate on the UI side is idempotent.
    figma.clientStorage.getAsync('sorb.settings')
      .then((data) => figma.ui.postMessage({ type: 'sorb-restore', data: data || {} }))
      .catch((e) => figma.ui.postMessage({ type: 'sorb-restore', data: {} }));
  }
  else if (msg.type === 'sorb-persist') {
    // UI mirrors its full settings blob here on every change → durable store.
    figma.clientStorage.setAsync('sorb.settings', msg.data || {}).catch((e) => {});
  }
  else if (msg.type === 'sorb-clear') {
    // Reset settings — wipe the durable store, then tell the UI to finish up.
    figma.clientStorage.setAsync('sorb.settings', {})
      .then(() => figma.ui.postMessage({ type: 'sorb-cleared' }))
      .catch((e) => figma.ui.postMessage({ type: 'sorb-cleared' }));
  }
  else if (msg.type === 'notify') figma.notify(msg.message);
  else if (msg.type === 'close') figma.closePlugin();
};

// Push the current tokens as soon as the UI is up. The UI follows with a
// `set-auto` message that starts/stops the watch based on its saved toggle.
sendTokens('open');

// Forward the Figma user's display name so the UI can show ambient teammate
// activity (self excluded) and post its own verify activity (U3 · F8).
// figma.currentUser requires the "currentuser" manifest permission; guard so a
// missing permission (or any access error) degrades to null instead of throwing.
try {
  figma.ui.postMessage({ type: 'figmaUser', name: (figma.currentUser && figma.currentUser.name) || null });
} catch (e) {
  figma.ui.postMessage({ type: 'figmaUser', name: null });
}
