'use strict';

/**
 * The fixture profiles `ref-desktop` seeds (#27 slice 4a, docs/testing.md "The performance
 * probe"), in the storage fixture format (`ntn-storage-fixture/1`), each with the digest the
 * report records, so two runs can say they seeded the same thing:
 *
 * - `first-run`: an empty profile, not onboarded, so the new tab runs the 1.4.0 walkthrough
 *   over the welcome note.
 * - `typical`: what 1.4.0's own code wrote for a synthetic seed (recorded/v8.v1.4.0.json):
 *   eight notes in a folder, archived, trashed, a Daily Note and a template, with media, a
 *   snapshot, backups and settings, the welcome note last opened. Onboarded, with the background
 *   AI jobs' one-time switch-off marked as done.
 * - `maximal`: #73's maximal profile (generate.mjs), every record type at sizes past #17's copy
 *   bounds, made from this tree's block types and default settings. Onboarded, with the same mark.
 *
 * Canaries fill with the loader's placeholders (`canary-<slot>`), so the AI key is a fake one
 * and the network is off anyway.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const STORAGE = path.join(ROOT, 'test', 'fixtures', 'storage');
const ONBOARDED = { setting_hasCompletedOnboarding: true };

/**
 * The background AI jobs' one-time switch-off (NTN-21), marked as done, so each start measures
 * the jobs as the profile stores them: `typical` has both on, and `maximal` both off. Without the
 * mark, the start would turn `typical`'s off before they run. The budget should cover the heavier
 * case, someone who turns AI back on, and readings that drop because the measurement changed
 * would read like a gain we didn't make. The switch-off's own upgrade tests prove it runs
 * (test/ai-settings.test.js, e2e/ai-settings.spec.js); these profiles don't. `first-run` is a new
 * install, so its start shows the new default.
 */
const JOBS_SWITCH_OFF_DONE = { setting_backgroundJobsOffOnce: true };

const PROFILES = Object.freeze(['first-run', 'typical', 'maximal']);

/**
 * `fixture` with onboarding marked complete, and the background AI jobs' one-time switch-off
 * marked as done
 * @param {any} fixture
 */
function onboarded(fixture) {
  return { ...fixture, chromeStorageLocal: { ...fixture.chromeStorageLocal, ...ONBOARDED, ...JOBS_SWITCH_OFF_DONE } };
}

/**
 * The profile `name` as `{name, fixture, digest}`; `first-run`'s fixture is null
 * @param {string} name
 */
async function profileFixture(name) {
  let fixture;
  if (name === 'first-run') {
    fixture = null;
  } else if (name === 'typical') {
    fixture = onboarded(JSON.parse(fs.readFileSync(path.join(STORAGE, 'recorded', 'v8.v1.4.0.json'), 'utf8')));
  } else if (name === 'maximal') {
    const { productionInputs } = await import(pathToFileURL(path.join(ROOT, 'test', 'kernel', 'generated-inputs.mjs')).href);
    const { maximalFixture } = await import(pathToFileURL(path.join(STORAGE, 'generate.mjs')).href);
    fixture = onboarded(maximalFixture(await productionInputs()).fixture);
  } else {
    throw new Error(`perf:probe: no profile "${name}"; the profiles are ${PROFILES.join(', ')}`);
  }
  const digest = fixture === null ? null : crypto.createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
  return { name, fixture, digest };
}

module.exports = { profileFixture, PROFILES };
