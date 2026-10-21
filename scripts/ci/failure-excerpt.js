#!/usr/bin/env node

/**
 * Write the start of a failed or cancelled CI job's output to the step output
 * `excerpt`, which pr-gate shows in its job summary. Takes up to 20 lines from the
 * first line that matches the job's marker, or the last 20 lines when none does,
 * as after a timeout. Without GITHUB_OUTPUT, as in a local run, it prints them.
 *
 *   node scripts/ci/failure-excerpt.js <log> <job>
 */

const fs = require('fs');
const crypto = require('crypto');

const MAX_LINES = 20;
const MAX_LINE_LENGTH = 300;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

// Where each pr-checks job's failure report starts in its log
const MARKERS = {
  unit: /^✖ failing tests:/,
  typecheck: /^typecheck ratchet/,
  // test:kernel's summary, typecheck:kernel's first diagnostic, or check:boundaries' report
  kernel: /^✖ failing tests:|error TS\d+:|^check:boundaries failed/,
  build: /^✗ Strict build failed|^Build failed|^check:dist failed|^Packaging failed|^Error|^check:notices failed/,
  // Playwright's list reporter numbers each failed test; a spec or config that fails to
  // load, or a failed browser install, prints a bare Error line instead
  extension: /^ {2}1\) |^Error: /,
};

function excerpt(text, marker) {
  const lines = text.replace(ANSI_ESCAPE, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  let start = marker ? lines.findIndex(line => marker.test(line)) : -1;
  if (start < 0) start = Math.max(0, lines.length - MAX_LINES);

  return lines
    .slice(start, start + MAX_LINES)
    .map(line => {
      const chars = [...line];
      return chars.length > MAX_LINE_LENGTH ? `${chars.slice(0, MAX_LINE_LENGTH).join('')}...` : line;
    })
    .join('\n');
}

if (require.main === module) {
  const [log, job] = process.argv.slice(2);
  let text = '';
  try {
    text = fs.readFileSync(log, 'utf8');
  } catch {
    // Nothing was captured, for example when checkout failed
  }
  const marker = Object.hasOwn(MARKERS, job) ? MARKERS[job] : null;
  const body = excerpt(text, marker) || '(no output captured)';
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `EXCERPT_${crypto.randomBytes(16).toString('hex')}`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `excerpt<<${delimiter}\n${body}\n${delimiter}\n`);
  } else {
    console.log(body);
  }
}

module.exports = { excerpt, MARKERS, MAX_LINES };
