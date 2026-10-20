#!/usr/bin/env node

/**
 * Upload a release zip to the Chrome Web Store and submit it for publishing. Only
 * release.yml's publish-store job runs this, after it checks the zip against the GitHub
 * Release's .sha256 file and the tag.
 *
 *   node scripts/release/publish-store.mjs <zip>
 *
 * Reads CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN, CHROME_EXTENSION_ID,
 * and CHROME_PUBLISHER_ID, the chrome-web-store environment's secrets. Only tests set
 * CWS_TEST_BASE_URL, a loopback origin that replaces both Google origins, and
 * CWS_TEST_TIME_SCALE, which divides the request timeout, poll interval, and polling cap.
 *
 * Exits 0 when :publish reports PUBLISHED or PENDING_REVIEW. Anything else exits 1 and
 * names the call that failed, and an upload that doesn't end SUCCEEDED stops before
 * :publish. It never prints the access token, the refresh token, or the client secret.
 *
 * Chrome Web Store API V2 fields this relies on, from the reference
 * (https://developer.chrome.com/docs/webstore/api/reference/rest) and its discovery
 * document (https://chromewebstore.googleapis.com/$discovery/rest?version=v2):
 *   - media.upload: POST /upload/v2/{name}:upload with the zip as the body. The response
 *     is { name, itemId, crxVersion, uploadState }.
 *   - UploadState: SUCCEEDED, IN_PROGRESS, FAILED, NOT_FOUND, UPLOAD_STATE_UNSPECIFIED. The
 *     upload reference also says UPLOAD_IN_PROGRESS, so both count as in progress.
 *   - publishers.items.fetchStatus: GET /v2/{name}:fetchStatus. This reads only its
 *     lastAsyncUploadState, an UploadState.
 *   - publishers.items.publish: POST /v2/{name}:publish with { publishType, blockOnWarnings }.
 *     The response is { name, itemId, state, warningInfo: { warnings: [{ reason, description }] } },
 *     state an ItemState: PENDING_REVIEW, STAGED, PUBLISHED, PUBLISHED_TO_TESTERS, REJECTED,
 *     CANCELLED, or ITEM_STATE_UNSPECIFIED.
 *   - {name} is publishers/<publisher ID>/items/<extension ID>. Errors come back as
 *     { error: { code, status, message } }.
 * The token call is the refresh-token grant from "Use the Chrome Web Store API"
 * (https://developer.chrome.com/docs/webstore/using-api): POST https://oauth2.googleapis.com/token
 * with client_id, client_secret, refresh_token, and grant_type=refresh_token, then read
 * access_token from the response.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const GOOGLE = { token: 'https://oauth2.googleapis.com', store: 'https://chromewebstore.googleapis.com' };
const REQUIRED = ['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN', 'CHROME_EXTENSION_ID', 'CHROME_PUBLISHER_ID'];
const IN_PROGRESS = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REQUEST_TIMEOUT_MS = 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;
const POLL_CAP_MS = 10 * 60 * 1000;
const MAX_SNIPPET = 500;
const HELP = 'See "When publish-store fails" in docs/release-plan.md. Fix the cause, then dispatch publish-store again for the same tag. Never retag.';

// Values that never reach the output, even when a response echoes them back
const hidden = new Set();

class Failure extends Error {}

/**
 * Keep a value out of the output, as sent and as it looks inside a URL or form body
 */
function hide(value) {
  hidden.add(value);
  hidden.add(encodeURIComponent(value));
  hidden.add(new URLSearchParams({ value }).toString().slice('value='.length));
}

function redact(text) {
  let out = String(text);
  for (const value of hidden) out = out.split(value).join('[redacted]');
  return out;
}

function say(line) {
  process.stdout.write(`${redact(line)}\n`);
}

function shown(value) {
  if (value === undefined) return '(missing)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function snippet(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat === '') return '(empty body)';
  return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET)}...` : flat;
}

function duration(ms) {
  if (ms >= 60 * 1000) return `${+(ms / 60 / 1000).toFixed(2)} min`;
  if (ms >= 1000) return `${+(ms / 1000).toFixed(2)} s`;
  return `${+ms.toFixed(1)} ms`;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function timeScale(value) {
  if (value === undefined || value === '') return 1;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Failure(`CWS_TEST_TIME_SCALE must be a positive number, not ${JSON.stringify(value)}. No call was made.`);
  }
  return scale;
}

function origins(value) {
  if (value === undefined || value === '') return GOOGLE;
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // Reported below
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Failure(`CWS_TEST_BASE_URL must be an http or https URL on 127.0.0.1, localhost, or [::1], not ${JSON.stringify(value)}. `
      + 'Only tests set it. No call was made.');
  }
  say(`CWS_TEST_BASE_URL is set, so every call goes to ${url.origin} instead of Google.`);
  return { token: url.origin, store: url.origin };
}

/**
 * The error a Google API or OAuth response carries, or null
 */
function errorText(body) {
  const error = body?.error;
  if (typeof error === 'string') return [error, body.error_description].filter(Boolean).join(': ');
  if (error && typeof error === 'object') return [error.status, error.message].filter(Boolean).join(': ') || null;
  return null;
}

/**
 * Make one call and return its JSON object body. Fails on a network error, a response
 * that takes longer than the timeout, a non-2xx status, or a body that isn't a JSON object.
 */
async function call(name, url, init, timeoutMs) {
  say(`→ ${name}`);
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let text;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal });
    text = await response.text();
  } catch (error) {
    if (signal.aborted) {
      throw new Failure(`${name} got no complete response within ${duration(timeoutMs)}.`);
    }
    throw new Failure(`${name} failed: ${error?.cause?.message ?? error?.message ?? error}.`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new Failure(`${name} failed with HTTP ${response.status}: ${errorText(body) ?? snippet(text)}`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Failure(`${name} answered HTTP ${response.status} with a body that isn't a JSON object: ${snippet(text)}`);
  }
  return body;
}

