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
 * A row whose mode is `report` never fails this script; one whose mode is `gate` exits 1 when
 * it fails, or when the run is invalid.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIB = 1024 * 1024;

const pct = ratio => `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`;
const ms = value => (value === null || value === undefined ? 'n/a' : `${Math.round(value)} ms`);

/**
 * @param {any} probe - the probe's JSON
 * @param {any} budgets - build/budgets.json
 * @returns {{markdown: string, failed: boolean, verdicts: Array<{profile: string, valid: boolean, timing: string, heap: string}>}}
 */
function gateReport(probe, budgets) {
  const timing = budgets.timing;
  const heap = budgets.heap;
  const heapCeiling = heap.limitMiB * (1 + heap.tolerancePct / 100);
  const lines = [
    '## perf: timing and heap against 1.4.0',
    '',
    `Timing (${timing.mode}): the candidate's median ratio to both 1.4.0 runs fails above ${pct(1 + timing.tolerancePct / 100)}; a run is invalid when 1.4.0 against itself is more than ${timing.tolerancePct}% off.`,
    `Heap (${heap.mode}): the candidate's median fails above ${heap.limitMiB} MiB plus ${heap.tolerancePct}%, ${heapCeiling.toFixed(2)} MiB.`,
    `Rows from build/budgets.json. ${timing.mode === 'report' && heap.mode === 'report' ? 'Both are report-only: nothing here fails the job.' : ''}`,
    '',
    '| Profile | Rounds | 1.4.0 against itself | Valid | Candidate against both 1.4.0 runs | Timing | Candidate heap | Heap | 1.4.0, again, candidate (median ms) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const verdicts = [];
  let failed = false;
  for (const [name, profile] of Object.entries(probe.timing ? probe.timing.profiles : {})) {
    const ratios = Object.entries(profile.ratios || {});
    const self = ratios.find(([, ratio]) => ratio.self);
    const candidate = ratios.find(([, ratio]) => ratio.againstBoth);
    if (!self || !candidate) {
      lines.push(`| ${name} | | the run has no reference pair and candidate | | | | | | |`);
      failed = true;
      continue;
    }
    const selfMedian = self[1].interactionReady.median;
    const valid = Math.abs(selfMedian - 1) * 100 <= timing.tolerancePct;
    const both = candidate[1].againstBoth.interactionReady;
    const timingVerdict = !valid ? 'invalid' : both.median - 1 <= timing.tolerancePct / 100 ? 'pass' : 'fail';
    const heapMiB = profile.packages[candidate[0]].heapBytes.median / MIB;
    const heapVerdict = heapMiB <= heapCeiling ? 'pass' : 'fail';
    if (timing.mode === 'gate' && timingVerdict !== 'pass') failed = true;
    if (heap.mode === 'gate' && heapVerdict !== 'pass') failed = true;
    const labels = Object.keys(profile.packages);
    const absolute = labels.map(label => ms(profile.packages[label].interactionReadyMs && profile.packages[label].interactionReadyMs.median)).join(', ');
    lines.push(`| ${name} | ${both.values.length} | ${pct(selfMedian)} (${pct(self[1].interactionReady.q1)} to ${pct(self[1].interactionReady.q3)}) | ${valid ? 'yes' : '**no**'} | ${pct(both.median)} (${pct(both.q1)} to ${pct(both.q3)}) | ${timingVerdict} | ${heapMiB.toFixed(2)} MiB | ${heapVerdict} | ${absolute} |`);
    verdicts.push({ profile: name, valid, timing: timingVerdict, heap: heapVerdict });
  }
  const environment = probe.environment || {};
  lines.push('', `Machine: ${environment.cpu || 'unknown'}, ${environment.cores || '?'} cores, ${environment.platform || ''}; Chromium ${(probe.timing && probe.timing.browser) || 'unknown'}.`);
  if ((probe.problems || []).length > 0) lines.push('', ...probe.problems.map(problem => `- ${problem}`));
  return { markdown: `${lines.join('\n')}\n`, failed, verdicts };
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

module.exports = { gateReport };
