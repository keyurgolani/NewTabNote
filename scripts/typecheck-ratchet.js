#!/usr/bin/env node

/**
 * Type diagnostic ratchet.
 *
 * Runs `tsc --project jsconfig.json --pretty false` and compares its diagnostics with
 * ci/baselines/typecheck.json. Each diagnostic is keyed by file, code, and message, with
 * no line or column, so edits above it don't move it, and repeats are counted.
 *
 * Diagnostics in js/kernel/ are dropped first: `npm run typecheck:kernel` checks those
 * files under tsconfig.kernel.json's strict config and must report none. jsconfig.json
 * still reaches them, through its js/ include and the imports from js/background.js, until
 * #27 lists the legacy files instead (docs/adr/0001-kernel-stack.md, decision 1).
 *
 *   npm run typecheck:ratchet               fail on a new key, a higher count, or a lower
 *                                           count the baseline hasn't recorded yet
 *   npm run typecheck:ratchet -- --update   record lowered and removed counts; exits 1
 *                                           without writing when anything is new or higher
 *   node scripts/typecheck-ratchet.js --init  write the first baseline; refuses when the
 *                                           file already exists
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const BASELINE_PATH = path.join(ROOT_DIR, 'ci', 'baselines', 'typecheck.json');
const TSC_ARGS = ['--project', 'jsconfig.json', '--pretty', 'false'];
const UPDATE_COMMAND = 'npm run typecheck:ratchet -- --update';
const ABOUT = 'tsc diagnostics allowed by scripts/typecheck-ratchet.js, as file -> code -> message -> count. '
  + `A new key or a higher count fails. Record fixes with \`${UPDATE_COMMAND}\`.`;

// `file(line,col): error TS1234: message`, and the same without a file for global diagnostics
const LOCATED = /^(\S.*?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const GLOBAL = /^(error|warning|message) (TS\d+): (.*)$/;
// tsc's exit codes when it reports diagnostics (DiagnosticsPresent_OutputsSkipped and _OutputsGenerated)
const DIAGNOSTIC_EXIT_CODES = [1, 2];
// Node's own warnings, the only stderr a trusted run may have
const NODE_WARNING = /^\(node:\d+\) |^\(Use `node --trace-[a-z-]+ \.\.\.` to show where the warning was created\)$/;
// Checked by typecheck:kernel instead (see the top of this file)
const KERNEL_DIR = 'js/kernel/';

/**
 * Run tsc from the repository root and return its exit status and output
 */
