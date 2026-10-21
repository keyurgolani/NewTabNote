#!/usr/bin/env node

/**
 * Kernel boundary check (#12, "Boundaries and the ledger"; docs/adr/0001-kernel-stack.md).
 *
 * Runs eslint.config.mjs's boundary rules over js/, with inline config comments ignored so
 * none can switch a rule off, counts the hits per file and ledger rule, and compares them
 * with docs/architecture/kernel-ledger.json, one {file, rule, count, owner, removeWhen,
 * verify} row per pair. It fails on:
 * - a hit no row covers, or more hits than a row's count;
 * - fewer hits than a row's count: lower it, or delete the row at zero, in the same PR;
 * - a row missing a field, naming a rule this file doesn't define, or repeated;
 * - with --base <git ref>: a row whose count is higher than at that ref, or a row that ref
 *   doesn't have which names #12 as its owner. A later PR may add a row by hand, but only
 *   for a defined rule, owned by another issue. With no ledger at the ref, as in the PR
 *   that seeds it, every row is new.
 * - with --base: for a rule the ledger at that ref lists in `shrinkOnly` (#17's
 *   storage-access rules, #17 slice 1), any new row or higher count, so that exemption list
 *   only shrinks, and a rule dropped from `shrinkOnly`. The one exception is a blind write
 *   that replaces raw access: a legacyBlindWrite count may rise in a file by as much as its
 *   getStore and objectStore counts fall in the same PR. The PR that first lists a rule in
 *   `shrinkOnly` seeds its rows by hand.
 * declared-gap rows record gaps no rule sees, so they're checked for shape and never against
 * hits: count 1, the legacy adapter module as file, which has to exist, and #17 as owner,
 * since #17's adapter closes each gap. That module declares several gaps, told apart by
 * verify; every other row is one per file and rule.
 *
 *   npm run check:boundaries                         compare with the ledger
 *   npm run check:boundaries -- --base origin/next   also compare with the ledger at a ref
 *   npm run check:boundaries -- --write-baseline     seed the ledger from today's hits, or
 *                                                    record lower counts; never raises one
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const LEDGER = 'docs/architecture/kernel-ledger.json';
const FIELDS = ['file', 'rule', 'count', 'owner', 'removeWhen', 'verify'];
const KERNEL_ISSUE = 12;
const VERIFY = 'npm run check:boundaries';
const ABOUT = 'Hits of the kernel boundary rules (#12, eslint.config.mjs) each legacy file may still have, '
  + 'per rule. `npm run check:boundaries` fails on a hit no row covers, a count that rises, and a count '
  + 'that falls without its row falling in the same PR. Only `--write-baseline` writes this file; a PR '
  + 'may add a row by hand for a rule #12 defines, with an owner other than #12, removeWhen, and verify. '
  + 'The rules in shrinkOnly (#17\'s storage access) take no new row and no higher count, except a '
  + 'legacyBlindWrite count that rises by no more than the same file\'s getStore and objectStore counts fall.';

// The ledger rules, which #12 defines; each eslint.config.mjs message starts with its rule
const RULES = {
  indexedDB: 'indexedDB outside js/kernel/ and js/storage.js',
  Storage: 'the legacy Storage global outside js/kernel/ and js/storage.js',
  'this.storage': 'this.storage outside js/kernel/ and js/storage.js',
  'chrome.storage': 'chrome.storage outside js/kernel/ and js/storage.js',
  'window.app': 'the global App outside js/kernel/ and js/storage.js',
  'window.opener': 'window.opener outside js/kernel/ and js/storage.js',
  LLM: 'the LLM global outside js/kernel/ and js/storage.js',
  fetch: 'fetch outside js/kernel/ and js/storage.js',
  'adapter-import': 'an import from js/kernel/adapters/ outside js/kernel/',
  'core-global': 'a browser API or legacy global in js/kernel/core/',
  'core-import': 'an import into js/kernel/core/ from outside it and js/lib/valibot/',
  'app-callback': "an assignment to a controller's on* or get* property in js/app.js",
  'scheduler-timer': 'a setInterval assigned to autoTitleIntervalId or insightsIntervalId',
  'declared-gap': 'a gap no rule sees, written by hand (count 1, file is the legacy adapter module)',
  // #17's storage-access rules (#17 slice 1): their rows are a shrink-only exemption list
  objectStore: "an IndexedDB object store opened outside #17's IndexedDB adapter",
  getStore: 'a call of DatabaseManager.getStore',
  legacyBlindWrite: 'a write through legacyBlindWrite(), which skips its expected version',
  'chrome.storage.local': 'chrome.storage.local outside js/kernel/adapters/ and js/kernel/composition/',
};
const DECLARED_GAP = 'declared-gap';
// The one module that declares gaps (its adapter flags), and the issue whose adapter closes them
const DECLARED_GAP_FILE = 'js/kernel/adapters/legacy/adapter.js';
const DECLARED_GAP_OWNER = 17;
// The raw access a blind write may replace in the same file under a shrinkOnly rule: an
// unconverted caller moves onto #17's adapter, which commits it, before it gets a command
const CONVERTS_FROM = { legacyBlindWrite: ['getStore', 'objectStore'] };

/**
 * Who removes each kind of hit, for rows --write-baseline seeds: the first entry whose
 * file and rule match. Owners follow #12's "Allowed at close"; anything else is #12's.
 */
