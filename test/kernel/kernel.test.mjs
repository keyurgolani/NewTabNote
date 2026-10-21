// The kernel's dispatcher: the policy before any adapter call, for every command and query
// in the catalog; saveNoteContent's transaction opening in the calling task; deferred init;
// and the logger never hearing a payload.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/policy.js').PolicyPort} PolicyPort */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */

const KERNEL_DIR = path.join(import.meta.dirname, '..', '..', 'js', 'kernel');

/**
 * An adapter that logs each call into `log` before passing it to `inner`.
 * @param {KernelAdapter} inner
 * @param {string[]} log
 * @returns {KernelAdapter}
 */
function spyAdapter(inner, log) {
  return {
    name: 'spy',
    flags: inner.flags,
    recall: command => {
      log.push('recall');
      return inner.recall(command);
    },
    commit: work => {
      log.push(`commit ${work.command.type}`);
      return inner.commit(work);
    },
    read: (stores, body) => {
      log.push('read');
      return inner.read(stores, body);
    },
    readSettings: (area, keys) => {
      log.push('readSettings');
      return inner.readSettings(area, keys);
    },
  };
}

/**
 * A policy that logs each question into `log`, and answers `allow`.
 * @param {string[]} log
 * @param {boolean} allow
 * @returns {PolicyPort}
 */
function spyPolicy(log, allow) {
  /** @type {import('../../js/kernel/core/ports/policy.js').Decision} */
  const decision = allow ? { allowed: true } : { allowed: false, code: 'test-deny' };
  return {
    authorize: request => {
      log.push(`authorize ${String(request.type)}`);
      return decision;
    },
  };
}

/** @param {{adapter?: KernelAdapter, policy?: PolicyPort, ready?: PromiseLike<unknown>, logger?: import('../../js/kernel/core/ports/runtime.js').Logger}} [options] */
function kernelWith({ adapter = createMemoryAdapter(), policy = createBaselinePolicy(), ready, logger } = {}) {
  return createKernel({ adapter, policy, caller: CALLERS.newtab, ids: testIds(), clock: testClock(), ready, logger });
}

