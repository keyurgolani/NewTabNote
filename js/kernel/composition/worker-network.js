/**
 * The service worker's network (#21 slice 1b, PR 3): its one runtime.onMessage listener, and
 * through it
 *
 * - `API_REQUEST`, the request proxy until #9 and #11 delete it: only this extension's own
 *   senders, only what the proxy policy takes (api-request.js), and the Ollama URL through the
 *   offscreen document, which checks it again (js/offscreen.js);
 * - `NETWORK_REFUSED`, the calls a page's network guard refused, journaled with the sending
 *   page's surface, from this extension only;
 * - each handler js/background.js hands it in `ownHandlers`, run only for this extension's
 *   own senders, so a handler there can't skip the sender check;
 *
 * and the worker's network guard: it refuses every destination when the registry has a
 * problem, and journals what it refused, the calls it held since the worker started first.
 *
 * js/background.js installs it in one call, installWorkerNetwork, and adds no onMessage
 * listener of its own (test/worker-network.test.js). The security baseline hashes this file
 * whole (scripts/build/security-baseline.js), in place of js/background.js, so the worker's
 * other code changes with no security/changes.json entry. It never throws as it installs.
 */

import { checkRequest, isOwnSender, send, storedLoopbackOrigin } from './api-request.js';
import { REGISTRY_PROBLEMS } from './destinations.js';
import { REFUSAL_MESSAGE, refusalFields } from './network-refusals.js';

/** A page's request for the proxy */
export const API_MESSAGE = 'API_REQUEST';
/** The worker's request to the offscreen document for the Ollama URL */
export const OFFSCREEN_MESSAGE = 'OFFSCREEN_API_REQUEST';
/** The message types this module answers, which no handler it's given may take */
export const MESSAGE_TYPES = Object.freeze([API_MESSAGE, REFUSAL_MESSAGE, OFFSCREEN_MESSAGE]);

/**
 * How long the worker waits for the offscreen document's answer. Under the page's own 30 s
 * (js/llm.js's fetchViaBackground), so the worker answers first: with no answer, and the page's
 * fallback sends the request, which then goes out at most twice, as before.
 */
const OFFSCREEN_ANSWER_MS = 25_000;

/** What askOffscreen answers when the document doesn't answer in time */
const OFFSCREEN_LATE = Symbol('offscreen-late');

/**
 * @typedef {(request: any, sender: chrome.runtime.MessageSender, sendResponse: (answer?: unknown) => void) => boolean | undefined} Listener
 * @typedef {(request: any, sender: chrome.runtime.MessageSender) => unknown} OwnHandler - its
 *   answer, or a promise of it
 * @typedef {{event(code: string, fields?: Record<string, unknown>, error?: unknown): void}} Events
 * @typedef {{refuseAll(): void, onRefused(listener: (report: Record<string, unknown>) => void): void}} GuardHandle
 * @typedef {object} WorkerRuntime
 * @property {string} [id]
 * @property {{addListener(listener: Listener): void}} onMessage
 */

/**
 * The message an error answers with
 * @param {unknown} error
 * @returns {{error: string}}
 */
function errorAnswer(error) {
  return { error: error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error) };
}

/**
 * Install the worker's network on `runtime`. Never throws.
 * @param {object} [options]
 * @param {GuardHandle | null} [options.guard] - the worker's guard handle (network-guard-first.js)
 * @param {Events} [options.events] - the worker's failure events, which journal what was refused
 * @param {Record<string, OwnHandler>} [options.ownHandlers] - by message type, run for this
 *   extension's own senders only; one of MESSAGE_TYPES is left out
 * @param {WorkerRuntime} [options.runtime] - the runtime it listens on and whose id it takes
 *   senders by: chrome.runtime unless a test passes another. The proxy itself calls
 *   chrome.runtime and chrome.offscreen by name, so the build's closure check (#27) follows its
 *   paths to offscreen.html.
 * @param {boolean} [options.quiet] - log no handler it leaves out
 */
