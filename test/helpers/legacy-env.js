'use strict';

/**
 * Test environment for the legacy (1.4.x) scripts.
 *
 * Loads the production files unmodified into a node:vm context, the way the
 * extension loads them as classic scripts, with:
 * - fake-indexeddb as `indexedDB` (one fresh IDBFactory per environment),
 * - a fake clock behind setTimeout, setInterval, and requestAnimationFrame,
 * - recording `chrome.*` and `importScripts` stubs,
 * - an exclusive `navigator.locks` stub (Web Locks),
 * - an optional minimal DOM (FakeDocument) for page contexts.
 *
 * Nothing here copies production logic. Fixtures are built with raw
 * indexedDB.open calls so tests see the same databases a 1.4.0 or newer
 * build would leave behind.
 */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const ROOT = path.join(__dirname, '..', '..');
const DB_NAME = 'CanvasTabDB';

// ─── Fake clock ───

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    /** @type {Map<number, {at: number, fn: Function, args: any[], interval: number|null}>} */
    this.timers = new Map();
    this.setTimeout = (fn, ms = 0, ...args) => this._add(fn, ms, args, null);
    this.setInterval = (fn, ms = 0, ...args) => this._add(fn, ms, args, Math.max(1, Number(ms) || 0));
    this.clearTimeout = (id) => { if (id !== null && id !== undefined) this.timers.delete(Number(id)); };
    this.clearInterval = this.clearTimeout;
  }

  _add(fn, ms, args, interval) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, args, interval });
    return id;
  }

  /** Number of timers waiting to fire. */
  pending() {
    return this.timers.size;
  }

  /** Advance time by `ms`, firing due timers in order. */
  tick(ms = 0) {
    const target = this.now + ms;
    for (let guard = 0; guard < 10000; guard++) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && id < nextId))) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) break;
      this.now = next.at;
      if (next.interval) {
        next.at += next.interval;
      } else {
        this.timers.delete(nextId);
      }
      next.fn(...next.args);
    }
    this.now = target;
  }
}

// ─── FileReader on top of Node's Blob ───

