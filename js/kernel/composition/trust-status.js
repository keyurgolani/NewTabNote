/**
 * The new tab's status lines (#20 slice 4c): its sidebar line and Settings' Trust Center lines, a
 * chunk the status read's ask (./trust-status-ask.js) loads through the page loader only when an
 * answer could put a line in the sidebar, or when Settings opens, so a tab with nothing to show
 * never loads it. It reads the status through the ask's send, checks each answer in full by hand
 * (js/trust/core/status-message.js), and draws what status.js says in the signed words. The worker
 * reads the records, so no record, no IndexedDB and no check is in this chunk, and neither Valibot
 * nor #13's client is.
 *
 * It reads again when the tab is shown again and when Settings opens at Data & Backup. When the
 * worker didn't answer in time, or answers anything the check doesn't take, it draws nothing, and
 * Settings' section reads as it did before (#20 slice 4b). Its rules are the new tab's own
 * (css/editor.css), so it puts no style in the page.
 *
 * Loading it touches no browser API: its first read is the send's.
 */

import { statusFrom } from '../../trust/core/status-message.js';
import { GLYPHS } from '../../trust/ui/glyphs.js';
import { statusOf } from '../../trust/ui/status.js';

/** @typedef {ReturnType<typeof statusOf>} Lines */

/**
 * A status shape, which screen readers skip: the words beside it say the state
 * @param {Document} doc
 * @param {string} tone
 */
function glyph(doc, tone) {
  const span = doc.createElement('span');
  span.className = `trust-glyph trust-tone-${tone}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = /** @type {Record<string, string>} */ (GLYPHS)[tone] || GLYPHS.unknown;
  return span;
}

/**
 * A line: its shape, then its words, with the cause's sentence after the first in plain weight
 * when there is one, as Settings at capture risk draws it (g3)
 * @param {Document} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} tone
 * @param {string} text
 * @param {string | null} [cause]
 */
function line(doc, tag, className, tone, text, cause = null) {
  const element = doc.createElement(tag);
  element.className = className;
  element.appendChild(glyph(doc, tone));
  const words = doc.createElement('span');
  if (cause) {
    const strong = doc.createElement('strong');
    strong.textContent = text;
    words.appendChild(strong);
    words.appendChild(doc.createTextNode(` ${cause}`));
  } else {
    words.textContent = text;
  }
  element.appendChild(words);
  return element;
}

/**
 * Whether 1b's space notice shows in this tab (js/ui/export-notice.js, SpaceNotice)
 * @param {Document} doc
 */
function spaceNoticeShows(doc) {
  const card = doc.getElementById('export-notice');
  return !!card && card.classList.contains('is-shown') && card.dataset.notice === 'space-blocked';
}

/**
 * Starts the lines: reads the status now through `send`, the ask's, and again when the tab is
 * shown again and when Settings opens at Data & Backup. `now` is a test's.
 * @param {{document?: Document, send: () => Promise<unknown>, now?: () => number}} options
 * @returns {{read: () => Promise<Lines | null>, ready: Promise<Lines | null>}} - `ready`: the first read
 */
export function startTrustStatus({ document: doc = globalThis.document, send: ask, now = () => Date.now() }) {
  const section = doc.querySelector('.settings-section[data-setting-label="trust center"]');
  const lead = section ? section.querySelector('.setting-lead') : null;
  const link = section ? section.querySelector('.setting-link') : null;
  // Settings' section as 4b shipped it, which a later read that gets no answer puts back
  const shipped = {
    lead: lead ? lead.textContent : '',
    label: link ? link.textContent : '',
    href: link ? link.getAttribute('href') : null,
    className: link ? link.className : '',
  };

  /** @param {Lines | null} lines */
  const draw = lines => {
    for (const drawn of doc.querySelectorAll('.trust-sidebar-line')) drawn.remove();
    const footer = doc.querySelector('.sidebar-footer');
    if (lines && lines.sidebar && footer && footer.parentNode) {
      const sidebar = line(doc, 'a', 'trust-sidebar-line', lines.sidebar.tone, lines.sidebar.text);
      sidebar.setAttribute('href', lines.sidebar.href);
      const go = doc.createElement('span');
      go.className = 'trust-sidebar-go';
      go.setAttribute('aria-hidden', 'true');
      go.textContent = '›';
      sidebar.appendChild(go);
      footer.parentNode.insertBefore(sidebar, footer);
    }
    const parent = lead ? lead.parentNode : null;
    if (!section || !lead || !link || !parent) return;
    for (const drawn of section.querySelectorAll('.trust-settings-status')) drawn.remove();
    const settings = lines ? lines.settings : null;
    if (settings) {
      const { first } = settings;
      parent.insertBefore(line(doc, 'p', 'trust-settings-status', first.tone, first.text, first.cause), lead);
      if (settings.second)
        parent.insertBefore(line(doc, 'p', 'trust-settings-status', 'action', settings.second), lead);
    }
    lead.textContent = settings && settings.riskLine ? settings.riskLine : shipped.lead;
    link.textContent = settings ? settings.action.label : shipped.label;
    link.setAttribute('href', settings ? settings.action.href : /** @type {string} */ (shipped.href));
    link.className = settings
      ? `${settings.action.primary ? 'primary-btn' : 'secondary-btn'} setting-link`
      : shipped.className;
  };

  /** @returns {Promise<Lines | null>} */
  const read = async () => {
    /** @type {Lines | null} */
    let lines = null;
    try {
      const status = statusFrom(await ask());
      if (status) lines = statusOf(status, { now: now(), spaceNotice: spaceNoticeShows(doc) });
    } catch {
      lines = null;
    }
    draw(lines);
    return lines;
  };

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') read();
  });
  const data = doc.querySelector('.settings-nav-item[data-category="data"]');
  if (data) data.addEventListener('click', () => read());
  return { read, ready: read() };
}