export function installWorkerNetwork({ guard = null, events = { event() {} }, ownHandlers = {}, runtime = globalThis.chrome?.runtime, quiet = false } = {}) {
  // A registry the destination client found a problem with: the client refuses every request,
  // and so does the guard, which reports why once, and every refusal it held is journaled now
  try {
    if (guard && REGISTRY_PROBLEMS.length > 0) guard.refuseAll();
    if (guard) guard.onRefused((report) => events.event('network.request-refused', report));
  } catch {
    // The journal is best effort, and the guard refuses on its own
  }

  /** @type {Map<string, OwnHandler>} */
  const handlers = new Map();
  for (const [type, handler] of Object.entries(ownHandlers || {})) {
    if (MESSAGE_TYPES.includes(type) || typeof handler !== 'function') {
      if (!quiet) console.error(`NewTabNote: the worker's network leaves out the handler for ${type}`);
      continue;
    }
    handlers.set(type, handler);
  }

  const proxy = createProxy();
  const own = (/** @type {unknown} */ sender) => isOwnSender(sender, runtime?.id);

  /** @type {Listener} */
  const listener = (request, sender, sendResponse) => {
    const type = request !== null && typeof request === 'object' ? request.type : undefined;
    // A page's network guard refused a call: journaled here, from this extension only. Its
    // surface is the sending page's; one that comes before the journal is set up is dropped
    if (type === REFUSAL_MESSAGE) {
      try {
        const fields = own(sender) ? refusalFields(request.report, sender.url) : null;
        if (fields && events && typeof events.event === 'function') events.event('network.request-refused', fields);
      } catch {
        // The journal is best effort
      }
      return false;
    }
    if (type === API_MESSAGE) {
      // A web page or another extension never gets a request made for it
      if (!own(sender)) {
        sendResponse({ error: 'request-refused' });
        return false;
      }
      proxy(request).then((response) => {
        // No answer in time: the page's own fallback sends it, so it goes out at most twice
        if (response === null) {
          sendResponse(null);
          return;
        }
        if ('error' in response) console.debug('Background: API request failed:', response.error);
        else console.debug('Background: API response status:', response.status, 'ok:', response.ok);
        sendResponse(response);
      }).catch((error) => {
        console.error('Background: API error:', error && error.message);
        sendResponse(errorAnswer(error));
      });
      return true;
    }
    const handler = typeof type === 'string' ? handlers.get(type) : undefined;
    if (!handler) return undefined;
    if (!own(sender)) {
      sendResponse({ error: 'request-refused' });
      return false;
    }
    let answer;
    try {
      answer = handler(request, sender);
    } catch (error) {
      sendResponse(errorAnswer(error));
      return false;
    }
    Promise.resolve(answer).then(sendResponse, (error) => sendResponse(errorAnswer(error)));
    return true;
  };

  try {
    runtime?.onMessage.addListener(listener);
  } catch (error) {
    console.error("NewTabNote: the worker's network couldn't listen for messages", error);
  }
}

/**
 * The proxy: a request the policy took, sent with fetch, or through the offscreen document for
 * the Ollama URL's loopback origin
 * @returns {(request: unknown) => Promise<{ok: boolean, status: number, data?: unknown, error?: string} | {error: string} | null>}
 */
function createProxy() {
  /** @type {Promise<void> | null} */
  let creatingOffscreen = null;

  /**
   * Ensure the offscreen document exists. Both paths stay string literals, so the build's
   * closure check (#27) can find offscreen.html in the package.
   * @returns {Promise<void>}
   */
  async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (existingContexts.length > 0) return;
    // One that couldn't be made is made again at the next request, so a failure once doesn't
    // send every later one around it
    if (!creatingOffscreen) {
      // Its url and reasons stay string literals, which the closure check and the security
      // baseline read
      creatingOffscreen = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Making API requests to bypass CORS for Ollama and other LLM providers',
      }).finally(() => {
        creatingOffscreen = null;
      });
    }
    await creatingOffscreen;
  }

  /**
   * `message` sent to the offscreen document, and its answer, or OFFSCREEN_LATE when it
   * doesn't answer within OFFSCREEN_ANSWER_MS
   * @param {object} message
   * @returns {Promise<unknown>}
   */
  async function askOffscreen(message) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(OFFSCREEN_LATE), OFFSCREEN_ANSWER_MS); });
    try {
      return await Promise.race([chrome.runtime.sendMessage(message), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A request, proxied once the policy took it: a packaged destination, or the Ollama URL's
   * loopback origin, with Content-Type only. Null when the offscreen document didn't answer in time.
   * @param {unknown} request
   */
  return async function handleApiRequest(request) {
    const checked = checkRequest(request, { loopback: await storedLoopbackOrigin() });
    if (!checked.ok) return { error: 'request-refused' };

    console.debug('Background: Making fetch to', checked.url);

    // The Ollama URL goes through the offscreen document, which checks it again
    if (checked.loopback) {
      try {
        await ensureOffscreenDocument();
        /** @type {{method: string, body?: string}} */
        const options = { method: checked.method };
        if (checked.body !== undefined) options.body = checked.body;
        const response = /** @type {{ok: boolean, status: number, data: unknown} | {error: string} | undefined | typeof OFFSCREEN_LATE} */ (await askOffscreen({
          type: OFFSCREEN_MESSAGE,
          url: checked.url,
          options,
          loopbackOrigin: new URL(checked.url).origin,
        }));
        // Its answer is final, an error included, so the loopback origin is reached once. The
        // worker fetches itself only when the document can't be reached or answers nothing; one
        // that doesn't answer in time leaves it to the page's fallback
        if (response === OFFSCREEN_LATE) return null;
        if (response) return response;
      } catch (error) {
        console.debug('Background: Offscreen failed, trying direct fetch:', error && /** @type {{message?: unknown}} */ (error).message);
      }
    }

    try {
      const answer = await send(checked);
      console.debug('Background: Fetch response status:', answer.status);
      return answer;
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
      console.error('Background: Fetch error:', message);
      return { ok: false, status: 0, error: message };
    }
  };
}
