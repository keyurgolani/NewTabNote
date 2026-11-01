// #20 slice 2's permissions and destinations (AC4): Chrome's grants against the manifest, each
// difference with its status and incident, and the packaged list of uncovered egress held to
// the manifest's CSP and to the shipped files that reach each origin.
// e2e/trust-permissions.spec.js runs the same check against Chromium's chrome.permissions.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCheck } from '../../js/trust/core/checks.js';
import { UNCOVERED_EGRESS, UNCOVERED_ORIGINS } from '../../js/trust/core/providers/egress.js';
import { comparePermissions, permissions } from '../../js/trust/core/providers/permissions.js';
import { MANIFEST } from './trust-provider-support.mjs';
import { manualClock, realTimers } from './trust-support.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');

/**
 * The check against Chrome granting `granted`
 * @param {{permissions?: string[], origins?: string[]}} granted
 * @param {object} [manifest]
 */
const checkWith = (granted, manifest = MANIFEST) =>
  runCheck(
    {
      id: 'permissions',
      operation: 'permissions.compare-manifest',
      observes: ['grant-missing', 'permission-changed'],
      costClass: 'local-cheap',
      timeoutMs: 5000,
      freshnessMs: 60_000,
      check: context => permissions.check(context),
    },
    { context: { permissions: { getAll: async () => granted }, manifest }, clock: manualClock(), timers: realTimers },
  );

// What Chromium grants this manifest (e2e/trust-permissions.spec.js saw it): every declared
// permission and host, and newTabPageOverride, which chrome_url_overrides.newtab implies
const DECLARED = Object.freeze({ permissions: [...MANIFEST.permissions, 'newTabPageOverride'], origins: [...MANIFEST.host_permissions] });

describe('permissions and destinations (#20 slice 2)', () => {
  it("verifies when Chrome grants exactly what the manifest declares, counting the grants and the egress list", async () => {
    const { receipt, faults } = await checkWith(DECLARED);
    assert.equal(receipt.status, 'verified');
    assert.deepEqual(receipt.evidence, {
      count: MANIFEST.permissions.length + 1 + MANIFEST.host_permissions.length,
      records: UNCOVERED_EGRESS.length,
    });
    assert.deepEqual(faults, []);
  });

  it('a host the user withheld site access from is degraded, AI only', async () => {
    const granted = { ...DECLARED, origins: DECLARED.origins.filter(origin => origin !== 'https://api.openai.com/*') };
    const { receipt, faults } = await checkWith(granted);
    assert.deepEqual([receipt.status, receipt.evidence.pending], ['degraded', 1]);
    assert.deepEqual(faults.map(fault => [fault.faultCode, fault.subjectId, fault.affected]), [['grant-missing', null, ['ai']]]);
  });

  it('a declared API permission missing, or one granted outside the manifest, is action-required, each with its incident', async () => {
    const missing = await checkWith({ ...DECLARED, permissions: DECLARED.permissions.filter(name => name !== 'contextMenus') });
    assert.equal(missing.receipt.status, 'action-required');
    assert.deepEqual(missing.faults.map(fault => [fault.faultCode, fault.subjectId]), [['grant-missing', 'contextMenus']]);
    const extra = await checkWith({ ...DECLARED, permissions: [...DECLARED.permissions, 'bookmarks'] });
    assert.equal(extra.receipt.status, 'action-required');
    assert.deepEqual(extra.faults.map(fault => fault.faultCode), ['permission-changed']);
    // An optional permission the manifest lists is no change
    const optional = await checkWith({ ...DECLARED, permissions: [...DECLARED.permissions, 'bookmarks'] }, {
      ...MANIFEST,
      optional_permissions: ['bookmarks'],
    });
    assert.equal(optional.receipt.status, 'verified');
    // The new tab override is implied only by chrome_url_overrides.newtab
    const { chrome_url_overrides: _, ...noOverride } = MANIFEST;
    const implied = await checkWith(DECLARED, noOverride);
    assert.deepEqual(implied.faults.map(fault => fault.faultCode), ['permission-changed']);
  });

  it('compares origins and permissions as sets, whatever order Chrome answers in', () => {
    const found = comparePermissions(
      { permissions: [...DECLARED.permissions].reverse(), origins: [...DECLARED.origins].reverse() },
      MANIFEST,
    );
    assert.deepEqual([found.missingApis, found.missingOrigins, found.extraApis, found.extraOrigins], [[], [], [], []]);
  });

  it("a getAll that rejects verifies nothing", async () => {
    const { receipt } = await runCheck(
      {
        id: 'permissions',
        operation: 'permissions.compare-manifest',
      observes: ['grant-missing', 'permission-changed'],
        costClass: 'local-cheap',
        timeoutMs: 5000,
        freshnessMs: 60_000,
        check: context => permissions.check(context),
      },
      {
        context: { permissions: { getAll: () => Promise.reject(new Error('no')) }, manifest: MANIFEST },
        clock: manualClock(),
        timers: realTimers,
      },
    );
    assert.equal(receipt.status, 'unverified');
  });
});

describe('the packaged list of uncovered egress (#20 slice 2)', () => {
  it("names every origin the CSP lets a page connect to that isn't a host permission", () => {
    const csp = MANIFEST.content_security_policy.extension_pages;
    const connect = /connect-src ([^;]+)/.exec(csp);
    assert.ok(connect, 'the CSP has a connect-src');
    const sources = connect[1].trim().split(/\s+/).filter(source => source !== "'self'");
    const hosts = MANIFEST.host_permissions.map((/** @type {string} */ origin) => origin.replace(/\/\*$/, ''));
    const uncovered = sources.filter(source => {
      if (source === 'http://localhost:*') return !hosts.includes('http://localhost');
      // An Ollama URL on 127.0.0.1 is one the user enters, which the list leaves out (egress.js),
      // and the CSP reaches it with no host permission (#21 slice 1b, security/changes.json)
      if (source === 'http://127.0.0.1:*') return false;
      return !hosts.includes(source);
    });
    assert.deepEqual(
      uncovered.filter(source => !UNCOVERED_ORIGINS.includes(source)),
      [],
      'the CSP reaches an origin the egress list lacks',
    );
  });

  it('each entry names files that still reach its fixed origins', () => {
    for (const egress of UNCOVERED_EGRESS) {
      const text = egress.sources.map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
      for (const origin of egress.origins.filter(candidate => !candidate.includes('*'))) {
        assert.ok(text.includes(origin.replace(/^https:\/\//, '')), `${egress.id}: no listed file names ${origin}`);
      }
    }
  });
});