class FakeFileReader {
  constructor() {
    this.result = null;
    this.error = null;
    this.onload = null;
    this.onerror = null;
  }

  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      const type = blob.type || 'application/octet-stream';
      this.result = `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
      if (this.onload) this.onload({ target: this });
    }, (error) => this._fail(error));
  }

  readAsText(blob) {
    blob.text().then((text) => {
      this.result = text;
      if (this.onload) this.onload({ target: this });
    }, (error) => this._fail(error));
  }

  _fail(error) {
    this.error = error;
    if (this.onerror) this.onerror({ target: this });
  }
}

// ─── Minimal DOM ───

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.set = new Set();
  }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  toString() { return Array.from(this.set).join(' '); }
}

/** A compound selector: an optional tag, then .class and #id parts, then [attr] or [attr="value"] parts. */
function matchesSimple(element, selector) {
  if (!element || !element.tagName) return false;
  const parts = selector.match(/^([a-zA-Z0-9-]*)((?:[.#][\w-]+)*)((?:\[[^\]=]+(?:="[^"]*")?\])*)$/);
  if (!parts) return false;
  if (parts[1] && element.tagName.toLowerCase() !== parts[1].toLowerCase()) return false;
  const rest = parts[2].match(/[.#][\w-]+/g) || [];
  const simple = rest.every((token) => (token[0] === '#'
    ? element.id === token.slice(1)
    : element.classList.contains(token.slice(1))));
  if (!simple) return false;
  const attributes = parts[3].match(/\[[^\]]+\]/g) || [];
  return attributes.every((token) => {
    const [, name, expected] = token.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    const value = element.getAttribute(name);
    return expected === undefined ? value !== null : value === expected;
  });
}

function matches(element, selectorList) {
  return selectorList.split(',').map((s) => s.trim()).some((s) => matchesSimple(element, s));
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList(this);
    this.listeners = {};
    this._text = '';
    this._html = null;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.placeholder = '';
  }

  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = String(value); }
  get className() { return this.classList.toString(); }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this._html = null;
    this._text = value === null || value === undefined ? '' : String(value);
  }

  get innerHTML() {
    if (this._html !== null && this.children.length === 0) return this._html;
    return this._text + this.children.map((c) => (c.outerHTML || c.textContent)).join('');
  }
  set innerHTML(value) {
    this.textContent = '';
    this._html = String(value);
    this._text = this._html.replace(/<[^>]*>/g, '');
  }

  get outerHTML() {
    return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  get firstChild() { return this.children[0] || null; }

  /** Whether it's in its document's tree */
  get isConnected() {
    const root = this.ownerDocument && this.ownerDocument.documentElement;
    for (let node = this; node; node = node.parentNode) {
      if (node === root) return true;
    }
    return false;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = reference ? this.children.indexOf(reference) : -1;
    child.parentNode = this;
    if (index === -1) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  after(node) {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this.parentNode;
    siblings.splice(index + 1, 0, node);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key in this.dataset) return this.dataset[key];
    }
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }

  /**
   * Dispatch an event to this element and then its ancestors.
   * @param {Object} event - plain object with at least `type`
   */
  dispatchEvent(event) {
    const evt = event;
    if (!evt.target) evt.target = this;
    if (!evt.preventDefault) evt.preventDefault = () => { evt.defaultPrevented = true; };
    if (!evt.stopPropagation) evt.stopPropagation = () => { evt.propagationStopped = true; };
    let node = this;
    while (node) {
      evt.currentTarget = node;
      for (const fn of (node.listeners[evt.type] || []).slice()) fn.call(node, evt);
      if (evt.propagationStopped) break;
      node = node.parentNode;
    }
    return !evt.defaultPrevented;
  }

  click() { this.dispatchEvent({ type: 'click' }); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() {}

  matches(selector) { return matches(this, selector); }

  /** Whether `node` is this element or inside it */
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector) {
    let node = this;
    while (node && node.tagName) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.head = this.documentElement.appendChild(new FakeElement('head', this));
    this.body = this.documentElement.appendChild(new FakeElement('body', this));
    this.activeElement = this.body;
    this.visibilityState = 'visible';
    this.listeners = {};
    /** Window-like target for `pagehide`; set by createLegacyEnv. */
    this.defaultView = null;
  }

  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(text) {
    const node = new FakeElement('#text', this);
    node.textContent = text;
    return node;
  }
  getElementById(id) {
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.documentElement);
  }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  /** No text selection in this fake */
  getSelection() { return null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  /** Fire a document-level event such as DOMContentLoaded or visibilitychange; returns listener results. */
  fire(type, event = {}) {
    return (this.listeners[type] || []).slice().map((fn) => fn({ type, ...event }));
  }

  /**
   * Add elements by id under body, e.g. stub(['app', 'page-list']).
   * @param {Array<string|{id: string, tag?: string}>} specs
   * @returns {Object<string, FakeElement>}
   */
  stub(specs) {
    const made = {};
    for (const spec of specs) {
      const { id, tag = 'div' } = typeof spec === 'string' ? { id: spec } : spec;
      const element = this.createElement(tag);
      element.id = id;
      this.body.appendChild(element);
      made[id] = element;
    }
    return made;
  }
}

class FakeWindowTarget {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  fire(type, event = {}) {
    return (this.listeners[type] || []).slice().map((fn) => fn({ type, ...event }));
  }
}

// ─── navigator.locks stub ───

/**
 * Exclusive Web Locks, granted per name in request order. Share one between
 * environments to model pages of the same origin.
 */
function createLockManager() {
  const tails = new Map();
  return {
    request(name, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      const held = (tails.get(name) || Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
      tails.set(name, held.catch(() => {}));
      return held;
    },
  };
}

// ─── BroadcastChannel stub ───

/**
 * BroadcastChannel between pages. Share one bus between environments to model
 * extension pages of the same origin. A message reaches every other open
 * channel of the same name on a later turn, never the one that sent it.
 */
function createChannelBus() {
  /** @type {Map<string, Set<any>>} */
  const open = new Map();
  const sent = [];
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = String(name);
      this.onmessage = null;
      this.closed = false;
      if (!open.has(this.name)) open.set(this.name, new Set());
      open.get(this.name).add(this);
    }

    postMessage(data) {
      if (this.closed) throw new Error('InvalidStateError: the channel is closed');
      const message = structuredClone(data);
      sent.push({ name: this.name, data: message });
      for (const other of open.get(this.name)) {
        if (other === this) continue;
        setImmediate(() => {
          if (!other.closed && other.onmessage) other.onmessage({ data: structuredClone(message) });
        });
      }
    }

    close() {
      this.closed = true;
      open.get(this.name).delete(this);
    }
  }
  return { BroadcastChannel: FakeBroadcastChannel, sent };
}

// ─── chrome.* stub ───

function createEventStub() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
  };
}

function createChromeStub() {
  /** @type {Object<string, any>} */
  const local = {};
  const calls = [];
  const notifications = [];
  const tabsCreated = [];
  const setFailures = [];
  const getFailures = [];
  const later = (fn) => setImmediate(fn);
  const toJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const runtime = {
    lastError: undefined,
    id: 'test-extension',
    getURL: (p) => `chrome-extension://test-extension/${p}`,
    sendMessage() { return Promise.resolve(); },
    getContexts: async () => [],
    onMessage: createEventStub(),
    onInstalled: createEventStub(),
    onStartup: createEventStub(),
    onConnect: createEventStub(),
  };

  const withLastError = (error, fn) => {
    runtime.lastError = error ? { message: error.message || String(error) } : undefined;
    try { fn(); } finally { runtime.lastError = undefined; }
  };

  const storageLocal = {
    get(keys, callback) {
      const failure = getFailures.shift();
      calls.push({ method: 'get', keys, failed: Boolean(failure) });
      if (failure) {
        // As Chrome does, the callback gets no result when the read fails
        if (callback) { later(() => withLastError(failure, () => callback())); return undefined; }
        return Promise.reject(failure);
      }
      let result = {};
      if (keys === null || keys === undefined) {
        result = toJson(local);
      } else if (typeof keys === 'string') {
        if (keys in local) result[keys] = toJson(local[keys]);
      } else if (Array.isArray(keys)) {
        keys.forEach((k) => { if (k in local) result[k] = toJson(local[k]); });
      } else {
        Object.keys(keys).forEach((k) => { result[k] = k in local ? toJson(local[k]) : keys[k]; });
      }
      if (callback) { later(() => withLastError(null, () => callback(result))); return undefined; }
      return Promise.resolve(result);
    },
    set(items, callback) {
      const failure = setFailures.shift();
      calls.push({ method: 'set', keys: Object.keys(items), failed: Boolean(failure) });
      if (!failure) Object.keys(items).forEach((k) => { local[k] = toJson(items[k]); });
      if (callback) { later(() => withLastError(failure, () => callback())); return undefined; }
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      calls.push({ method: 'remove', keys: list });
      list.forEach((k) => { delete local[k]; });
      if (callback) { later(() => withLastError(null, () => callback())); return undefined; }
      return Promise.resolve();
    },
  };

  const api = {
    runtime,
    storage: { local: storageLocal, onChanged: createEventStub() },
    notifications: {
      create(idOrOptions, maybeOptions, callback) {
        const options = typeof idOrOptions === 'string' ? maybeOptions : idOrOptions;
        notifications.push(toJson(options));
        const cb = typeof maybeOptions === 'function' ? maybeOptions : callback;
        if (cb) later(() => cb('notification-id'));
        return Promise.resolve('notification-id');
      },
    },
    tabs: {
      create(options) { tabsCreated.push(toJson(options)); return Promise.resolve({ id: 1, ...options }); },
      query: async () => [{ id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' }],
    },
    contextMenus: { create() {}, onClicked: createEventStub() },
    commands: { onCommand: createEventStub() },
    action: { onClicked: createEventStub() },
    sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
    offscreen: { createDocument: async () => {} },
  };

  return {
    api,
    local,
    calls,
    notifications,
    tabsCreated,
    /** Make the next chrome.storage.local.set fail with `error` (via runtime.lastError). */
    failNextSet(error = new Error('QUOTA_BYTES quota exceeded')) { setFailures.push(error); },
    /** Make the next chrome.storage.local.get fail with `error` (via runtime.lastError). */
    failNextGet(error = new Error('IO error: storage read failed')) { getFailures.push(error); },
    /** set and remove calls, which are the writes. */
    writes() { return calls.filter((c) => c.method === 'set' || c.method === 'remove'); },
  };
}

// ─── Environment ───

/**
 * @param {Object} [options]
 * @param {'page'|'worker'} [options.context='page'] - page: window, self, document. worker: self and importScripts only.
 * @param {IDBFactory} [options.indexedDB] - share a factory between environments (for example a page and the worker)
 * @param {FakeDocument|null} [options.document] - page contexts get a FakeDocument unless null is passed
 * @param {ReturnType<typeof createChromeStub>} [options.chrome] - share chrome.* (and chrome.storage.local) with another environment
 * @param {ReturnType<typeof createLockManager>|null} [options.locks] - share navigator.locks with another
 *   environment, or pass null for a context without it
 * @param {ReturnType<typeof createChannelBus>} [options.channels] - share BroadcastChannel with another
 *   environment, as two new tabs do
 */
function createLegacyEnv(options = {}) {
  const kind = options.context || 'page';
  const indexedDB = options.indexedDB || new IDBFactory();
  const clock = new FakeClock();
  const frames = [];
  const chrome = options.chrome || createChromeStub();
  const locks = options.locks === null ? undefined : (options.locks || createLockManager());
  const channels = options.channels || createChannelBus();
  const logs = [];
  const record = (level) => (...args) => { logs.push({ level, args }); };
  const quietConsole = {
    log: record('log'), info: record('info'), debug: record('debug'), warn: record('warn'), error: record('error'),
  };

  const sandbox = {
    console: quietConsole,
    indexedDB,
    IDBKeyRange,
    Blob,
    FileReader: FakeFileReader,
    structuredClone,
    DOMException,
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    chrome: chrome.api,
    BroadcastChannel: channels.BroadcastChannel,
    navigator: { maxTouchPoints: 0, userAgent: 'node-test', locks },
    location: { reload() { sandbox.__reloads = (sandbox.__reloads || 0) + 1; } },
  };

  let document = null;
  let windowTarget = null;
  if (kind === 'page' && options.document !== null) {
    document = options.document || new FakeDocument();
    windowTarget = new FakeWindowTarget();
    // As in a page, window.requestAnimationFrame is the global one.
    windowTarget.requestAnimationFrame = sandbox.requestAnimationFrame;
    document.defaultView = windowTarget;
    sandbox.document = document;
  }

  const context = vm.createContext(sandbox);
  vm.runInContext(kind === 'page' ? 'var window = this; var self = this;' : 'var self = this;', context);
  if (windowTarget) {
    // pagehide and other window listeners go to windowTarget so tests can fire them.
    sandbox.addEventListener = (type, fn) => windowTarget.addEventListener(type, fn);
    sandbox.removeEventListener = (type, fn) => windowTarget.removeEventListener(type, fn);
  }

  const loaded = [];
  const load = (...files) => {
    for (const file of files) {
      const full = path.join(ROOT, file);
      vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
      loaded.push(file);
    }
  };
  if (kind === 'worker') {
    // Service worker scripts live in js/ and call importScripts with names relative to it.
    sandbox.importScripts = (...names) => {
      sandbox.__imported = (sandbox.__imported || []).concat(names);
      load(...names.map((n) => path.join('js', n)));
    };
  }

  return {
    kind,
    context,
    global: sandbox,
    document,
    window: windowTarget,
    indexedDB,
    clock,
    chrome,
    channels,
    logs,
    loaded,
    load,
    /** Evaluate an expression in the context, e.g. get('Storage'). */
    get(expression) { return vm.runInContext(expression, context); },
    /** Run queued requestAnimationFrame callbacks. */
    frames() {
      const batch = frames.splice(0, frames.length);
      batch.forEach((fn) => fn(clock.now));
      return batch.length;
    },
    pendingFrames() { return frames.length; },
    warnings() { return logs.filter((l) => l.level === 'warn' || l.level === 'error'); },
  };
}

// ─── Database fixtures ───

/** The ten stores of the 1.4.0 schema (version 8), as storage.js creates them. */
const SCHEMA_V8 = {
  canvases: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] },
  elements: { keyPath: 'id', indexes: [['canvasId', 'canvasId'], ['type', 'type']] },
  settings: { keyPath: 'key', indexes: [] },
  media: { keyPath: 'id', indexes: [['canvasId', 'canvasId']] },
  search_index: { keyPath: 'noteId', indexes: [] },
  folders: { keyPath: 'id', indexes: [['parentId', 'parentId'], ['name', 'name']] },
  links: { keyPath: 'id', indexes: [['fromNoteId', 'fromNoteId'], ['toNoteId', 'toNoteId']] },
  themes: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] },
  vectors: { keyPath: 'id', indexes: [] },
  snapshots: { keyPath: 'id', indexes: [['noteId', 'noteId'], ['timestamp', 'timestamp']] },
};

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Create a database with raw indexedDB.open calls.
 * @param {IDBFactory} factory
 * @param {Object} spec
 * @param {number} [spec.version=8]
 * @param {string[]} [spec.omit=[]] - v8 stores to leave out
 * @param {Object<string, {keyPath?: string|null, indexes?: Array}>} [spec.extraStores={}] - e.g. a v9 `meta` store
 * @param {Object<string, Array<Object|{key: any, value: any}>>} [spec.records={}] - rows per store; out-of-line stores take {key, value}
 */