function runTsc() {
  const tsc = require.resolve('typescript/bin/tsc', { paths: [ROOT_DIR] });
  const result = spawnSync(process.execPath, [tsc, ...TSC_ARGS], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Parse `tsc --pretty false` output. A line indented under a diagnostic continues its
 * message. Returns the diagnostics and any line that is neither.
 */
function parseTscOutput(text) {
  const diagnostics = [];
  const unparsed = [];
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;

    if (current && /^\s/.test(line)) {
      current.message += `\n${line}`;
      current.lines.push(line);
      continue;
    }

    const located = LOCATED.exec(line);
    const global = located ? null : GLOBAL.exec(line);
    if (located) {
      current = { file: located[1].replace(/\\/g, '/'), code: located[5], message: located[6], lines: [line] };
      diagnostics.push(current);
    } else if (global) {
      current = { file: '', code: global[2], message: global[3], lines: [line] };
      diagnostics.push(current);
    } else {
      unparsed.push(line);
    }
  }

  return { diagnostics, unparsed };
}

/**
 * Why a tsc run can't be trusted, or null. Diagnostics must come with one of tsc's
 * diagnostic exit codes and no diagnostics with 0, stderr may hold only Node's own
 * warnings, and every stdout line must parse. Anything else may be a crash after
 * partial output, which --update would otherwise record as fixes.
 */
function untrustedRun(tsc, diagnostics, unparsed) {
  const lines = text => (text || '').split(/\r?\n/).filter(line => line.trim());
  const stderr = lines(tsc.stderr).filter(line => !NODE_WARNING.test(line));

  if (tsc.status === null) {
    return { reason: 'tsc was killed by a signal', lines: stderr };
  }
  if (diagnostics.length === 0 && tsc.status !== 0) {
    return { reason: `tsc exited ${tsc.status} with no parseable diagnostics`, lines: [...lines(tsc.stdout), ...stderr] };
  }
  if (stderr.length > 0) {
    return { reason: 'tsc wrote to stderr', lines: stderr };
  }
  if (diagnostics.length > 0 && !DIAGNOSTIC_EXIT_CODES.includes(tsc.status)) {
    return { reason: `tsc printed diagnostics but exited ${tsc.status}, not ${DIAGNOSTIC_EXIT_CODES.join(' or ')}`, lines: [] };
  }
  if (unparsed.length > 0) {
    return { reason: `tsc printed ${plural(unparsed.length, 'line')} the ratchet can't parse`, lines: unparsed };
  }
  return null;
}

/**
 * The diagnostics the ratchet counts: all but those in js/kernel/
 */
function legacyDiagnostics(diagnostics) {
  return diagnostics.filter(({ file }) => !file.startsWith(KERNEL_DIR));
}

function keyOf({ file, code, message }) {
  return JSON.stringify([file, code, message]);
}

function describeKey(key) {
  const [file, code, message] = JSON.parse(key);
  const firstLine = message.split('\n')[0];
  return `${file || '(no file)'} ${code} ${JSON.stringify(firstLine)}`;
}

/**
 * Count diagnostics by key
 */
function countDiagnostics(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const key = keyOf(diagnostic);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Serialize counts as the baseline file, sorted so diffs stay small
 */
function serializeBaseline(counts) {
  const diagnostics = {};
  const keys = [...counts.keys()].map(key => JSON.parse(key));
  keys.sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]) || byCodeUnit(a[2], b[2]));
  for (const [file, code, message] of keys) {
    diagnostics[file] = diagnostics[file] || {};
    diagnostics[file][code] = diagnostics[file][code] || {};
    diagnostics[file][code][message] = counts.get(JSON.stringify([file, code, message]));
  }
  return `${JSON.stringify({ about: ABOUT, diagnostics }, null, 2)}\n`;
}

/**
 * Read the baseline file into counts. Throws on a malformed file.
 */
function parseBaseline(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.diagnostics !== 'object' || data.diagnostics === null) {
    throw new Error('missing a "diagnostics" object');
  }
  const counts = new Map();
  for (const [file, codes] of Object.entries(data.diagnostics)) {
    for (const [code, messages] of Object.entries(codes || {})) {
      for (const [message, count] of Object.entries(messages || {})) {
        if (!Number.isInteger(count) || count < 1) {
          throw new Error(`${describeKey(keyOf({ file, code, message }))} has count ${JSON.stringify(count)}`);
        }
        counts.set(keyOf({ file, code, message }), count);
      }
    }
  }
  return counts;
}

/**
 * Compare current counts with the baseline
 */
function compare(baseline, current) {
  const added = [];
  const raised = [];
  const lowered = [];
  for (const [key, count] of current) {
    const allowed = baseline.get(key) || 0;
    if (allowed === 0) added.push({ key, allowed, count });
    else if (count > allowed) raised.push({ key, allowed, count });
    else if (count < allowed) lowered.push({ key, allowed, count });
  }
  for (const [key, allowed] of baseline) {
    if (!current.has(key)) lowered.push({ key, allowed, count: 0 });
  }
  return { added, raised, lowered };
}

