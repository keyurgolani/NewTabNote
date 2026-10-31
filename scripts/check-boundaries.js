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
 * hits: count 1, an adapter module that declares gaps as file, which has to exist, and the
 * issue that closes them as owner (DECLARED_GAP_OWNERS): #17 for the legacy adapter's, which
 * #17's adapter closes. #17's adapter declares none since its PR 4a runs the backup tasks.
 * A module's gaps are told apart by verify. A rule whose messages name what they found
 * (NAMED_RULES: app-callback names the callback, legacy-store the handle) may have rows that
 * each name one (`name`), which count that one's hits; the file and rule's row without a name
 * counts the rest. Every other row is one per file and rule.
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
// A row of a named rule may also name the hit it counts, in this order
const ROW_FIELDS = ['file', 'rule', 'name', 'count', 'owner', 'removeWhen', 'verify'];
const KERNEL_ISSUE = 12;
const VERIFY = 'npm run check:boundaries';
const ABOUT = 'Hits of the kernel boundary rules (#12, eslint.config.mjs) each legacy file may still have, '
  + 'per rule. `npm run check:boundaries` fails on a hit no row covers, a count that rises, and a count '
  + 'that falls without its row falling in the same PR. Only `--write-baseline` writes this file; a PR '
  + 'may add a row by hand for a rule #12 defines, with an owner other than #12, removeWhen, and verify. '
  + 'A row of app-callback or legacy-store may name the callback or handle it counts (name), and the '
  + 'file and rule\'s row without one counts the rest. '
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
  // #15's registry kit, host-neutral like core (#15 slice 1)
  'registry-global': 'a browser API or legacy global in js/kernel/registry/',
  'registry-import': 'an import into js/kernel/registry/ from outside it and js/lib/valibot/',
  // #20's trust core, host-neutral like core (#20 slice 1)
  'trust-global': 'a browser API or legacy global in js/trust/core/',
  'trust-import': 'an import into js/trust/core/ from outside it, kernel core, the registry kit, and js/lib/valibot/',
  'app-callback': "an assignment to a controller's on* or get* property in js/app.js",
  'legacy-store': "a handle on js/storage.js the new-tab root gives App, or the whole of it as legacyStorage, outside js/kernel/",
  'scheduler-timer': 'a setInterval assigned to autoTitleIntervalId or insightsIntervalId',
  'declared-gap': 'a gap no rule sees, written by hand (count 1, file is an adapter module that declares gaps)',
  // #17's storage-access rules (#17 slice 1): their rows are a shrink-only exemption list
  // Each counts any use of its function but where it's defined: called, bound, passed on, or taken apart
  objectStore: "an IndexedDB object store opened outside #17's IndexedDB adapter",
  getStore: 'a use of DatabaseManager.getStore',
  legacyBlindWrite: 'a write through legacyBlindWrite(), which skips its expected version',
  'chrome.storage.local': 'chrome.storage.local outside js/kernel/adapters/ and js/kernel/composition/',
};
const DECLARED_GAP = 'declared-gap';
// The modules that declare gaps (their adapter flags), each with the issue that closes them: the
// legacy adapter's, which #17's adapter closes. #17's adapter has every flag since its PR 4a,
// which runs the legacy backup tasks there, so it declares none
const DECLARED_GAP_OWNERS = Object.freeze({
  'js/kernel/adapters/legacy/adapter.js': 17,
});
const DECLARED_GAP_FILES = Object.keys(DECLARED_GAP_OWNERS);
// The raw access a blind write may replace in the same file under a shrinkOnly rule: an
// unconverted caller moves onto #17's adapter, which commits it, before it gets a command
const CONVERTS_FROM = { legacyBlindWrite: ['getStore', 'objectStore'] };
// The rules whose messages name what they found, after the rule, as `[app-callback]
// sidebarController.onArchiveNote: ...`, so a row can count one name's hits (#12 slice 7c)
const NAMED_RULES = ['app-callback', 'legacy-store'];
// What a row's name may be: a property, or a controller and its property
const NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/;

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
  { file: 'js/editor.js', rule: 'window.opener', owner: 12, removeWhen: "#12 slice 4: getLLM's lookups become the injected AI port, re-pointed to #11 if they stay here" },
  { file: 'js/editor.js', owner: 12, removeWhen: '#12 slice 4: BlockEditor, PiP included, gets a document client and a navigation port in place of Storage and getApp' },
  { file: 'js/app.js', rule: 'window.app', owner: 12, removeWhen: '#12 slice 7: the new-tab composition root replaces the bootstrap' },
  { file: 'js/app.js', rule: 'app-callback', owner: 3, removeWhen: "#3's workspace shell wires the editors, tabs, sidebars, palette, and modals itself, with no App between them" },
  { rule: 'legacy-store', owner: 22, removeWhen: "#22's pipelines and #19's sync engine take what App still hands them of js/storage.js" },
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

