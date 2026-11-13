/**
 * Playwright reporter that holds what test:a11y's checks find to test/a11y/baseline.json, listed in
 * test/a11y/playwright.config.js (#24 slice 2). A test's page is its spec's path under test/a11y/,
 * from the file Playwright loaded it from, so a test that a helper declares is its spec's. A test that
 * passes attaches what its checks found as `a11y-findings`, JSON of {findings: [{rule, target, gate?}],
 * point?, points?}, with `gate` the matrix's gate at a gated point, and at a matrix point the point and
 * how many its page has. A run that covered only some of a page's points keeps that page's lines out
 * of the drop check.
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

/** A list of findings, each a rule and a target with a gate or none, and a point with its page's count, or neither */
const isRecord = (/** @type {any} */ record) =>
  Array.isArray(record?.findings) &&
  record.findings.every((/** @type {any} */ finding) => typeof finding?.rule === 'string' && typeof finding.target === 'string' && ['undefined', 'string'].includes(typeof finding.gate)) &&
  (record.point === undefined ? record.points === undefined : typeof record.point === 'string' && record.point !== '' && Number.isInteger(record.points) && record.points > 0);

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
   * A test's page, from the file Playwright loaded it from rather than the file that declared it, or
   * null for the library's own specs under checks/, whose tests attach nothing
   * @param {{location: {file: string}, parent?: any}} test
   */
  _pageOf(test) {
    let file = test.location.file;
    for (let suite = test.parent; suite; suite = suite.parent) {
      if (suite.type === 'file' && suite.location) {
        file = suite.location.file;
        break;
      }
    }
    const page = path.relative(this._specs, file).split(path.sep).join('/').replace(/\.spec\.js$/, '');
    return page.startsWith('checks/') ? null : page;
  }

  /**
   * @param {unknown} config
   * @param {{allTests: () => {location: {file: string}, parent?: any}[]}} suite
   */
  onBegin(config, suite) {
    this._selected = new Set(suite.allTests().flatMap(test => this._pageOf(test) ?? []));
  }

  /**
   * @param {{title: string, location: {file: string}, parent?: any}} test
   * @param {{status: string, attachments: {name: string, body?: Buffer, path?: string}[]}} result
   */
  onTestEnd(test, result) {
    const page = this._pageOf(test);
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
      if (isRecord(record)) {
        this._records.push({ page, findings: record.findings, ...(record.point === undefined ? {} : { point: record.point, points: record.points }) });
      } else {
        this._problems.push(`"${test.title}" attached ${NAME} that isn't a list of findings, each a rule and a target`);
      }
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
      // A page that ran at only some of its points, as a run filtered inside its spec does
      const partial = new Set();
      for (const page of reported) {
        const at = this._records.filter(record => record.page === page && record.point !== undefined);
        if (at.length > 0 && new Set(at.map(({ point }) => point)).size < Math.max(...at.map(({ points }) => points ?? 0))) partial.add(page);
      }
      const found = runProblems(this._records, file, partial);
      if (seeded) problems.push(...found);
      else if (found.length > 0) this._write(`\ntest:a11y's findings, reported only until ${BASELINE} lands with its seed:\n${found.map(finding => `  ${finding}`).join('\n')}\n`);
    }
    if (problems.length === 0) return undefined;
    this._write(`\ntest:a11y's findings don't match ${BASELINE}:\n${problems.map(problem => `  ${problem}`).join('\n')}\n`);
    return { status: /** @type {const} */ ('failed') };
  }
}

module.exports = BaselineReporter;
