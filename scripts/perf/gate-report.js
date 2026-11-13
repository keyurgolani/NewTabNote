#!/usr/bin/env node
'use strict';

/**
 * Reads a timing run of npm run perf:probe (1.4.0, 1.4.0 again, the candidate, with
 * --baseline build/budgets.json) against build/budgets.json's timing and heap rows, and writes
 * what each says as Markdown, for CI's job summary (#27 slice 4b). For each profile: whether the
 * run is valid (1.4.0 against itself within the timing tolerance), the candidate's ratio to
 * both 1.4.0 runs against the timing row, its heap against the heap row, and the absolute
 * milliseconds beside them.
 *
 *   node scripts/perf/gate-report.js <probe.json> [budgets.json]
 *
 * A profile is invalid when 1.4.0 against itself is off by more than the tolerance, when any
 * round of any package failed, when the probe reported a problem (a fixture digest that isn't
 * the recorded one, for one), or when fewer rounds have a run of every package than the probe
 * asked for, or than build/budgets.json takes. A profile either row takes that the run has no
 * rounds of is invalid too, so a run that measured nothing can't pass a gate. An invalid
 * profile's timing and heap say `invalid`, with the reasons listed under the table.
 *
 * A row whose mode is `report` never fails this script. One whose mode is `gate` exits 1 when
 * it fails on a profile it takes, when the run of one is invalid, or when it names no profile.
 * The probe lists its problems for the whole run, not by profile, so one about a profile a row
 * doesn't take still makes that row's profiles invalid.
 *
 * Then the counts (#300): on each profile the timing row takes, the counted package's highest
 * over its runs, the new tab's IndexedDB reads before its mark and each entry's requests outside
 * the extension, against the entry's reads and requests rows. A null row reports what was
 * counted. A number exits 1 on a count over it, and on a profile the run has no count of, so a
 * run that counted nothing can't pass.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIB = 1024 * 1024;

/** What each count row holds, as the summary names it */
const COUNTS = Object.freeze({ reads: 'IndexedDB reads before its mark', requests: 'requests outside the extension' });

const pct = ratio => `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`;
const ms = value => (value === null || value === undefined ? 'n/a' : `${Math.round(value)} ms`);

/**
 * Each count against its row (#300), on each of `profiles`: the counted package's highest over
 * its runs, the last package the probe counted
 * @param {any} probe
 * @param {any} budgets
 * @param {string[]} profiles
 * @returns {Array<{profile: string, entry: string, row: string, count: number | undefined, limit: number | null, verdict: 'pass' | 'fail' | 'invalid' | 'report'}>}
 */
function countVerdicts(probe, budgets, profiles) {
  const measured = (probe.counts && probe.counts.profiles) || {};
  const verdicts = [];
  for (const profile of profiles) {
    const counted = Object.values((measured[profile] && measured[profile].packages) || {});
    const max = counted.length > 0 ? /** @type {any} */ (counted[counted.length - 1]).max || {} : {};
    for (const [entry, row] of Object.entries(budgets.entries || {})) {
      if (/** @type {any} */ (row).planned) continue;
      for (const name of Object.keys(COUNTS)) {
        if (!(name in /** @type {any} */ (row))) continue;
        const limit = /** @type {any} */ (row)[name];
        const count = max[entry] ? max[entry][name] : undefined;
        const verdict = limit === null ? 'report' : count === undefined ? 'invalid' : count <= limit ? 'pass' : 'fail';
        verdicts.push({ profile, entry, row: name, count, limit, verdict });
      }
    }
  }
  return /** @type {any} */ (verdicts);
}

/**
 * @param {any} probe - the probe's JSON
 * @param {any} budgets - build/budgets.json
 * @returns {{markdown: string, failed: boolean, verdicts: Array<{profile: string, valid: boolean, timing: string, heap: string, problems: string[]}>, countVerdicts: ReturnType<typeof countVerdicts>}}
 */
