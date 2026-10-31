/**
 * The 18 built-in block types as `block` contributions (#14, approved AC2), in the order
 * 1.4.x's BlockTypes lists them (js/blocks.js), with its names as labels and its descriptions.
 * Each is version 1, runs on every host, and has its model as a static implementation. No view
 * yet: slice 4 adds `viewVersion` with each type's view.
 */

import { BLOCK_FIXTURE, BLOCK_HOSTS } from './contract.js';
import { MODELS } from './models.js';

/** @typedef {import('./models.js').BlockModel} BlockModel */

/**
 * A block contribution as the kit and the catalog take it
 * @typedef {Readonly<{
 *   id: string,
 *   version: number,
 *   apiVersion: number,
 *   group: string,
 *   rank: number,
 *   hosts: readonly (typeof BLOCK_HOSTS)[number][],
 *   label: string,
 *   description: string,
 *   fixtures: readonly string[],
 *   fields: Readonly<Record<string, import('./fields.js').FieldKind>>,
 *   viewVersion?: number,
 *   implementation: BlockModel,
 * }>} BlockDescriptor
 */

/** Each type's group, label, and description, in BlockTypes order */
const TYPES = Object.freeze([
  ['text', 'text', 'Text', 'Plain text paragraph'],
  ['h1', 'text', 'Heading 1', 'Large section heading'],
  ['h2', 'text', 'Heading 2', 'Medium section heading'],
  ['h3', 'text', 'Heading 3', 'Small section heading'],
  ['bullet', 'list', 'Bulleted List', 'Simple bullet point'],
  ['numbered', 'list', 'Numbered List', 'Numbered list item'],
  ['todo', 'list', 'To-do', 'Checkbox item'],
  ['toggle', 'list', 'Toggle', 'Collapsible content'],
  ['quote', 'text', 'Quote', 'Capture a quote'],
  ['code', 'text', 'Code', 'Code snippet'],
  ['divider', 'structure', 'Divider', 'Visual separator'],
  ['callout', 'text', 'Callout', 'Highlighted info box'],
  ['image', 'media', 'Image', 'Upload or embed image'],
  ['table', 'structure', 'Table', 'Simple table'],
  ['bookmark', 'media', 'Bookmark', 'Link bookmark with preview'],
  ['video', 'media', 'Video', 'Embed YouTube/Vimeo video'],
  ['file', 'media', 'File', 'File attachment'],
  ['equation', 'structure', 'Equation', 'Math equation'],
]);

/** @type {readonly BlockDescriptor[]} */
export const BUILT_IN_BLOCKS = Object.freeze(
  TYPES.map(([id, group, label, description], index) =>
    Object.freeze({
      id,
      version: 1,
      apiVersion: 1,
      group,
      // BlockTypes order, which is unique across groups too
      rank: (index + 1) * 10,
      hosts: BLOCK_HOSTS,
      label,
      description,
      fixtures: Object.freeze([BLOCK_FIXTURE]),
      fields: MODELS[id].fields,
      implementation: MODELS[id].model,
    }),
  ),
);

/** The built-in types, in BlockTypes order */
export const BUILT_IN_TYPES = Object.freeze(BUILT_IN_BLOCKS.map(descriptor => descriptor.id));
