#!/usr/bin/env node
'use strict';

/**
 * npm run check:states (#26 slice 1): every registered contribution has a state row, or the reason a
 * state can't arise, for each of the 11 states, or ci/baselines/states.json lists what it's
 * missing. The baseline only shrinks: a missing row it doesn't list fails, a written row it still
 * lists fails, and an entry for a contribution or a state that doesn't exist fails. Matrix
 * descriptors and causes have to resolve on their families and keep the causes' joined rules, and
 * every message key a row or a cause names needs a catalog string. With --base <ref>, an entry the
 * base's baseline doesn't have fails, so the baseline only shrinks from its first day; a base with
 * no baseline yet passes and says so. It writes nothing, and no flag makes it.
 *
 * The contributions are today's: #13's, #20's and recovery.html's port operations (#35 slice 8), as
 * commands and queries by their names in kebab case, and the kit's hosts as surfaces. Routes and background jobs join when #15's
 * navigation family and #35's job host register them. Owners register rows in js/states/rows.js.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const BASELINE = 'ci/baselines/states.json';
const USAGE = 'usage: node scripts/check-states.js [--base <git ref>]';

/** @param {string} name - `createNote` */
const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

/**
 * @param {readonly {code: string, field?: string}[]} problems
 */
const said = problems => problems.map(({ code, field }) => (field ? `${code} (${field})` : code)).join(', ');

/**
 * What's registered, from the modules under `root`
 * @param {string} root
 */
async function registered(root) {
  const at = (/** @type {string} */ file) => import(pathToFileURL(path.join(root, file)).href);
  const [worker, port, system, trust, kit, validate, families, words, causes, chunks, rows] = await Promise.all(
    [
      'js/kernel/core/contracts/worker-catalog.js',
      'js/kernel/core/contracts/recovery-port.js',
      'js/kernel/core/contracts/system.js',
      'js/trust/core/contracts.js',
      'js/kernel/registry/vocabulary.js',
      'js/kernel/registry/validate.js',
      'js/states/core/families.js',
      'js/states/core/vocabulary.js',
      'js/states/core/causes.js',
      'js/states/catalog/chunks.js',
      'js/states/rows.js',
    ].map(at),
  );
  /** @type {Set<string>} */
  const contributions = new Set();
  const add = (/** @type {string} */ group, /** @type {Iterable<string>} */ names) => {
    for (const name of names) contributions.add(`${group}:${kebab(name)}`);
  };
  add('command', [
    ...Object.keys(worker.WORKER_COMMANDS),
    ...Object.keys(port.RECOVERY_PORT_COMMANDS),
    ...Object.keys(trust.TRUST_COMMANDS),
  ]);
  add('query', [...Object.keys(worker.WORKER_QUERIES), ...Object.keys(system.SYSTEM_QUERIES), ...Object.keys(trust.TRUST_QUERIES)]);
  add('surface', kit.HOSTS);
  /** @type {Set<string>} */
  const strings = new Set();
  for (const chunk of chunks.CHUNKS) for (const key of Object.keys((await chunk.load()).default)) strings.add(key);
  return { contributions, strings, states: words.STATES, validate, families, causes: causes.KERNEL_CAUSES, rows: rows.ROWS };
}

/**
 * @param {string[]} [argv]
 * @param {{root?: string, log?: (line: string) => void, error?: (line: string) => void,
 *   git?: (args: string[]) => string}} [options] - `git` runs git in `root`, unless a test hands in another
 * @returns {Promise<number>}
 */