/** The key of a named rule's row for `name` in `file` */
function namedKey(file, rule, name) {
  return `${keyOf(file, rule)}\0${name}`;
}

/**
 * A ledger row's key: its file and rule, for a declared-gap row its verify too, since the
 * legacy adapter module declares one gap per row, and for a named row its name
 */
function rowKey(row) {
  if (row.rule === DECLARED_GAP) return `${keyOf(row.file, row.rule)}\0${row.verify}`;
  return typeof row.name === 'string' ? namedKey(row.file, row.rule, row.name) : keyOf(row.file, row.rule);
}

/** A row's or a hit's label: its file and rule, and its name when it names one */
function labelOf({ file, rule, name }) {
  return name === undefined ? `${file} ${rule}` : `${file} ${rule} ${name}`;
}

function byFileThenRule(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
}

/** By file and rule, then a rule's unnamed row before its named ones, by name */
function byName(a, b) {
  const [x, y] = [a.name === undefined ? '' : `\0${a.name}`, b.name === undefined ? '' : `\0${b.name}`];
  return x < y ? -1 : x > y ? 1 : 0;
}

function byRowKey(a, b) {
  return byFileThenRule(a, b) || byName(a, b) || (a.verify < b.verify ? -1 : a.verify > b.verify ? 1 : 0);
}

/** Where no-undef counts under registry-global or trust-global rather than core-global */
const REGISTRY_DIR = 'js/kernel/registry/';
const TRUST_DIR = 'js/trust/core/';

/**
 * The ledger rule an ESLint message in `file` counts under, or null when it isn't a boundary
 * message. no-undef runs only in kernel core, the registry kit, and the trust core, so its
 * rule is the one for the directory it's in.
 */
function ruleOf(message, file = '') {
  if (message.ruleId === 'no-undef') {
    if (file.startsWith(REGISTRY_DIR)) return 'registry-global';
    return file.startsWith(TRUST_DIR) ? 'trust-global' : 'core-global';
  }
  const tag = /\[([^\]\s]+)\]/.exec(message.message || '');
  return tag && Object.hasOwn(RULES, tag[1]) && tag[1] !== DECLARED_GAP ? tag[1] : null;
}

/** What a named rule's message says it found, as `sidebarController.onArchiveNote`, or null */
function nameOf(message) {
  const found = /^\[[^\]\s]+\] ([^\s:]+):/.exec(message.message || '');
  return found && NAME.test(found[1]) ? found[1] : null;
}

/**
 * Lint js/ under `root` with its eslint.config.mjs. Returns the hits by file and rule, as
 * { file, rule, count, at: ['line:col', ...] } in a Map by keyOf, a named rule's with the
 * same by name in `names`, and what isn't a hit: files ESLint couldn't parse, messages from
 * rules no ledger rule names, and a named rule's message that names nothing.
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
      const rule = message.fatal ? null : ruleOf(message, file);
      const name = rule && NAMED_RULES.includes(rule) ? nameOf(message) : undefined;
      if (!rule || name === null) {
        errors.push(`${file}:${at} ${message.fatal ? "doesn't parse: " : `${message.ruleId || 'eslint'}: `}${message.message}`);
        continue;
      }
      const key = keyOf(file, rule);
      if (!hits.has(key)) hits.set(key, { file, rule, count: 0, at: [] });
      const hit = hits.get(key);
      hit.count++;
      hit.at.push(at);
      if (name !== undefined) {
        if (!hit.names) hit.names = new Map();
        const named = hit.names.get(name) || { count: 0, at: [] };
        named.count++;
        named.at.push(at);
        hit.names.set(name, named);
      }
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
    if (row && typeof row.name === 'string') label += ` ${row.name}`;
    const fail = why => problems.push(`${name}: ${label} ${why}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('is not an object');
      return;
    }
    const missing = FIELDS.filter(field => !Object.hasOwn(row, field));
    const extra = Object.keys(row).filter(field => !ROW_FIELDS.includes(field));
    if (missing.length > 0) fail(`is missing ${missing.join(', ')}`);
    if (extra.length > 0) fail(`has fields the ledger doesn't define: ${extra.join(', ')}`);
    if (missing.length > 0) return;

    if (typeof row.file !== 'string' || !/^js\/[^\0]+$/.test(row.file) || row.file.split('/').includes('..')) {
      fail('needs a file under js/');
    }
    if (!Object.hasOwn(RULES, row.rule)) fail(`names a rule #12 doesn't define (${Object.keys(RULES).join(', ')})`);
    if (Object.hasOwn(row, 'name')) {
      if (!NAMED_RULES.includes(row.rule)) fail(`names a hit, which only a row of ${NAMED_RULES.join(' or ')} may`);
      else if (typeof row.name !== 'string' || !NAME.test(row.name)) fail('needs a name its rule reports, as `syncStore` or `sidebarController.onArchiveNote`');
    }
    if (!Number.isInteger(row.count) || row.count < 1) fail('needs a count of 1 or more');
    if (!Number.isInteger(row.owner) || row.owner < 1) fail('needs an owner issue number');
    for (const field of ['removeWhen', 'verify']) {
      if (typeof row[field] !== 'string' || row[field].trim() === '') fail(`needs a ${field}`);
    }
    if (row.rule === DECLARED_GAP) {
      if (row.count !== 1) fail('is a declared-gap row, so its count is 1');
      if (!DECLARED_GAP_FILES.includes(row.file)) {
        fail(`is a declared-gap row, so its file is ${DECLARED_GAP_FILES.join(' or ')}`);
      } else {
        if (!fs.existsSync(path.join(root, row.file))) fail(`names ${row.file}, which doesn't exist`);
        const owner = DECLARED_GAP_OWNERS[/** @type {keyof typeof DECLARED_GAP_OWNERS} */ (row.file)];
        if (row.owner !== owner) fail(`is a declared-gap row, so #${owner} owns it`);
      }
    }

    const key = rowKey(row);
    if (rows.has(key)) fail('appears twice');
    else rows.set(key, row);
  });
  return { rows, shrinkOnly, problems };
}

