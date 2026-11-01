#!/usr/bin/env node
'use strict';

/**
 * The performance probe (#27 slice 4a; docs/testing.md, "The performance probe"). It measures
 * built extensions from the outside, so it works the same on the legacy build, the 1.4.0
 * package and a bundler's output:
 *
 * - always: for each package's new tab, Popup and Side Panel, the JS, CSS, HTML and font
 *   bytes (raw and gzip) each page loads before it runs, its module count, and what its lazy
 *   chunks and workers would add (scripts/perf/package-bytes.js). It reads a package from the
 *   outside, so a chunk the page's loader boots at once, like today's workspace chunk, is
 *   lazy here; the build's budget check counts it as start (scripts/build/budgets.js);
 * - with --timing: on `ref-desktop`, for each fixture profile, the install-cold
 *   interaction-ready time and the JS heap at it, over --runs rounds, each run on a fresh
 *   profile (scripts/perf/timing.js). With two or more packages the runs interleave: every
 *   round runs each package once, the order rotated each round (AB, BA for two; ABC, BCA, CAB
 *   for three), so the
 *   machine's drift lands on all of them alike, and each package's time is also given as its
 *   per-round ratio to the first package's. Compare packages only within one invocation.
 *
 * It writes JSON to dist-report/ and never touches a package. The timing runs launch Chromium,
 * so they go through the machine lock on a shared machine, like test:extension.
 *
 *   npm run perf:probe                                        bytes for dist/
 *   npm run perf:probe -- --dist <dir> --label 1.4.0          another package, named in the report
 *   npm run perf:probe -- --dist <1.4.0> --dist dist --timing [--runs 11] [--profiles typical,maximal]
 *   npm run perf:probe -- --dist <1.4.0> --dist <1.4.0> --dist dist --timing --runs 12
 *       --baseline docs/performance/baseline-1.4.0.json      a gate run: see gateProblems
 *   npm run perf:probe -- --out <file>                        write the JSON somewhere else
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageBytes } = require('./perf/package-bytes');
const { PROFILES, profileFixture } = require('./perf/profiles');

const ROOT = path.join(__dirname, '..');
const FORMAT = 'ntn-perf-probe/2';
const DEFAULT_RUNS = 11;
const TIMED = ['interactionReadyMs', 'markMs', 'heapBytes', 'saveMs', 'driverMs', 'throttledAtMs', 'documentAtMs', 'domContentLoadedMs', 'keyTries'];

/**
 * The options in `argv`, or a thrown Error that names what's wrong
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { dists: [], labels: [], timing: false, runs: DEFAULT_RUNS, profiles: [...PROFILES], out: null, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--dist') options.dists.push(value());
    else if (arg === '--label') options.labels.push(value());
    else if (arg === '--out') options.out = value();
    else if (arg === '--baseline') options.baseline = value();
    else if (arg === '--timing') options.timing = true;
    else if (arg === '--runs') {
      options.runs = Number(value());
      if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs takes a whole number of at least 1');
    } else if (arg === '--profiles') {
      options.profiles = value().split(',').map(name => name.trim()).filter(Boolean);
      const unknown = options.profiles.filter(name => !PROFILES.includes(name));
      if (unknown.length > 0 || options.profiles.length === 0) {
        throw new Error(`--profiles takes a list of ${PROFILES.join(', ')}${unknown.length > 0 ? `, not ${unknown.join(', ')}` : ''}`);
      }
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (options.labels.length > Math.max(options.dists.length, 1)) throw new Error('there are more --label options than packages');
  return options;
}

/**
 * The median, quartiles, minimum and maximum of `values`, and the values themselves, or null
 * for none
 * @param {number[]} values
 */
function summary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = fraction => {
    const position = (sorted.length - 1) * fraction;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  const round = n => Math.round(n * 1000) / 1000;
  return { median: round(at(0.5)), q1: round(at(0.25)), q3: round(at(0.75)), min: sorted[0], max: sorted[sorted.length - 1], values };
}

