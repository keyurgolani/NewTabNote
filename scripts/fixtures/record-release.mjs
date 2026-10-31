#!/usr/bin/env node
// Records test/fixtures/storage/recorded/<shape>.<tag>.json (#28 slice 3): the storage a
// release's own code writes, from its tag's source loaded unpacked in #34's extension harness
// (e2e/harness/), in Playwright's Chromium, headless. One tag per run, by hand, after
// `git fetch --tags`; nothing is downloaded. The output is committed and reviewed:
//
//   node scripts/fixtures/record-release.mjs v1.4.0
//   node scripts/fixtures/derive-expected.mjs
//
// It `git archive`s the tag into a scratch directory, launches it on a fresh profile, waits
// for the new tab's Storage to open, and writes a synthetic seed through whichever of these
// the release has: Storage's notes, archive, trash, templates, folders, links, media,
// settings, themes, vectors, snapshots, auto and recovery backups, the editor's block save
// (Block.serialize, canvasId, order, saveElement, with the preview SidebarUtils computes), the
// Daily Note template, note insights, the AI chat history, a custom AI prompt template, the
// Ollama URL and LLM endpoint, the WebDAV settings SyncService.connect stores (its password in
// plain text; the harness blocks the network, so this is connect's setSetting call with its
// shape), and the Popup's quick note, typed into the Popup. Every user-text field, the AI key,
// and the WebDAV username and password hold a
// per-run canary, `ntn-canary-<slot>-<hex>`. Then e2e/harness/fixture-host.js dumps every
// database and chrome.storage.local from the service worker, each canary goes back to its
// `{{CANARY:<slot>}}` placeholder (a canary left over in any other form fails the run), and
// the extension's ID, a profile value, becomes `ntn-extension-id`. header.source names the
// tag, its commit and tree, the browser, and the write paths that ran.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.join(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const { launchExtension } = require('../../e2e/harness/extension.js');
const { fixtureHost } = require('../../e2e/harness/fixture-host.js');

const DIR = path.join(ROOT, 'test', 'fixtures', 'storage');
const SHAPES = JSON.parse(fs.readFileSync(path.join(DIR, 'shapes.json'), 'utf8')).shapes;
const RECORDER = 'scripts/fixtures/record-release.mjs';
const RECORDABLE = ['v1.0.0', 'v1.1.0', 'v1.1.1', 'v1.1.2', 'v1.1.3', 'v1.1.4', 'v1.1.5', 'v1.2.0', 'v1.3.0', 'v1.4.0'];
const PROFILE_ID = 'ntn-extension-id';
const SETTLE_MS = 1500;
// The canary slots the seed fills: every user-text field it writes, and the AI key
const SLOTS = [
  'note-1-title', 'note-2-title', 'note-3-title', 'note-4-title', 'note-5-title',
  'block-1', 'block-2', 'block-3', 'block-4', 'block-5', 'block-6', 'block-7',
  'folder-1', 'theme-1', 'popup-note', 'llm-api-key',
  'webdav-password', 'webdav-username', 'chat-message', 'prompt-template', 'daily-template', 'llm-endpoint', 'insight',
];
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]).toString('base64');

const tag = process.argv[2];
if (!RECORDABLE.includes(tag)) {
  console.error(`usage: node ${RECORDER} <tag>, one of ${RECORDABLE.join(' ')}`);
  process.exit(2);
}
const shape = Object.keys(SHAPES).find(name => SHAPES[name].releases.includes(tag));
if (!shape) throw new Error(`no shape in shapes.json lists ${tag}`);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git('rev-parse', `${tag}^{commit}`);
const tree = git('rev-parse', `${tag}^{tree}`);

/**
 * The seed, run in the release's new tab page. Feature-detects each write path, since the
 * releases differ, and returns the ones that ran.
 * @param {{c: Record<string, string>, png: string}} input
 */
