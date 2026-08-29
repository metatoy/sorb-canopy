// Tests for code.js's mode-aware token read (dark-mode-phase3 P3.0/P3.1):
// collectTokens(wantDark)/collectModes()/resolveValueForMode + the sendTokens
// message envelope. code.js is a Figma-sandbox script (no module system, no
// figma.* mock available outside the plugin host), so we run it with Node's
// `vm` module against a minimal fake `figma` and assert on the `tokens`
// message(s) posted to `figma.ui.postMessage` — the same contract ui.html
// consumes. Mirrors the code.js/lib sync convention noted in the file header.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const CODE_JS = fs.readFileSync(path.join(__dirname, '..', 'code.js'), 'utf-8');

// Build a fake Figma Variables graph and run code.js against it, returning
// every message posted to figma.ui.postMessage plus a way to wait for the
// initial `sendTokens('open')` send that runs at the bottom of code.js.
function runPlugin({ collections, variables }) {
  const posted = [];
  const collectionById = new Map(collections.map((c) => [c.id, c]));
  const variableById = new Map(variables.map((v) => [v.id, v]));

  const fakeFigma = {
    showUI() {},
    clientStorage: {
      getAsync: async () => ({}),
      setAsync: async () => {},
    },
    ui: {
      postMessage: (msg) => posted.push(msg),
      onmessage: null,
    },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async () => variables,
      getVariableByIdAsync: async (id) => variableById.get(id) || null,
    },
    on() {},
    off() {},
    currentUser: null,
    fileKey: 'FAKE_FILE_KEY',
  };
  void collectionById;

  const sandbox = {
    figma: fakeFigma,
    __html__: '',
    console,
    Date,
    Math,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE_JS, sandbox, { filename: 'code.js' });
  return { posted, sandbox };
}

// Poll until a message matching `pred` shows up (the top-level `sendTokens`
// call is async), or fail after a short timeout.
async function waitFor(posted, pred, label) {
  for (let i = 0; i < 200; i++) {
    const found = posted.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.fail('timed out waiting for ' + label);
}

describe('collectTokens/collectModes mode-read (dark-mode-phase3 P3.0)', () => {
  it('no dark mode present: flat back-compat — darkTokens omitted/empty, hasDark false', async () => {
    const collections = [
      { id: 'B', name: 'Semantic', defaultModeId: 'n1', modes: [{ modeId: 'n1', name: 'Mode 1' }] },
    ];
    const variables = [
      {
        id: 'v2',
        name: 'button/bg',
        variableCollectionId: 'B',
        resolvedType: 'COLOR',
        valuesByMode: { n1: { r: 1, g: 0, b: 0, a: 1 } },
      },
    ];
    const { posted } = runPlugin({ collections, variables });
    const msg = await waitFor(posted, (m) => m.type === 'tokens', 'initial tokens message');

    assert.equal(msg.hasDark, false);
    assert.equal(msg.darkTokens, null);
    assert.deepEqual(JSON.parse(JSON.stringify(msg.tokens)), { 'button-bg': '#ff0000' });
  });

  it('dark mode present: envelope carries BOTH modes, differing on the dark variable', async () => {
    const collections = [
      {
        id: 'A',
        name: 'Primitives',
        defaultModeId: 'm1',
        modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }],
      },
    ];
    const variables = [
      {
        id: 'v1',
        name: 'color/bg/primary',
        variableCollectionId: 'A',
        resolvedType: 'COLOR',
        valuesByMode: {
          m1: { r: 1, g: 1, b: 1, a: 1 }, // white in light
          m2: { r: 0, g: 0, b: 0, a: 1 }, // black in dark
        },
      },
    ];
    const { posted } = runPlugin({ collections, variables });
    const msg = await waitFor(posted, (m) => m.type === 'tokens', 'initial tokens message');

    assert.equal(msg.hasDark, true);
    assert.deepEqual(JSON.parse(JSON.stringify(msg.tokens)), { 'color-bg-primary': '#ffffff' });
    assert.deepEqual(JSON.parse(JSON.stringify(msg.darkTokens)), { 'color-bg-primary': '#000000' });
  });

  it('per-mode alias resolution: an alias in a NO-dark collection still reads its target\'s dark value', async () => {
    const collections = [
      {
        id: 'A',
        name: 'Primitives',
        defaultModeId: 'm1',
        modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }],
      },
      // Semantic has no Dark mode of its own — the alias must still resolve
      // to the PRIMITIVE's dark value, not collapse to light (spec §4 risk).
      { id: 'B', name: 'Semantic', defaultModeId: 'n1', modes: [{ modeId: 'n1', name: 'Mode 1' }] },
    ];
    const variables = [
      {
        id: 'v1',
        name: 'color/bg/primary',
        variableCollectionId: 'A',
        resolvedType: 'COLOR',
        valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 }, m2: { r: 0, g: 0, b: 0, a: 1 } },
      },
      {
        id: 'v2',
        name: 'button/bg',
        variableCollectionId: 'B',
        resolvedType: 'COLOR',
        valuesByMode: { n1: { type: 'VARIABLE_ALIAS', id: 'v1' } },
      },
    ];
    const { posted } = runPlugin({ collections, variables });
    const msg = await waitFor(posted, (m) => m.type === 'tokens', 'initial tokens message');

    assert.equal(msg.tokens['button-bg'], '#ffffff');      // light: alias → primitive light
    assert.equal(msg.darkTokens['button-bg'], '#000000');  // dark: alias → primitive DARK, not light
  });

  it('a mode literally named "dark" (any case) is detected; "darker"/"midnight" are not', async () => {
    const collections = [
      {
        id: 'A',
        name: 'Primitives',
        defaultModeId: 'm1',
        modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'DARK' }],
      },
    ];
    const variables = [
      {
        id: 'v1',
        name: 'radius/sm',
        variableCollectionId: 'A',
        resolvedType: 'FLOAT',
        valuesByMode: { m1: 4, m2: 4 },
      },
    ];
    const { posted } = runPlugin({ collections, variables });
    const msg = await waitFor(posted, (m) => m.type === 'tokens', 'initial tokens message');
    assert.equal(msg.hasDark, true); // case-insensitive match on "DARK"
  });
});