/**
 * The packages to measure, each with a label unique in the report
 * @param {{dists: string[], labels: string[]}} options
 */
function packagesOf({ dists, labels }) {
  const dirs = dists.length > 0 ? dists : [process.env.NTN_DIST || path.join(ROOT, 'dist')];
  const seen = new Map();
  return dirs.map((dir, index) => {
    const dist = path.resolve(dir);
    const manifestPath = path.join(dist, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`no built extension at ${dist} (no manifest.json); build one first or pass --dist`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const base = labels[index] || manifest.version;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return { label: count === 1 ? base : `${base}#${count}`, dist, manifest, digest: packageDigest(dist) };
  });
}

/**
 * SHA-256 over a package's files, sorted by path: each file's path and its own SHA-256, so the
 * same package built once has the same digest wherever it's copied
 * @param {string} root
 */
function packageDigest(root) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(`${file}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

/**
 * The order of round `round` over `count` packages: each round rotated one place, so with two
 * the rounds run AB, BA, AB, ... and three run ABC, BCA, CAB, ...
 * @param {number} count
 * @param {number} round
 */
function roundOrder(count, round) {
  return Array.from({ length: count }, (_, index) => (index + round) % count);
}

/**
 * Times `runs` rounds of install-cold runs of each profile, the packages interleaved. Each
 * package after the first gets its per-round ratio to the first; when the second package is
 * the first one again (the same digest), each later one also gets its ratio to the mean of the
 * two copies in the same round (`againstBoth`), and the second's own ratio is the reference
 * against itself.
 * @param {{packages: Array<{label: string, dist: string, digest: string}>, runs: number, profiles: string[], log: (line: string) => void}} options
 */
async function measureTiming({ packages, runs, profiles, log }) {
  // Loaded only for --timing, so the bytes alone need no browser
  const { installCold, THROTTLE, SETTLE_MS, EDITOR, KEY, SAVE_WAIT_MS } = require('./perf/timing');
  const result = {
    runs,
    order: packages.length > 1 ? `interleaved: every round runs each package once, rotated one place each round, balanced every ${packages.length} rounds` : 'one package',
    network: 'offline (a dead proxy and no host resolution in Chromium; no route)',
    cpuThrottle: THROTTLE,
    settleMs: SETTLE_MS,
    editor: EDITOR,
    key: KEY,
    heap: `after a collection, once the save the key sets off has committed (saveMs), or ${SAVE_WAIT_MS} ms after the echo`,
    browser: null,
    reference: packages[0].label,
    profiles: {},
  };
  for (const name of profiles) {
    const { fixture, digest } = await profileFixture(name);
    /** @type {Array<Array<object | null>>} per package, per round */
    const measured = packages.map(() => []);
    const failures = packages.map(() => []);
    for (let round = 0; round < runs; round++) {
      for (const index of roundOrder(packages.length, round)) {
        const { label, dist } = packages[index];
        try {
          const run = await installCold({ dist, fixture });
          result.browser = run.browser;
          measured[index][round] = run;
          log(`${name} round ${round + 1}/${runs} ${label}: interaction-ready ${run.interactionReadyMs} ms, heap ${(run.heapBytes / 1048576).toFixed(2)} MiB, save ${run.saveMs === null ? 'none' : `+${run.saveMs} ms`}`);
        } catch (error) {
          measured[index][round] = null;
          failures[index].push({ round: round + 1, message: String(error && error.message ? error.message : error).split('\n')[0] });
          log(`${name} round ${round + 1}/${runs} ${label} failed: ${failures[index][failures[index].length - 1].message}`);
        }
      }
    }
    const of = (index, key) => summary(measured[index].filter(Boolean).map(run => run[key]).filter(value => typeof value === 'number'));
    const profile = { fixtureDigest: digest, packages: {}, ratios: {} };
    packages.forEach(({ label }, index) => {
      profile.packages[label] = Object.fromEntries([...TIMED.map(key => [key, of(index, key)]), ['failures', failures[index]]]);
    });
    // Each package against the first, round by round, over the rounds both measured
    const twin = packages.length > 2 && packages[1].digest === packages[0].digest;
    const ratio = (b, a) => Math.round((b / a) * 10000) / 10000;
    packages.slice(1).forEach(({ label }, offset) => {
      const index = offset + 1;
      const paired = measured[0].map((reference, round) => [reference, measured[index][round]]).filter(([a, b]) => a && b);
      profile.ratios[label] = {
        against: packages[0].label,
        ...(twin && index === 1 ? { self: true } : {}),
        rounds: paired.length,
        interactionReady: summary(paired.map(([a, b]) => ratio(b.interactionReadyMs, a.interactionReadyMs))),
        heap: summary(paired.map(([a, b]) => ratio(b.heapBytes, a.heapBytes))),
      };
      if (twin && index > 1) {
        const both = measured[0]
          .map((reference, round) => [reference, measured[1][round], measured[index][round]])
          .filter(([a, a2, b]) => a && a2 && b);
        profile.ratios[label].againstBoth = {
          against: [packages[0].label, packages[1].label],
          rounds: both.length,
          interactionReady: summary(both.map(([a, a2, b]) => ratio(b.interactionReadyMs, (a.interactionReadyMs + a2.interactionReadyMs) / 2))),
          heap: summary(both.map(([a, a2, b]) => ratio(b.heapBytes, (a.heapBytes + a2.heapBytes) / 2))),
        };
      }
    });
    result.profiles[name] = profile;
  }
  return result;
}

/**
 * What makes a run against `file` (build/budgets.json, or a baseline report such as
 * docs/performance/baseline-1.4.0.json)
 * not a valid gate run, before any timing: the first package isn't the baseline's reference
 * (by its digest), the second isn't the reference again, or the rounds are fewer than 12 or
 * not a multiple of the package count (12, 15, 18 for three), which leaves the rotation
 * unbalanced: each package has to run in each position equally often
 * @param {{packages: Array<{label: string, digest: string}>, runs: number, timing: boolean}} run
 * @param {string} file
 */
function gateProblems(run, file) {
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reference = baseline.reference || {};
  const problems = [];
  if (!run.timing) return problems;
  const [first, second] = run.packages;
  if (!reference.packageDigest) problems.push(`${file} records no reference package digest`);
  else if (first.digest !== reference.packageDigest) {
    problems.push(`the first package (${first.label}) isn't ${file}'s reference, ${reference.label} (${first.digest.slice(0, 12)}, not ${String(reference.packageDigest).slice(0, 12)})`);
  }
  if (!second || second.digest !== first.digest) problems.push('a gate run measures the reference twice a round: pass it as the second package too');
  const count = run.packages.length;
  if (run.runs < 12 || run.runs % count !== 0) {
    problems.push(`a gate run takes at least 12 rounds, a multiple of its ${count} packages, so the rotation balances; not ${run.runs}`);
  }
  return problems;
}

/**
 * Whether each fixture this run seeded is the one `baseline` recorded, and whether the
 * reference against itself stayed within the baseline's tolerance (a run where it didn't is
 * invalid, not a pass), as problems
 * @param {any} timing
 * @param {string} file
 */
function fixtureProblems(timing, file) {
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  const recorded = baseline.fixtureDigests || {};
  // build/budgets.json's timing row, or a baseline report's proposed one
  const row = baseline.timing || (baseline.proposed && baseline.proposed.timing) || {};
  const tolerancePct = typeof row.tolerancePct === 'number' ? row.tolerancePct : undefined;
  const problems = [];
  for (const [name, profile] of Object.entries(timing.profiles)) {
    if (!(name in recorded)) {
      problems.push(`${file} records no ${name} fixture, so this run can't be compared with it`);
    } else if (recorded[name] !== profile.fixtureDigest) {
      problems.push(`the ${name} fixture isn't the one ${file} measured (${String(profile.fixtureDigest).slice(0, 12)}, not ${String(recorded[name]).slice(0, 12)}), so its numbers don't compare`);
    }
    const self = Object.entries(profile.ratios || {}).find(([, ratio]) => ratio.self);
    if (self && typeof tolerancePct === 'number' && self[1].interactionReady) {
      const off = Math.abs(self[1].interactionReady.median - 1) * 100;
      if (off > tolerancePct) {
        problems.push(`invalid run on ${name}: the reference against itself (${self[0]}) is ${(off).toFixed(1)}% off, more than the ${tolerancePct}% tolerance`);
      }
    }
  }
  return problems;
}