function total(counts) {
  let sum = 0;
  for (const count of counts.values()) sum += count;
  return sum;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Print each new or higher diagnostic in full
 */
function reportIncreases({ added, raised }, diagnostics, baselineName, error) {
  const linesFor = key => diagnostics.filter(d => keyOf(d) === key).flatMap(d => d.lines);
  if (added.length > 0) {
    error(`\nNew diagnostics, not in ${baselineName}:`);
    for (const { key } of added) linesFor(key).forEach(line => error(`  ${line}`));
  }
  if (raised.length > 0) {
    error(`\nMore diagnostics than ${baselineName} allows:`);
    for (const { key, allowed, count } of raised) {
      error(`  ${describeKey(key)}: ${count} found, ${allowed} allowed`);
      linesFor(key).forEach(line => error(`    ${line}`));
    }
  }
}

function reportDecreases(lowered, write) {
  for (const { key, allowed, count } of lowered) {
    write(`  ${describeKey(key)}: ${allowed} -> ${count}`);
  }
}

/**
 * Run the ratchet. Returns the exit code.
 */
function main(argv = process.argv.slice(2), options = {}) {
  const {
    runTsc: run = runTsc,
    baselinePath = BASELINE_PATH,
    log = console.log,
    error = console.error,
  } = options;
  const baselineName = path.relative(ROOT_DIR, baselinePath).startsWith('..')
    ? baselinePath
    : path.relative(ROOT_DIR, baselinePath);

  const unknown = argv.filter(arg => arg !== '--init' && arg !== '--update');
  const init = argv.includes('--init');
  const update = argv.includes('--update');
  if (unknown.length > 0 || (init && update)) {
    error(`usage: node scripts/typecheck-ratchet.js [--init | --update]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`);
    return 2;
  }

  if (init && fs.existsSync(baselinePath)) {
    error(`typecheck ratchet: refusing --init, ${baselineName} already exists. Record fixes with \`${UPDATE_COMMAND}\`.`);
    return 1;
  }

  const tsc = run();
  const parsed = parseTscOutput(tsc.stdout || '');
  // Every diagnostic counts toward trusting the run, kernel ones included
  const untrusted = untrustedRun(tsc, parsed.diagnostics, parsed.unparsed);
  if (untrusted) {
    error(`typecheck ratchet: ${untrusted.reason}${init || update ? `, so ${baselineName} was not written` : ''}`);
    untrusted.lines.slice(0, 20).forEach(line => error(`  ${line}`));
    return 1;
  }
  const diagnostics = legacyDiagnostics(parsed.diagnostics);
  const current = countDiagnostics(diagnostics);

  if (init) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, serializeBaseline(current));
    log(`typecheck ratchet: wrote ${baselineName} with ${plural(total(current), 'diagnostic')} under ${plural(current.size, 'key')}`);
    return 0;
  }

  if (!fs.existsSync(baselinePath)) {
    error(`typecheck ratchet: ${baselineName} is missing. Seed it once with \`node scripts/typecheck-ratchet.js --init\`.`);
    return 1;
  }
  let baseline;
  try {
    baseline = parseBaseline(fs.readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    error(`typecheck ratchet: can't read ${baselineName}: ${e.message}`);
    return 1;
  }

  const result = compare(baseline, current);
  const increases = result.added.length + result.raised.length;

  if (increases > 0) {
    const parts = [];
    if (result.added.length) parts.push(`${plural(result.added.length, 'new key')}`);
    if (result.raised.length) parts.push(`${plural(result.raised.length, 'key')} above the baseline count`);
    error(`typecheck ratchet failed: ${parts.join(', ')}${update ? `. --update only lowers or removes counts, so ${baselineName} was not written` : ''}`);
    reportIncreases(result, diagnostics, baselineName, error);
    if (result.lowered.length > 0) {
      error(`\nAlso lowered (record with \`${UPDATE_COMMAND}\` once the new diagnostics are fixed):`);
      reportDecreases(result.lowered, error);
    }
    return 1;
  }

  if (result.lowered.length > 0) {
    if (update) {
      fs.writeFileSync(baselinePath, serializeBaseline(current));
      log(`typecheck ratchet: recorded ${plural(result.lowered.length, 'lowered key')} in ${baselineName}, now ${plural(total(current), 'diagnostic')}`);
      reportDecreases(result.lowered, log);
      return 0;
    }
    error(`typecheck ratchet failed: ${plural(result.lowered.length, 'key')} below the baseline count. Record the fixes with \`${UPDATE_COMMAND}\` and commit ${baselineName}.`);
    reportDecreases(result.lowered, error);
    return 1;
  }

  log(`typecheck ratchet: OK, ${plural(total(current), 'diagnostic')} under ${plural(current.size, 'key')} match ${baselineName}${update ? ', nothing to record' : ''}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, parseTscOutput, legacyDiagnostics, countDiagnostics, compare, serializeBaseline, parseBaseline };
