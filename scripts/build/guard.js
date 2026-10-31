'use strict';

/**
 * The network guard comes first, in what the build wrote (#21 slice 1b, "Guard"):
 *
 *   guard/page-first          each page's first <script> is the guard, js/network-guard.js, a
 *                             classic script, neither async nor deferred, ahead of every other
 *   guard/worker-first        the service worker's and each module worker's first module in
 *                             execution order is the guard's (network-guard-first.js), with only
 *                             the modules it imports itself ahead of it
 *   guard/not-installed       the built js/network-guard.js, run on stand-ins for a page's
 *                             APIs, doesn't mark each one it wraps, or lets a call to an
 *                             unregistered destination go
 *   guard/registry-unreadable the destination registry has a problem (destinations.js says
 *                             which), so the build won't inline it in the page guard, or the
 *                             built guard reads rows it can't use and refuses every destination
 *
 * The pages pass bundles js/network-guard.js into a classic script at its own path, and the
 * report (scripts/build/vite-config.js's reportPlugin) records each chunk's modules in
 * execution order, which guardOrderProblems reads.
 */

const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { problem } = require('./diagnostics.js');
const { htmlTags } = require('./markup.js');
const { resolve } = require('./closure.js');
const { GUARD_SCRIPT, BACKGROUND_ENTRY } = require('./vite-config.js');

/** @typedef {import('./diagnostics.js').Problem} Problem */
/** @typedef {import('./package-files.js').PackageFiles} PackageFiles */
/** @typedef {import('./vite-config.js').BundleReport} BundleReport */

/** The module that installs the guard where it's imported, the first of each module context */
const GUARD_FIRST = 'js/kernel/composition/network-guard-first.js';

/** The guard's mark (js/kernel/composition/network-guard.js's GUARD) */
const GUARD = Symbol.for('ntn.networkGuard');

/**
 * A problem for each page whose first script isn't the guard
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkGuardPages(files) {
  /** @type {Problem[]} */
  const problems = [];
  for (const page of files.paths.filter((file) => /\.html?$/i.test(file))) {
    const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : '';
    const [first] = htmlTags(files.text(page)).filter((tag) => tag.name === 'script');
    const src = first ? first.attributes.get('src') : undefined;
    const type = first ? (first.attributes.get('type') || '').trim().toLowerCase() : '';
    const at = first ? ` at ${first.at}` : '';
    if (!first || !src || resolve(src, dir) !== GUARD_SCRIPT) {
      problems.push(problem('guard/page-first', page, `its first script${at} is ${src || (first ? 'inline' : 'missing')}, not the network guard, ${GUARD_SCRIPT}, so a script ahead of it reaches the network unguarded`));
    } else if (type === 'module' || first.attributes.has('async') || first.attributes.has('defer')) {
      problems.push(problem('guard/page-first', page, `it loads the network guard${at} as a module, async, or deferred, so the scripts after it run first`));
    }
  }
  return problems;
}

/**
 * A problem for the service worker and each module worker whose first module, in execution
 * order, isn't the guard's
 * @param {BundleReport} report
 * @param {string} root
 * @param {(id: string, root: string) => string | null} sourcePath
 * @returns {Problem[]}
 */
function guardOrderProblems(report, root, sourcePath) {
  const sources = (/** @type {string[]} */ ids) => ids.map((id) => sourcePath(id, root)).filter((file) => file !== null && /\.m?js$/.test(file));
  const guard = report.chunks.find((chunk) => chunk.pass === 'guard' && chunk.fileName === GUARD_SCRIPT);
  if (!guard) return [problem('guard/page-first', GUARD_SCRIPT, 'the build wrote no network guard for the pages')];
  // The guard's own graph: what it imports runs ahead of it, and nothing else may
  const own = new Set(sources(guard.moduleIds).filter((file) => file !== GUARD_SCRIPT));
  /** @type {Problem[]} */
  const problems = [];
  const contexts = report.chunks.filter((chunk) => chunk.isEntry && ((chunk.pass === 'background' && chunk.fileName === BACKGROUND_ENTRY) || chunk.pass === 'worker'));
  for (const chunk of contexts) {
    const order = sources(chunk.moduleIds);
    const at = order.indexOf(GUARD_FIRST);
    const ahead = at === -1 ? order : order.slice(0, at).filter((file) => !own.has(file));
    if (at === -1 || ahead.length > 0) {
      problems.push(problem('guard/worker-first', chunk.fileName, at === -1
        ? `it doesn't import the network guard, ${GUARD_FIRST}`
        : `${ahead.join(', ')} run${ahead.length === 1 ? 's' : ''} ahead of the network guard, ${GUARD_FIRST}, which has to be its first import`));
    }
  }
  return problems;
}

/**
 * Stand-ins for a page's network APIs, each recording a call that went through
 * @param {string[]} sent
 */
