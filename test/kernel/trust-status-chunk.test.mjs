// #20 slice 4c, PR 2: the new tab's trust-status chunk (js/kernel/composition/trust-status.js),
// which the status read's ask loads when an answer could put a line in the sidebar, or when
// Settings opens (test/kernel/trust-status-ask.test.mjs). It reads the status through the ask's
// send, checks each answer by hand, and draws the sidebar line above the sidebar's footer and
// Settings' Trust Center lines. It reads again when the tab is shown again and when Settings
// opens at Data & Backup. When the worker didn't answer in time, or answers anything the check
// doesn't take, it draws nothing, and Settings' section reads as 4b shipped it. Its rules are the
// new tab's own (css/editor.css), so it puts no style in the page (#16's scan).
//
// The chunk is new in this PR, so it loads inside each case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { whenText } from '../../js/trust/ui/model.js';
import { legacyEnv } from './legacy-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = Date.parse('2026-11-07T18:42:00');
const CHECKED = NOW - 5 * 60 * 1000;
const SHIPPED_LEAD = 'See where your notes live, what protects them, and what can leave this device.';

/** A new tab's document, with what the lines draw into */
function tabDocument() {
  const doc = new legacyEnv.FakeDocument();
  /**
   * @param {string} tag
   * @param {Record<string, string>} attributes
   * @param {any} [parent]
   */
  const add = (tag, attributes, parent = doc.body) => {
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'class') element.className = value;
      else element.setAttribute(name, value);
    }
    parent.appendChild(element);
    return element;
  };
  const sidebar = add('aside', { class: 'sidebar' });
  add('div', { id: 'sidebar-notes-list' }, sidebar);
  add('div', { class: 'sidebar-footer' }, sidebar);
  add('div', { id: 'export-notice', class: 'export-notice' });
  const nav = add('nav', { class: 'settings-nav' });
  add('button', { class: 'settings-nav-item', 'data-category': 'data' }, nav);
  const section = add('div', { class: 'settings-section', 'data-setting-label': 'trust center' });
  add('h3', {}, section).textContent = 'Trust Center';
  add('p', { class: 'setting-lead' }, section).textContent = SHIPPED_LEAD;
  const row = add('div', { class: 'setting-row' }, section);
  add('a', { class: 'secondary-btn setting-link', href: 'recovery.html#trust' }, row).textContent = 'Open Trust Center';
  return doc;
}

/**
 * A status's group
 * @param {string} group
 * @param {Record<string, unknown>} [fields]
 */
const group = (group, fields = {}) => ({ group, needsAction: 0, checkedAt: CHECKED, cause: null, ...fields });

/** @param {Record<string, unknown>} [fields] */
const status = (fields = {}) => ({
  capture: 'safe',
  route: 'trust',
  records: 'open',
  groups: [group('storage'), group('vault')],
  ...fields,
});

const ATTENTION = status({ groups: [group('storage'), group('vault', { needsAction: 1 })] });
const AT_RISK = status({
  capture: 'at-risk',
  route: 'recovery',
  groups: [
    group('storage', {
      needsAction: 1,
      cause: {
        from: 'incident',
        providerId: 'storage',
        faultCode: 'quota',
        errorCode: 'quota',
        severity: 'capture-risk',
        consequenceKey: null,
      },
    }),
    group('vault'),
  ],
});

/**
 * A status read whose answers are `answers`, in turn, which counts its sends
 * @param {unknown[]} answers - each what the worker answers, or an Error the send rejects with
 */
