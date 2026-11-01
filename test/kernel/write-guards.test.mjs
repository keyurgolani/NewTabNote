// AC1 of #17, held to the catalog and the code (#17 PR 4b): every catalog command is in
// write-guards.mjs's table, each guarded one takes its version where the table says and no
// other command takes one, each writer writes in the scope the table gives it and no other
// command writes a note or a block, and the page's callers of each guarded command are the ones
// the table names, none sending a version. The kernel contract suite sends each guarded command
// twice from one version (contract.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createKernel } from './test-kernel.mjs';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { walk } from '../../js/kernel/core/contracts/schema-walk.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { indexedDbFixture } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';
import { SCOPE_GUARDS, VERSION_FIELDS, WRITE_GUARDS } from './write-guards.mjs';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/repository.js').WriteScope} WriteScope */
/** @typedef {import('./write-guards.mjs').WriteGuard} WriteGuard */

const ROOT = path.join(import.meta.dirname, '..', '..');
const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/** @type {Map<string, any>} */
const payloads = new Map();
for (const [type, entry] of Object.entries(COMMANDS)) {
  payloads.set(type, (await import(new URL(entry.schema, CATALOG_URL).href)).payload);
}

/**
 * Where a version field sits in a command's payload: each path to one, joined by dots
 * @param {CommandType} type
 * @returns {string[]}
 */
const versionPaths = type =>
  walk(payloads.get(type))
    .filter(visit => VERSION_FIELDS.includes(visit.path[visit.path.length - 1]))
    .map(visit => visit.path.join('.'))
    .filter((at, index, all) => all.indexOf(at) === index);

/**
 * The document client's and the removal port's methods a page calls, and the command each one
 * sends (js/kernel/composition/document.js, removal.js)
 * @type {Record<string, CommandType>}
 */
const CLIENT_METHODS = {
  saveContent: 'saveNoteContent',
  deleteBlocks: 'deleteBlocks',
  renameNote: 'renameNote',
  deriveTitle: 'applyDerivedTitle',
  insertBlocks: 'insertBlocks',
  attachInsights: 'attachInsights',
  setPinned: 'setPinned',
  archiveNote: 'archiveNote',
  unarchiveNote: 'unarchiveNote',
  restoreNote: 'restoreNote',
  convertNoteToTemplate: 'convertNoteToTemplate',
  convertTemplateToNote: 'convertTemplateToNote',
  moveNoteToFolder: 'moveNoteToFolder',
};

/**
 * The search index handle's writes NotesManager calls on `this.storage`, and the command each
 * one sends since #17 PR 4b (js/kernel/composition/storage-facade.js)
 * @type {Record<string, CommandType>}
 */
const FACADE_METHODS = {
  setSearchIndex: 'updateSearchIndex',
  setSearchIndexEntry: 'updateSearchIndex',
  removeSearchIndexEntry: 'updateSearchIndex',
  saveVector: 'saveVector',
};

/**
 * Every page file: js/ but its libraries and the kernel, which the callers reach through
 * @returns {string[]} paths from the repository's root
 */
function pageFiles() {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const visit = dir => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const at = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (at !== 'js/lib' && at !== 'js/kernel') visit(at);
      } else if (entry.name.endsWith('.js')) {
        found.push(at);
      }
    }
  };
  visit('js');
  return found.sort();
}

/**
 * Each call `sources` make that sends a guarded command, as `Class.method` with the command it
 * sends: a document client method, removeNotes with the command's type, or one of the
 * facade's writes on a handle, each matched across lines, so a call split over two lines counts
 * (R131). A method is a class's method at two spaces in, as every page class holds its methods.
 * @param {Array<[string, string]>} sources - each file's path and text
 * @returns {Map<CommandType, string[]>}
 */
