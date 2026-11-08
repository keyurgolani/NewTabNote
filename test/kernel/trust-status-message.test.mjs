// #20 slice 4c, PR 2: the status read's answer (js/trust/core/status-message.js). The worker
// sends trust.summary narrowed to what the status lines and cards read, and a page takes an
// answer only when it's exactly that, each value one this build registers, since no schema
// checks it: the page loads neither Valibot nor #13's client. Anything else is no answer.
//
// status-message.js is new in this PR, so it loads inside each case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const AT = Date.parse('2026-11-07T18:42:00');

/** A cause as the summary has it: an incident's, with its id and time */
const SUMMARY_CAUSE = Object.freeze({
  from: 'incident',
  providerId: 'storage',
  faultCode: 'migration-blocked',
  errorCode: 'space-short',
  severity: 'degraded',
  consequenceKey: null,
  incidentId: '00000000-0000-4000-8000-000000000001',
  at: AT,
});

/** A summary with every field trust.summary has */
const SUMMARY = Object.freeze({
  worstCore: 'degraded',
  capture: 'safe',
  actionRequired: 1,
  route: 'trust',
  records: 'open',
  groups: [
    { group: 'storage', providers: 2, needsAction: 1, worst: 'degraded', checkedAt: AT, cause: SUMMARY_CAUSE },
    { group: 'vault', providers: 1, needsAction: 0, worst: 'verified', checkedAt: null, cause: null },
  ],
});

/** What the status read answers for it */
const STATUS = Object.freeze({
  capture: 'safe',
  route: 'trust',
  records: 'open',
  groups: [
    {
      group: 'storage',
      needsAction: 1,
      checkedAt: AT,
      cause: {
        from: 'incident',
        providerId: 'storage',
        faultCode: 'migration-blocked',
        errorCode: 'space-short',
        severity: 'degraded',
        consequenceKey: null,
      },
    },
    { group: 'vault', needsAction: 0, checkedAt: null, cause: null },
  ],
});

/** STATUS with `edit` applied to a deep copy of it */
const edited = (/** @type {(status: any) => void} */ edit) => {
  const copy = structuredClone(STATUS);
  edit(copy);
  return copy;
};

describe("the status read's answer (#20 slice 4c)", () => {
  it('is trust.summary narrowed to what the lines and cards read, and no more', async () => {
    const { TRUST_STATUS_MESSAGE, narrowStatus } = await import('../../js/trust/core/status-message.js');
    assert.equal(TRUST_STATUS_MESSAGE, 'trust.status');
    assert.deepEqual(narrowStatus(/** @type {any} */ (SUMMARY)), STATUS);
  });

  it('is taken as it is when it holds exactly those fields, each one this build registers', async () => {
    const { statusFrom } = await import('../../js/trust/core/status-message.js');
    assert.deepEqual(statusFrom(structuredClone(STATUS)), STATUS);
    // A receipt's cause, with a consequence and no fault or severity, and no groups at all
    const receipt = edited(status => {
      status.groups[0].cause = {
        from: 'receipt',
        providerId: 'capture',
        faultCode: null,
        errorCode: null,
        severity: null,
        consequenceKey: 'storage.quota',
      };
    });
    assert.deepEqual(statusFrom(receipt), receipt);
    assert.deepEqual(statusFrom({ ...STATUS, groups: [] }), { ...STATUS, groups: [] });
  });

  it('is no answer with a field more or less, anywhere in it', async () => {
    const { statusFrom } = await import('../../js/trust/core/status-message.js');
    for (const [why, answer] of /** @type {Array<[string, unknown]>} */ ([
      ["the summary's worstCore", { ...STATUS, worstCore: 'verified' }],
      ['no records', edited(status => delete status.records)],
      ["a group's providers", edited(status => (status.groups[1].providers = 1))],
      ['a group with no checkedAt', edited(status => delete status.groups[1].checkedAt)],
      ["a cause's incident id", edited(status => (status.groups[0].cause.incidentId = SUMMARY_CAUSE.incidentId))],
      ['a cause with no consequence key', edited(status => delete status.groups[0].cause.consequenceKey)],
    ])) {
      assert.equal(statusFrom(answer), null, why);
    }
  });

  it("is no answer with a value this build doesn't register", async () => {
    const { statusFrom } = await import('../../js/trust/core/status-message.js');
    for (const [why, answer] of /** @type {Array<[string, unknown]>} */ ([
      ['capture', { ...STATUS, capture: 'maybe' }],
      ['route', { ...STATUS, route: 'moment' }],
      ['records', { ...STATUS, records: 'gone' }],
      ['a group', edited(status => (status.groups[1].group = 'cloud'))],
      ['a group twice', edited(status => (status.groups[1].group = 'storage'))],
      ['a provider', edited(status => (status.groups[0].cause.providerId = 'quantum'))],
      ['a fault', edited(status => (status.groups[0].cause.faultCode = 'gremlins'))],
      ['an error', edited(status => (status.groups[0].cause.errorCode = 'my-divorce-plans'))],
      ['a severity', edited(status => (status.groups[0].cause.severity = 'dire'))],
      ['a cause from elsewhere', edited(status => (status.groups[0].cause.from = 'rumour'))],
      ['a consequence key', edited(status => (status.groups[0].cause.consequenceKey = 'Out of space'))],
      ['a count of needs', edited(status => (status.groups[0].needsAction = -1))],
      ['a count of needs that is no whole number', edited(status => (status.groups[0].needsAction = 1.5))],
      ['a time', edited(status => (status.groups[0].checkedAt = 'yesterday'))],
      ['more groups than there are', { ...STATUS, groups: Array.from({ length: 10 }, () => STATUS.groups[1]) }],
    ])) {
      assert.equal(statusFrom(answer), null, why);
    }
  });

  it('is no answer for anything but such an object: none, a refusal, an array, or one with a prototype', async () => {
    const { statusFrom } = await import('../../js/trust/core/status-message.js');
    for (const answer of [
      undefined,
      null,
      'trust',
      { error: 'request-refused' },
      { error: 'unavailable' },
      [STATUS],
      Object.assign(Object.create({ inherited: true }), structuredClone(STATUS)),
      { ...STATUS, groups: 'storage' },
    ]) {
      assert.equal(statusFrom(answer), null, JSON.stringify(answer));
    }
  });
});