const SEED_OWNERS = [
  { rule: 'scheduler-timer', owner: 35, removeWhen: '#8 deletes them' },
  { rule: 'objectStore', owner: 17, removeWhen: "#17 slice 6 puts every store access behind #17's IndexedDB adapter" },
  { rule: 'getStore', owner: 17, removeWhen: '#17 slice 6 moves the readers to read-only queries and deletes getStore' },
  { rule: 'legacyBlindWrite', owner: 17, removeWhen: '#17 slice 6 converts every blind write into a typed command' },
  { rule: 'chrome.storage.local', owner: 17, removeWhen: "#17 slice 6 moves settings behind the kernel's typed settings repository" },
  { file: 'js/llm.js', owner: 11, removeWhen: '#11 moves provider settings, keys, and requests behind its provider registry; #21 reviews the key rows' },
  { file: 'js/services/sync-service.js', owner: 19, removeWhen: "#19's sync engine replaces js/services/sync-service.js" },
  { file: 'js/ui/graph-view.js', owner: 22, removeWhen: '#22 builds the graph view from its own pipeline' },
  { rule: 'LLM', owner: 11, removeWhen: '#11 replaces the LLM global with the injected AI port' },
  { rule: 'fetch', owner: 11, removeWhen: '#11 moves the provider request proxy into its AI adapter' },
  { file: 'js/popup.js', owner: 12, removeWhen: "#12 slice 4: Popup lists notes and saves its quick note through its composition root's client" },
  { file: 'js/sidepanel.js', owner: 12, removeWhen: "#12 slice 4: Side Panel reads notes through its composition root's client" },
  { file: 'js/background.js', owner: 12, removeWhen: "#12 slice 4: capture runs as the kernel's captureToDailyNote command" },
  { file: 'js/editor.js', rule: 'window.opener', owner: 12, removeWhen: "#12 slice 4: getApp's lookups go with getApp, and getLLM's become the injected AI port, re-pointed to #11 if they stay here" },
  { file: 'js/editor.js', owner: 12, removeWhen: '#12 slice 4: BlockEditor, PiP included, gets a document client and a navigation port in place of Storage and getApp' },
  { file: 'js/app.js', rule: 'window.app', owner: 12, removeWhen: '#12 slice 7: the new-tab composition root replaces the bootstrap' },
  { file: 'js/app.js', rule: 'app-callback', owner: 12, removeWhen: '#12 slice 7 replaces the domain callbacks with projections; UI-only ones left are re-pointed to #2 or #3' },
  { file: 'js/app.js', owner: 12, removeWhen: "#12 slices 4 to 7 route App's reads and writes through kernel commands and queries; search index, vector, and sync calls left are re-pointed to #22 and #19" },
  { file: 'js/controllers/tab-controller.js', rule: 'chrome.storage', owner: 12, removeWhen: '#12 slice 6: TabController saves the workspace session with saveWorkspaceSession' },
  { file: 'js/theme-engine.js', owner: 12, removeWhen: '#12 slice 6: themes go through kernel commands and queries' },
  { file: 'js/onboarding.js', owner: 12, removeWhen: '#12 slice 6: onboarding writes go through kernel commands' },
  { file: 'js/analytics.js', owner: 12, removeWhen: '#12: analytics reads the note-list projection in place of storage' },
  { rule: 'this.storage', owner: 12, removeWhen: '#12 slice 7: controllers get narrow ports in place of storage: Storage; search index and vector calls left are re-pointed to #22' },
  { owner: 12, removeWhen: '#12 routes these through kernel commands and queries' },
];

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function keyOf(file, rule) {
  return `${file}\0${rule}`;
}