function standIns(sent) {
  class XMLHttpRequest extends EventTarget {
    open() {}
    setRequestHeader() {}
    send() {
      sent.push('xhr');
    }
  }
  class WebSocket extends EventTarget {
    constructor() {
      super();
      sent.push('websocket');
    }
  }
  class EventSource extends EventTarget {
    constructor() {
      super();
      sent.push('eventsource');
    }
  }
  return {
    location: new URL('chrome-extension://ntn-build-check/newtab.html'),
    chrome: { runtime: { id: 'ntn-build-check' } },
    URL,
    Request,
    Headers,
    Response,
    Event,
    EventTarget,
    setTimeout: () => 0,
    fetch: async () => {
      sent.push('fetch');
      return new Response('');
    },
    XMLHttpRequest,
    WebSocket,
    EventSource,
    navigator: {
      sendBeacon: () => {
        sent.push('beacon');
        return true;
      },
    },
  };
}

/**
 * Run the built guard on stand-ins: it marks each API it wraps, a call to an unregistered
 * destination doesn't go, a call to this extension does, and its registry has no problem
 * @param {PackageFiles} files
 * @returns {Problem[]}
 */
function checkGuardScript(files) {
  if (!files.has(GUARD_SCRIPT)) return [problem('guard/not-installed', GUARD_SCRIPT, 'the package has no network guard')];
  /** @type {string[]} */
  const sent = [];
  /** @type {any} */
  const scope = standIns(sent);
  const context = vm.createContext(scope);
  vm.runInContext('globalThis.self = globalThis; globalThis.window = globalThis;', context);
  /** @type {Problem[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => problems.push(problem('guard/not-installed', GUARD_SCRIPT, message));
  try {
    vm.runInContext(files.text(GUARD_SCRIPT), context, { filename: GUARD_SCRIPT, timeout: 5000 });
  } catch (error) {
    fail(`it threw as it ran: ${error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error}`);
    return problems;
  }
  const unmarked = [
    ['fetch', scope.fetch],
    ['XMLHttpRequest.prototype.open', scope.XMLHttpRequest.prototype.open],
    ['XMLHttpRequest.prototype.send', scope.XMLHttpRequest.prototype.send],
    ['WebSocket', scope.WebSocket],
    ['EventSource', scope.EventSource],
    ['navigator.sendBeacon', scope.navigator.sendBeacon],
  ].filter(([, fn]) => !fn || /** @type {any} */ (fn)[GUARD] !== true).map(([name]) => name);
  if (unmarked.length > 0) fail(`it doesn't wrap ${unmarked.join(', ')}`);
  // Read in the guard's own realm: a symbol-keyed global it defines stays there
  const handle = vm.runInContext('globalThis[Symbol.for("ntn.networkGuard")]', context);
  /** @type {Array<{errorCode?: string}>} */
  const reports = [];
  if (!handle || typeof handle.onRefused !== 'function') fail('it leaves no handle on the page for its refusals to be journaled through');
  else handle.onRefused((/** @type {{errorCode?: string}} */ report) => reports.push(report));
  try {
    if (scope.navigator.sendBeacon('https://unregistered.invalid/collect', 'x') !== false || sent.length > 0) fail('a call to an unregistered destination went');
    if (scope.navigator.sendBeacon('chrome-extension://ntn-build-check/beacon', 'x') !== true) fail("a call to this extension's own origin didn't go");
  } catch (error) {
    fail(`a call threw: ${error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error}`);
  }
  if (reports.some((report) => report.errorCode === 'registry-unreadable')) {
    problems.push(problem('guard/registry-unreadable', GUARD_SCRIPT, 'its registry has a problem, so it refuses every destination. npm run check:destinations says which row.'));
  }
  return problems;
}

/**
 * The registry's rows for the page guard: validated by the destination client, then cut to
 * what the guard reads and compacted (destination-match.js's guardRows and compactRows), from
 * the sources at `root`
 * @param {string} root
 * @returns {Promise<{rows: readonly object[]} | {problem: Problem}>}
 */
async function guardRegistry(root) {
  const fail = (/** @type {string} */ message) => ({ problem: problem('guard/registry-unreadable', 'security/destinations.json', message) });
  try {
    const at = (/** @type {string} */ file) => pathToFileURL(path.join(root, file)).href;
    const client = await import(at('js/kernel/composition/destinations.js'));
    const match = await import(at('js/kernel/composition/destination-match.js'));
    if (client.REGISTRY_PROBLEMS.length > 0) return fail(`the registry has ${client.REGISTRY_PROBLEMS.length === 1 ? 'a problem' : 'problems'}, so the page guard would refuse every destination: ${client.REGISTRY_PROBLEMS.join('; ')}. npm run check:destinations checks it.`);
    const rows = match.guardRows(client.DESTINATIONS);
    if (rows === null) return fail("the page guard can't read the registry's rows");
    return { rows: match.compactRows(rows) };
  } catch (error) {
    return fail(`the registry couldn't be read: ${error && /** @type {any} */ (error).message ? /** @type {any} */ (error).message : error}`);
  }
}

module.exports = { checkGuardPages, checkGuardScript, guardOrderProblems, guardRegistry, GUARD_FIRST };
