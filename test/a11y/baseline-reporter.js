/**
 * Playwright reporter that holds what test:a11y's checks find to test/a11y/baseline.json, listed in
 * test/a11y/playwright.config.js (#24 slice 2). A test's page is its spec's path under test/a11y/, and
 * a test that passes attaches what its checks found as `a11y-findings`, JSON of
 * {findings: [{rule, target, gate?}]}, with `gate` the matrix's gate at a gated point.
 * scripts/check-a11y-baseline.js says what fails a run. Until the file lands with its seed, the run
 * reports what the checks find without failing on it, so no CI step goes red on today's known issues; a
 * spec that attaches nothing or garbles it still fails, and so does any failing test. It writes nothing.
 *
 *   options.baseline, options.specs  the file and the specs' folder (default: test/a11y/'s, the file
 *                                    at the path check:a11y-baseline reads)
 *   options.write                    where the problems go (default: stderr)
 */

const fs = require('node:fs');
const path = require('node:path');
const { BASELINE, CHECK, ROOT, SPECS, baselineIn, fileProblems, gates, runProblems, specProblems } = require('../../scripts/check-a11y-baseline.js');

const NAME = 'a11y-findings';

/** A list of findings, each a rule and a target, with a gate or none */
const isRecord = (/** @type {any} */ record) =>
  Array.isArray(record?.findings) &&
  record.findings.every((/** @type {any} */ finding) => typeof finding?.rule === 'string' && typeof finding.target === 'string' && ['undefined', 'string'].includes(typeof finding.gate));

class BaselineReporter {
  /** @param {{baseline?: string, specs?: string, write?: (text: string) => void}} [options] */
  constructor({ baseline = baselineIn(), specs = path.join(ROOT, SPECS), write = text => process.stderr.write(text) } = {}) {
    this._baseline = baseline;
    this._specs = specs;
    this._write = write;
    /** @type {Set<string>} the pages whose specs the run selected */
    this._selected = new Set();
    /** @type {import('../../scripts/check-a11y-baseline.js').Record[]} */
    this._records = [];
    /** @type {string[]} */
    this._problems = [];
  }

  printsToStdio() {
    return false;
  }

  /**
   * A spec's page, or null for the library's own spec under checks/, whose tests attach nothing
   * @param {string} file - the spec's absolute path
   */
  _pageOf(file) {
    const page = path.relative(this._specs, file).split(path.sep).join('/').replace(/\.spec\.js$/, '');
    return page.startsWith('checks/') ? null : page;
  }

  /**
   * @param {unknown} config
   * @param {{allTests: () => {location: {file: string}}[]}} suite
   */
  onBegin(config, suite) {
    this._selected = new Set(suite.allTests().flatMap(test => this._pageOf(test.location.file) ?? []));
  }

  /**
   * @param {{title: string, location: {file: string}}} test
   * @param {{status: string, attachments: {name: string, body?: Buffer, path?: string}[]}} result
   */
  onTestEnd(test, result) {
    const page = this._pageOf(test.location.file);
    if (page === null || result.status !== 'passed') return;
    const attached = result.attachments.filter(({ name }) => name === NAME);
    if (attached.length === 0) this._problems.push(`"${test.title}" passed without attaching ${NAME}`);
    for (const { body, path: file } of attached) {
      let record = null;
      try {
        record = JSON.parse(body ? body.toString('utf8') : fs.readFileSync(String(file), 'utf8'));
      } catch {
        // Not JSON, or a file that's gone: the problem below names it
      }
      if (isRecord(record)) this._records.push({ page, findings: record.findings });
      else this._problems.push(`"${test.title}" attached ${NAME} that isn't a list of findings, each a rule and a target`);
    }
  }

  onEnd() {
    // The file lands with its seed; until then there's none, which is no lines
    const seeded = fs.existsSync(this._baseline);
    const file = seeded ? JSON.parse(fs.readFileSync(this._baseline, 'utf8')) : { check: CHECK, entries: [] };
    const shape = fileProblems(file, gates());
    const problems = [...this._problems, ...shape];
    if (shape.length === 0) {
      const reported = new Set(this._records.map(({ page }) => page));
      for (const page of new Set(file.entries.map((/** @type {{page: string}} */ line) => line.page))) {
        if (this._selected.has(page) && !reported.has(page)) problems.push(`${page}'s spec ran, but no test of it reported what its checks found, so its lines go unchecked`);
      }
      problems.push(...specProblems(file, this._specs));
      const found = runProblems(this._records, file);
      if (seeded) problems.push(...found);
      else if (found.length > 0) this._write(`\ntest:a11y's findings, reported only until ${BASELINE} lands with its seed:\n${found.map(finding => `  ${finding}`).join('\n')}\n`);
    }
    if (problems.length === 0) return undefined;
    this._write(`\ntest:a11y's findings don't match ${BASELINE}:\n${problems.map(problem => `  ${problem}`).join('\n')}\n`);
    return { status: /** @type {const} */ ('failed') };
  }
}

module.exports = BaselineReporter;