function gateReport(probe, budgets) {
  const timing = budgets.timing;
  const heap = budgets.heap;
  const heapCeiling = heap.limitMiB * (1 + heap.tolerancePct / 100);
  /** The profiles a row takes */
  const takes = (/** @type {any} */ row) => (Array.isArray(row.profiles) ? row.profiles : []);
  const on = (/** @type {any} */ row) => takes(row).join(' and ') || 'no profile';
  const lines = [
    '## perf: timing and heap against 1.4.0',
    '',
    `Timing (${timing.mode}, on ${on(timing)}): the candidate's median ratio to both 1.4.0 runs fails above ${pct(1 + timing.tolerancePct / 100)}; a run is invalid when 1.4.0 against itself is more than ${timing.tolerancePct}% off.`,
    `Heap (${heap.mode}, on ${on(heap)}): the candidate's median fails above ${heap.limitMiB} MiB plus ${heap.tolerancePct}%, ${heapCeiling.toFixed(2)} MiB.`,
    `Rows from build/budgets.json. ${timing.mode === 'report' && heap.mode === 'report' ? 'Both are report-only: nothing here fails the job.' : ''}`,
    '',
    '| Profile | Rounds | 1.4.0 against itself | Valid | Candidate against both 1.4.0 runs | Timing | Candidate heap | Heap | 1.4.0, again, candidate (median ms) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const verdicts = [];
  /** @type {string[]} */
  const notes = [];
  let failed = false;
  // A gate row that names no profile can't pass any run
  for (const [label, row] of [['timing', timing], ['heap', heap]]) {
    if (takes(row).length > 0) continue;
    notes.push(`- build/budgets.json's ${label} row names no profile`);
    if (row.mode === 'gate') failed = true;
  }
  // For the whole run: the probe doesn't list them by profile, so each one counts for every profile
  const probeProblems = [...(probe.problems || []), ...(probe.packages || []).flatMap(entry => entry.problems || [])];
  // Each profile a row takes, then any other the run measured. A row fails the job only on the
  // profiles it takes
  const measured = (probe.timing && probe.timing.profiles) || {};
  const names = [...new Set([...takes(timing), ...takes(heap), ...Object.keys(measured)])];
  for (const name of names) {
    const timingGates = timing.mode === 'gate' && takes(timing).includes(name);
    const heapGates = heap.mode === 'gate' && takes(heap).includes(name);
    const profile = measured[name];
    const ratios = Object.entries((profile && profile.ratios) || {});
    const self = ratios.find(([, ratio]) => ratio.self);
    const candidate = ratios.find(([, ratio]) => ratio.againstBoth);
    if (!self || !candidate) {
      // Not a run this summary can read: invalid, so a gate fails and a report still writes
      const problems = [profile ? 'the run has no 1.4.0 pair and candidate' : 'the run has no rounds of this profile, which build/budgets.json takes'];
      lines.push(`| ${name} | 0 | n/a | **no** | n/a | invalid | n/a | invalid | |`);
      notes.push(...problems.map(item => `- ${name}: ${item}`));
      if (timingGates || heapGates) failed = true;
      verdicts.push({ profile: name, valid: false, timing: 'invalid', heap: 'invalid', problems });
      continue;
    }
    // A package whose rounds all failed has null where the probe couldn't summarize
    const selfRatio = self[1].interactionReady;
    const both = candidate[1].againstBoth.interactionReady;
    const candidateHeap = profile.packages[candidate[0]] && profile.packages[candidate[0]].heapBytes;
    // What makes the whole profile's run unusable, timing and heap alike
    const problems = [];
    for (const [label, entry] of Object.entries(profile.packages)) {
      if (!entry.interactionReadyMs) problems.push(`${label} measured no round`);
      for (const failure of entry.failures || []) problems.push(`${label} round ${failure.round} failed: ${failure.message}`);
    }
    if (!selfRatio) problems.push('1.4.0 against itself has no paired round');
    if (!both) problems.push(`the ${candidate[0]} has no round paired with both 1.4.0 runs`);
    for (const item of probeProblems) problems.push(`the probe: ${item}`);
    // The medians below rest on the rounds with a run of every package: every round asked needs
    // one, and at least as many as the row takes, so a package short on either side is invalid
    const asked = probe.timing.runs;
    const paired = both ? both.values.length : 0;
    const rounds = Math.min(asked ?? Infinity, paired);
    if (!Number.isInteger(timing.rounds) || timing.rounds < 1) problems.push("build/budgets.json's timing row doesn't say how many rounds it takes");
    else if (rounds < timing.rounds) problems.push(`${rounds} rounds, fewer than the ${timing.rounds} build/budgets.json takes`);
    else if (paired < asked) problems.push(`only ${paired} of the ${asked} rounds asked have a run of every package`);
    const valid = problems.length === 0 && Math.abs(selfRatio.median - 1) * 100 <= timing.tolerancePct;
    const timingVerdict = !valid ? 'invalid' : both.median - 1 <= timing.tolerancePct / 100 ? 'pass' : 'fail';
    const heapMiB = candidateHeap ? candidateHeap.median / MIB : null;
    const heapVerdict = problems.length > 0 || heapMiB === null ? 'invalid' : heapMiB <= heapCeiling ? 'pass' : 'fail';
    notes.push(...problems.map(item => `- ${name}: ${item}`));
    if (timingGates && timingVerdict !== 'pass') failed = true;
    if (heapGates && heapVerdict !== 'pass') failed = true;
    const labels = Object.keys(profile.packages);
    const absolute = labels.map(label => ms(profile.packages[label].interactionReadyMs && profile.packages[label].interactionReadyMs.median)).join(', ');
    const spread = (/** @type {any} */ summary) => (summary ? `${pct(summary.median)} (${pct(summary.q1)} to ${pct(summary.q3)})` : 'n/a');
    lines.push(`| ${name} | ${both ? both.values.length : 0} | ${spread(selfRatio)} | ${valid ? 'yes' : '**no**'} | ${spread(both)} | ${timingVerdict} | ${heapMiB === null ? 'n/a' : `${heapMiB.toFixed(2)} MiB`} | ${heapVerdict} | ${absolute} |`);
    verdicts.push({ profile: name, valid, timing: timingVerdict, heap: heapVerdict, problems });
  }
  if (notes.length > 0) lines.push('', 'Invalid, so neither row is read:', '', ...notes);
  const counts = countVerdicts(probe, budgets, takes(timing));
  if (counts.some(verdict => verdict.verdict === 'fail' || verdict.verdict === 'invalid')) failed = true;
  lines.push(
    '',
    '## perf: counts against their rows',
    '',
    `On ${on(timing)}: the counted package's highest over ${(probe.counts && probe.counts.runs) || 0} untimed runs (#300). A row with no number yet reports; one with a number fails a count over it, or a profile with no count.`,
    '',
    '| Profile | Entry | Count | Counted | Row | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...counts.map(({ profile, entry, row, count, limit, verdict }) => `| ${profile} | ${entry} | ${COUNTS[/** @type {'reads' | 'requests'} */ (row)]} | ${count === undefined ? 'n/a' : count} | ${limit === null ? 'none yet' : limit} | ${verdict} |`),
  );
  const environment = probe.environment || {};
  lines.push('', `Machine: ${environment.cpu || 'unknown'}, ${environment.cores || '?'} cores, ${environment.platform || ''}; Chromium ${(probe.timing && probe.timing.browser) || 'unknown'}.`);
  return { markdown: `${lines.join('\n')}\n`, failed, verdicts, countVerdicts: counts };
}

if (require.main === module) {
  const [probeFile, budgetsFile = path.join(ROOT, 'build', 'budgets.json')] = process.argv.slice(2);
  if (!probeFile) {
    process.stderr.write('usage: node scripts/perf/gate-report.js <probe.json> [budgets.json]\n');
    process.exit(2);
  }
  const report = gateReport(JSON.parse(fs.readFileSync(probeFile, 'utf8')), JSON.parse(fs.readFileSync(budgetsFile, 'utf8')));
  process.stdout.write(report.markdown);
  process.exit(report.failed ? 1 : 0);
}

module.exports = { gateReport, countVerdicts };
