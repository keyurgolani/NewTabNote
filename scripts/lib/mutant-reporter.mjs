// A node:test reporter for scripts/mutants.js: one line per test that ran, as MARK and then
// JSON {outcome, name, path, skipped}. `path` is the names of its suites and then its own.
// Suites are left out, and so is what the tests print, which node:test hands reporters as
// their own events. A file's tests run one at a time, so each test starts after its suite
// and before its suite's next test.

export const MARK = '@@mutant-result ';

/**
 * @param {AsyncIterable<{type: string, data: any}>} source
 */
export default async function* mutantReporter(source) {
  /** @type {string[]} */
  const suites = [];
  for await (const event of source) {
    const { name, nesting = 0, details, skip, todo } = event.data || {};
    if (event.type === 'test:start') {
      suites.length = nesting;
      suites[nesting] = name;
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (details && details.type === 'suite') continue;
    yield `${MARK}${JSON.stringify({
      outcome: event.type === 'test:pass' ? 'pass' : 'fail',
      name,
      path: [...suites.slice(0, nesting), name],
      skipped: Boolean(skip) || Boolean(todo),
    })}\n`;
  }
}
