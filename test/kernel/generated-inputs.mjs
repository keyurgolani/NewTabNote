// The production inputs test/fixtures/storage/generate.mjs takes (#28 slice 3): BlockTypes'
// keys and the Block serializer from js/blocks.js, read by running the production file in
// legacy-env, and the chrome.storage.local entries the new tab's startup maintenance writes on a
// first load, #17's adapter's first-run settings, which js/storage.js's initializeDefaultSettings
// wrote until #17 PR 4b. So a block type or setting added there reaches the maximal fixture with
// no edit here.

import fs from 'node:fs';
import path from 'node:path';

import { FIRST_RUN_SETTINGS, INITIALIZED_KEY } from '../../js/kernel/adapters/indexeddb/settings.js';
import { FIXTURES, legacyEnv } from './migration-support.mjs';

/** @typedef {import('../fixtures/storage/generate.mjs').Inputs} Inputs */

/** @type {Inputs | null} */
let inputs = null;

/** @returns {Promise<Inputs>} */
export async function productionInputs() {
  if (inputs) return inputs;
  const env = legacyEnv.createLegacyEnv();
  env.load('js/utils.js', 'js/blocks.js');
  const Block = env.get('Block');
  inputs = {
    shapes: JSON.parse(fs.readFileSync(path.join(FIXTURES, 'shapes.json'), 'utf8')).shapes,
    blockTypes: JSON.parse(JSON.stringify(Object.keys(env.get('BlockTypes')))),
    // Out of the vm context as plain JSON values, as the editor's save hands them to IndexedDB
    serializeBlock: options => JSON.parse(JSON.stringify(new Block(options).serialize())),
    // What the maintenance writes on a profile with nothing stored (adapter.js, maintain)
    defaultSettings: JSON.parse(JSON.stringify({ ...FIRST_RUN_SETTINGS, [INITIALIZED_KEY]: true })),
  };
  return inputs;
}