/**
 * A ledger row's key: its file and rule, and for a declared-gap row its verify too, since
 * the legacy adapter module declares one gap per row
 */
function rowKey(row) {
  return row.rule === DECLARED_GAP ? `${keyOf(row.file, row.rule)}\0${row.verify}` : keyOf(row.file, row.rule);
}

function byFileThenRule(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
}

function byRowKey(a, b) {
  return byFileThenRule(a, b) || (a.verify < b.verify ? -1 : a.verify > b.verify ? 1 : 0);
}

/**
 * The ledger rule an ESLint message counts under, or null when it isn't a boundary message
 */
function ruleOf(message) {
  if (message.ruleId === 'no-undef') return 'core-global';
  const tag = /\[([^\]\s]+)\]/.exec(message.message || '');
  return tag && Object.hasOwn(RULES, tag[1]) && tag[1] !== DECLARED_GAP ? tag[1] : null;
}

/**
 * Lint js/ under `root` with its eslint.config.mjs. Returns the hits by file and rule, as
 * { file, rule, count, at: ['line:col', ...] } in a Map by keyOf, and what isn't a hit:
 * files ESLint couldn't parse and messages from rules no ledger rule names.
 */
async function lint(root) {
  const { ESLint } = require('eslint');
  const eslint = new ESLint({ cwd: root, allowInlineConfig: false });
  const results = await eslint.lintFiles(['js']);
  const hits = new Map();
  const errors = [];
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join('/');
    for (const message of result.messages) {
      const at = `${message.line}:${message.column}`;
      const rule = message.fatal ? null : ruleOf(message);
      if (!rule) {
        errors.push(`${file}:${at} ${message.fatal ? "doesn't parse: " : `${message.ruleId || 'eslint'}: `}${message.message}`);
        continue;
      }
      const key = keyOf(file, rule);
      if (!hits.has(key)) hits.set(key, { file, rule, count: 0, at: [] });
      const hit = hits.get(key);
      hit.count++;
      hit.at.push(at);
    }
  }
  return { hits, errors, files: results.length };
}

/**
 * The ledger at `ref`, as { text } or { missing: true } when the ref has none. Throws when
 * git can't resolve the ref.
 */
function readBase(ref, root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`git can't resolve ${ref} to a commit; fetch it, or check out with enough history`);
  }
  try {
    git(['cat-file', '-e', `${ref}:${LEDGER}`]);
  } catch {
    return { missing: true };
  }
  return { text: git(['show', `${ref}:${LEDGER}`]) };
}

/**
 * The rules a ledger's `shrinkOnly` lists: each a hit rule this file defines, once
 */
function parseShrinkOnly(value, name, problems) {
  const rules = new Set();
  if (value === undefined) return rules;
  if (!Array.isArray(value)) {
    problems.push(`${name}: shrinkOnly isn't a list of rules`);
    return rules;
  }
  for (const rule of value) {
    if (typeof rule !== 'string' || !Object.hasOwn(RULES, rule) || rule === DECLARED_GAP) {
      problems.push(`${name}: shrinkOnly names ${JSON.stringify(rule)}, which isn't a rule with hits`);
    } else if (rules.has(rule)) {
      problems.push(`${name}: shrinkOnly names ${rule} twice`);
    } else {
      rules.add(rule);
    }
  }
  return rules;
}

