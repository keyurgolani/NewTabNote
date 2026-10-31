'use strict';

// #21 slice 1b, PR 1: the credentialed-call ledger (security/network-ledger.json). Every network
// call first-party code makes outside the destination client is a row: its file and function,
// how many calls, the credential it carries, the registry rows it reaches, and the issue that
// removes it. A call no row covers, a count that changed, and a row whose call is gone all fail.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { networkCalls, scanSource, ledgerProblems } = require('./helpers/network-scan');

const ROOT = path.join(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const CREDENTIALS = ['none', 'bearer', 'x-api-key', 'x-goog-api-key', 'basic', 'caller'];

describe('the credentialed-call ledger (security/network-ledger.json)', () => {
  it('covers every network call, the client files included, each count as it is, and no call that is gone', () => {
    assert.deepEqual(ledgerProblems(networkCalls(), read('security/network-ledger.json')), []);
  });

  it('fails on a new raw network call in either client file', () => {
    const ledger = read('security/network-ledger.json');
    for (const file of ['js/kernel/composition/api-request.js', 'js/kernel/composition/destinations.js']) {
      const text = `${fs.readFileSync(path.join(ROOT, file), 'utf8')}\nexport function added() { return fetch('/x'); }\n`;
      const problems = ledgerProblems(networkCalls({ texts: { [file]: text } }), ledger);
      assert.deepEqual(problems.map((problem) => problem.split(':')[0]), [`${file}#added`], file);
    }
  });

  it('gives each row a known credential, registry rows that exist, an owner, and what removes it', () => {
    const ledger = read('security/network-ledger.json');
    const ids = new Set(read('security/destinations.json').destinations.map((entry) => entry.id));
    for (const entry of ledger.calls) {
      const name = `${entry.file}#${entry.function}`;
      assert.ok(CREDENTIALS.includes(entry.credential), `${name}: ${entry.credential}`);
      assert.ok(Array.isArray(entry.destinations) && entry.destinations.every((id) => ids.has(id)), `${name}: ${entry.destinations}`);
      assert.ok(Number.isSafeInteger(entry.owner) && entry.owner > 0, name);
      assert.equal(typeof entry.removeWhen, 'string', name);
    }
    for (const proxy of ledger.proxies) {
      const handler = fs.readFileSync(path.join(ROOT, proxy.handler), 'utf8');
      assert.ok(handler.includes(`'${proxy.message}'`), `${proxy.handler} handles ${proxy.message}`);
      assert.ok(Number.isSafeInteger(proxy.owner), proxy.message);
    }
  });

  it('finds each kind of network call, in the function it is in, and never one in a comment or a string', () => {
    const found = scanSource(`
      // fetch('https://example.test') in a comment
      const text = "fetch('https://example.test')";
      async function load() { return fetch('/x'); }
      class Sync { async send() { return window.fetch('/y'); } }
      const open = () => new XMLHttpRequest();
      const socket = function () { return new WebSocket('wss://example.test'); };
      const stream = { start: () => new EventSource('/events') };
      navigator.sendBeacon('/beacon', 'x');
    `);
    assert.deepEqual(found.map(({ api, function: name }) => [api, name]), [
      ['fetch', 'load'],
      ['fetch', 'send'],
      ['XMLHttpRequest', 'open'],
      ['WebSocket', 'socket'],
      ['EventSource', 'start'],
      ['sendBeacon', '(top level)'],
    ]);
  });
});
