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
const { ALLOWED, VENDORED, scanSource, collect, main, problemOf } = require('../scripts/transaction-waits.js');

const ROOT = path.join(__dirname, '..');

/**
 * The waits one file's source has, as `event on receiver`, or `name <expression> on receiver`
 * for an event name the scan can't read
 */
const waitsIn = (source, file = 'js/x.js') =>
  scanSource(file, source).map((wait) => `${wait.event === null ? `name ${wait.named}` : wait.event} on ${wait.on}`);

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

  it("finds the ways around a plain one: a name it can't read, any assignment, an object's key, a call that names the handler, brackets, .call and .apply, and a transaction named like a signal (R131)", () => {
    // R131's planted waits, each in a function of its own
    const waits = waitsIn(`
      export function loop(db) {
        const tx = db.transaction('canvases', 'readwrite');
        for (const type of ['complete', 'abort']) tx.addEventListener(type, () => {});
      }
      const END = 'complete';
      export const byConst = (tx) => new Promise((resolve) => tx.addEventListener(END, resolve));
      export const assigned = (tx, done) => Object.assign(tx, { oncomplete: done, onabort: done });
      export const nullish = (tx, done) => {
        tx.oncomplete ??= done;
        tx.onabort ||= done;
      };
      export const optional = (tx, done) => tx?.addEventListener('complete', done);
      export const element = (tx, done) => tx['addEventListener']('complete', done);
      export const viaCall = (tx, done) => EventTarget.prototype.addEventListener.call(tx, 'abort', done);
      export const viaApply = (tx, done) => EventTarget.prototype.addEventListener.apply(tx, ['complete', done]);
      export const defined = (tx, done) => Object.defineProperty(tx, 'oncomplete', { value: done });
      export const named = (db) => {
        const writeSignal = db.transaction('x', 'readwrite');
        writeSignal.onabort = () => {};
      };
      export const method = (tx) => Object.assign(tx, { onabort() {} });
    `);
    assert.deepEqual(waits, [
      'name type on tx',
      'name END on tx',
      'complete on tx',
      'abort on tx',
      'complete on tx',
      'abort on tx',
      'complete on tx',
      'complete on tx',
      'abort on tx',
      'complete on tx',
      'complete on tx',
      'abort on writeSignal',
      'abort on tx',
    ]);
    const [unread] = scanSource('js/x.js', 'tx.addEventListener(type, done);');
    assert.match(problemOf(unread), /^js\/x\.js:1 names an event or a handler on tx through type, which the scan can't read: name it with a literal, and wait on a transaction's end with endOf\(tx\)/);
  });

  it("finds the natural ways left: a handler set on a transaction through a key it can't read, and a bound addEventListener, and says which it lets by (R131's second read)", () => {
    // R131's second set, the contrived three among them
    const waits = waitsIn(`
      export const bound = (tx, done) => {
        const listen = tx.addEventListener.bind(tx);
        listen('complete', done);
      };
      export const reflected = (tx, done) => Reflect.apply(tx.addEventListener, tx, ['complete', done]);
      export const keyed = (tx, done) => {
        const key = 'oncomplete';
        tx[key] = done;
      };
      export const looped = (tx, done) => {
        for (const handler of ['oncomplete', 'onabort']) tx[handler] = done;
      };
      export const opened = (db, handler, done) => {
        db.transaction('x', 'readwrite')[handler] = done;
      };
      export const destructured = (tx, done) => {
        const { addEventListener } = tx;
        addEventListener.call(tx, 'complete', done);
      };
      export const control = (tx, done) => tx.addEventListener('abort', done);
    `);
    assert.deepEqual(waits, [
      'name tx.addEventListener.bind(tx) on tx',
      'name key on tx',
      'name handler on tx',
      "name handler on db.transaction('x', 'readwrite')",
      'abort on tx',
    ]);
    // A computed key on anything else is any object's own business
    assert.deepEqual(waitsIn('for (const key of keys) settings[key] = values[key];'), []);
  });

  it("reads txn, and a name ending in Txn, as a transaction too, and lets one held as t by (R131's delta read)", () => {
    const waits = waitsIn(`
      export const abbreviated = (txn, key, done) => {
        txn[key] = done;
      };
      export const suffixed = (writeTxn, key, done) => {
        writeTxn[key] = done;
      };
      export const held = (store, key, done) => {
        store.txn[key] = done;
      };
      export const viaRequest = (request, key, done) => {
        request.transaction[key] = done;
      };
      export const short = (db, key, done) => {
        const t = db.transaction('canvases', 'readwrite');
        t[key] = done;
      };
    `);
    assert.deepEqual(waits, [
      'name key on txn',
      'name key on writeTxn',
      'name key on store.txn',
      'name key on request.transaction',
    ]);
  });

  it(`holds the vendored libraries in ${VENDORED} to every rule but the literal name, which their minified code can't keep`, () => {
    const source = 'e.addEventListener(t, f); tx[k] = f; e.addEventListener.bind(e); tx.oncomplete = f; tx.addEventListener("abort", f);';
    assert.deepEqual(waitsIn(source, `${VENDORED}chart.js`), ['complete on tx', 'abort on tx']);
    assert.deepEqual(waitsIn(source), [
      'name t on e',
      'name k on tx',
      'name e.addEventListener.bind(e) on e',
      'complete on tx',
      'abort on tx',
    ]);
  });

  it("leaves an AbortSignal's abort, a FileReader's, and every other event alone", () => {
    assert.deepEqual(waitsIn(`
      signal.addEventListener('abort', cancel);
      controller.signal.addEventListener('abort', cancel);
      signal.onabort = cancel;
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
