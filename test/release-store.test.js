const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release', 'publish-store.mjs');

// Test values only
const CREDENTIALS = {
  CHROME_CLIENT_ID: 'ntn-test-client.apps.googleusercontent.com',
  CHROME_CLIENT_SECRET: 'ntn-test-client-secret-5b0f1c',
  CHROME_REFRESH_TOKEN: '1//ntn-test-refresh-token-9e27d4',
  CHROME_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  CHROME_PUBLISHER_ID: 'ntn-test-publisher',
};
const ACCESS_TOKEN = 'ya29.ntn-test-access-token-31c8aa';
// Each as sent, and as it looks inside a URL or form body
const NEVER_PRINTED = [ACCESS_TOKEN, CREDENTIALS.CHROME_REFRESH_TOKEN, CREDENTIALS.CHROME_CLIENT_SECRET]
  .flatMap(value => [value, encodeURIComponent(value), new URLSearchParams({ value }).toString().slice('value='.length)]);

// Divides the 60 s request timeout to 300 ms, the 5 s poll interval to 25 ms, and the
// 10 min polling cap to 3 s
const TIME_SCALE = 200;
const TIMEOUT_MS = 60000 / TIME_SCALE;
const INTERVAL_MS = 5000 / TIME_SCALE;
const CAP_MS = 600000 / TIME_SCALE;

const ITEM = `publishers/${CREDENTIALS.CHROME_PUBLISHER_ID}/items/${CREDENTIALS.CHROME_EXTENSION_ID}`;
// Every request the script may make. Anything else is recorded as `unexpected`.
const ROUTES = {
  'POST /token': 'token',
  [`POST /upload/v2/${ITEM}:upload`]: 'upload',
  [`GET /v2/${ITEM}:fetchStatus`]: 'fetchStatus',
  [`POST /v2/${ITEM}:publish`]: 'publish',
};
// The name the script gives each call in its output
const CALL_NAMES = { token: 'OAuth token request', upload: ':upload', fetchStatus: ':fetchStatus', publish: ':publish' };

// Replies shaped like the token endpoint's and the V2 reference's
const ok = body => ({ status: 200, body });
const TOKEN_OK = ok({ access_token: ACCESS_TOKEN, expires_in: 3599, scope: 'https://www.googleapis.com/auth/chromewebstore', token_type: 'Bearer' });
const uploaded = uploadState => ok({
  name: ITEM,
  itemId: CREDENTIALS.CHROME_EXTENSION_ID,
  ...(uploadState === 'SUCCEEDED' ? { crxVersion: '1.4.1' } : {}),
  ...(uploadState === undefined ? {} : { uploadState }),
});
const status = lastAsyncUploadState => ok({
  name: ITEM,
  itemId: CREDENTIALS.CHROME_EXTENSION_ID,
  publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion: '1.3.0' }] },
  ...(lastAsyncUploadState === undefined ? {} : { lastAsyncUploadState }),
});
const published = (state, warnings) => ok({
  name: ITEM,
  itemId: CREDENTIALS.CHROME_EXTENSION_ID,
  ...(state === undefined ? {} : { state }),
  ...(warnings ? { warningInfo: { warnings } } : {}),
});
const googleError = (httpStatus, code, message) => ({ status: httpStatus, body: { error: { code: httpStatus, message, status: code } } });

const SYNC_UPLOAD = { token: TOKEN_OK, upload: uploaded('SUCCEEDED'), publish: published('PENDING_REVIEW') };
const ASYNC_UPLOAD = { ...SYNC_UPLOAD, upload: uploaded('IN_PROGRESS'), fetchStatus: status('SUCCEEDED') };

/**
 * A local stand-in for oauth2.googleapis.com and chromewebstore.googleapis.com. Each
 * route's reply is an object, or a function of the call count and the request. A reply
 * with `hang` never answers, `stall` sends headers and part of a body and then stops, and
 * `raw` sends that text instead of JSON.
 */
