'use strict';

// R88's read of #17 PR 4a's close-race fix: nothing in js/ waits on an IndexedDB transaction's
// complete or abort outside js/kernel/adapters/indexeddb/requests.js, whose endOf(tx) also ends
// when the connection closes (scripts/transaction-waits.js). Chrome fires neither event on a
// transaction a forced close catches, so a wait on them alone would hang.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ALLOWED, scanSource, collect, main } = require('../scripts/transaction-waits.js');

const ROOT = path.join(__dirname, '..');

/** The waits one file's source has, as `event on receiver` */
const waitsIn = (source) => scanSource('js/x.js', source).map((wait) => `${wait.event} on ${wait.on}`);

/** A scratch repository holding only `files`, removed after `body` */
function withRepo(files, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-waits-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const quiet = { log() {}, error() {} };

describe("waits on a transaction's end", () => {
  it(`js/ has none outside ${ALLOWED}`, () => {
    assert.deepEqual(collect(ROOT).map((wait) => `${wait.file}:${wait.line} ${wait.event} on ${wait.on}`), []);
  });

  it('finds a complete or abort handler or listener, whatever it is set on', () => {
    assert.deepEqual(waitsIn(`
      function commit(db) {
        const tx = db.transaction('canvases', 'readwrite');
        tx.oncomplete = () => {};
        tx.onabort = () => {};
        tx['oncomplete'] = () => {};
        db.transaction('links', 'readonly').addEventListener('complete', () => {});
      }
      const settled = (done) => new Promise((resolve) => done.addEventListener('abort', resolve));
    `), ['complete on tx', 'abort on tx', 'complete on tx', "complete on db.transaction('links', 'readonly')", 'abort on done']);
  });

  it("leaves an AbortSignal's abort, a FileReader's, and every other event alone", () => {
    assert.deepEqual(waitsIn(`
      signal.addEventListener('abort', cancel);
      controller.signal.addEventListener('abort', cancel);
      timeoutSignal.addEventListener('abort', cancel);
      const reader = new FileReader();
      reader.onabort = () => {};
      reader.addEventListener('abort', () => {});
      tx.addEventListener('error', () => {});
      tx.onerror = () => {};
      request.onsuccess = () => {};
      tx.removeEventListener('complete', done);
    `), []);
  });

  it(`skips ${ALLOWED} and nothing else, and fails the run on a wait anywhere in js/`, () => {
    const wait = "export const ended = (tx) => new Promise((resolve) => { tx.oncomplete = resolve; });\n";
    withRepo({ [ALLOWED]: wait, 'js/kernel/adapters/indexeddb/other.js': wait, 'js/ui/panel.js': wait, 'test/helper.js': wait }, (root) => {
      assert.deepEqual(collect(root).map((found) => found.file), ['js/kernel/adapters/indexeddb/other.js', 'js/ui/panel.js']);
      assert.equal(main([root], quiet), 1);
    });
    withRepo({ [ALLOWED]: wait }, (root) => {
      assert.equal(main([root], quiet), 0);
    });
  });
});