/**
 * Parse and validate ledger text. Returns the rows in a Map by rowKey, the rules its
 * `shrinkOnly` lists, and each problem.
 */
function parseLedger(text, root, name) {
  const rows = new Map();
  const problems = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { rows, shrinkOnly: new Set(), problems: [`${name} isn't valid JSON: ${e.message}`] };
  }
  if (!data || !Array.isArray(data.rows)) {
    return { rows, shrinkOnly: new Set(), problems: [`${name} has no "rows" array`] };
  }
  const shrinkOnly = parseShrinkOnly(data.shrinkOnly, name, problems);

  data.rows.forEach((row, index) => {
    let label = row && typeof row.file === 'string' && typeof row.rule === 'string'
      ? `${row.file} ${row.rule}` : `row ${index + 1}`;
    if (row && row.rule === DECLARED_GAP && typeof row.verify === 'string') label += ` (${row.verify})`;
    const fail = why => problems.push(`${name}: ${label} ${why}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('is not an object');
      return;
    }
    const missing = FIELDS.filter(field => !Object.hasOwn(row, field));
    const extra = Object.keys(row).filter(field => !FIELDS.includes(field));
    if (missing.length > 0) fail(`is missing ${missing.join(', ')}`);
    if (extra.length > 0) fail(`has fields the ledger doesn't define: ${extra.join(', ')}`);
    if (missing.length > 0) return;

    if (typeof row.file !== 'string' || !/^js\/[^\0]+$/.test(row.file) || row.file.split('/').includes('..')) {
      fail('needs a file under js/');
    }
    if (!Object.hasOwn(RULES, row.rule)) fail(`names a rule #12 doesn't define (${Object.keys(RULES).join(', ')})`);
    if (!Number.isInteger(row.count) || row.count < 1) fail('needs a count of 1 or more');
    if (!Number.isInteger(row.owner) || row.owner < 1) fail('needs an owner issue number');
    for (const field of ['removeWhen', 'verify']) {
      if (typeof row[field] !== 'string' || row[field].trim() === '') fail(`needs a ${field}`);
    }
    if (row.rule === DECLARED_GAP) {
      if (row.count !== 1) fail('is a declared-gap row, so its count is 1');
      if (row.file !== DECLARED_GAP_FILE) fail(`is a declared-gap row, so its file is ${DECLARED_GAP_FILE}`);
      else if (!fs.existsSync(path.join(root, row.file))) fail(`names ${row.file}, which doesn't exist`);
      if (row.owner !== DECLARED_GAP_OWNER) fail(`is a declared-gap row, so #${DECLARED_GAP_OWNER} owns it`);
    }

    const key = rowKey(row);
    if (rows.has(key)) fail('appears twice');
    else rows.set(key, row);
  });
  return { rows, shrinkOnly, problems };
}