async function fakeGoogle(replies) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const { pathname } = new URL(req.url, 'http://fake-google');
      const route = ROUTES[`${req.method} ${pathname}`] ?? 'unexpected';
      const request = { route, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), at: performance.now() };
      requests.push(request);
      const handler = replies[route];
      const reply = (typeof handler === 'function' ? handler(requests.filter(r => r.route === route).length, request) : handler)
        ?? googleError(404, 'NOT_FOUND', `fake Google has no ${req.method} ${pathname}`);
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, { 'Content-Type': reply.type ?? 'application/json; charset=UTF-8', ...reply.headers });
      if (reply.stall) {
        res.write('{"uploadState": ');
        return;
      }
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    calls: route => requests.filter(r => r.route === route),
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

let zipPath;
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('a stand-in for the release zip, with binary bytes '), Buffer.from([0, 255, 13, 10, 128])]);
before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-release-store-'));
  temps.push(dir);
  zipPath = path.join(dir, 'new-tab-note-v1.4.1.zip');
  fs.writeFileSync(zipPath, ZIP_BYTES);
});

function runScript(args, env) {
  return new Promise((resolve, reject) => {
    // Only the variables a test sets, so nothing comes in from the shell or CI
    const childEnv = { PATH: process.env.PATH };
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[name] = value;
    }
    const started = performance.now();
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv });
    // A run that never ends fails its test instead of hanging the suite
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, output: `${stdout}${stderr}${signal ? `\n(killed by ${signal})` : ''}`, elapsed: performance.now() - started });
    });
  });
}

/**
 * Run publish-store.mjs against fake Google with the test credentials. `env` overrides
 * them, and an undefined value removes one.
 */
async function publish(replies, { env = {}, args = [zipPath] } = {}) {
  const google = await fakeGoogle(replies);
  try {
    const result = await runScript(args, {
      ...CREDENTIALS,
      CWS_TEST_BASE_URL: google.url,
      CWS_TEST_TIME_SCALE: String(TIME_SCALE),
      ...env,
    });
    return { ...result, google };
  } finally {
    await google.close();
  }
}

function assertNothingSecret({ stdout, stderr }) {
  for (const value of NEVER_PRINTED) {
    assert.ok(!stdout.includes(value), `stdout has a secret value:\n${stdout}`);
    assert.ok(!stderr.includes(value), `stderr has a secret value:\n${stderr}`);
  }
}

function assertSucceeded(result) {
  assert.equal(result.code, 0, result.output);
  assert.equal(result.stderr, '');
  assertNothingSecret(result);
  assert.deepEqual(result.google.calls('unexpected'), []);
}

/**
 * Exit 1 with a ✗ line that starts with the failed call's name (or names the missing input)
 * and matches `detail`, plus the pointer to the release plan
 */
function assertFailed(result, subject, detail) {
  assert.equal(result.code, 1, result.output);
  const line = result.stderr.split('\n').find(l => l.startsWith('✗ '));
  assert.ok(line, `no ✗ line in:\n${result.output}`);
  if (Object.values(CALL_NAMES).includes(subject)) {
    assert.ok(line.startsWith(`✗ ${subject} `), `the ✗ line doesn't start with ${subject}: ${line}`);
  } else {
    assert.ok(line.includes(subject), `"${subject}" is missing from: ${line}`);
  }
  if (detail) assert.match(line, detail);
  assert.match(result.stderr, /See "When publish-store fails" in docs\/release-plan\.md/);
  assert.doesNotMatch(result.stdout, /^✓/m);
  assertNothingSecret(result);
  assert.deepEqual(result.google?.calls('unexpected') ?? [], []);
}

