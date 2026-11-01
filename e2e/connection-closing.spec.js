/**
 * #17 PR 4a in Chromium: what #17's adapter's closing check (adapter.js's going()) rests on,
 * which the unit suites have only from fake-indexeddb. A transaction asked for over no store is
 * refused with an InvalidAccessError on an open connection, and with an InvalidStateError once
 * close() was called on it, or while its own upgrade runs, so asking tells a closing connection
 * from an open one and opens nothing.
 *
 * And Chrome's own close of a connection, here DevTools Protocol's Storage.clearDataForOrigin,
 * as clearing the extension's data does, in the order Chrome gives it: the read open on the
 * connection fails, its request with an AbortError and then its transaction with an
 * UnknownError, while the connection still takes a transaction, and only then does close fire,
 * when the connection refuses one. So the adapter, imported from the sources (the harness copies
 * js/kernel/ into this spec's extension copy, as trust-permissions.spec.js has it), answers
 * transaction-failed for a read in flight, and reload-required for the next call. The unit
 * suites' Chrome close (test/kernel/storage-mid-close.test.mjs) follows this order, so a Chrome
 * that changes it fails here first. Each round clears the extension's IndexedDB, so the adapter
 * opens versioned, which makes CanvasTabDB again where it's gone.
 */

const { test, expect, expectNoUncaught } = require('./harness');

test.use({ extensionSources: ['js/kernel/', 'js/lib/valibot/'] });

/** How many forced closes the second test watches, so an order that varies shows */
const ROUNDS = 10;

/**
 * In the page: what a transaction over no store is refused with on a scratch database's
 * connection, while its upgrade runs, once it's open, and after close()
 */
async function refusals() {
  const name = 'ntn-closing-check';
  /** @param {() => unknown} ask */
  const refused = ask => {
    try {
      ask();
      return 'nothing';
    } catch (error) {
      return error.name;
    }
  };
  /** @type {Record<string, string>} */
  const seen = {};
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('rows');
      seen.upgrading = refused(() => request.result.transaction([], 'readonly'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  seen.open = refused(() => db.transaction([], 'readonly'));
  db.close();
  seen.closed = refused(() => db.transaction([], 'readonly'));
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  return seen;
}

/**
 * In the page: two reads that keep their transactions open until Chrome closes their
 * connections, or 5 seconds pass. One on a scratch database's own connection records each
 * event in order with what a transaction over no store is refused with right then, and, as its
 * transaction aborts, opens another and records what that one comes to: the window a command's
 * run again, and a call that starts before the close, open their transactions in. One goes
 * through #17's adapter on CanvasTabDB, and as its transaction aborts, a command goes through a
 * kernel on the adapter. Resolves once both run; window.closing then resolves with what each
 * came to, and the adapter's next call.
 */
async function startReads() {
  const { createIndexedDbAdapter } = await import('/js/kernel/adapters/indexeddb/adapter.js');
  const { createKernel } = await import('/js/kernel/core/application/kernel.js');
  const { createBaselinePolicy } = await import('/js/kernel/core/ports/policy.js');
  const deadline = Date.now() + 5_000;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ntn-closing-read', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('rows');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const refused = () => {
    try {
      db.transaction([], 'readonly');
      return 'nothing';
    } catch (error) {
      return error.name;
    }
  };
  /** @type {unknown[][]} */
  const events = [];
  /** @type {unknown[][]} */
  const late = [];
  const raw = new Promise(resolve => {
    // What the transaction opened after the abort comes to lands within this after close
    db.onclose = () => {
      events.push(['close', refused()]);
      setTimeout(() => resolve({ events, late }), 1_000);
    };
    const tx = db.transaction('rows', 'readonly');
    tx.onabort = () => {
      events.push(['abort', tx.error ? tx.error.name : null, refused()]);
      /** @type {IDBTransaction} */
      let next;
      try {
        next = db.transaction('rows', 'readonly');
      } catch (error) {
        late.push(['refused', error.name]);
        return;
      }
      next.onabort = () => late.push(['abort', next.error ? next.error.name : null, refused(), events.length]);
      next.oncomplete = () => late.push(['complete', refused(), events.length]);
      const request = next.objectStore('rows').get('none');
      request.onsuccess = () => late.push(['success', refused(), events.length]);
      request.onerror = () => late.push(['error', request.error ? request.error.name : null, refused(), events.length]);
      // Whether the request's error bubbles to its transaction and its connection, where 1.4.1's
      // transactions listen for it (saveNoteWithBlocks' onerror)
      next.onerror = event => {
        if (event.target === request) late.push(['transaction-error', events.length]);
      };
      db.addEventListener('error', event => {
        if (event.target === request) late.push(['connection-error', events.length]);
      });
    };
    tx.oncomplete = () => {
      events.push(['complete']);
      resolve({ events, late });
    };
    const store = tx.objectStore('rows');
    const next = () => {
      const request = store.get('none');
      request.onsuccess = () => {
        if (Date.now() < deadline) next();
      };
      request.onerror = () => events.push(['error', request.error ? request.error.name : null, refused()]);
    };
    next();
  });

  const adapter = createIndexedDbAdapter({ indexedDB, settings: chrome.storage.local, mode: 'versioned' });
  await adapter.open();
  let count = 0;
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: { surface: 'newtab', contextId: 'connection-closing' },
    ids: { next: () => `pin-${Date.now()}-${(count += 1)}` },
    clock: { now: () => Date.now() },
  });
  /** @param {Promise<unknown>} call */
  const answer = call =>
    Promise.race([
      call.then(
        value => ({ value }),
        error => ({ failed: [error.unavailableCause, error.code, error.retryable] }),
      ),
      new Promise(resolve => setTimeout(() => resolve({ unanswered: 3000 }), 3000)),
    ]);
  /** @param {any} outcome */
  const outcomeOf = outcome =>
    outcome.value ? [outcome.value.kind, outcome.value.cause ?? null, outcome.value.code ?? null, outcome.value.retryable ?? null] : outcome;
  // The adapter's read transaction, caught as it opens, sends the command as it aborts
  /** @type {Promise<unknown> | null} */
  let command = null;
  const { transaction } = IDBDatabase.prototype;
  IDBDatabase.prototype.transaction = function watched(...args) {
    const tx = transaction.apply(this, args);
    if (this.name === 'CanvasTabDB') {
      IDBDatabase.prototype.transaction = transaction;
      command = new Promise(resolve =>
        tx.addEventListener('abort', () =>
          resolve(
            answer(kernel.execute({ type: 'createNote', commandId: `pin-${Date.now()}`, noteId: `pin-${Date.now()}`, name: 'Between' })).then(outcomeOf),
          ),
        ),
      );
    }
    return tx;
  };
  const read = answer(
    adapter.read(['notes'], async tx => {
      while (Date.now() < deadline) await tx.get('notes', 'none');
      return 'read through';
    }),
  );
  IDBDatabase.prototype.transaction = transaction;
  window.closing = Promise.all([raw, read]).then(async ([seen, inFlight]) => ({
    order: seen.events,
    late: seen.late,
    inFlight,
    command: command ? await command : 'no transaction caught',
    next: await answer(adapter.read(['notes'], async () => 'read')),
    openState: adapter.openState(),
  }));
  return adapter.openState();
}

