// The production inputs test/fixtures/storage/generate.mjs takes (#28 slice 3): BlockTypes'
// keys and the Block serializer from js/blocks.js, and the chrome.storage.local entries
// js/storage.js's initializeDefaultSettings writes on a first load, each read by running the
// production file in legacy-env, so a block type or setting added there reaches the maximal
// fixture with no edit here.

import fs from 'node:fs';
import path from 'node:path';

import { FIXTURES, legacyEnv } from './migration-support.mjs';

/** @typedef {import('../fixtures/storage/generate.mjs').Inputs} Inputs */

/** @type {Inputs | null} */
let inputs = null;

/** @returns {Promise<Inputs>} */
export async function productionInputs() {
  if (inputs) return inputs;
  const env = legacyEnv.createLegacyEnv();
  env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/blocks.js');
  await legacyEnv.runUntil(env, env.get('Storage').initializeDefaultSettings());
  const Block = env.get('Block');
  inputs = {
    shapes: JSON.parse(fs.readFileSync(path.join(FIXTURES, 'shapes.json'), 'utf8')).shapes,
    blockTypes: JSON.parse(JSON.stringify(Object.keys(env.get('BlockTypes')))),
    // Out of the vm context as plain JSON values, as the editor's save hands them to IndexedDB
    serializeBlock: options => JSON.parse(JSON.stringify(new Block(options).serialize())),
    defaultSettings: JSON.parse(JSON.stringify(env.chrome.local)),
  };
  return inputs;
}