function sendOf(answers) {
  const sent = { count: 0 };
  return {
    sent,
    send: async () => {
      sent.count += 1;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** Timers a case runs by hand, which keep how long each was set for */
function manualTimers() {
  /** @type {Map<number, {callback: () => void, ms: number}>} */
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimeout: (/** @type {() => void} */ callback, /** @type {number} */ ms) => {
      next += 1;
      pending.set(next, { callback, ms });
      return next;
    },
    clearTimeout: (/** @type {number} */ handle) => {
      pending.delete(handle);
    },
    /** Runs every timer that's set, and lets what they set going settle */
    fire: async () => {
      const due = [...pending.values()];
      pending.clear();
      for (const { callback } of due) callback();
      for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
    },
  };
}

/** Timers that never run, for a case about something else */
const INERT = Object.freeze({ setTimeout: () => 0, clearTimeout: () => {} });

/** What the tab shows: the sidebar line's words, Settings' lines, the section's sentence, and its button */
const shown = (/** @type {any} */ doc) => {
  const line = doc.querySelector('.trust-sidebar-line');
  const link = doc.querySelector('.setting-link');
  return {
    sidebar: line ? [line.textContent, line.getAttribute('href')] : null,
    settings: doc.querySelectorAll('.trust-settings-status').map((/** @type {any} */ p) => p.textContent),
    lead: doc.querySelector('.setting-lead').textContent,
    button: [link.textContent, link.getAttribute('href'), link.className],
  };
};

describe("the new tab's trust-status chunk (#20 slice 4c)", () => {
  it("draws the sidebar line above the footer and Settings' lines, and reads again when the tab is shown and when Settings opens at Data & Backup", async () => {
    const { startTrustStatus } = await import('../../js/kernel/composition/trust-status.js');
    const doc = tabDocument();
    const { sent, send } = sendOf([ATTENTION, AT_RISK, status()]);
    await startTrustStatus({ document: /** @type {any} */ (doc), send, now: () => NOW }).ready;
    const footer = doc.querySelector('.sidebar-footer');
    const line = doc.querySelector('.trust-sidebar-line');
    assert.ok(line && line.parentNode === footer.parentNode, 'the line sits in the sidebar');
    assert.equal(
      footer.parentNode.children.indexOf(line) + 1,
      footer.parentNode.children.indexOf(footer),
      'just above its footer',
    );
    assert.deepEqual(shown(doc), {
      sidebar: ['Saved keys needs your attention›', 'recovery.html#trust'],
      settings: [
        `Your notes are saving normally. Checked ${whenText(CHECKED, NOW)}.`,
        '1 thing needs your attention: Saved keys.',
      ],
      lead: SHIPPED_LEAD,
      button: ['Open Trust Center', 'recovery.html#trust', 'secondary-btn setting-link'],
    });
    // The tab shown again: capture at risk
    doc.visibilityState = 'visible';
    await Promise.all(doc.fire('visibilitychange'));
    assert.deepEqual(shown(doc), {
      sidebar: ['New notes may not be saved›', 'recovery.html#recovery'],
      settings: [
        "New notes may not be saved. This device is out of space for NewTabNote, so new notes and changes can't be saved.",
      ],
      lead: 'The Recovery Center shows what went wrong and can save a copy of everything that can still be read.',
      button: ['Open Recovery Center', 'recovery.html#recovery', 'primary-btn setting-link'],
    });
    assert.equal(doc.querySelectorAll('.trust-sidebar-line').length, 1, 'one line, drawn again in its place');
    // Settings opened at Data & Backup: all is well, so the sidebar says nothing
    const data = doc.querySelector('.settings-nav-item[data-category="data"]');
    await Promise.all((data.listeners.click || []).map((/** @type {any} */ fn) => fn({ type: 'click' })));
    assert.deepEqual(shown(doc), {
      sidebar: null,
      settings: [`Your notes are saving normally. Checked ${whenText(CHECKED, NOW)}.`],
      lead: SHIPPED_LEAD,
      button: ['Open Trust Center', 'recovery.html#trust', 'secondary-btn setting-link'],
    });
    assert.equal(sent.count, 3);
  });

  it("draws nothing, and leaves Settings' section as 4b shipped it, with no answer, a refusal, or anything the check doesn't take", async () => {
    const { startTrustStatus } = await import('../../js/kernel/composition/trust-status.js');
    for (const [why, answer] of /** @type {Array<[string, unknown]>} */ ([
      ['a send that failed', new Error('Could not establish connection. Receiving end does not exist.')],
      ['no answer in time', undefined],
      ['a refusal', { error: 'request-refused' }],
      ["records it couldn't read", { error: 'unavailable' }],
      ["the summary's worstCore beside it", { ...AT_RISK, worstCore: 'failed' }],
      ['a group this build has no name for', { ...AT_RISK, groups: [group('cloud', { needsAction: 1 })] }],
    ])) {
      const doc = tabDocument();
      // Drawn once, then a read that gets no answer takes it all away
      const lines = startTrustStatus({
        document: /** @type {any} */ (doc),
        send: sendOf([AT_RISK, answer]).send,
        now: () => NOW,
        timers: INERT,
      });
      await lines.ready;
      assert.ok(doc.querySelector('.trust-sidebar-line'), why);
      await lines.read();
      assert.deepEqual(
        shown(doc),
        {
          sidebar: null,
          settings: [],
          lead: SHIPPED_LEAD,
          button: ['Open Trust Center', 'recovery.html#trust', 'secondary-btn setting-link'],
        },
        why,
      );
    }
  });

  it("shows no sidebar line for a wait for free space while 1b's space notice shows in the tab", async () => {
    const { startTrustStatus } = await import('../../js/kernel/composition/trust-status.js');
    const space = status({
      groups: [
        group('storage', {
          needsAction: 1,
          cause: {
            from: 'incident',
            providerId: 'storage',
            faultCode: 'migration-blocked',
            errorCode: 'space-short',
            severity: 'degraded',
            consequenceKey: null,
          },
        }),
      ],
    });
    const doc = tabDocument();
    const notice = doc.getElementById('export-notice');
    notice.classList.add('is-shown');
    notice.dataset.notice = 'space-blocked';
    const lines = startTrustStatus({
      document: /** @type {any} */ (doc),
      send: sendOf([space, space]).send,
      now: () => NOW,
    });
    await lines.ready;
    assert.equal(doc.querySelector('.trust-sidebar-line'), null);
    // The notice closed: the line shows
    notice.classList.remove('is-shown');
    await lines.read();
    assert.equal(doc.querySelector('.trust-sidebar-line').textContent, 'Notes database needs your attention›');
  });

  it("puts no style in the page, since the tab's stylesheet has the rules its lines' look rests on", async () => {
    const { startTrustStatus } = await import('../../js/kernel/composition/trust-status.js');
    const doc = tabDocument();
    await startTrustStatus({ document: /** @type {any} */ (doc), send: sendOf([AT_RISK]).send, now: () => NOW }).ready;
    assert.equal(doc.head.querySelectorAll('style').length, 0, 'no style of its own');
    // At capture risk it draws each of them, the red shape's included
    const sheet = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
    for (const name of [
      'trust-sidebar-line',
      'trust-sidebar-go',
      'trust-settings-status',
      'trust-glyph',
      'trust-tone-failed',
    ]) {
      assert.ok(doc.querySelector(`.${name}`), `it draws .${name}`);
      assert.match(sheet, new RegExp(`\\.${name}(?![\\w-])[^{}]*\\{`), `css/editor.css has a rule for .${name}`);
    }
  });

  it('draws only the newest read started, so an older one that gets its answer later, none included, leaves what the newer drew', async () => {
    const { startTrustStatus } = await import('../../js/kernel/composition/trust-status.js');
    const doc = tabDocument();
    // The first read's send waits, as one to a cold worker does, until it's let go with no answer
    /** @type {() => void} */
    let letGo = () => {};
    /** @type {Array<() => Promise<unknown>>} */
    const sends = [
      () =>
        new Promise(resolve => {
          letGo = () => resolve(undefined);
        }),
      async () => AT_RISK,
    ];
    const lines = startTrustStatus({
      document: /** @type {any} */ (doc),
      send: () => /** @type {() => Promise<unknown>} */ (sends.shift())(),
      now: () => NOW,
      timers: INERT,
    });
    // Settings opened at Data & Backup while the first read waits: its read answers first
    const data = doc.querySelector('.settings-nav-item[data-category="data"]');
    await Promise.all((data.listeners.click || []).map((/** @type {any} */ fn) => fn({ type: 'click' })));
    assert.deepEqual(shown(doc).sidebar, ['New notes may not be saved›', 'recovery.html#recovery']);
    letGo();
    assert.equal(await lines.ready, null, 'the older read draws nothing');
    assert.deepEqual(shown(doc).sidebar, ['New notes may not be saved›', 'recovery.html#recovery'], 'and wipes nothing');
  });

  it('asks once more RETRY_MS after a read that got no answer, draws what that one answers, and asks no more after it', async () => {
    const { startTrustStatus, RETRY_MS } = await import('../../js/kernel/composition/trust-status.js');
    assert.ok(RETRY_MS >= 1000 && RETRY_MS <= 10_000, 'a few seconds');
    // A first read with no answer, as when the worker didn't answer in time, then one at risk
    const doc = tabDocument();
    const timers = manualTimers();
    const { sent, send } = sendOf([undefined, AT_RISK]);
    const lines = startTrustStatus({ document: /** @type {any} */ (doc), send, now: () => NOW, timers });
    await lines.ready;
    assert.deepEqual(
      [sent.count, shown(doc).sidebar, [...timers.pending.values()].map(timer => timer.ms)],
      [1, null, [RETRY_MS]],
    );
    await timers.fire();
    assert.deepEqual([sent.count, shown(doc).sidebar], [2, ['New notes may not be saved›', 'recovery.html#recovery']]);
    assert.equal(timers.pending.size, 0, 'nothing more is set');
    // The one more that gets no answer asks nothing after it
    const quiet = tabDocument();
    const again = manualTimers();
    const silent = sendOf([undefined, undefined]);
    await startTrustStatus({ document: /** @type {any} */ (quiet), send: silent.send, now: () => NOW, timers: again }).ready;
    await again.fire();
    assert.deepEqual([silent.sent.count, again.pending.size], [2, 0]);
    // A send that failed is no answer too; a read that starts while the one more waits takes its place
    const shownAgain = tabDocument();
    const waiting = manualTimers();
    const failing = sendOf([new Error('Could not establish connection. Receiving end does not exist.'), AT_RISK]);
    await startTrustStatus({ document: /** @type {any} */ (shownAgain), send: failing.send, now: () => NOW, timers: waiting })
      .ready;
    assert.equal(waiting.pending.size, 1);
    shownAgain.visibilityState = 'visible';
    await Promise.all(shownAgain.fire('visibilitychange'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([failing.sent.count, waiting.pending.size], [2, 0]);
    assert.deepEqual(shown(shownAgain).sidebar, ['New notes may not be saved›', 'recovery.html#recovery']);
  });

  it('answers a read whose drawing threw with nothing, so its first read still settles and nothing goes unhandled', async () => {
    const { startTrustStatus } = await import('../../js/kernel/composition/trust-status.js');
    const doc = tabDocument();
    const footer = doc.querySelector('.sidebar-footer');
    footer.parentNode.insertBefore = () => {
      throw new Error('no room for it');
    };
    const lines = startTrustStatus({
      document: /** @type {any} */ (doc),
      send: sendOf([AT_RISK, AT_RISK]).send,
      now: () => NOW,
      timers: INERT,
    });
    assert.equal(await lines.ready, null);
    assert.equal(await lines.read(), null, 'and so does every read after it');
  });
});