async function seed({ c, png }) {
  /* global Block, Utils, SidebarUtils, LLM, AIPromptTemplates, SyncService, chrome */
  const S = window.Storage;
  const ran = [];
  const has = name => typeof S[name] === 'function';
  const bytes = Uint8Array.from(atob(png), ch => ch.charCodeAt(0));
  const dataUrl = `data:image/png;base64,${png}`;

  const n1 = await S.createNote(c['note-1-title']);
  const n2 = await S.createNote(c['note-2-title']);
  const n3 = await S.createNote(c['note-3-title']);
  const n4 = await S.createNote(c['note-4-title']);
  ran.push('Storage.createNote');

  // The editor's save: each Block serialized, with its note and order, then the note
  const notesBlocks = [
    [n1, [{ type: 'h1', content: c['block-1'] }, { type: 'text', content: c['block-2'] }, { type: 'todo', content: c['block-3'], checked: true }, { type: 'image', imageUrl: dataUrl }]],
    [n2, [{ type: 'text', content: c['block-4'] }, { type: 'todo', content: c['block-5'], checked: false }]],
    [n3, [{ type: 'text', content: c['block-6'] }]],
    [n4, [{ type: 'text', content: c['block-7'] }]],
  ];
  for (const [note, specs] of notesBlocks) {
    const blocks = specs.map(spec => new Block(spec));
    for (let i = 0; i < blocks.length; i++) {
      const data = blocks[i].serialize();
      data.canvasId = note.id;
      data.order = i;
      await S.saveElement(data);
    }
    if (typeof SidebarUtils !== 'undefined' && SidebarUtils.buildNoteSaveMetadata) {
      const current = await S.getNote(note.id);
      const metadata = SidebarUtils.buildNoteSaveMetadata(blocks);
      current.preview = metadata.preview;
      current.todoProgress = metadata.todoProgress;
      await S.updateNote(current);
    }
  }
  ran.push('the editor save (Block.serialize, saveElement)');
  if (typeof SidebarUtils !== 'undefined' && SidebarUtils.buildNoteSaveMetadata) ran.push('the editor save metadata (preview, todoProgress)');

  await S.saveMedia(Utils.generateId(), n1.id, new Blob([bytes], { type: 'image/png' }), 'image/png');
  ran.push('Storage.saveMedia');

  if (has('updateNoteLinks')) {
    await S.updateNoteLinks(n1.id, [c['note-2-title']]);
    ran.push('Storage.updateNoteLinks');
  }
  if (has('createFolder')) {
    const folder = await S.createFolder(c['folder-1']);
    await S.moveNoteToFolder(n1.id, folder.id);
    ran.push('Storage.createFolder', 'Storage.moveNoteToFolder');
  }
  await S.archiveNote(n3.id);
  ran.push('Storage.archiveNote');
  await S.trashNote(n4.id);
  ran.push('Storage.trashNote');
  if (has('getTemplates')) {
    // NotesManager.convertNoteToTemplate, or App's in v1.2.0
    const n5 = await S.createNote(c['note-5-title']);
    const template = await S.getNote(n5.id);
    template.isTemplate = true;
    template.folderId = null;
    await S.updateNote(template);
    ran.push('convert a note to a template (updateNote)');
    // Settings > Daily Notes' template, which ensureDailyNote applies to the new Daily Note
    const data = new Block({ type: 'text', content: c['daily-template'] }).serialize();
    data.canvasId = n5.id;
    data.order = 0;
    await S.saveElement(data);
    await S.setSetting('dailyNoteTemplate', n5.id);
    ran.push('the Daily Note template (setSetting dailyNoteTemplate)');
  }
  if (has('ensureDailyNote')) {
    await S.ensureDailyNote();
    ran.push('Storage.ensureDailyNote');
  }
  if (has('saveCustomTheme')) {
    // The theme builder's save
    const theme = await S.saveCustomTheme({ name: c['theme-1'], properties: { '--bg-primary': '#101820', '--text-primary': '#f2f2f2' } });
    await S.setSetting('theme', theme.id);
    ran.push('Storage.saveCustomTheme');
  } else {
    await S.setSetting('theme', 'dark');
  }
  if (has('saveVector')) {
    await S.saveVector(n1.id, [0.125, -0.5, 0.25, 1]);
    ran.push('Storage.saveVector');
  }
  if (has('saveSnapshot')) {
    const blocks = (await S.getElementsByNote(n1.id)).map(data => Block.deserialize(data).serialize());
    await S.saveSnapshot(n1.id, blocks, c['note-1-title']);
    ran.push('Storage.saveSnapshot');
  }
  await S.setSetting('llmProvider', 'openai');
  await S.setSetting('llmApiKey', c['llm-api-key']);
  ran.push('Storage.setSetting');
  if ('insights' in n1) {
    // What LLM.extractInsights returns, as App stores it on the note
    const note = await S.getNote(n1.id);
    note.insights = { todos: [c.insight], reminders: [], deadlines: [], highlights: [], tags: [], extractedAt: Date.now() };
    note.lastInsightsExtractedAt = Date.now();
    await S.updateNote(note);
    ran.push('note insights (updateNote)');
  }
  // Settings the release's first load wrote, read back to see which this release has
  const local = await new Promise(resolve => chrome.storage.local.get(null, resolve));
  if (Object.hasOwn(local, 'setting_noteChatMessages')) {
    // The AI chat's saveNoteChatHistory and saveGlobalChatHistory
    await S.setSetting('aiChatHistory', [{ role: 'user', content: c['chat-message'] }]);
    await S.setSetting('noteChatMessages', [{ content: c['chat-message'], type: 'user' }]);
    await S.setSetting('globalChatHistory', [{ role: 'user', content: c['chat-message'] }]);
    await S.setSetting('globalChatMessages', [{ content: c['chat-message'], type: 'user', sourceNotes: [] }]);
    ran.push('the AI chat history (setSetting)');
  }
  if (Object.hasOwn(local, 'setting_ollamaUrl')) {
    await S.setSetting('ollamaUrl', `http://localhost:11434/${c['llm-endpoint']}`);
    ran.push('the Ollama URL (setSetting)');
  }
  if (typeof LLM !== 'undefined' && typeof LLM.getDefaultEndpointForProvider === 'function') {
    await S.setSetting('llmEndpoint', c['llm-endpoint']);
    ran.push('the LLM endpoint (setSetting)');
  }
  if (typeof AIPromptTemplates !== 'undefined' && typeof AIPromptTemplates.sanitizeAIPromptTemplates === 'function') {
    // App.persistAIPromptTemplates: the saved list, sanitized, with a custom one added
    const saved = (await S.getSetting('aiPromptTemplates', null)) || [];
    const custom = { id: 'custom-recorded', label: 'Custom prompt', prompt: c['prompt-template'], scope: 'both', behavior: 'send' };
    await S.setSetting('aiPromptTemplates', AIPromptTemplates.sanitizeAIPromptTemplates([...saved, custom]));
    ran.push('a custom AI prompt template (setSetting aiPromptTemplates)');
  }
  if (typeof SyncService !== 'undefined') {
    // What SyncService.connect('webdav', config) stores once the server answers, the password
    // in plain text (#21's KD-006). The harness blocks the network, so connect can't reach that
    // line itself; this is its setSetting call with its shape.
    await S.setSetting('syncProvider', 'webdav');
    await S.setSetting('syncWebdavConfig', {
      serverUrl: 'https://webdav.example.test/notes',
      username: c['webdav-username'],
      password: c['webdav-password'],
    });
    ran.push("SyncService.connect's WebDAV settings (setSetting syncWebdavConfig)");
  }
  if (has('createAutoBackup')) {
    await S.createAutoBackup();
    ran.push('Storage.createAutoBackup');
  }
  if (has('_exportBeforeCorruptionDelete')) {
    await S._exportBeforeCorruptionDelete(S.db);
    ran.push('Storage._exportBeforeCorruptionDelete');
  }
  // A read on every store the seed wrote, so each write before it has committed
  await S.getAllNotes(true);
  for (const note of [n1, n2, n3, n4]) await S.getElementsByNote(note.id);
  return ran;
}