async function accessToken(origin, env, timeoutMs) {
  const name = 'OAuth token request';
  const body = await call(name, `${origin}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.CHROME_CLIENT_ID,
      client_secret: env.CHROME_CLIENT_SECRET,
      refresh_token: env.CHROME_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  }, timeoutMs);
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    const fields = Object.keys(body).join(', ') || 'none';
    throw new Failure(`${name} answered without an access_token (fields: ${fields}).`);
  }
  return body.access_token;
}

/**
 * Poll :fetchStatus every interval until the upload leaves IN_PROGRESS, up to the cap
 */
async function waitForUpload(url, headers, timing) {
  const deadline = Date.now() + timing.cap;
  for (;;) {
    await sleep(timing.interval);
    const status = await call(':fetchStatus', url, { method: 'GET', headers }, timing.request);
    const state = status.lastAsyncUploadState;
    say(`  lastAsyncUploadState ${shown(state)}`);
    if (state === 'SUCCEEDED') return;
    if (!IN_PROGRESS.has(state)) {
      throw new Failure(`:fetchStatus reports lastAsyncUploadState ${shown(state)}, so the upload ended without SUCCEEDED. `
        + `Response: ${snippet(JSON.stringify(status))}`);
    }
    if (Date.now() >= deadline) {
      throw new Failure(`:fetchStatus still reports ${state} after ${duration(timing.cap)} of polling every ${duration(timing.interval)}.`);
    }
  }
}

async function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    throw new Failure('Usage: node scripts/release/publish-store.mjs <zip>');
  }
  const [zipPath] = argv;

  const missing = REQUIRED.filter(name => !process.env[name]?.trim());
  if (missing.length > 0) throw new Failure(`Missing ${missing.join(', ')}. No call was made.`);
  // A value pasted with a newline would 404 or get invalid_grant, which reads like an expired token
  const padded = REQUIRED.filter(name => process.env[name] !== process.env[name].trim());
  if (padded.length > 0) {
    throw new Failure(`${padded.join(', ')} ${padded.length === 1 ? 'has' : 'have'} leading or trailing whitespace, such as a pasted newline. `
      + 'Save the secret again without it. No call was made.');
  }
  const env = Object.fromEntries(REQUIRED.map(name => [name, process.env[name]]));
  hide(env.CHROME_CLIENT_SECRET);
  hide(env.CHROME_REFRESH_TOKEN);

  const scale = timeScale(process.env.CWS_TEST_TIME_SCALE);
  const timing = { request: REQUEST_TIMEOUT_MS / scale, interval: POLL_INTERVAL_MS / scale, cap: POLL_CAP_MS / scale };
  const origin = origins(process.env.CWS_TEST_BASE_URL);

  let zip;
  try {
    zip = fs.readFileSync(zipPath);
  } catch (error) {
    throw new Failure(`Can't read ${zipPath} (${error.code ?? error.message}). No call was made.`);
  }
  if (zip.length === 0) throw new Failure(`${zipPath} is empty. No call was made.`);
  say(`Uploading ${path.basename(zipPath)} (${size(zip.length)}) to the Chrome Web Store.`);

  const token = await accessToken(origin.token, env, timing.request);
  hide(token);
  const auth = { Authorization: `Bearer ${token}` };
  const item = `publishers/${encodeURIComponent(env.CHROME_PUBLISHER_ID)}/items/${encodeURIComponent(env.CHROME_EXTENSION_ID)}`;

  const upload = await call(':upload', `${origin.store}/upload/v2/${item}:upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/zip' },
    body: zip,
  }, timing.request);
  say(`  uploadState ${shown(upload.uploadState)}${upload.crxVersion ? `, crxVersion ${upload.crxVersion}` : ''}`);
  if (IN_PROGRESS.has(upload.uploadState)) {
    await waitForUpload(`${origin.store}/v2/${item}:fetchStatus`, auth, timing);
  } else if (upload.uploadState !== 'SUCCEEDED') {
    throw new Failure(`:upload ended with uploadState ${shown(upload.uploadState)}, not SUCCEEDED. `
      + `Response: ${snippet(JSON.stringify(upload))}`);
  }

  const result = await call(':publish', `${origin.store}/v2/${item}:publish`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: false }),
  }, timing.request);
  const warnings = result.warningInfo?.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) say(`  ⚠ ${shown(warning?.reason)}: ${shown(warning?.description)}`);
  } else if (result.warningInfo !== undefined) {
    say(`  ⚠ warningInfo: ${snippet(JSON.stringify(result.warningInfo))}`);
  }

  if (result.state === 'PENDING_REVIEW') {
    say('✓ Submitted, pending store review. It goes live when the review passes. Follow it in the Developer Dashboard.');
  } else if (result.state === 'PUBLISHED') {
    say('✓ Published. The store lists this version as live.');
  } else {
    throw new Failure(`:publish returned state ${shown(result.state)}, not PUBLISHED or PENDING_REVIEW. `
      + `Response: ${snippet(JSON.stringify(result))}`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Failure ? error.message : `Unexpected error: ${error?.stack ?? error}`;
  process.stderr.write(`${redact(`✗ ${message}`)}\n${HELP}\n`);
  process.exitCode = 1;
}
