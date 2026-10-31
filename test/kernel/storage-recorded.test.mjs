// #28 slice 3, the release fixtures (test/fixtures/storage/recorded/, recorded by
// scripts/fixtures/record-release.mjs from each tag's own code in #34's harness): one for every
// release from v1.0.0 to v1.4.0, each the tag's by commit and tree; each loads and dumps back as
// itself; each runs through #17's registry to 9 and equals its expected file, which
// derive-expected.mjs derives without the runner, recovery point included; a run stopped at
// each step and run again ends the same; and the canaries hold every user-text field the seed
// wrote, so no recorded value came from a real profile.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { canarySlots, dumpFixture, fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import { FIXTURES, Killed, asDumped, dump, expectedFor, newProfile, profileWith, run } from './migration-support.mjs';

/** @typedef {import('../fixtures/storage/load-fixture.mjs').Fixture} Fixture */

const RELEASES = ['v1.0.0', 'v1.1.0', 'v1.1.1', 'v1.1.2', 'v1.1.3', 'v1.1.4', 'v1.1.5', 'v1.2.0', 'v1.3.0', 'v1.4.0'];
const SHAPES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'shapes.json'), 'utf8')).shapes;
/** Releases that fell back to #17's synthesized fixture for their row, each with why */
const FALLBACKS = /** @type {Record<string, string>} */ ({});

/** @returns {Map<string, Fixture>} every recorded fixture, by its release */
function recorded() {
  const dir = path.join(FIXTURES, 'recorded');
  const out = new Map();
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort() : []) {
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    out.set(fixture.header.source.tag, fixture);
  }
  return out;
}

const RECORDED = recorded();

/** The tags this clone has, or null in a shallow one (CI's checkout has none) */
function tagsHere() {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v1.*'], { cwd: path.join(FIXTURES, '..', '..', '..'), encoding: 'utf8' });
    return out.trim() === '' ? null : new Set(out.trim().split('\n'));
  } catch {
    return null;
  }
}

/** The canary slots every recording holds, whatever the release */
const ALWAYS = [
  'note-1-title', 'note-2-title', 'note-3-title', 'note-4-title',
  'block-1', 'block-2', 'block-3', 'block-4', 'block-5', 'block-6', 'block-7', 'llm-api-key',
];
/** The slots each of record-release.mjs's write paths fills, when header.source.writePaths lists it */
const SLOTS_OF = /** @type {Record<string, string[]>} */ ({
  'Storage.createFolder': ['folder-1'],
  'Storage.saveCustomTheme': ['theme-1'],
  'the Popup quick note': ['popup-note'],
  'convert a note to a template (updateNote)': ['note-5-title'],
  'the Daily Note template (setSetting dailyNoteTemplate)': ['daily-template'],
  'note insights (updateNote)': ['insight'],
  'the AI chat history (setSetting)': ['chat-message'],
  'the Ollama URL (setSetting)': ['llm-endpoint'],
  'the LLM endpoint (setSetting)': ['llm-endpoint'],
  'a custom AI prompt template (setSetting aiPromptTemplates)': ['prompt-template'],
  "SyncService.connect's WebDAV settings (setSetting syncWebdavConfig)": ['webdav-username', 'webdav-password'],
});

/**
 * The slots `fixture`'s write paths imply that it doesn't hold
 * @param {any} fixture
 * @returns {string[]}
 */
function missingSlots(fixture) {
  const held = canarySlots(fixture);
  const wanted = new Set([...ALWAYS, ...fixture.header.source.writePaths.flatMap((/** @type {string} */ p) => SLOTS_OF[p] || [])]);
  return [...wanted].filter(slot => !held.includes(slot)).sort();
}

