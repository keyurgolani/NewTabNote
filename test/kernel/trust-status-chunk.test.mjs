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
});
