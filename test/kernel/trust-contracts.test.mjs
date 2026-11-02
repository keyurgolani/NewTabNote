// #20 slice 1's contracts (AC1): trust.summary, trust.report, recovery.incidents,
// trust.verify, recovery.raise, recovery.run, and diagnostics.export as versioned #13
// operations, held to #13's schema lint, read by #13's validators, and answered by the use
// cases within their result schemas. Only the worker's failure events reach js/trust/ and
// NewTabNoteTrust's adapter statically, the new tab's only through import() after a failure
// (#20 slice 1b, R1: no visible change), and capture-critical.js never does.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import * as v from '../../js/lib/valibot/index.mjs';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import { SURFACES } from '../../js/kernel/core/contracts/surfaces.js';
import { SYSTEM_QUERIES } from '../../js/kernel/core/contracts/system.js';
import { checkRequest, checkResult } from '../../js/kernel/core/contracts/validate.js';
import { encode } from '../../js/kernel/core/contracts/codec.js';
import { createLookup } from '../../js/kernel/core/messaging/operations.js';
import { TRUST_COMMANDS, TRUST_QUERIES } from '../../js/trust/core/contracts.js';
import { evidenceSchema } from '../../js/trust/core/evidence.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { incidentSchema, journalEventSchema, receiptSchema, runSchema } from '../../js/trust/core/records.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { TRUST_OPERATIONS } from '../../js/trust/core/trust-operations.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { health } from '../../js/trust/core/families.js';
import { lint } from './contract-schema-lint.test.mjs';
import { dynamicImportsIn, importGraph, loadsOf, reachGraph } from './import-graph.mjs';
import { hexIds, manualClock, realTimers, settingsArea } from './trust-support.mjs';

/** @type {{readScriptGraph: (root: string, options?: {pages?: string[]}) => {modules: Set<string>, classic: Set<string>, workerFiles: Set<string>, pageModules: Map<string, Array<{file: string, depth: number}>>, problems: unknown[]}}} */
const { readScriptGraph } = createRequire(import.meta.url)('../../scripts/lib/script-graph.js');

const ROOT = path.join(import.meta.dirname, '..', '..');
const CATALOG_URL = new URL('../../js/trust/core/contracts.js', import.meta.url);

const ENTRIES =
  /** @type {Array<[string, import('../../js/kernel/core/contracts/commands.js').CommandEntry | import('../../js/kernel/core/contracts/queries.js').QueryEntry]>} */ ([
    ...Object.entries(TRUST_QUERIES),
    ...Object.entries(TRUST_COMMANDS),
  ]);

/** Each operation with the schema module its entry names */
const MODULES = await Promise.all(
  ENTRIES.map(async ([name, entry]) => ({
    name,
    entry,
    module: await import(new URL(entry.schema, CATALOG_URL).href),
  })),
);