function serializeLedger(rows, shrinkOnly = new Set()) {
  const sorted = [...rows].sort(byRowKey).map(row => Object.fromEntries(FIELDS.map(field => [field, row[field]])));
  const ledger = shrinkOnly.size > 0
    ? { about: ABOUT, shrinkOnly: [...shrinkOnly].sort(), rows: sorted }
    : { about: ABOUT, rows: sorted };
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/**
 * The row --write-baseline seeds for a hit with no row yet
 */
function seedRow({ file, rule, count }) {
  const policy = SEED_OWNERS.find(entry => (!entry.file || entry.file === file) && (!entry.rule || entry.rule === rule));
  return { file, rule, count, owner: policy.owner, removeWhen: policy.removeWhen, verify: VERIFY };
}

/**
 * Compare hits with the ledger rows. Returns problems, each { kind, message, at }: kind
 * 'over' for hits past a row's count (or with no row) and 'under' for a count to lower,
 * and at the hit locations to print under the message.
 */
function compare(hits, rows) {
  const problems = [];
  const keys = new Set([...hits.keys(), ...[...rows].filter(([, row]) => row.rule !== DECLARED_GAP).map(([key]) => key)]);
  const ordered = [...keys].map(key => hits.get(key) || rows.get(key)).sort(byFileThenRule);
  for (const { file, rule } of ordered) {
    const key = keyOf(file, rule);
    const hit = hits.get(key) || { count: 0, at: [] };
    const row = rows.get(key);
    const allowed = row ? row.count : 0;
    if (hit.count > allowed) {
      problems.push({
        kind: 'over',
        message: row
          ? `${file}: ${plural(hit.count, `${rule} hit`)}, ${allowed} allowed by the ledger`
          : `${file}: ${plural(hit.count, `${rule} hit`)} no ledger row covers`,
        at: hit.at,
      });
    } else if (hit.count < allowed) {
      problems.push({
        kind: 'under',
        message: `${file}: ${plural(hit.count, `${rule} hit`)}, below the ledger's ${allowed}: `
          + (hit.count === 0 ? 'delete the row' : `lower its count to ${hit.count}`) + ' in this PR',
        at: [],
      });
    }
  }
  return problems;
}

/**
 * Compare the ledger with the ledger at the base ref. `shrinkOnly` is the rules the ledger
 * lists there, and `baseShrinkOnly` the ones the base lists, whose rows only shrink.
 */
function compareBase(rows, baseRows, ref, { shrinkOnly = new Set(), baseShrinkOnly = new Set() } = {}) {
  const problems = [];
  const countIn = (ledgerRows, file, rule) => (ledgerRows.get(keyOf(file, rule)) || { count: 0 }).count;
  // How far the hits a blind write may replace fell in `file` since the base
  const replaced = (file, rule) => (CONVERTS_FROM[rule] || [])
    .reduce((sum, from) => sum + Math.max(0, countIn(baseRows, file, from) - countIn(rows, file, from)), 0);
  for (const rule of [...baseShrinkOnly].sort()) {
    if (!shrinkOnly.has(rule)) {
      problems.push({ message: `shrinkOnly no longer lists ${rule}, which it lists at ${ref}; that exemption list only shrinks`, at: [] });
    }
  }
  for (const row of [...rows.values()].sort(byRowKey)) {
    const was = baseRows.get(rowKey(row));
    if (baseShrinkOnly.has(row.rule)) {
      const before = was ? was.count : 0;
      if (row.count > before + replaced(row.file, row.rule)) {
        const grew = was ? `count ${was.count} at ${ref} rose to ${row.count}` : `a row added since ${ref}`;
        const unless = CONVERTS_FROM[row.rule]
          ? `, except by as much as ${CONVERTS_FROM[row.rule].join(' and ')} hits in the same file fall`
          : '';
        problems.push({ message: `${row.file} ${row.rule}: ${grew}, but ${row.rule}'s exemption list only shrinks${unless}`, at: [] });
      }
      if (!was && row.owner === KERNEL_ISSUE) {
        problems.push({ message: `${row.file} ${row.rule}: a row added since ${ref} names #12 as owner; a new row needs another issue as its owner`, at: [] });
      }
      continue;
    }
    if (was && row.count > was.count) {
      problems.push({ message: `${row.file} ${row.rule}: count ${was.count} at ${ref} rose to ${row.count}; fix the new hits instead`, at: [] });
    } else if (!was && row.owner === KERNEL_ISSUE) {
      problems.push({ message: `${row.file} ${row.rule}: a row added since ${ref} names #12 as owner; a new row needs another issue as its owner`, at: [] });
    }
  }
  return problems;
}

function usage(error) {
  error('usage: node scripts/check-boundaries.js [--base <git ref>] [--write-baseline]');
  return 2;
}

/**
 * Run the check. Resolves to the exit code.
 */
async function main(argv = process.argv.slice(2), options = {}) {
  const {
    root = ROOT_DIR,
    lint: runLint = lint,
    readBase: readBaseLedger = readBase,
    log = console.log,
    error = console.error,
  } = options;
  const ledgerPath = path.join(root, LEDGER);

  let base = null;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-baseline') write = true;
    else if (argv[i] === '--base' && argv[i + 1] && !argv[i + 1].startsWith('-')) base = argv[++i];
    else return usage(error);
  }
  if (write && base) return usage(error);

  const fail = (summary, problems) => {
    error(`check:boundaries failed: ${summary}`);
    for (const { message, at } of problems) {
      error(`  - ${message}`);
      if (at.length > 0) error(`      at ${at.join(', ')}`);
    }
    return 1;
  };

  const { hits, errors, files } = await runLint(root);
  if (errors.length > 0) {
    return fail(`${plural(errors.length, 'ESLint message')} that no ledger rule counts, so the hits can't be trusted`,
      errors.map(message => ({ message, at: [] })));
  }
  const totalHits = [...hits.values()].reduce((sum, hit) => sum + hit.count, 0);

  const exists = fs.existsSync(ledgerPath);
  const ledger = exists
    ? parseLedger(fs.readFileSync(ledgerPath, 'utf8'), root, LEDGER)
    : { rows: new Map(), shrinkOnly: new Set(), problems: [] };
  if (ledger.problems.length > 0) {
    return fail(`${LEDGER} has ${plural(ledger.problems.length, 'problem')}`, ledger.problems.map(message => ({ message, at: [] })));
  }

  if (write) {
    let rows;
    if (!exists) {
      rows = [...hits.values()].map(seedRow);
    } else {
      const raised = compare(hits, ledger.rows).filter(problem => problem.kind === 'over');
      if (raised.length > 0) {
        return fail(`--write-baseline only seeds the ledger or lowers its counts, so ${LEDGER} was not written. `
          + 'Fix these hits, or add their rows by hand with an owner other than #12', raised);
      }
      rows = [...ledger.rows.values()]
        .map(row => (row.rule === DECLARED_GAP ? row : { ...row, count: (hits.get(keyOf(row.file, row.rule)) || { count: 0 }).count }))
        .filter(row => row.count > 0);
    }
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, serializeLedger(rows, ledger.shrinkOnly));
    const byRule = {};
    rows.forEach(row => { byRule[row.rule] = (byRule[row.rule] || 0) + 1; });
    log(`check:boundaries: ${exists ? 'recorded' : 'seeded'} ${LEDGER} with ${plural(rows.length, 'row')} for ${plural(totalHits, 'hit')}`);
    Object.keys(byRule).sort().forEach(rule => log(`  ${rule}: ${plural(byRule[rule], 'row')}`));
    return 0;
  }

  if (!exists) {
    return fail(`${LEDGER} is missing. Seed it once with \`npm run check:boundaries -- --write-baseline\``, []);
  }

  const problems = compare(hits, ledger.rows);
  let baseNote = '';
  if (base) {
    let found;
    try {
      found = readBaseLedger(base, root);
    } catch (e) {
      return fail(`can't read the ledger at ${base}: ${e.message}`, []);
    }
    if (found.missing) {
      baseNote = `; ${base} has no ledger, so every row is new`;
    } else {
      const baseLedger = parseLedger(found.text, root, `${LEDGER} at ${base}`);
      problems.push(...compareBase(ledger.rows, baseLedger.rows, base, {
        shrinkOnly: ledger.shrinkOnly,
        baseShrinkOnly: baseLedger.shrinkOnly,
      }));
      baseNote = `; no row rose or was added for #12 since ${base}`;
      if (baseLedger.shrinkOnly.size > 0) baseNote += `, and no shrinkOnly list grew`;
    }
  }
  if (problems.length > 0) return fail(`${plural(problems.length, 'problem')} against ${LEDGER}`, problems);

  log(`check:boundaries: OK, ${plural(totalHits, 'hit')} in ${plural(files, 'file')} match ${plural(ledger.rows.size, 'row')} of ${LEDGER}${baseNote}`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, e => {
    console.error(`check:boundaries failed: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}

module.exports = { main, lint, ruleOf, parseLedger, serializeLedger, seedRow, compare, compareBase, RULES, SEED_OWNERS, LEDGER };
