#!/usr/bin/env node

/**
 * Write the start of a failed CI job's output to the step output `excerpt`, which
 * pr-gate shows in its job summary. Takes up to 20 lines from the first line that
 * matches the marker (a regular expression), or the last 20 lines when none does.
 *
 *   node scripts/ci/failure-excerpt.js <log> [marker]
 */

const fs = require('fs');
const crypto = require('crypto');

const MAX_LINES = 20;
const MAX_LINE_LENGTH = 300;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function excerpt(text, marker) {
  const lines = text.replace(ANSI_ESCAPE, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const pattern = marker ? new RegExp(marker) : null;
  let start = pattern ? lines.findIndex(line => pattern.test(line)) : -1;
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
  const [log, marker] = process.argv.slice(2);
  let text = '';
  try {
    text = fs.readFileSync(log, 'utf8');
  } catch {
    // Nothing was captured, for example when checkout failed
  }
  const body = excerpt(text, marker) || '(no output captured)';
  const delimiter = `EXCERPT_${crypto.randomBytes(16).toString('hex')}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `excerpt<<${delimiter}\n${body}\n${delimiter}\n`);
}

module.exports = { excerpt, MAX_LINES };