describe('the recorded release fixtures', () => {
  it('every release from v1.0.0 to v1.4.0 has one, or is a listed fallback', () => {
    assert.deepStrictEqual(
      RELEASES.filter(tag => !RECORDED.has(tag) && !Object.hasOwn(FALLBACKS, tag)),
      [],
    );
    assert.deepStrictEqual([...RECORDED.keys()].filter(tag => !RELEASES.includes(tag)), []);
  });

  it('the slot check fails on a recording that lost a slot its write paths imply', () => {
    const fixture = /** @type {any} */ (structuredClone(RECORDED.get('v1.4.0')));
    assert.ok(fixture, 'no v1.4.0 recording');
    fixture.header.source.writePaths.push("SyncService.connect's WebDAV settings (setSetting syncWebdavConfig)");
    const text = JSON.stringify(fixture).replaceAll('{{CANARY:webdav-password}}', 'plain').replaceAll('{{CANARY:folder-1}}', 'Home');
    assert.deepStrictEqual(missingSlots(JSON.parse(text)), ['folder-1', 'webdav-password', 'webdav-username']);
  });

  for (const [tag, fixture] of RECORDED) {
    const { header } = fixture;
    it(`${header.id}: the header names ${tag}, its shape, and the recorder`, () => {
      assert.equal(header.provenance, 'recorded');
      assert.equal(header.id, `${header.shape}.${tag}`);
      assert.deepStrictEqual(header.releases, [tag]);
      assert.ok(SHAPES[header.shape].releases.includes(tag), `${tag} isn't a ${header.shape} release`);
      assert.equal(header.source.recorder, 'scripts/fixtures/record-release.mjs');
      assert.match(header.source.commit, /^[0-9a-f]{40}$/);
      assert.match(header.source.tree, /^[0-9a-f]{40}$/);
      assert.ok(header.source.writePaths.includes('Storage.createNote'));
      assert.deepStrictEqual(header.degraded, []);
    });

    it(`${header.id}: its commit and tree are ${tag}'s`, t => {
      const tags = tagsHere();
      if (!tags || !tags.has(tag)) {
        // CI's unit job fetches the tags and sets NTN_RELEASE_TAGS, so there a missing tag fails
        assert.notEqual(process.env.NTN_RELEASE_TAGS, 'required', `${tag} isn't in this clone, and NTN_RELEASE_TAGS requires it`);
        t.skip(`${tag} isn't in this clone: run \`git fetch --tags\` to check its pins`);
        return;
      }
      const git = (/** @type {string} */ ref) =>
        execFileSync('git', ['rev-parse', ref], { cwd: path.join(FIXTURES, '..', '..', '..'), encoding: 'utf8' }).trim();
      assert.equal(header.source.commit, git(`${tag}^{commit}`));
      assert.equal(header.source.tree, git(`${tag}^{tree}`));
    });

    it(`${header.id}: every canary slot its write paths imply is there, the AI key among them`, () => {
      assert.deepStrictEqual(missingSlots(fixture), []);
      assert.doesNotMatch(JSON.stringify(fixture), /ntn-canary-/, 'a filled canary was committed');
    });

    it(`${header.id}: loads and dumps back as itself`, async () => {
      const of = newProfile();
      await loadFixture(fixture, { factory: of.real, storage: of.chrome.api.storage.local });
      const dumped = await dumpFixture({ factory: of.real, storage: of.chrome.api.storage.local, header });
      assert.deepStrictEqual(dumped, fillCanaries({ ...fixture, chromeStorageLocal: fixture.chromeStorageLocal || {} }));
    });

    it(`${header.id}: migrated to 9, the profile equals expected/${header.id}.v9.json`, async () => {
      const of = await profileWith(fixture);
      const outcome = await run(of);
      assert.equal(outcome.status, 'migrated', JSON.stringify(outcome));
      const expected = expectedFor(header.id);
      assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
    });

    it(`${header.id}: stopped at each step in turn and run again, it ends at the expected file`, async () => {
      const expected = asDumped(expectedFor(header.id));
      let stops = 0;
      for (let at = 1; ; at++) {
        const of = await profileWith(fixture);
        /** @type {string[]} */
        const labels = [];
        let killed = false;
        await run(of, {
          limits: { records: 8, bytes: 2 * 1024 * 1024 },
          hooks: {
            between: label => {
              labels.push(label);
              if (labels.length === at) {
                killed = true;
                throw new Killed();
              }
            },
          },
        });
        if (!killed) {
          stops = labels.length;
          break;
        }
        await run(of);
        assert.deepStrictEqual(await dump(of, expected.header), expected, `stopped at ${labels.join(' > ')}`);
      }
      assert.ok(stops >= 3, `only ${stops} places to stop`);
    });
  }
});
