// Unit tests for lib/token-mapping.js — the pure (no figma.*) helpers behind
// the "Export variables" plugin action (FLS v0.5.0 P1). Run with `node --test`
// (zero new deps, matching the rest of the Sorb polyrepo's test convention).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toTokenName,
  toDottedId,
  rgbaToHex,
  toTokenValue,
  tierFromCollectionName,
  figmaTypeToTokenType,
  toResolvedEntry,
} = require('../lib/token-mapping.js');

describe('toTokenName (slash → kebab, full path)', () => {
  it('joins the full slash path with dashes, not just the leaf', () => {
    assert.equal(toTokenName('button/primary/bg/default'), 'button-primary-bg-default');
  });
  it('trims whitespace around each segment', () => {
    assert.equal(toTokenName(' color / action / primary '), 'color-action-primary');
  });
  it('single-segment name passes through unchanged', () => {
    assert.equal(toTokenName('radius'), 'radius');
  });
});

describe('toDottedId (slash → dot, inverse of idToVarName)', () => {
  it('converts a slash Variable name to a dotted DTCG id', () => {
    assert.equal(toDottedId('button/primary/bg/default'), 'button.primary.bg.default');
  });
});

describe('rgbaToHex / toTokenValue (COLOR + FLOAT)', () => {
  it('opaque color → 6-digit hex, no alpha suffix', () => {
    assert.equal(rgbaToHex({ r: 0.058823529, g: 0.396078431, b: 0.937254902, a: 1 }), '#0f65ef');
  });
  it('translucent color → 8-digit hex with alpha suffix', () => {
    const hex = rgbaToHex({ r: 1, g: 1, b: 1, a: 0.5 });
    assert.equal(hex.length, 9);
    assert.equal(hex.slice(0, 7), '#ffffff');
  });
  it('toTokenValue COLOR delegates to rgbaToHex', () => {
    assert.equal(toTokenValue('COLOR', { r: 0, g: 0, b: 0, a: 1 }), '#000000');
  });
  it('toTokenValue FLOAT 0 stays bare "0" (no px)', () => {
    assert.equal(toTokenValue('FLOAT', 0), '0');
  });
  it('toTokenValue FLOAT non-zero gets a px suffix', () => {
    assert.equal(toTokenValue('FLOAT', 4), '4px');
  });
  it('toTokenValue STRING/BOOLEAN stringifies as-is', () => {
    assert.equal(toTokenValue('STRING', 'Inter'), 'Inter');
    assert.equal(toTokenValue('BOOLEAN', true), 'true');
  });
  it('toTokenValue null/undefined value → empty string', () => {
    assert.equal(toTokenValue('COLOR', null), '');
    assert.equal(toTokenValue('FLOAT', undefined), '');
  });
});

describe('tierFromCollectionName', () => {
  it('maps the three known tier collections', () => {
    assert.equal(tierFromCollectionName('Primitives'), 'primitive');
    assert.equal(tierFromCollectionName('Semantic'), 'semantic');
    assert.equal(tierFromCollectionName('Component'), 'component');
  });
  it('an unknown collection name → undefined (tier omitted, not guessed)', () => {
    assert.equal(tierFromCollectionName('Icons'), undefined);
    assert.equal(tierFromCollectionName(''), undefined);
    assert.equal(tierFromCollectionName(undefined), undefined);
  });
});

describe('figmaTypeToTokenType', () => {
  it('COLOR → "color"', () => {
    assert.equal(figmaTypeToTokenType('COLOR', '#0f65ef'), 'color');
  });
  it('FLOAT formatted with a px suffix → "dimension"', () => {
    assert.equal(figmaTypeToTokenType('FLOAT', '4px'), 'dimension');
  });
  it('FLOAT formatted without a px suffix (the 0 case) → "number"', () => {
    assert.equal(figmaTypeToTokenType('FLOAT', '0'), 'number');
  });
  it('STRING/BOOLEAN → "string"', () => {
    assert.equal(figmaTypeToTokenType('STRING', 'Inter'), 'string');
    assert.equal(figmaTypeToTokenType('BOOLEAN', 'true'), 'string');
  });
});

describe('toResolvedEntry — the full per-Variable → resolved-map-entry mapping', () => {
  it('a semantic color Variable', () => {
    const entry = toResolvedEntry(
      'color/action/primary',
      'Semantic',
      'COLOR',
      { r: 0.058823529, g: 0.396078431, b: 0.937254902, a: 1 },
    );
    assert.deepEqual(entry, {
      id: 'color.action.primary',
      cssVar: '--color-action-primary',
      value: '#0f65ef',
      type: 'color',
      tier: 'semantic',
    });
  });

  it('a component-tier dimension Variable', () => {
    const entry = toResolvedEntry('radius/control', 'Component', 'FLOAT', 4);
    assert.deepEqual(entry, {
      id: 'radius.control',
      cssVar: '--radius-control',
      value: '4px',
      type: 'dimension',
      tier: 'component',
    });
  });

  it('a FLOAT-0 Variable is type "number", not "dimension"', () => {
    const entry = toResolvedEntry('spacing/none', 'Primitives', 'FLOAT', 0);
    assert.equal(entry.value, '0');
    assert.equal(entry.type, 'number');
    assert.equal(entry.tier, 'primitive');
  });

  it('a Variable in an unrecognized collection omits `tier` entirely', () => {
    const entry = toResolvedEntry('icon/size', 'Icons', 'FLOAT', 16);
    assert.equal('tier' in entry, false);
    assert.deepEqual(Object.keys(entry).sort(), ['cssVar', 'id', 'type', 'value']);
  });
});
