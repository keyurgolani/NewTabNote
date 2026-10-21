// What Moment (#2) loads of #13 (core/messaging/capture-critical.js, #13 AC1): the client,
// the frames and the handshake, the hint channel's frames, and the validators, and no
// operation's schema module but the Moment commands #2 and #35 add to MOMENT_OPERATIONS by PR.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import * as captureCritical from '../../js/kernel/core/messaging/capture-critical.js';
import { importGraph } from './import-graph.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const ENTRY = path.join(ROOT, 'js', 'kernel', 'core', 'messaging', 'capture-critical.js');

/**
 * The operation schema modules Moment may load: none until #2 and #35 add their commands,
 * each with its entry in docs/performance/contracts-size.json under #27's budget rule
 * @type {string[]}
 */
const MOMENT_OPERATIONS = [];

/** Every module capture-critical.js reaches, relative to the repository root */
const graph = [...importGraph(ENTRY)].map(file => path.relative(ROOT, file)).sort();

describe('capture-critical.js (#13, AC1)', () => {
  it('exports the client, the frames and handshake, the hint frames, and the validators, and nothing else', () => {
    assert.deepEqual(Object.keys(captureCritical).sort(), [
      'cancelSchema',
      'cancelledSchema',
      'channelFrameSchema',
      'checkRequest',
      'checkResult',
      'createClient',
      'createLookup',
      'errorSchema',
      'frameSchema',
      'helloSchema',
      'hintSchema',
      'operationOf',
      'pageRequestSchema',
      'pageResponseSchema',
      'readChannelFrame',
      'readFrame',
      'requestSchema',
      'responseSchema',
      'targetSchema',
      'tooLateSchema',
      'welcomeSchema',
    ]);
  });

  it("reaches no operation's schema module but Moment's own", () => {
    const operations = graph.filter(file => file.startsWith('js/kernel/core/contracts/operations/'));
    assert.deepEqual(operations, MOMENT_OPERATIONS);
    // Nor the catalog, the coordinator's own queries, an adapter, or the application kernel
    assert.deepEqual(
      graph.filter(file =>
        /contracts\/(?:commands|queries|system)\.js$|messaging\/system-operations\.js$|adapters\/|application\//.test(
          file,
        ),
      ),
      [],
    );
  });

  it('loads as plain modules: core and Valibot only', () => {
    assert.ok(
      graph.every(file => file.startsWith('js/kernel/core/') || file === 'js/lib/valibot/index.mjs'),
      graph.join('\n'),
    );
    assert.ok(graph.includes('js/lib/valibot/index.mjs'));
  });
});