async function main(argv = process.argv.slice(2), options = {}) {
  const { root = ROOT, log = console.log, error = console.error } = options;
  const git = options.git ?? (args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  /** @type {string | null} */
  let base = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--base' || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      error(USAGE);
      return 2;
    }
    base = argv[(i += 1)];
  }
  const { contributions, strings, states, validate, families, causes, rows } = await registered(root);
  /** @type {string[]} */
  const problems = [];

  /** @type {Map<string, Set<string>>} the states each contribution's rows cover */
  const covered = new Map();
  for (const descriptor of rows) {
    const checked = validate.checkDescriptor(families.matrix, descriptor);
    const subject = `${descriptor.group}:${descriptor.subject}`;
    if (checked.problems.length > 0) problems.push(`matrix ${String(descriptor.id)}: ${said(checked.problems)}`);
    else if (!contributions.has(subject)) problems.push(`matrix ${descriptor.id}: ${subject} is no registered contribution`);
    else if (covered.has(subject)) problems.push(`matrix ${descriptor.id}: ${subject} has rows in another descriptor`);
    else {
      covered.set(subject, new Set(Object.keys(descriptor.states)));
      for (const [state, row] of Object.entries(descriptor.states)) {
        if (!('notApplicable' in row) && !strings.has(row.messageKey)) {
          problems.push(`matrix ${descriptor.id}: ${state}'s ${row.messageKey} has no catalog string`);
        }
      }
    }
  }
  for (const cause of causes) {
    const broken = [said(validate.checkDescriptor(families.cause, cause).problems), ...families.causeProblems(cause)];
    if (broken.join('') !== '') problems.push(`cause ${cause.id}: ${broken.filter(Boolean).join(', ')}`);
    if (!strings.has(cause.messageKey)) problems.push(`cause ${cause.id}: ${cause.messageKey} has no catalog string`);
  }

  /** @type {Record<string, string[]>} */
  const listed = JSON.parse(fs.readFileSync(path.join(root, BASELINE), 'utf8')).missing;
  for (const [subject, list] of Object.entries(listed)) {
    if (!contributions.has(subject)) problems.push(`${BASELINE}: ${subject} is no registered contribution`);
    for (const state of list) {
      if (!states.includes(state)) problems.push(`${BASELINE}: ${subject} lists ${state}, which isn't one of the 11 states`);
    }
    if (new Set(list).size !== list.length) problems.push(`${BASELINE}: ${subject} lists a state twice`);
  }
  let note = '';
  if (base !== null) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    } catch {
      error(`check:states failed: git can't read ${base}, so there's no baseline to hold this one to`);
      return 1;
    }
    if (git(['ls-tree', '--name-only', base, '--', BASELINE]).trim() === '') note = `; ${base} has no baseline yet`;
    else {
      /** @type {Record<string, string[]>} */
      const before = JSON.parse(git(['show', `${base}:${BASELINE}`])).missing;
      for (const [subject, list] of Object.entries(listed)) {
        for (const state of list) {
          if (!(before[subject] ?? []).includes(state)) {
            problems.push(`${subject} lists ${state}, which ${base}'s baseline doesn't: the baseline only shrinks`);
          }
        }
      }
      note = `, none of them new since ${base}`;
    }
  }
  let missing = 0;
  for (const subject of [...contributions].sort()) {
    const has = covered.get(subject) ?? new Set();
    const list = listed[subject] ?? [];
    const unlisted = states.filter((/** @type {string} */ state) => !has.has(state) && !list.includes(state));
    const written = states.filter((/** @type {string} */ state) => has.has(state) && list.includes(state));
    if (unlisted.length > 0) problems.push(`${subject} has no row for ${unlisted.join(', ')}, and ${BASELINE} doesn't list them`);
    if (written.length > 0) problems.push(`${subject} has rows for ${written.join(', ')}: remove them from its entry in ${BASELINE}`);
    missing += states.length - has.size;
  }

  if (problems.length > 0) {
    error(`check:states failed: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    for (const problem of problems) error(`  - ${problem}`);
    return 1;
  }
  log(`check:states: OK, ${contributions.size} contributions, ${rows.length} with rows, ${missing} missing rows that ${BASELINE} lists${note}`);
  return 0;
}

if (require.main === module) {
  main().then(
    code => {
      process.exitCode = code;
    },
    e => {
      console.error(`check:states failed: ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
    },
  );
}

module.exports = { main, BASELINE };