async function createDatabase(factory, spec = {}) {
  const version = spec.version || 8;
  const omit = new Set(spec.omit || []);
  const stores = {};
  for (const [name, def] of Object.entries(SCHEMA_V8)) if (!omit.has(name)) stores[name] = def;
  Object.assign(stores, spec.extraStores || {});

  const request = factory.open(spec.name || DB_NAME, version);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const [name, def] of Object.entries(stores)) {
      const store = db.createObjectStore(name, def.keyPath === null ? {} : { keyPath: def.keyPath || 'id' });
      for (const [indexName, keyPath] of def.indexes || []) store.createIndex(indexName, keyPath, { unique: false });
    }
  };
  const db = await requestToPromise(request);
  const records = spec.records || {};
  const names = Object.keys(records).filter((n) => records[n].length > 0);
  if (names.length > 0) {
    const tx = db.transaction(names, 'readwrite');
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const row of records[name]) {
        if (store.keyPath === null) store.put(row.value, row.key); else store.put(row);
      }
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  db.close();
}

async function encodeValue(value) {
  if (value instanceof Blob) {
    return { __blob: Buffer.from(await value.arrayBuffer()).toString('base64'), type: value.type };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeValue));
  if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = await encodeValue(value[key]);
    return out;
  }
  return value;
}