async function main(argv, { log = line => process.stderr.write(`perf:probe: ${line}\n`) } = {}) {
  const options = parseArgs(argv);
  const packages = packagesOf(options);
  const report = {
    format: FORMAT,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
      cores: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 1073741824),
    },
    packages: packages.map(({ label, dist, manifest, digest }) => {
      const bytes = packageBytes(dist);
      return { label, version: manifest.version, name: manifest.name, digest, bytes: bytes.pages, problems: bytes.problems };
    }),
    timing: null,
    problems: [],
  };
  if (options.baseline) {
    // Checked before any timing, so a run that can't count doesn't take the machine for nothing
    const problems = gateProblems({ packages, runs: options.runs, timing: options.timing }, options.baseline);
    if (problems.length > 0) throw new Error(`not a gate run:\n  ${problems.join('\n  ')}`);
  }
  if (options.timing) {
    report.timing = await measureTiming({ packages, runs: options.runs, profiles: options.profiles, log });
    if (options.baseline) report.problems.push(...fixtureProblems(report.timing, options.baseline));
  }

  const out = path.resolve(options.out || path.join(ROOT, 'dist-report', `perf-probe-${packages.map(entry => entry.label).join('-vs-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of report.packages) {
    for (const [name, page] of Object.entries(entry.bytes)) {
      log(`${entry.label} ${name}: ${page.total.raw} bytes (${page.total.gzip} gzip), ${page.js.raw} of JS in ${page.modules} modules and ${page.classicScripts} classic scripts; lazy ${page.lazy.raw}, workers ${page.workers.raw}`);
    }
    entry.problems.forEach(problem => log(`${entry.label} problem: ${problem}`));
  }
  if (report.timing) {
    for (const [name, profile] of Object.entries(report.timing.profiles)) {
      for (const [label, ratio] of Object.entries(profile.ratios)) {
        if (ratio.interactionReady) log(`${name}: ${label} / ${ratio.against} interaction-ready ratio median ${ratio.interactionReady.median} over ${ratio.rounds} rounds`);
        if (ratio.againstBoth && ratio.againstBoth.interactionReady) log(`${name}: ${label} / both ${ratio.against} copies, median ${ratio.againstBoth.interactionReady.median}`);
      }
    }
  }
  report.problems.forEach(problem => log(`problem: ${problem}`));
  const shown = path.relative(process.cwd(), out);
  log(`wrote ${shown.startsWith('..') ? out : shown}`);
  const failed = report.timing
    ? Object.values(report.timing.profiles).some(profile => Object.values(profile.packages).some(entry => entry.failures.length > 0))
    : false;
  const problems = report.problems.length + report.packages.reduce((sum, entry) => sum + entry.problems.length, 0);
  return problems > 0 || failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`perf:probe: ${error.message}\n`);
      process.exit(2);
    },
  );
}

module.exports = { parseArgs, summary, roundOrder, packagesOf, packageDigest, measureTiming, gateProblems, fixtureProblems, main };