function callersIn(sources) {
  /** @type {Map<CommandType, string[]>} */
  const callers = new Map();
  for (const [, text] of sources) {
    // The class and method each line is in, and where each line starts
    /** @type {string[]} */
    const inside = [];
    /** @type {number[]} */
    const starts = [];
    let className = '';
    let method = '';
    let offset = 0;
    for (const line of text.split('\n')) {
      const declared = /^(?:export )?class (\w+)/.exec(line);
      if (declared) className = declared[1];
      const header = /^ {2}(?:async |static )*(?:get |set )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line);
      if (header && !['if', 'for', 'while', 'switch', 'catch'].includes(header[1])) method = header[1];
      inside.push(`${className}.${method}`);
      starts.push(offset);
      offset += line.length + 1;
    }
    /**
     * @param {number} index - where a call starts in the text
     * @param {CommandType} type
     */
    const sent = (index, type) => {
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= index) line += 1;
      const list = callers.get(type) || [];
      list.push(inside[line]);
      callers.set(type, list);
    };
    for (const match of text.matchAll(/documentClient\s*\.\s*(\w+)\s*\(/g)) {
      if (Object.hasOwn(CLIENT_METHODS, match[1])) sent(match.index, CLIENT_METHODS[match[1]]);
    }
    for (const match of text.matchAll(/removeNotes\(\s*\{\s*type:\s*'(\w+)'/g)) {
      sent(match.index, /** @type {CommandType} */ (match[1]));
    }
    for (const match of text.matchAll(/\bstorage\s*\.\s*(\w+)\s*\(/g)) {
      if (Object.hasOwn(FACADE_METHODS, match[1])) sent(match.index, FACADE_METHODS[match[1]]);
    }
  }
  return callers;
}

/** Each call a page file makes that sends a guarded command (callersIn) */
const pageCallers = () => callersIn(pageFiles().map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));

describe("#17's AC1: every writer's scope and guard", () => {
  it('names every catalog command once', () => {
    assert.deepEqual(Object.keys(WRITE_GUARDS).sort(), [...COMMAND_TYPES].sort());
  });

  it('each guarded command takes its version where the table says, for its scope, and no other command takes one', () => {
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      const paths = versionPaths(type);
      if (guard.kind === 'guarded') {
        assert.deepEqual(paths, [guard.guard, ...Object.keys(guard.also)], type);
        assert.equal(guard.guard.split('.').pop(), SCOPE_GUARDS[guard.scope], type);
      } else if (guard.kind === 'bulk') {
        // A bulk command carries no version of its own, only its items' for each note
        assert.ok(
          paths.every(at => at.includes('[]')),
          `${type}: ${paths.join(', ')}`,
        );
        for (const item of guard.items) assert.equal(WRITE_GUARDS[item].kind, 'guarded', `${type} runs ${item}`);
      } else {
        assert.deepEqual(paths, [], type);
      }
    }
  });

  it('finds a call split over lines, as one on a line (R131)', () => {
    const page = [
      'class Panel {',
      '  async save(state) {',
      '    await this.documentClient',
      '      .saveContent(state);',
      '    this.documentClient.renameNote(',
      "      'n1',",
      '    );',
      '  }',
      '',
      '  trash() {',
      '    return this.removal.removeNotes({',
      "      type: 'trashNote',",
      '    });',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(Object.fromEntries(callersIn([['js/panel.js', page]])), {
      saveNoteContent: ['Panel.save'],
      renameNote: ['Panel.save'],
      trashNote: ['Panel.trash'],
    });
  });

  it('every page caller of a guarded command is the one the table names, and none sends a version', () => {
    const callers = pageCallers();
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      const found = [...new Set(callers.get(type) || [])].sort();
      if (guard.kind === 'guarded') assert.deepEqual(found, guard.callers, type);
    }
    // So the table's callers send none: no page names a version field, until #6's conflict view
    for (const file of pageFiles()) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.deepEqual(
        VERSION_FIELDS.filter(field => new RegExp(`\\b${field}\\b`).test(text)),
        [],
        file,
      );
    }
  });

  /**
   * Runs every catalog sample through a kernel over `inner`, and answers the scopes each
   * command's work committed in, and which commands committed or ran
   * @param {KernelAdapter} inner
   * @param {{committing: CommandType | null}} [tracking] - set to the command whose work commits
   */
  async function samplesOn(inner, tracking = { committing: null }) {
    /** @type {Map<CommandType, Set<WriteScope>>} */
    const scopes = new Map();
    /** @type {KernelAdapter} */
    const adapter = {
      ...inner,
      async commit(work) {
        const type = /** @type {CommandType} */ (work.command.type);
        const kinds = scopes.get(type) || new Set();
        kinds.add(work.scope || 'content');
        scopes.set(type, kinds);
        tracking.committing = type;
        try {
          return await inner.commit(work);
        } finally {
          tracking.committing = null;
        }
      },
    };
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
    });
    /** @type {string[]} */
    const ran = [];
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      const outcome = await kernel.execute(/** @type {Command} */ ({ ...fields, type, commandId: `c-${type}` }));
      if (outcome.kind === 'committed' || outcome.kind === 'bulk') ran.push(type);
    }
    return { scopes, ran };
  }

  /**
   * Holds each command's committed scopes to the table's
   * @param {Map<CommandType, Set<WriteScope>>} scopes
   * @param {string} where
   */
  function assertScopes(scopes, where) {
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      const kinds = [...(scopes.get(type) || [])];
      if (guard.kind === 'guarded' || guard.kind === 'unguarded') {
        const declared = guard.kind === 'guarded' ? [guard.scope] : guard.scopes;
        assert.ok(
          kinds.every(kind => declared.includes(kind)),
          `${where}: ${type} committed in ${kinds.join(', ')}`,
        );
      } else if (guard.kind === 'bulk') {
        assert.deepEqual(kinds, [], `${where}: ${type} commits nothing of its own`);
      }
    }
    // The bulk commands' items ran as their own commands
    assert.ok(scopes.has('applyRemoteContent') && scopes.has('applyRemotePlacement'), where);
  }

  it('each writer commits in the scope the table gives it, and a command the table says writes no note or block writes none', async () => {
    /** @type {Map<CommandType, Set<string>>} */
    const writes = new Map();
    /** @type {{committing: CommandType | null}} */
    const tracking = { committing: null };
    const memory = createMemoryAdapter({
      beforeWrite: target => {
        if (!tracking.committing) return;
        const stores = writes.get(tracking.committing) || new Set();
        stores.add(target);
        writes.set(tracking.committing, stores);
      },
    });
    const { scopes, ran } = await samplesOn(memory, tracking);
    // The samples commit, so the checks below aren't empty
    assert.ok(ran.length >= 40, ran.join(', '));
    assertScopes(scopes, 'memory');
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      if (guard.kind !== 'none') continue;
      const touched = [...(writes.get(type) || [])].filter(store => store === 'notes' || store === 'blocks');
      assert.deepEqual(touched, [], type);
    }
  });

  it("#17's adapter commits each writer in the scope the table gives it, the backup tasks included", async () => {
    const ctx = await indexedDbFixture.start();
    try {
      const { scopes, ran } = await samplesOn(ctx.adapter);
      // #17's adapter runs the import, which the in-memory one can't
      assert.ok(ran.includes('importBackup') && scopes.has('importBackup'), ran.join(', '));
      assertScopes(scopes, 'indexeddb');
    } finally {
      await ctx.close();
    }
  });
});