describe('the trust catalog (#20 slice 1, AC1)', () => {
  it('lists the eleven operations, each at catalog version 1, named apart from every kernel and system operation', () => {
    assert.deepEqual(ENTRIES.map(([name]) => name).sort(), [
      'diagnostics.export',
      'recovery.check',
      'recovery.copies',
      'recovery.dismiss',
      'recovery.incidents',
      'recovery.raise',
      'recovery.run',
      'recovery.undismiss',
      'trust.report',
      'trust.summary',
      'trust.verify',
    ]);
    for (const [name, entry] of ENTRIES) {
      assert.equal(entry.version, 1, name);
      assert.ok(
        !(name in COMMANDS) && !(name in QUERIES) && !(name in SYSTEM_QUERIES),
        `${name} is already an operation`,
      );
      assert.equal(
        entry.schema,
        `./operations/${name.replace('.', '-').replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}.js`,
      );
      assert.ok(entry.surfaces.length > 0 && entry.surfaces.every(surface => SURFACES.includes(surface)), name);
      assert.deepEqual(entry.destinations, []);
      assert.equal(entry.journaled, false);
    }
    assert.equal(TRUST_QUERIES['trust.summary'].kind, 'query');
    assert.equal(TRUST_COMMANDS['recovery.raise'].kind, 'command');
  });

  it('lets any context raise an incident, and only the new tab and recovery.html run a remediation', () => {
    assert.ok(TRUST_COMMANDS['recovery.raise'].surfaces.includes('worker-internal'));
    assert.deepEqual([...TRUST_COMMANDS['recovery.raise'].surfaces].sort(), [...SURFACES].sort());
    assert.deepEqual(TRUST_COMMANDS['recovery.run'].surfaces, ['newtab', 'recovery']);
    assert.deepEqual(TRUST_QUERIES['trust.summary'].surfaces, ['newtab', 'popup', 'sidepanel', 'recovery']);
  });

  it("names each operation's own type in its payload, and the lookup hands out the module's schemas", () => {
    for (const { name, entry, module } of MODULES) {
      const base = entry.kind === 'command' ? { type: name, commandId: 'c1' } : { type: name };
      const minimal = {
        'trust.verify': { trigger: 'verify-now' },
        'recovery.raise': { providerId: 'storage', faultCode: 'open-failed', severity: 'degraded' },
        'recovery.run': { remediationId: 'retry-open', userInitiated: true },
        'recovery.dismiss': { incidentId: 'a1b20001-0000-4000-8000-000000000000', occurrences: 1 },
        'recovery.undismiss': { incidentId: 'a1b20001-0000-4000-8000-000000000000' },
        'recovery.check': { incidentId: 'a1b20001-0000-4000-8000-000000000000' },
      }[name];
      assert.ok(v.is(module.payload, { ...base, ...minimal }), name);
      assert.equal(v.is(module.payload, { ...base, ...minimal, type: 'other' }), false, name);
      assert.equal(TRUST_OPERATIONS[name].payload, module.payload);
      assert.equal(TRUST_OPERATIONS[name].result, module.result);
      assert.equal(TRUST_OPERATIONS[name].entry, entry);
    }
  });

  it("passes #13's schema lint: payloads, answers, and stored records", () => {
    for (const { name, module } of MODULES) {
      assert.deepEqual(lint(module.payload, { role: 'payload' }), [], `${name} payload`);
      assert.deepEqual(lint(module.result, { role: 'result' }), [], `${name} result`);
    }
    // Evidence travels in recovery.raise's payload, so it's held to every rule
    assert.deepEqual(lint(evidenceSchema, { role: 'payload' }), [], 'evidenceSchema');
    for (const [name, schema] of Object.entries({ receiptSchema, incidentSchema, runSchema, journalEventSchema })) {
      assert.deepEqual(lint(schema, { role: 'result' }), [], name);
    }
    // and none of them marks content anywhere: nothing a trust schema holds is what the user wrote
    for (const { name, module } of MODULES) {
      for (const schema of [module.payload, module.result]) {
        assert.deepEqual(lint(schema, { role: 'outcome' }), [], `${name} carries content`);
      }
    }
  });

  it('refuses recovery.run without userInitiated: true, and evidence outside the allowlist, at the router', () => {
    const lookup = createLookup(TRUST_OPERATIONS);
    /** @param {string} operation @param {unknown} payload */
    const request = (operation, payload) => {
      const frame = { frame: 'request', requestId: 'r1', operation, version: 1, deadline: 1, payload };
      return checkRequest(/** @type {any} */ (frame), encode(frame).length, lookup);
    };
    const run = { type: 'recovery.run', commandId: 'c1', remediationId: 'retry-open' };
    assert.equal(request('recovery.run', run).ok, false);
    assert.equal(request('recovery.run', { ...run, userInitiated: false }).ok, false);
    assert.equal(request('recovery.run', { ...run, userInitiated: 'true' }).ok, false);
    assert.equal(request('recovery.run', { ...run, userInitiated: true }).ok, true);
    const raise = {
      type: 'recovery.raise',
      commandId: 'c2',
      providerId: 'storage',
      faultCode: 'open-failed',
      severity: 'degraded',
    };
    assert.equal(request('recovery.raise', { ...raise, evidence: { durationMs: 3 } }).ok, true);
    assert.deepEqual(request('recovery.raise', { ...raise, evidence: { title: 'x' } }), {
      ok: false,
      code: 'invalid-payload',
      issues: [{ type: 'strict_object', path: '/evidence/*' }],
    });
    assert.equal(request('recovery.raise', { ...raise, evidence: { subjectId: 'a sentence with spaces' } }).ok, false);
    assert.equal(request('trust.verify', { type: 'trust.verify', commandId: 'c3', trigger: 'open' }).ok, true);
  });

  it('answers each operation within its result schema', async () => {
    const clock = manualClock();
    const records = createTrustRecords({
      store: createMemoryTrustStore(),
      settings: settingsArea(),
      clock,
      ids: hexIds(),
    });
    await records.open();
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(health, [
      {
        id: 'storage',
        version: 1,
        apiVersion: 1,
        group: 'storage',
        rank: 1,
        hosts: ['workspace'],
        label: 'Storage',
        owner: 17,
        operation: 'storage.probe-readwrite',
        costClass: 'local-cheap',
        timeoutMs: 50,
        freshnessMs: 60_000,
        triggers: ['open'],
        core: true,
        fixtures: ['truthful-receipt'],
        observes: ['scan-findings'],
        implementation: {
          check: () => ({
            status: 'degraded',
            capture: 'safe',
            faults: [{ faultCode: 'scan-findings', severity: 'degraded' }],
          }),
        },
      },
    ]);
    const resolution = root.resolve();
    const runtime = createRuntime(resolution);
    const trust = createTrustUseCases({
      records,
      journal,
      clock,
      timers: realTimers,
      registry: { resolution, runtime },
      versions: { extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 },
    });
    const answers = {
      'trust.verify': await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'open' }),
      'recovery.raise': await trust.raise({
        type: 'recovery.raise',
        commandId: 'c2',
        providerId: 'backup',
        faultCode: 'stale-backup',
        severity: 'data-risk',
        evidence: { ageMs: 9 },
      }),
      'trust.summary': await trust.summary(),
      'trust.report': await trust.report(),
      'recovery.incidents': await trust.incidents({}),
      'diagnostics.export': await trust.exportDiagnostics(),
    };
    for (const [name, answer] of Object.entries(answers)) {
      assert.ok(
        ['committed', 'ready', 'diagnostics'].includes(/** @type {any} */ (answer).kind),
        `${name}: ${JSON.stringify(answer)}`,
      );
      const checked = checkResult(TRUST_OPERATIONS[name], answer);
      assert.equal(checked.ok, true, `${name}: ${JSON.stringify(checked)}`);
    }
    assert.deepEqual(/** @type {any} */ (answers['recovery.raise']).changedIds.length, 1);
    // A payload a router would refuse is refused in-process too
    assert.equal(
      (await trust.raise({ type: 'recovery.raise', commandId: 'c3', providerId: 'storage' })).kind,
      'rejected',
    );
    assert.equal((await trust.verify({ type: 'trust.verify', commandId: 'c4', trigger: 'boot' })).kind, 'rejected');
  });
});

