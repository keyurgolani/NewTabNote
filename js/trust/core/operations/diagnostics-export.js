/**
 * diagnostics.export, catalog version 1 (#20, "Security and privacy"): build the diagnostic
 * report, `newtabnote-diagnostics-<date>.json`, and its preview: `fields` lists every field
 * the file holds with its value, so the user sees all of it before anything is saved, and
 * `serialized` is the file. Saving it locally is slice 4's view. It never uploads.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count } from '../../../kernel/core/contracts/fields.js';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import { rejectedSchema, unavailableSchema } from '../../../kernel/core/contracts/outcome-schemas.js';

export const payload = commandPayload('diagnostics.export', {});

/** One field of the file, by its path, with the value it holds */
export const previewFieldSchema = v.strictObject({
  field: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]{1,200}$/)),
  value: v.union([v.pipe(v.string(), v.maxLength(512)), v.number(), v.boolean(), v.null()]),
});

export const exportedSchema = v.strictObject({
  kind: v.literal('diagnostics'),
  filename: v.pipe(v.string(), v.regex(/^newtabnote-diagnostics-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/)),
  bytes: count,
  fields: v.array(previewFieldSchema),
  serialized: v.pipe(v.string(), v.maxLength(16 * 1024 * 1024)),
  // What the preview says beside the fields: the install id links every report from this
  // profile, or there's none because chrome.storage.local failed
  notices: v.array(v.picklist(['install-id-stable', 'install-id-missing'])),
});

export const result = v.variant('kind', [exportedSchema, rejectedSchema, unavailableSchema]);

/** @typedef {v.InferOutput<typeof payload>} DiagnosticsExport */
/** @typedef {v.InferOutput<typeof exportedSchema>} DiagnosticsExported */