/**
 * Read every store (schema, keys, values) through an unversioned open.
 * Blobs become {__blob, type} so two dumps can be compared with deepStrictEqual.
 * @returns {Promise<{version: number, stores: Object}>}
 */
async function dumpDatabase(factory, name = DB_NAME) {
  const db = await requestToPromise(factory.open(name));
  try {
    const stores = {};
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const indexes = Array.from(store.indexNames).map((n) => {
        const index = store.index(n);
        return { name: n, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      });
      const [keys, values] = await Promise.all([
        requestToPromise(store.getAllKeys()),
        requestToPromise(store.getAll()),
      ]);
      stores[storeName] = {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
        records: await Promise.all(keys.map(async (key, i) => ({ key, value: await encodeValue(values[i]) }))),
      };
    }
    return { version: db.version, stores };
  } finally {
    db.close();
  }
}

/** Records of one store from a dump, keyed by primary key. */
function recordsOf(dump, storeName) {
  const store = dump.stores[storeName];
  return store ? Object.fromEntries(store.records.map((r) => [String(r.key), r.value])) : {};
}

/** Let fake-indexeddb and the chrome stub run queued work. */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Poll `predicate` until it returns something truthy, letting queued work run in between; returns that value. */
async function waitFor(predicate, { rounds = 500, message = 'condition' } = {}) {
  for (let i = 0; i < rounds; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/**
 * Copy a value out of the vm context into this realm, so strict deep equality
 * doesn't trip over the context's own Object and Array prototypes.
 */
function plain(value) {
  return structuredClone(value);
}

/** A 1.4.0-shaped note record. */
function note(id, fields = {}) {
  return {
    id,
    name: `Note ${id}`,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archived: false,
    archivedAt: null,
    titleManuallySet: false,
    preview: '',
    pinned: false,
    todoProgress: null,
    isDaily: false,
    dateStr: null,
    isTemplate: false,
    folderId: null,
    ...fields,
  };
}

/** A 1.4.0-shaped block (element) record. */
function block(id, canvasId, order, content = `Block ${id}`, fields = {}) {
  return {
    id,
    type: 'text',
    content,
    indentLevel: 0,
    checked: false,
    imageUrl: null,
    calloutIcon: '💡',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    canvasId,
    order,
    ...fields,
  };
}

// ─── The new tab's note workspace, without App ───

/**
 * A navigation port that asks nothing of a page, as an editor with none around it gets. Each
 * call is recorded in `calls`, as [method, ...args].
 * @returns {Object}
 */
function quietNavigation() {
  const calls = [];
  const record = (method) => (...args) => { calls.push([method, ...args]); };
  return {
    calls,
    titleChanged: record('titleChanged'),
    noteSaved: record('noteSaved'),
    openNote: record('openNote'),
    openNoteByName: record('openNoteByName'),
    noteReplaced: async (...args) => { calls.push(['noteReplaced', ...args]); },
    reloadPage: record('reloadPage'),
  };
}

/**
 * The page's document client as its editors get it: each call goes to `client`, and what a
 * read answers is copied into this realm, as fake-indexeddb's answers to Storage always were,
 * so a test compares it with its own arrays. Its methods can be replaced, so a test can make
 * a save fail the way a full disk does.
 * @param {Object} client - js/kernel/composition/document.js's, made in the page
 * @returns {Object}
 */
function testDocumentClient(client) {
  const copied = (read) => async (...args) => plain(await read(...args));
  return {
    openNote: copied(client.openNote),
    readNote: copied(client.readNote),
    backlinks: copied(client.backlinks),
    noteNames: copied(client.noteNames),
    templates: copied(client.templates),
    blocksOf: copied(client.blocksOf),
    saveContent: (save) => client.saveContent(save),
    deleteBlocks: (noteId, blockIds) => client.deleteBlocks(noteId, blockIds),
    createNote: (fields) => client.createNote(fields),
    newId: () => client.newId(),
    beforeConnectionCloses: (flush) => client.beforeConnectionCloses(flush),
    connectionOpen: () => client.connectionOpen(),
  };
}

/**
 * Make the document client the page's editors read and write through
 * (test/helpers/editor-client.mjs): a new tab's kernel over the page's Storage, which has
 * to have started. Each editor makeEditor makes for the page gets it. It takes
 * test/helpers/page-module.js, so node runs with --experimental-vm-modules (npm test
 * passes it).
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @returns {Promise<Object>} the client
 */
async function startEditorClient(env) {
  const { loadPageModule } = require('./page-module');
  const { editorClientFor } = await loadPageModule(env, 'test/helpers/editor-client.mjs');
  env.documentClient = testDocumentClient(
    editorClientFor({ storage: env.get('Storage'), settings: env.chrome.api.storage.local }),
  );
  return env.documentClient;
}

/**
 * Start the page's kernel the way the new tab's root does (js/kernel/composition/newtab.js):
 * it opens Storage itself, versioned and watching its connection, and runs startup
 * maintenance. Its document client becomes the one makeEditor gives editors. Storage must not
 * have started.
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @returns {Promise<Object>} the document client, once the kernel is ready
 */
async function startNewTabKernel(env) {
  const { loadPageModule } = require('./page-module');
  const root = await loadPageModule(env, 'js/kernel/composition/newtab.js');
  const host = { storage: env.get('Storage'), settings: env.chrome.api.storage.local };
  const kernel = root.createNewTabClient(host);
  const failure = await kernel.whenReady();
  if (failure) throw new Error(`the new tab's kernel didn't start: ${failure.code}`);
  env.documentClient = testDocumentClient(root.createNewTabDocumentClient(kernel, host));
  return env.documentClient;
}

/**
 * A BlockEditor without its DOM constructor: real persistence through the page's document
 * client (startEditorClient), render methods stubbed. Its root is a pane (`.editor-pane`,
 * active unless `root` is given) holding the writing column (`.editor`) with the title and
 * the blocks container, where the editor puts its own notices.
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @param {FakeDocument} [doc] - Its own document, as the PiP window has
 * @param {{root?: FakeElement|null, navigation?: Object, documentClient?: Object}} [options] - The
 *   pane element to use, as App passes #editor-container, the navigation port,
 *   quietNavigation() unless given, and the document client, the page's unless given
 */
function makeEditor(env, doc = env.document, {
  root: pane = null,
  navigation = quietNavigation(),
  documentClient = env.documentClient,
} = {}) {
  if (!documentClient) throw new Error('makeEditor: await startEditorClient(env) first, once Storage has started');
  const BlockEditor = env.get('BlockEditor');
  const editor = Object.create(BlockEditor.prototype);
  const root = pane || doc.createElement('div');
  if (!pane) root.className = 'editor-pane active';
  const column = root.appendChild(doc.createElement('div'));
  column.className = 'editor';
  const titleEl = column.appendChild(doc.createElement('div'));
  titleEl.className = 'page-title';
  const container = column.appendChild(doc.createElement('div'));
  container.className = 'blocks-container';
  Object.assign(editor, {
    root,
    doc,
    navigation,
    documentClient,
    noteId: null,
    noteData: null,
    blocks: [],
    titleEl,
    container,
    insightsPollingId: null,
    undoStack: [],
    redoStack: [],
    _contentUndoPending: {},
    selectedBlockIds: new Set(),
    _snapshotDirty: false,
    _snapshotInterval: null,
    hasReceivedFirstContent: false,
    pendingAutoTitle: false,
  });
  editor._initPersistenceState();
  editor._bindLifecycleFlush();
  const noop = () => {};
  Object.assign(editor, {
    renderBlocks: noop,
    renderBacklinks: noop,
    updateTimestampDisplay: noop,
    updateSaveStatus: noop,
    clearBlockSelection: noop,
    placeCaretAtEnd: noop,
    renderInsights: async () => {},
    startInsightsPollingIfNeeded: async () => {},
    stripHtmlTags: (html) => String(html || '').replace(/<[^>]*>/g, ''),
  });
  return editor;
}

/** Keep animation frames flowing until `promise` settles, as a visible page does. */
async function runUntil(env, promise) {
  let finished = false;
  const tracked = Promise.resolve(promise).finally(() => { finished = true; });
  for (let i = 0; i < 400 && !finished; i++) {
    env.frames();
    await settle(2);
  }
  return tracked;
}

/** What App loads for the note workspace, in its order. */
const NEW_TAB_FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/ui/confirm-dialog.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/controllers/tab-controller.js',
  'js/controllers/notes-manager.js',
  'js/controllers/sidebar-controller.js',
  'js/controllers/settings-controller.js',
];

/**
 * A new tab's note workspace without App: Storage started, the elements the tab
 * bar and split view touch, and a TabController with both panes, wired the way
 * App wires it. `page.notes` stands in for App's list of active notes, which
 * onRefreshNotesList refreshes. `wire(controller)` gives a controller that takes
 * notes out of the active set App's hooks for it. With `ready: false` the tab
 * is still starting up: other tabs' messages refresh nothing until `tabs.workspaceReady()`.
 * `page.refreshes` counts the refreshes, and `page.listsOnly` the ones that asked for lists only.
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @param {{files?: Array<string>, ready?: boolean}} [options]
 */
async function bootNewTab(env, { files = NEW_TAB_FILES, ready = true } = {}) {
  env.load(...files);
  const Storage = env.get('Storage');
  await Storage.init();
  await startEditorClient(env);
  const panes = env.document.stub([
    'note-tabs', 'workspace-container', 'editor-container', 'secondary-editor-container', 'split-view-toggle',
    'settings-modal', 'sidebar-trash-actions',
  ]);
  // The two panes as newtab.html has them, which the editors use as their roots
  panes['editor-container'].className = 'editor-pane active';
  panes['secondary-editor-container'].className = 'editor-pane secondary hidden';
  const TabController = env.get('TabController');
  const tabs = new TabController({ storage: Storage, eventBus: null, domRefs: null, logger: null });
  // As App's port, the tab of a note saved as a new one follows it
  const navigation = () => ({
    ...quietNavigation(),
    noteReplaced: (editor, goneId, note) => tabs.noteReplaced(editor, goneId, note),
  });
  tabs.editor = makeEditor(env, env.document, { root: panes['editor-container'], navigation: navigation() });
  tabs.secondaryEditor = makeEditor(env, env.document, {
    root: panes['secondary-editor-container'],
    navigation: navigation(),
  });
  const page = { notes: await Storage.getAllNotes(), refreshes: 0, listsOnly: 0 };
  tabs.onGetNotes = () => page.notes;
  tabs.onCreateNote = () => Storage.createNote('Untitled');
  tabs.onRefreshNotesList = async ({ listsOnly = false } = {}) => {
    page.notes = await Storage.getAllNotes();
    page.refreshes += 1;
    if (listsOnly) page.listsOnly += 1;
  };
  tabs.onRenderNotesList = async () => {};
  tabs.onUpdateEmptyState = () => {};
  await tabs.init();
  if (ready) tabs.workspaceReady();
  const wire = (controller) => Object.assign(controller, {
    onNotesLeaving: (ids) => tabs.forgetNotes(ids),
    onNotesLeft: (ids) => tabs.announceNotesLeft(ids),
    onRefreshNotesList: tabs.onRefreshNotesList,
    onUpdateEmptyState: () => {},
    onOpenNoteInNewTab: (noteId) => tabs.openNoteInNewTab(noteId),
    onOpenImportedNote: (noteId) => tabs.openImportedNote(noteId),
    getEditor: () => tabs.getEditor(),
  });
  return { Storage, tabs, page, wire };
}

/** The tab names the tab bar shows, in order. */
function shownTabs(env) {
  const bar = env.document.getElementById('note-tabs');
  return bar ? bar.querySelectorAll('.note-tab-name').map((name) => name.textContent) : [];
}

module.exports = {
  DB_NAME,
  SCHEMA_V8,
  NEW_TAB_FILES,
  FakeClock,
  FakeDocument,
  FakeElement,
  createLegacyEnv,
  createChromeStub,
  createLockManager,
  createChannelBus,
  makeEditor,
  startEditorClient,
  startNewTabKernel,
  quietNavigation,
  runUntil,
  bootNewTab,
  shownTabs,
  createDatabase,
  dumpDatabase,
  recordsOf,
  requestToPromise,
  settle,
  waitFor,
  plain,
  note,
  block,
};