describe('where trust code loads (#20 slice 1b, R1)', () => {
  const isTrust = (/** @type {string} */ file) =>
    file.startsWith('js/trust/') || file === 'js/kernel/adapters/indexeddb/trust.js';

  /** What the failure events load: the journal, the records, and NewTabNoteTrust's adapter */
  const FAILURE_EVENTS_GRAPH = [
    'js/kernel/adapters/indexeddb/trust.js',
    'js/trust/core/codes.js',
    'js/trust/core/event-codes.js',
    'js/trust/core/evidence.js',
    'js/trust/core/incidents.js',
    'js/trust/core/journal.js',
    'js/trust/core/ports.js',
    'js/trust/core/records.js',
    'js/trust/core/trust-records.js',
    'js/trust/core/vocabulary.js',
  ];

  it('is reached statically only from the service worker, through its failure events, and from no page', () => {
    const pages = ['offscreen.html'].filter(page => fs.existsSync(path.join(ROOT, page)));
    const graph = readScriptGraph(ROOT, { pages });
    const pageLoaded = [...[...graph.pageModules.values()].flat().map(({ file }) => file), ...graph.classic];
    assert.ok(pageLoaded.length > 20, 'the script graph found too little to mean anything');
    assert.ok(graph.pageModules.has('newtab.html') && graph.pageModules.has('sidepanel.html'));
    assert.deepEqual(pageLoaded.filter(isTrust), []);
    assert.deepEqual([...graph.workerFiles].filter(isTrust).sort(), FAILURE_EVENTS_GRAPH);
    const events = path.join(ROOT, 'js', 'kernel', 'composition', 'trust.js');
    assert.deepEqual(
      [...importGraph(events)]
        .map(file => path.relative(ROOT, file))
        .filter(isTrust)
        .sort(),
      FAILURE_EVENTS_GRAPH,
    );
  });

  it('reaches the new tab only through import(), after its first failure', () => {
    const graph = readScriptGraph(ROOT, { pages: [] });
    // What the tab starts with: the boot root's own graph, and the workspace chunk's, which the
    // root loads at once through the loader (#27 slice 3)
    const root = (graph.pageModules.get('newtab.html') || []).map(({ file }) => file);
    assert.deepEqual([...root].sort(), ['js/entries/boot.js', 'js/entries/newtab.js', 'js/runtime/lazy.js']);
    const workspace = [...importGraph(path.join(ROOT, 'js', 'workspace.js'))].map(file => path.relative(ROOT, file).split(path.sep).join('/'));
    const newtab = [...root, ...workspace];
    assert.ok(newtab.includes('js/kernel/composition/lazy-failure-events.js'));
    assert.deepEqual(newtab.filter(isTrust), []);
    assert.ok(!newtab.includes('js/kernel/composition/trust.js'));
    // The tab's import()s: the root's of the workspace chunk, the loader's retry, the failure
    // events' own, of ./trust.js, and the close-time drafts' two, of close-drafts-chunk.js: the
    // start's, when localStorage gives it work, and applyCloseDraft's wrapper's, at first use
    // (#33, option 1)
    const dynamic = dynamicImportsIn(newtab.map(file => path.join(ROOT, file)))
      .map(at => path.relative(ROOT, at).split(path.sep).join('/').replace(/:\d+:\d+$/, ''))
      .sort();
    assert.deepEqual(dynamic, [
      'js/entries/newtab.js',
      'js/kernel/composition/lazy-failure-events.js',
      'js/kernel/composition/newtab.js',
      'js/kernel/core/application/close-drafts-on-demand.js',
      'js/runtime/lazy.js',
    ]);
    const source = fs.readFileSync(path.join(ROOT, 'js', 'kernel', 'composition', 'lazy-failure-events.js'), 'utf8');
    assert.ok(source.includes("import('./trust.js')"));
    // Each close-time drafts' import() loads the chunk and nothing else, and what the chunk
    // reaches, through its imports and import()s, holds no trust code
    for (const [file, specifier] of [
      ['js/kernel/composition/newtab.js', '../core/application/close-drafts-chunk.js'],
      ['js/kernel/core/application/close-drafts-on-demand.js', './close-drafts-chunk.js'],
    ]) {
      const loads = loadsOf(fs.readFileSync(path.join(ROOT, file), 'utf8')).dynamicLoads.map(load => load.specifier);
      assert.deepEqual(loads, [specifier], file);
    }
    const drafts = reachGraph([path.join(ROOT, 'js', 'kernel', 'core', 'application', 'close-drafts-chunk.js')]);
    const reached = [...drafts.modules].map(file => path.relative(ROOT, file).split(path.sep).join('/'));
    assert.ok(reached.length > 10, "the chunk's graph found too little to mean anything");
    assert.deepEqual(reached.filter(isTrust), []);
    assert.deepEqual(drafts.computed, []);
  });

  it("is never reached from capture-critical.js, Moment's import of #13, whose graph is what it was before slice 1b", () => {
    const entry = path.join(ROOT, 'js', 'kernel', 'core', 'messaging', 'capture-critical.js');
    const graph = [...importGraph(entry)].map(file => path.relative(ROOT, file)).sort();
    assert.deepEqual(graph.filter(isTrust), []);
    assert.deepEqual(graph, [
      'js/kernel/core/contracts/checks.js',
      'js/kernel/core/contracts/clone.js',
      'js/kernel/core/contracts/codec.js',
      'js/kernel/core/contracts/envelope.js',
      'js/kernel/core/contracts/fields.js',
      'js/kernel/core/contracts/hint-channel.js',
      'js/kernel/core/contracts/limits.js',
      'js/kernel/core/contracts/outcome-schemas.js',
      'js/kernel/core/contracts/outcomes.js',
      'js/kernel/core/contracts/surfaces.js',
      'js/kernel/core/contracts/transport-codes.js',
      'js/kernel/core/contracts/upcast.js',
      'js/kernel/core/contracts/validate.js',
      'js/kernel/core/messaging/capture-critical.js',
      'js/kernel/core/messaging/client.js',
      'js/kernel/core/messaging/operations.js',
      'js/kernel/core/ports/runtime.js',
      'js/lib/valibot/index.mjs',
    ]);
  });

  it("is never reached from the worker's kernel, which captures: the failure events sit beside it in js/background.js", () => {
    const entry = path.join(ROOT, 'js', 'kernel', 'composition', 'background.js');
    const graph = [...importGraph(entry)].map(file => path.relative(ROOT, file));
    assert.deepEqual(graph.filter(isTrust), []);
  });

  it("keeps NewTabNoteTrust's adapter free of imports from js/trust/, so it can ship before the trust core does", () => {
    const adapter = path.join(ROOT, 'js', 'kernel', 'adapters', 'indexeddb', 'trust.js');
    const graph = [...importGraph(adapter)].map(file => path.relative(ROOT, file));
    assert.deepEqual(
      graph.filter(file => file.startsWith('js/trust/')),
      [],
    );
  });
});