describe('publish-store.mjs on success', () => {
  it('publishes a synchronous SUCCEEDED upload without calling :fetchStatus, and reports PENDING_REVIEW as submitted', async () => {
    const result = await publish(SYNC_UPLOAD);
    assertSucceeded(result);
    assert.deepEqual(result.google.requests.map(r => r.route), ['token', 'upload', 'publish']);
    assert.match(result.stdout, /^✓ Submitted, pending store review\./m);
    assert.doesNotMatch(result.output, /published/i);
  });

  it('reports a PUBLISHED publish as published', async () => {
    const result = await publish({ ...SYNC_UPLOAD, publish: published('PUBLISHED') });
    assertSucceeded(result);
    assert.match(result.stdout, /^✓ Published\./m);
  });

  it('polls :fetchStatus every interval while an upload is IN_PROGRESS, then publishes once it SUCCEEDED', async () => {
    const result = await publish({
      ...ASYNC_UPLOAD,
      fetchStatus: count => status(count < 3 ? 'IN_PROGRESS' : 'SUCCEEDED'),
    });
    assertSucceeded(result);
    assert.deepEqual(result.google.requests.map(r => r.route), ['token', 'upload', 'fetchStatus', 'fetchStatus', 'fetchStatus', 'publish']);
    const times = result.google.requests.filter(r => r.route === 'upload' || r.route === 'fetchStatus').map(r => r.at);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= INTERVAL_MS * 0.9, `poll ${i} came ${gap.toFixed(1)} ms after the previous request, under the ${INTERVAL_MS} ms interval`);
    }
    assert.match(result.stdout, /^✓ Submitted, pending store review\./m);
  });

  it('treats UPLOAD_IN_PROGRESS as in progress too', async () => {
    const result = await publish({ ...ASYNC_UPLOAD, upload: uploaded('UPLOAD_IN_PROGRESS') });
    assertSucceeded(result);
    assert.equal(result.google.calls('fetchStatus').length, 1);
    assert.equal(result.google.calls('publish').length, 1);
  });

  it('prints every warning in the :publish warningInfo', async () => {
    const warnings = [
      { reason: 'NTN_TEST_WARNING_ONE', description: 'The first test warning.' },
      { reason: 'NTN_TEST_WARNING_TWO', description: 'The second test warning.' },
    ];
    const result = await publish({ ...SYNC_UPLOAD, publish: published('PENDING_REVIEW', warnings) });
    assertSucceeded(result);
    for (const { reason, description } of warnings) {
      assert.ok(result.stdout.includes(`${reason}: ${description}`), result.stdout);
    }
  });

  it('sends the refresh-token grant, then the zip and the token to the V2 paths, with blockOnWarnings false', async () => {
    const result = await publish(SYNC_UPLOAD);
    assertSucceeded(result);
    const [token, upload, publishCall] = result.google.requests;

    assert.equal(token.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body.toString())), {
      client_id: CREDENTIALS.CHROME_CLIENT_ID,
      client_secret: CREDENTIALS.CHROME_CLIENT_SECRET,
      refresh_token: CREDENTIALS.CHROME_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });

    assert.equal(upload.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.ok(upload.body.equals(ZIP_BYTES), 'the :upload body is not the zip');

    assert.equal(publishCall.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.deepEqual(JSON.parse(publishCall.body.toString()), { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: false });
  });

  it('calls only the OAuth token endpoint and the V2 store endpoints, never v1.1', () => {
    const code = fs.readFileSync(SCRIPT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    assert.deepEqual([...new Set(code.match(/https?:\/\/[^\s'"`]+/g))], ['https://oauth2.googleapis.com', 'https://chromewebstore.googleapis.com']);
    assert.doesNotMatch(code, /v1\.1/);
    assert.ok(code.includes('/upload/v2/${item}:upload') && code.includes('/v2/${item}:fetchStatus') && code.includes('/v2/${item}:publish'));
  });
});

describe('publish-store.mjs fails closed', () => {
  for (const name of Object.keys(CREDENTIALS)) {
    it(`exits 1 before any call without ${name}`, async () => {
      for (const value of [undefined, '', '  ']) {
        const result = await publish(SYNC_UPLOAD, { env: { [name]: value } });
        assertFailed(result, name, /No call was made/);
        assert.deepEqual(result.google.requests, []);
      }
    });
  }

  it('exits 1 before any call when the zip is missing or empty', async () => {
    const empty = path.join(path.dirname(zipPath), 'empty.zip');
    fs.writeFileSync(empty, '');
    for (const args of [[path.join(path.dirname(zipPath), 'missing.zip')], [empty], [], [zipPath, zipPath]]) {
      const result = await publish(SYNC_UPLOAD, { args });
      assertFailed(result, args.length === 1 ? args[0] : 'Usage');
      assert.deepEqual(result.google.requests, []);
    }
  });

  it('refuses a CWS_TEST_BASE_URL that is not loopback', async () => {
    for (const base of ['https://chromewebstore.example.com', 'not a url', 'file:///tmp']) {
      const result = await publish(SYNC_UPLOAD, { env: { CWS_TEST_BASE_URL: base } });
      assertFailed(result, 'CWS_TEST_BASE_URL', /must be an http or https URL on 127\.0\.0\.1, localhost, or \[::1\]/);
      assert.deepEqual(result.google.requests, []);
    }
  });

  it('exits 1 on a token response without access_token', async () => {
    const result = await publish({ ...SYNC_UPLOAD, token: ok({ token_type: 'Bearer', expires_in: 3599 }) });
    assertFailed(result, 'OAuth token request', /without an access_token \(fields: token_type, expires_in\)/);
    assert.deepEqual(result.google.requests.map(r => r.route), ['token']);
  });

  it('prints the OAuth error when the token endpoint refuses the refresh token', async () => {
    const token = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    const result = await publish({ ...SYNC_UPLOAD, token });
    assertFailed(result, 'OAuth token request', /HTTP 400: invalid_grant: Token has been expired or revoked\./);
    assert.deepEqual(result.google.requests.map(r => r.route), ['token']);
  });

  // Each call, the replies that reach it, and the routes called up to and including it
  const REACHING = {
    token: [SYNC_UPLOAD, ['token']],
    upload: [SYNC_UPLOAD, ['token', 'upload']],
    fetchStatus: [ASYNC_UPLOAD, ['token', 'upload', 'fetchStatus']],
    publish: [SYNC_UPLOAD, ['token', 'upload', 'publish']],
  };

  for (const [route, [replies, routes]] of Object.entries(REACHING)) {
    it(`exits 1 naming ${CALL_NAMES[route]} on a non-2xx response`, async () => {
      const result = await publish({ ...replies, [route]: googleError(503, 'UNAVAILABLE', 'The service is currently unavailable.') });
      assertFailed(result, CALL_NAMES[route], /HTTP 503: UNAVAILABLE: The service is currently unavailable\./);
      assert.deepEqual(result.google.requests.map(r => r.route), routes);
    });

    it(`exits 1 naming ${CALL_NAMES[route]} on a body that is not JSON`, async () => {
      const result = await publish({ ...replies, [route]: { status: 200, type: 'text/html', raw: '<html><body>Sorry</body></html>' } });
      assertFailed(result, CALL_NAMES[route], /isn't a JSON object: <html><body>Sorry<\/body><\/html>/);
      assert.deepEqual(result.google.requests.map(r => r.route), routes);
    });

    it(`exits 1 naming ${CALL_NAMES[route]} when it takes longer than the request timeout`, async () => {
      const result = await publish({ ...replies, [route]: { hang: true } });
      assertFailed(result, CALL_NAMES[route], new RegExp(`no complete response within ${TIMEOUT_MS} ms`));
      assert.deepEqual(result.google.requests.map(r => r.route), routes);
      assert.ok(result.elapsed >= TIMEOUT_MS, `exited after ${result.elapsed.toFixed(0)} ms`);
    });
  }

  it('exits 1 naming :upload when its body stops arriving before the request timeout', async () => {
    const result = await publish({ ...SYNC_UPLOAD, upload: { stall: true } });
    assertFailed(result, ':upload', new RegExp(`no complete response within ${TIMEOUT_MS} ms`));
    assert.ok(result.elapsed >= TIMEOUT_MS, `exited after ${result.elapsed.toFixed(0)} ms`);
  });

  it('exits 1 naming :upload when a JSON array or null comes back instead of an object', async () => {
    for (const raw of ['[]', 'null', '"SUCCEEDED"']) {
      const result = await publish({ ...SYNC_UPLOAD, upload: { status: 200, raw } });
      assertFailed(result, ':upload', /isn't a JSON object/);
    }
  });

  it('exits 1 naming :upload when it refuses the upload because a submission is pending review', async () => {
    const upload = googleError(400, 'FAILED_PRECONDITION', 'You may not edit or publish an item that is in review.');
    const result = await publish({ ...SYNC_UPLOAD, upload });
    assertFailed(result, ':upload', /HTTP 400: FAILED_PRECONDITION: You may not edit or publish an item that is in review\./);
    assert.deepEqual(result.google.requests.map(r => r.route), ['token', 'upload']);
  });

  it('exits 1 without :publish when :upload ends anywhere but SUCCEEDED', async () => {
    for (const state of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined]) {
      const result = await publish({ ...SYNC_UPLOAD, upload: uploaded(state) });
      assertFailed(result, ':upload', new RegExp(`uploadState ${state ?? '\\(missing\\)'}, not SUCCEEDED`));
      assert.deepEqual(result.google.requests.map(r => r.route), ['token', 'upload']);
    }
  });

  it('exits 1 without :publish when :fetchStatus reports the upload ended anywhere but SUCCEEDED', async () => {
    for (const state of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined]) {
      const result = await publish({ ...ASYNC_UPLOAD, fetchStatus: count => status(count < 2 ? 'IN_PROGRESS' : state) });
      assertFailed(result, ':fetchStatus', new RegExp(`lastAsyncUploadState ${state ?? '\\(missing\\)'}, so the upload ended without SUCCEEDED`));
      assert.deepEqual(result.google.requests.map(r => r.route), ['token', 'upload', 'fetchStatus', 'fetchStatus']);
    }
  });

  it('exits 1 without :publish when the upload is still IN_PROGRESS at the polling cap', async () => {
    const result = await publish({ ...ASYNC_UPLOAD, fetchStatus: status('IN_PROGRESS') });
    assertFailed(result, ':fetchStatus', new RegExp(`still reports IN_PROGRESS after ${CAP_MS / 1000} s of polling every ${INTERVAL_MS} ms`));
    const polls = result.google.calls('fetchStatus').length;
    assert.ok(polls >= 2 && polls <= CAP_MS / INTERVAL_MS + 1, `${polls} polls`);
    assert.ok(result.elapsed >= CAP_MS, `gave up after ${result.elapsed.toFixed(0)} ms`);
    assert.equal(result.google.calls('publish').length, 0);
  });

  it('exits 1 naming :publish on any state but PUBLISHED or PENDING_REVIEW', async () => {
    for (const state of ['STAGED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED', 'ITEM_STATE_UNSPECIFIED', undefined]) {
      const result = await publish({ ...SYNC_UPLOAD, publish: published(state) });
      assertFailed(result, ':publish', new RegExp(`state ${state ?? '\\(missing\\)'}, not PUBLISHED or PENDING_REVIEW`));
    }
  });

  it('exits 1 naming :upload on a redirect instead of following it', async () => {
    const upload = { status: 307, headers: { Location: '/elsewhere' }, body: {} };
    const result = await publish({ ...SYNC_UPLOAD, upload });
    assertFailed(result, ':upload', /:upload failed: unexpected redirect/);
    assert.deepEqual(result.google.requests.map(r => r.route), ['token', 'upload']);
  });

  it('never prints a secret, even when a response echoes one back', async () => {
    const echoToken = (count, request) => googleError(401, 'UNAUTHENTICATED', `Rejected ${request.headers.authorization}`);
    let result = await publish({ ...SYNC_UPLOAD, upload: echoToken });
    assertFailed(result, ':upload', /Rejected Bearer \[redacted\]/);

    const echoGrant = (count, request) => ({ status: 400, body: { error: 'invalid_client', error_description: `Rejected ${request.body}` } });
    result = await publish({ ...SYNC_UPLOAD, token: echoGrant });
    assertFailed(result, 'OAuth token request', /client_secret=\[redacted\]&refresh_token=\[redacted\]&grant_type=refresh_token/);
  });
});

describe('fake Google', () => {
  it('answers a request off the V2 paths with 404 and records it', async () => {
    const google = await fakeGoogle(SYNC_UPLOAD);
    try {
      const response = await fetch(`${google.url}/chromewebstore/v1.1/items/${CREDENTIALS.CHROME_EXTENSION_ID}/publish`, { method: 'POST' });
      assert.equal(response.status, 404);
      assert.deepEqual(google.calls('unexpected').map(r => r.url), [`/chromewebstore/v1.1/items/${CREDENTIALS.CHROME_EXTENSION_ID}/publish`]);
    } finally {
      await google.close();
    }
  });
});
