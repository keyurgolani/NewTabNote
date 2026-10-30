'use strict';

// #20 slice 1: js/trust/core/ is host-neutral under #12's module rules. check:boundaries runs
// eslint.config.mjs's trust-global and trust-import rules over a copy of js/ with forbidden
// code added to the trust core, and the repository's own trust core has no hit and no row.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const boundaries = require('../scripts/check-boundaries.js');

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-trust-boundaries-'));
  temps.push(dir);
  return dir;
}

describe('check:boundaries on js/trust/core/ (#20 slice 1)', () => {
  it('counts no-undef there as trust-global', () => {
    assert.equal(boundaries.ruleOf({ ruleId: 'no-undef', message: "'chrome' is not defined." }, 'js/trust/core/probe.js'), 'trust-global');
    assert.equal(boundaries.ruleOf({ ruleId: 'no-undef', message: "'chrome' is not defined." }, 'js/trust/ui/view.js'), 'core-global');
  });

  it('has no ledger row for the trust rules, so the trust core has no exemption', () => {
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, boundaries.LEDGER), 'utf8'));
    assert.deepEqual(ledger.rows.filter(row => row.file.startsWith('js/trust/') || /^trust-/.test(row.rule)), []);
  });

  it('keeps the trust core host-neutral in a copy of js/: no browser API, legacy global, or outside import', async () => {
    const root = tempRoot();
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(root, 'js', 'trust', 'core', 'probe.js'), [
      "import '../../storage.js';",
      "import '../../core/logger.js';",
      "import 'https://cdn.example.test/trust.js';",
      'export const later = name => import(`./${name}.js`);',
      // Allowed: the trust core itself, kernel core, the registry kit, and the vendored Valibot
      "import { opaqueId } from './evidence.js';",
      "import { UnavailableError } from '../../kernel/core/contracts/outcomes.js';",
      "import { defineFamily } from '../../kernel/registry/family.js';",
      "import * as v from '../../lib/valibot/index.mjs';",
      // Each a browser API or legacy global
      'export const id = () => chrome.runtime.id;',
      "export const open = () => navigator.locks.request('x', () => {});",
      'export const uuid = () => crypto.randomUUID();',
      'export const kind = typeof document;',
      'export const all = globalThis;',
      'export const wait = () => setTimeout(() => {}, 1);',
      // ECMAScript's own globals are fine
      'export const ok = [opaqueId, UnavailableError, defineFamily, v, new Map(), JSON.stringify({}), Date.now()];',
    ].join('\n'));

    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    for (const expected of [
      'js/trust/core/probe.js: 4 trust-import hits no ledger row covers',
      'js/trust/core/probe.js: 6 trust-global hits no ledger row covers',
    ]) {
      assert.ok(output.includes(expected), `"${expected}" missing from:\n${output}`);
    }
    assert.doesNotMatch(output, /core-global|core-import|registry-/);
    assert.equal(output.split('\n').filter(line => line.startsWith('  - ')).length, 2, output);
  });

  it('counts chrome.storage.local in the trust core, which reaches it only through its settings port', async () => {
    const root = tempRoot();
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'js', 'trust', 'core', 'probe.js'),
      'export const write = area => area.chrome.storage.local.set({});\n',
    );
    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    assert.ok(output.includes('js/trust/core/probe.js: 1 chrome.storage.local hit no ledger row covers'), output);
  });
});
