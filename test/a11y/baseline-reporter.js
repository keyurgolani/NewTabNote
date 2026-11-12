/**
 * Playwright reporter that holds what test:a11y's checks find to test/a11y/baseline.json, listed in
 * test/a11y/playwright.config.js (#24 slice 2). A test's page is its spec's path under test/a11y/, and
 * a test that passes attaches what its checks found as `a11y-findings`, JSON of
 * {findings: [{rule, target, gate?}]}, with `gate` the matrix's gate at a gated point.
 * scripts/check-a11y-baseline.js says what fails a run. It writes nothing.
 *
 *   options.baseline, options.specs  the file and the specs' folder (default: test/a11y/'s)
 *   options.write                    where the problems go (default: stderr)
 */

const fs = require('node:fs');
const path = require('node:path');
const { BASELINE, ROOT, SPECS, fileProblems, gates, runProblems, specProblems } = require('../../scripts/check-a11y-baseline.js');

const NAME = 'a11y-findings';

/** A list of findings, each a rule and a target, with a gate or none */
const isRecord = (/** @type {any} */ record) =>
  Array.isArray(record?.findings) &&
  record.findings.every((/** @type {any} */ finding) => typeof finding?.rule === 'string' && typeof finding.target === 'string' && ['undefined', 'string'].includes(typeof finding.gate));

class BaselineReporter {
  /** @param {{baseline?: string, specs?: string, write?: (text: string) => void}} [options] */
  constructor({ baseline = path.join(ROOT, BASELINE), specs = path.join(ROOT, SPECS), write = text => process.stderr.write(text) } = {}) {
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

  /** @param {string} file - a spec's absolute path */
  _pageOf(file) {
    return path.relative(this._specs, file).split(path.sep).join('/').replace(/\.spec\.js$/, '');
  }

  /**
   * @param {unknown} config
   * @param {{allTests: () => {location: {file: string}}[]}} suite
   */
  onBegin(config, suite) {
    this._selected = new Set(suite.allTests().map(test => this._pageOf(test.location.file)));
  }

  /**
   * @param {{title: string, location: {file: string}}} test
   * @param {{status: string, attachments: {name: string, body?: Buffer, path?: string}[]}} result
   */
  onTestEnd(test, result) {
    if (result.status !== 'passed') return;
    const attached = result.attachments.filter(({ name }) => name === NAME);
    if (attached.length === 0) this._problems.push(`"${test.title}" passed without attaching ${NAME}`);
    for (const { body, path: file } of attached) {
      let record = null;
      try {
        record = JSON.parse(body ? body.toString('utf8') : fs.readFileSync(String(file), 'utf8'));
      } catch {
        // Not JSON, or a file that's gone: the problem below names it
      }
      if (isRecord(record)) this._records.push({ page: this._pageOf(test.location.file), findings: record.findings });
      else this._problems.push(`"${test.title}" attached ${NAME} that isn't a list of findings, each a rule and a target`);
    }
  }

  onEnd() {
    const file = JSON.parse(fs.readFileSync(this._baseline, 'utf8'));
    const shape = fileProblems(file, gates());
    const problems = [...this._problems, ...shape];
    if (shape.length === 0) {
      const reported = new Set(this._records.map(({ page }) => page));
      for (const page of new Set(file.entries.map((/** @type {{page: string}} */ line) => line.page))) {
        if (this._selected.has(page) && !reported.has(page)) problems.push(`${page}'s spec ran, but no test of it reported what its checks found, so its lines go unchecked`);
      }
      problems.push(...specProblems(file, this._specs), ...runProblems(this._records, file));
    }
    if (problems.length === 0) return undefined;
    this._write(`\ntest:a11y's findings don't match ${BASELINE}:\n${problems.map(problem => `  ${problem}`).join('\n')}\n`);
    return { status: /** @type {const} */ ('failed') };
  }
}

module.exports = BaselineReporter;