function serializeLedger(rows, shrinkOnly = new Set()) {
  const sorted = [...rows].sort(byRowKey).map(row =>
    Object.fromEntries(ROW_FIELDS.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
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
  const units = unitsOf(hits, rows);
  const keys = new Set([...units.keys(), ...[...rows].filter(([, row]) => row.rule !== DECLARED_GAP).map(([key]) => key)]);
  const ordered = [...keys]
    .map(key => [key, units.get(key) || rows.get(key)])
    .sort(([, a], [, b]) => byFileThenRule(a, b) || byName(a, b));
  for (const [key, { file, rule, name }] of ordered) {
    const unit = units.get(key) || { count: 0, at: [] };
    const row = rows.get(key);
    const allowed = row ? row.count : 0;
    const counted = `${plural(unit.count, `${rule} hit`)}${name === undefined ? '' : ` for ${name}`}`;
    if (unit.count > allowed) {
      // Hits of names no row names, said by name
      const found = unit.names && unit.names.length > 0 ? ` (${unit.names.join(', ')})` : '';
      problems.push({
        kind: 'over',
        message: row
          ? `${file}: ${counted}, ${allowed} allowed by the ledger`
          : `${file}: ${counted}${found} no ledger row covers`,
        at: unit.at,
      });
    } else if (unit.count < allowed) {
      problems.push({
        kind: 'under',
        message: `${file}: ${counted}, below the ledger's ${allowed}: `
          + (unit.count === 0 ? 'delete the row' : `lower its count to ${unit.count}`) + ' in this PR',
        at: [],
      });
    }
  }
  return problems;
}

/**
 * The hits as the ledger's rows count them, in a Map by rowKey: by file and rule, and a named
 * rule's hits of each name a row names by themselves, the rest with their file and rule, which
 * keep their names in `names`
 * @returns {Map<string, {file: string, rule: string, name?: string, count: number, at: string[], names?: string[]}>}
 */
function unitsOf(hits, rows) {
  const units = new Map();
  for (const [key, hit] of hits) {
    if (!hit.names) {
      units.set(key, hit);
      continue;
    }
    const rest = { file: hit.file, rule: hit.rule, count: 0, at: [], names: [] };
    for (const [name, named] of hit.names) {
      const own = namedKey(hit.file, hit.rule, name);
      if (rows.has(own)) {
        units.set(own, { file: hit.file, rule: hit.rule, name, count: named.count, at: named.at });
      } else {
        rest.count += named.count;
        rest.at.push(...named.at);
        rest.names.push(name);
      }
    }
    if (rest.count > 0) units.set(key, rest);
  }
  return units;
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
      problems.push({ message: `${labelOf(row)}: count ${was.count} at ${ref} rose to ${row.count}; fix the new hits instead`, at: [] });
    } else if (!was && row.owner === KERNEL_ISSUE) {
      problems.push({ message: `${labelOf(row)}: a row added since ${ref} names #12 as owner; a new row needs another issue as its owner`, at: [] });
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
      const units = unitsOf(hits, ledger.rows);
      rows = [...ledger.rows]
        .map(([key, row]) => (row.rule === DECLARED_GAP ? row : { ...row, count: (units.get(key) || { count: 0 }).count }))
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

module.exports = {
  main, lint, ruleOf, nameOf, parseLedger, serializeLedger, seedRow, compare, compareBase, RULES, NAMED_RULES, SEED_OWNERS, LEDGER,
};