describe('the kernel', () => {
  it('asks the policy before any adapter call, for every command and query in the catalog', async () => {
    for (const type of COMMAND_TYPES) {
      /** @type {string[]} */
      const log = [];
      const kernel = kernelWith({ adapter: spyAdapter(createMemoryAdapter(), log), policy: spyPolicy(log, false) });
      const outcome = await kernel.execute(/** @type {Command} */ ({ type, commandId: 'c1' }));
      assert.deepEqual(outcome.kind === 'rejected' && [outcome.reason, outcome.code], ['policy', 'test-deny'], type);
      assert.deepEqual(log, [`authorize ${type}`], type);
    }
    for (const type of QUERY_TYPES) {
      /** @type {string[]} */
      const log = [];
      const kernel = kernelWith({ adapter: spyAdapter(createMemoryAdapter(), log), policy: spyPolicy(log, false) });
      assert.deepEqual(await kernel.query(/** @type {any} */ ({ type })), {
        kind: 'failed',
        cause: 'policy',
        code: 'test-deny',
      });
      assert.deepEqual(log, [`authorize ${type}`], type);
    }
  });

  it('runs a use case for every catalog command, after the policy and before the adapter commits', async () => {
    for (const type of COMMAND_TYPES) {
      /** @type {string[]} */
      const log = [];
      const kernel = kernelWith({ adapter: spyAdapter(createMemoryAdapter(), log), policy: spyPolicy(log, true) });
      // Only the ids, so most use cases refuse the shape before they reach the adapter
      const outcome = await kernel.execute(/** @type {Command} */ ({ type, commandId: 'c1' }));
      assert.notEqual(
        outcome.kind === 'unavailable' && outcome.code,
        'adapter-failed',
        `${type}: ${JSON.stringify(outcome)}`,
      );
      assert.equal(log[0], `authorize ${type}`);
      // recall would reserve a bulk command's key, so one with no action or notes is refused
      // before it, and leaves no record
      assert.deepEqual(log.slice(1, 2), COMMANDS[type].bulk ? [] : ['recall'], type);
    }
  });

  it('saveNoteContent opens its transaction in the task that calls execute', async () => {
    /** @type {string[]} */
    const log = [];
    const kernel = kernelWith({ adapter: spyAdapter(createMemoryAdapter(), log) });
    await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
    log.length = 0;
    const pending = kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'n1', blocks: [] });
    assert.deepEqual(log, ['recall', 'commit saveNoteContent']);
    assert.equal((await pending).kind, 'committed');
  });

  it('before its storage opens, a query is loading and a command waits', async () => {
    /** @type {() => void} */
    let open = () => {};
    const ready = new Promise(resolve => {
      open = () => resolve(undefined);
    });
    const kernel = kernelWith({ ready });
    assert.deepEqual(await kernel.query({ type: 'listNotes', view: 'active' }), { kind: 'loading' });
    let settled = false;
    const pending = kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' }).then(outcome => {
      settled = true;
      return outcome;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    open();
    assert.equal((await pending).kind, 'committed');
    assert.equal((await kernel.query({ type: 'listNotes', view: 'active' })).kind, 'ready');
  });

  it('keeps a command as it was when execute was called, even while storage is still opening', async () => {
    /** @type {() => void} */
    let open = () => {};
    const ready = new Promise(resolve => {
      open = () => resolve(undefined);
    });
    const kernel = kernelWith({ ready });
    const create = { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'First', blocks: [{ id: 'b1' }] };
    const creating = kernel.execute(/** @type {Command} */ (create));
    create.name = 'Changed while opening';
    create.blocks.push({ id: 'b2' });
    const blocks = [{ id: 'b1', type: 'text', content: 'Typed before the save' }];
    const saving = kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'n1', blocks });
    blocks[0].content = 'Typed after the save started';
    open();
    assert.deepEqual([(await creating).kind, (await saving).kind], ['committed', 'committed']);
    const note = await kernel.query({ type: 'getNote', noteId: 'n1' });
    assert.equal(note.kind === 'ready' && note.data.note.name, 'First');
    const stored = await kernel.query({ type: 'getNoteBlocks', noteId: 'n1' });
    assert.deepEqual(stored.kind === 'ready' && stored.data.map(block => [block.id, block.content]), [
      ['b1', 'Typed before the save'],
    ]);
  });

  it("when storage can't open, commands are unavailable and queries failed, with the cause", async () => {
    const kernel = kernelWith({ ready: Promise.reject(new UnavailableError('newer-schema', 'newer-schema', false)) });
    const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
    assert.deepEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable], [
      'newer-schema',
      'newer-schema',
      false,
    ]);
    assert.deepEqual(await kernel.query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'newer-schema',
      code: 'newer-schema',
    });
  });

  it("answers a failed open as not retryable, though the adapter's error was, since nothing opens it again", async () => {
    const kernel = kernelWith({ ready: Promise.reject(new UnavailableError('storage', 'no-database', true)) });
    for (const commandId of ['c1', 'c2']) {
      const outcome = await kernel.execute({ type: 'createNote', commandId, noteId: 'n1' });
      assert.deepEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable], [
        'storage',
        'no-database',
        false,
      ]);
    }
  });

  it('tells the logger about a listener that threw with the aggregate, the ids, and the error, never the payload', async () => {
    /** @type {Array<{event: string, detail: Record<string, unknown>}>} */
    const warnings = [];
    const kernel = kernelWith({ logger: { warn: (event, detail) => warnings.push({ event, detail }) } });
    const failure = new Error('listener bug');
    kernel.subscribe(() => {
      throw failure;
    });
    const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Secret title' });
    assert.equal(outcome.kind, 'committed');
    assert.deepEqual(warnings, [
      { event: 'commit-listener-failed', detail: { aggregate: 'note', ids: ['n1'], error: failure } },
    ]);
  });

  it('answers anything, even input that is no command, with an outcome', async () => {
    const kernel = kernelWith();
    for (const input of [null, undefined, 42, 'createNote', [], { type: 'createNote' }]) {
      const outcome = await kernel.execute(/** @type {any} */ (input));
      assert.equal(outcome.kind, 'rejected', JSON.stringify(input));
    }
  });

  it('a policy that throws denies, and an adapter that throws or rejects still gets an outcome', async () => {
    const broken = () => {
      throw new Error('policy bug');
    };
    const closed = kernelWith({ policy: { authorize: broken } });
    const denied = await closed.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
    assert.deepEqual(denied.kind === 'rejected' && [denied.reason, denied.code], ['policy', 'policy-failed']);
    assert.deepEqual(await closed.query({ type: 'listFolders' }), {
      kind: 'failed',
      cause: 'policy',
      code: 'policy-failed',
    });

    const memory = createMemoryAdapter();
    for (const adapter of [
      { ...memory, recall: () => broken() },
      { ...memory, commit: () => Promise.reject(new Error('adapter bug')) },
      { ...memory, commit: () => broken() },
    ]) {
      const kernel = kernelWith({ adapter: /** @type {KernelAdapter} */ (adapter) });
      const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
      assert.equal(outcome.kind === 'unavailable' && outcome.code, 'adapter-failed');
    }
    const unreadable = kernelWith({ adapter: { ...memory, read: () => broken() } });
    assert.deepEqual(await unreadable.query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'adapter',
      code: 'adapter-failed',
    });
  });

  it('answers with the committed outcome when a listener throws and so does the logger it reports to', async () => {
    const kernel = kernelWith({
      logger: {
        warn: () => {
          throw new Error('logger bug');
        },
      },
    });
    kernel.subscribe(() => {
      throw new Error('listener bug');
    });
    const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
    assert.equal(outcome.kind, 'committed');
  });

  it('denies unless the policy answers allowed: true, whatever else it answers', async () => {
    for (const answer of [undefined, null, 'yes', {}, { allowed: 'true' }, { allowed: 1 }]) {
      const answers = () => /** @type {any} */ (answer);
      const kernel = kernelWith({ policy: { authorize: answers } });
      const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
      assert.deepEqual(
        outcome.kind === 'rejected' && [outcome.reason, outcome.code],
        ['policy', 'policy-failed'],
        JSON.stringify(answer),
      );
      assert.deepEqual(
        await kernel.query({ type: 'listFolders' }),
        { kind: 'failed', cause: 'policy', code: 'policy-failed' },
        JSON.stringify(answer),
      );
    }
  });

  it("answers with an outcome when the adapter's commit or recall hands back something else", async () => {
    const memory = createMemoryAdapter();
    for (const adapter of [
      { ...memory, commit: () => undefined },
      { ...memory, commit: () => 42 },
      { ...memory, commit: () => Promise.resolve(undefined) },
      { ...memory, commit: () => Promise.resolve({ kind: 'saved' }) },
      { ...memory, recall: () => 'yes' },
    ]) {
      const kernel = kernelWith({ adapter: /** @type {any} */ (adapter) });
      const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' });
      assert.deepEqual(
        outcome.kind === 'unavailable' && [outcome.cause, outcome.code],
        ['adapter', 'adapter-failed'],
        JSON.stringify(outcome),
      );
    }
  });

  it('emits no note:saved event anywhere in js/kernel/', () => {
    /** @param {string} dir @returns {string[]} */
    const walk = dir =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : /\.m?js$/.test(entry.name) ? [full] : [];
      });
    const emitters = walk(KERNEL_DIR).filter(file => /['"`]note:saved['"`]/.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(emitters, []);
  });
});