test('a transaction asked for over no store: InvalidAccessError on an open connection, InvalidStateError after close() and while its upgrade runs', async ({
  extension,
}) => {
  const page = await extension.openSurface('popup');
  expect(await page.evaluate(refusals)).toEqual({
    upgrading: 'InvalidStateError',
    open: 'InvalidAccessError',
    closed: 'InvalidStateError',
  });
  await expectNoUncaught(extension, page);
});

test("Chrome's close of a connection aborts the read open on it before the page hears of the close, so #17's adapter answers transaction-failed for the read and reload-required for the next call", async ({
  extension,
}) => {
  test.setTimeout(120_000);
  const page = await extension.openSurface('popup');
  const devtools = await page.context().newCDPSession(page);
  // Node's URL gives a chrome-extension: URL no origin of its own
  const origin = `chrome-extension://${extension.extensionId}`;
  const rounds = [];
  for (let round = 0; round < ROUNDS; round++) {
    expect(await page.evaluate(startReads)).toBe('open');
    await devtools.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
    rounds.push(await page.evaluate(() => window.closing));
  }
  // What Chrome does with what opens between its aborts and its close, as R88 asked to see
  console.log(JSON.stringify(rounds.map(({ late, command }) => ({ late, command }))));
  for (const [round, seen] of rounds.entries()) {
    // A transaction opened between the aborts and the close: its request fails once close has
    // fired, while the connection refuses a transaction, and the error bubbles to the transaction
    // and the connection, but the transaction fires neither complete nor abort
    expect(seen.late, `round ${round}`).toEqual([
      ['error', 'AbortError', 'InvalidStateError', 3],
      ['transaction-error', 3],
      ['connection-error', 3],
    ]);
    // A command sent then, whose transaction that close catches, answers, as reload-required
    expect(seen.command, `round ${round}`).toEqual(['unavailable', 'storage', 'reload-required', false]);
    expect(seen.order, `round ${round}`).toEqual([
      ['error', 'AbortError', 'InvalidAccessError'],
      ['abort', 'UnknownError', 'InvalidAccessError'],
      ['close', 'InvalidStateError'],
    ]);
    expect(seen.inFlight, `round ${round}`).toEqual({ failed: ['storage', 'transaction-failed', true] });
    expect(seen.next, `round ${round}`).toEqual({ failed: ['storage', 'reload-required', false] });
    expect(seen.openState, `round ${round}`).toBe('closed-by-browser');
  }
  await devtools.detach();
  await expectNoUncaught(extension, page);
});