/** `value` with each canary back to its placeholder, and the extension ID to PROFILE_ID */
function placeholders(value, canaries, extensionId) {
  const swaps = Object.entries(canaries).map(([slot, canary]) => [canary, `{{CANARY:${slot}}}`]);
  const fix = item => {
    if (typeof item === 'string') {
      let out = item;
      for (const [canary, placeholder] of swaps) out = out.split(canary).join(placeholder);
      return out.split(extensionId).join(PROFILE_ID);
    }
    if (Array.isArray(item)) return item.map(fix);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [fix(key), fix(entry)]));
    return item;
  };
  return fix(value);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `ntn-record-${tag}-`));
const source = path.join(scratch, 'source');
fs.mkdirSync(source);
execFileSync('git', ['archive', '--format=tar', '-o', path.join(scratch, 'source.tar'), tag], { cwd: ROOT });
execFileSync('tar', ['-xf', path.join(scratch, 'source.tar'), '-C', source]);
console.log(`${tag}: ${commit} unpacked in ${source}`);

const canaries = Object.fromEntries(SLOTS.map(slot => [slot, `ntn-canary-${slot}-${randomBytes(4).toString('hex')}`]));
const extension = await launchExtension({ dist: source, headless: true });
let fixture;
try {
  const agent = await extension.worker.evaluate(() => navigator.userAgent);
  const browserVersion = (/Chrome\/([\d.]+)/.exec(agent) || [null, 'unknown'])[1];
  const page = await extension.openSurface('newtab');
  await page.waitForFunction(() => window.Storage && window.Storage.db, null, { timeout: 30_000 });
  await page.waitForTimeout(SETTLE_MS);
  const ran = await page.evaluate(seed, { c: canaries, png: PNG_BASE64 });

  const popup = await extension.openSurface('popup');
  const quick = popup.locator('#quick-note-input');
  if ((await quick.count()) > 0) {
    await quick.fill(canaries['popup-note']);
    await quick.press('Enter');
    await popup.waitForFunction(() => document.getElementById('quick-note-input').value === '', null, { timeout: 10_000 });
    ran.push('the Popup quick note');
  }
  await page.waitForTimeout(SETTLE_MS);
  await popup.close();
  await page.close();

  const dumped = await fixtureHost(extension.worker).dumpFixture({});
  const recorded = placeholders(dumped, canaries, extension.extensionId);
  const left = JSON.stringify(recorded).match(/ntn-canary-[a-z0-9-]+/g);
  if (left) throw new Error(`a canary is left outside its placeholder, so the release changed it: ${[...new Set(left)].join(', ')}`);

  const db = recorded.databases.find(database => database.name === 'CanvasTabDB');
  if (!db || db.version !== SHAPES[shape].idbVersion) {
    throw new Error(`${tag} left CanvasTabDB at ${db ? db.version : 'no version'}, not ${shape}'s ${SHAPES[shape].idbVersion}`);
  }
  const id = `${shape}.${tag}`;
  fixture = {
    format: recorded.format,
    header: {
      id,
      purpose: `What ${tag}'s own code writes for a synthetic seed: notes, blocks, media, settings and backups, as far as ${tag} has them.`,
      shape,
      releases: [tag],
      provenance: 'recorded',
      source: { recorder: RECORDER, tag, commit, tree, browser: `chromium ${browserVersion}`, writePaths: ran },
      schema: { idbVersion: db.version, structuralVersion: null, logicalVersion: null },
      degraded: [],
      privacy: 'synthetic',
    },
    databases: recorded.databases,
    chromeStorageLocal: recorded.chromeStorageLocal,
  };
  const uncaught = await extension.uncaught();
  if (uncaught.length > 0) console.log(`${tag}: uncaught while recording (kept in the log, not in the fixture):\n${uncaught.map(e => `  ${e.source}: ${e.message}`).join('\n')}`);
} finally {
  await extension.close();
}

fs.mkdirSync(path.join(DIR, 'recorded'), { recursive: true });
const out = path.join(DIR, 'recorded', `${fixture.header.id}.json`);
fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${tag}: wrote ${path.relative(ROOT, out)} (${fs.statSync(out).size} bytes); scratch left in ${scratch}`);
