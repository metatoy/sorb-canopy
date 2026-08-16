// Pure helpers for mapping Figma Variables ↔ Sorb's resolved-map token shape
// ({ id, cssVar, value, tier, type }, matching @sorb/core's ResolvedToken /
// GET /tokens/resolved). No `figma.*` calls anywhere in this file — safe to
// require() from tests (node:test) without a Figma runtime.
//
// code.js (the plugin's main thread) defines byte-identical copies of these
// same functions inline, alongside the figma.variables.* calls that actually
// walk the file. The Figma plugin sandbox has no module loader and this repo
// has no build step (CLAUDE.md hard rule), so code.js can't require() this
// file directly — keep the two copies in sync. This file is the one under
// test (see ../tests/token-mapping.test.js); code.js's copy is exercised via
// the HID visual-QA harness against the real plugin.

// Figma Variable names are grouped with "/" mirroring the DTCG path
// (e.g. "button/primary/bg/default"). Kebab form ("button-primary-bg-default")
// is the FULL slash path, not leaf-only — leaf-only would collide across tiers.
const toTokenName = (name) => name.split('/').map((s) => s.trim()).join('-');

// Dotted DTCG id form ("button.primary.bg.default") — the inverse of the
// dots→slashes idToVarName() used elsewhere in code.js.
const toDottedId = (name) => name.split('/').join('.');

const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');

const rgbaToHex = ({ r, g, b, a = 1 }) => {
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return a < 1 ? `${hex}${toHex(a)}` : hex;
};

// Map a resolved Figma variable value to a CSS-ready token value string.
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

// One Figma Variable Collection per DTCG tier — mirrors code.js's
// TIER_COLLECTION exactly.
const TIER_COLLECTION = { primitive: 'Primitives', semantic: 'Semantic', component: 'Component' };
const TIER_BY_COLLECTION_NAME = Object.keys(TIER_COLLECTION).reduce((acc, tier) => {
  acc[TIER_COLLECTION[tier]] = tier;
  return acc;
}, {});

// Collection name → DTCG tier ('primitive'|'semantic'|'component'), or
// undefined for a collection Sorb doesn't recognize — the exporter omits
// `tier` entirely in that case, per the resolved-map contract.
const tierFromCollectionName = (name) => TIER_BY_COLLECTION_NAME[name];

// Figma resolvedType (+ the already CSS-formatted value) → DTCG token `type`.
// FLOAT is 'dimension' when the formatted value carries a unit ("...px"),
// else 'number' (the FLOAT-0 case, which toTokenValue renders as bare "0").
const figmaTypeToTokenType = (resolvedType, cssValue) => {
  if (resolvedType === 'COLOR') return 'color';
  if (resolvedType === 'FLOAT') {
    return typeof cssValue === 'string' && cssValue.indexOf('px') !== -1 ? 'dimension' : 'number';
  }
  return 'string'; // STRING / BOOLEAN
};

// DTCG font-weight tokens (font.weight.*) are unitless numbers — the one
// FLOAT family the px formatting must not touch. Figma stores bare FLOATs;
// exporting "400px" is both unfaithful and a guaranteed /verify/figma
// mismatch against the DTCG source (BLOCKERS-v5 #2).
const isUnitlessTokenId = (id) => id === 'font.weight' || id.indexOf('font.weight.') === 0;

// Build one resolved-map entry for a single Figma Variable, given its
// already-resolved value (alias already followed) and the name of the
// collection it lives in. Pure — code.js's collectResolvedTokens() does the
// figma.variables.* async work and hands in plain data matching this shape.
const toResolvedEntry = (variableName, collectionName, resolvedType, value) => {
  const id = toDottedId(variableName);
  let cssValue = toTokenValue(resolvedType, value);
  if (resolvedType === 'FLOAT' && isUnitlessTokenId(id)) cssValue = String(value);
  const entry = {
    id,
    cssVar: '--' + toTokenName(variableName),
    value: cssValue,
    type: figmaTypeToTokenType(resolvedType, cssValue),
  };
  const tier = tierFromCollectionName(collectionName);
  if (tier) entry.tier = tier;
  return entry;
};

const mapping = {
  toTokenName,
  toDottedId,
  toHex,
  rgbaToHex,
  toTokenValue,
  TIER_COLLECTION,
  tierFromCollectionName,
  figmaTypeToTokenType,
  isUnitlessTokenId,
  toResolvedEntry,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = mapping;
}
