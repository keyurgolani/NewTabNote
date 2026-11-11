'use strict';

// #26 slice 1: js/states/core/ is host-neutral under #12's module rules, as #20's trust core is.
// check:boundaries runs eslint.config.mjs's states-global and states-import rules over a copy of
// js/ with forbidden code added to the states core, and the repository's states core has no hit
// and no row. It imports nothing of the trust core, whose views move onto its presenter.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const boundaries = require('../scripts/check-boundaries.js');

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('check:boundaries on js/states/core/ (#26 slice 1)', () => {
  it('counts no-undef there as states-global', () => {
    const message = { ruleId: 'no-undef', message: "'chrome' is not defined." };
    assert.equal(boundaries.ruleOf(message, 'js/states/core/presenter.js'), 'states-global');
    assert.equal(boundaries.ruleOf(message, 'js/states/ui/region.js'), 'core-global');
  });

  it('has no ledger row for the states rules, so the states core has no exemption', () => {
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, boundaries.LEDGER), 'utf8'));
    assert.deepEqual(ledger.rows.filter(row => row.file.startsWith('js/states/') || /^states-/.test(row.rule)), []);
  });

  it('keeps the states core host-neutral in a copy of js/: no browser API, legacy global, or outside import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-states-boundaries-'));
    temps.push(root);
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    fs.mkdirSync(path.join(root, 'js', 'states', 'core'), { recursive: true });
    fs.writeFileSync(path.join(root, 'js', 'states', 'core', 'probe.js'), [
      "import '../../storage.js';",
      "import '../../trust/core/vocabulary.js';",
      "import '../../ui/part-state.js';",
      'export const later = name => import(`./${name}.js`);',
      // Allowed: the states core itself, kernel core, the registry kit, and the vendored Valibot
      "import { STATES } from './vocabulary.js';",
      "import { unknown } from '../../kernel/core/contracts/outcomes.js';",
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
      'export const ok = [STATES, unknown, defineFamily, v, new Map(), JSON.stringify({}), Date.now()];',
    ].join('\n'));

    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    for (const expected of [
      'js/states/core/probe.js: 4 states-import hits no ledger row covers',
      'js/states/core/probe.js: 6 states-global hits no ledger row covers',
    ]) {
      assert.ok(output.includes(expected), `"${expected}" missing from:\n${output}`);
    }
    assert.doesNotMatch(output, /core-global|core-import|registry-|trust-/);
    assert.equal(output.split('\n').filter(line => line.startsWith('  - ')).length, 2, output);
  });
});
