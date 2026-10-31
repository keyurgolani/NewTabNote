'use strict';

/**
 * Finds every network call in first-party code (#21 slice 1b, the credentialed-call ledger):
 * `fetch(...)`, `new XMLHttpRequest()`, `new WebSocket(...)`, `new EventSource(...)`, and
 * `navigator.sendBeacon(...)`, each with the function it's in, read from the syntax tree, so a
 * comment or a string never counts. js/lib/ is vendored, and the guard covers it.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const CONSTRUCTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource']);
const GLOBALS = new Set(['globalThis', 'window', 'self']);

/**
 * The name of the function `node` is in: a method, a function, or the binding an arrow or
 * function expression is given; `(top level)` outside any
 * @param {ts.Node} node
 * @returns {string}
 */
function enclosingName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isGetAccessor(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      const owner = current.parent;
      if ((ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) && owner.name) {
        return owner.name.getText();
      }
    }
  }
  return '(top level)';
}

/**
 * What network API `node` calls, or null
 * @param {ts.Node} node
 * @returns {string | null}
 */
function apiOf(node) {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'fetch') return 'fetch';
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      const target = callee.expression;
      if (name === 'fetch' && ts.isIdentifier(target) && GLOBALS.has(target.text)) return 'fetch';
      if (name === 'sendBeacon') return 'sendBeacon';
    }
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CONSTRUCTORS.has(node.expression.text)) {
    return node.expression.text;
  }
  return null;
}

/**
 * The network calls in `source`, as `{api, function, line}`
 * @param {string} source
 * @param {string} [fileName]
 * @returns {Array<{api: string, function: string, line: number}>}
 */
function scanSource(source, fileName = 'source.js') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {Array<{api: string, function: string, line: number}>} */
  const found = [];
  const visit = (/** @type {ts.Node} */ node) => {
    const api = apiOf(node);
    if (api) found.push({ api, function: enclosingName(node), line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every first-party script under js/, js/lib/ left out
 * @returns {string[]} paths from the repo root
 */
function firstPartyFiles() {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (file !== 'js/lib') walk(file);
      } else if (/\.m?js$/.test(entry.name)) {
        files.push(file);
      }
    }
  };
  walk('js');
  return files.sort();
}

/**
 * Every network call in first-party code, counted per file and function. `texts` stands in for
 * files' contents, for a test that edits one.
 * @param {{texts?: Record<string, string>}} [options]
 * @returns {Map<string, {file: string, function: string, count: number, apis: string[], lines: number[]}>}
 */
function networkCalls({ texts = {} } = {}) {
  const calls = new Map();
  for (const file of firstPartyFiles()) {
    const text = Object.hasOwn(texts, file) ? texts[file] : fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const site of scanSource(text, file)) {
      const key = `${file}#${site.function}`;
      const entry = calls.get(key) || { file, function: site.function, count: 0, apis: [], lines: [] };
      entry.count += 1;
      if (!entry.apis.includes(site.api)) entry.apis.push(site.api);
      entry.lines.push(site.line);
      calls.set(key, entry);
    }
  }
  return calls;
}


/** Registry rows by the provider name js/llm.js's functions carry */
const PROVIDER_ROWS = Object.freeze({
  openai: ['openai'],
  anthropic: ['anthropic'],
  gemini: ['gemini'],
  openrouter: ['openrouter'],
  xai: ['xai'],
  deepseek: ['deepseek'],
  mistral: ['mistral'],
  groq: ['groq'],
  qwen: ['qwen-intl', 'qwen-china'],
  glm: ['glm-general', 'glm-coding', 'glm-china'],
  kimi: ['kimi-intl', 'kimi-china'],
  minimax: ['minimax-intl', 'minimax-china'],
  ollama: ['ollama-localhost', 'ollama-127'],
});
const PROVIDER_NAME = /(OpenAI|Anthropic|Gemini|OpenRouter|XAI|Deepseek|Mistral|Groq|Qwen|GLM|Kimi|MiniMax|Ollama)/;

/** A property's name, unquoted */
const propertyName = (/** @type {ts.PropertyName} */ name) => name.getText().replace(/^['"`]|['"`]$/g, '');

/**
 * The header names an object literal sets, lowercased, following a spread of a local object
 * @param {ts.ObjectLiteralExpression} literal
 * @param {(name: string) => ts.ObjectLiteralExpression | null} local
 * @returns {Set<string>}
 */
function headerNames(literal, local) {
  const names = new Set();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) names.add(propertyName(property.name).toLowerCase());
    else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      const spread = local(property.expression.text);
      if (spread) headerNames(spread, local).forEach((name) => names.add(name));
    }
  }
  return names;
}

/**
 * The object literal the local `name` is initialised to in `scope`, or null
 * @param {ts.Node} scope
 * @param {string} name
 * @returns {ts.ObjectLiteralExpression | null}
 */
function localObject(scope, name) {
  let found = null;
  const visit = (/** @type {ts.Node} */ node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/**
 * The headers js/llm.js sends each registry row, lowercased, read from the syntax tree: each
 * fetch and fetchViaBackground call's `headers` object (or the local it names), under the
 * provider its function's name carries, and _getOpenAICompatibleConfig's per provider for the
 * OpenAI-compatible stream. fetchViaBackground's own fallback sends its caller's.
 * @returns {Map<string, Set<string>>}
 */
function sentHeaders() {
  const file = ts.createSourceFile('llm.js', fs.readFileSync(path.join(ROOT, 'js/llm.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {Map<string, Set<string>>} */
  const sent = new Map();
  const add = (/** @type {string[]} */ rows, /** @type {Set<string>} */ names) => {
    for (const row of rows) {
      const set = sent.get(row) || new Set();
      names.forEach((name) => set.add(name));
      sent.set(row, set);
    }
  };
  /** @type {ts.MethodDeclaration | null} */
  let compatible = null;
  const methods = [];
  const visit = (/** @type {ts.Node} */ node) => {
    if (ts.isMethodDeclaration(node) && node.name) {
      if (node.name.getText() === '_getOpenAICompatibleConfig') compatible = node;
      methods.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const method of methods) {
    const name = method.name.getText();
    if (name === 'fetchViaBackground' || name === '_getOpenAICompatibleConfig') continue;
    const calls = [];
    const find = (/** @type {ts.Node} */ node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isFetch = ts.isIdentifier(callee) && callee.text === 'fetch';
        const isProxy = ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetchViaBackground';
        if ((isFetch || isProxy) && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) calls.push(node.arguments[1]);
      }
      ts.forEachChild(node, find);
    };
    find(method);
    if (calls.length === 0) continue;
    if (name === '_streamOpenAICompatible') {
      // Its headers are the config's, per provider
      if (!compatible) continue;
      const base = localObject(compatible, 'headers');
      const local = (/** @type {string} */ id) => (id === 'headers' ? base : localObject(/** @type {ts.Node} */ (compatible), id));
      const baseNames = base ? headerNames(base, local) : new Set();
      const cases = [];
      const collect = (/** @type {ts.Node} */ node) => {
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) cases.push(node);
        ts.forEachChild(node, collect);
      };
      collect(compatible);
      for (const clause of cases) {
        const provider = /** @type {ts.StringLiteral} */ (clause.expression).text;
        const names = new Set(baseNames);
        const inner = (/** @type {ts.Node} */ node) => {
          if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'headers' && ts.isObjectLiteralExpression(node.initializer)) {
            headerNames(node.initializer, local).forEach((header) => names.add(header));
          }
          ts.forEachChild(node, inner);
        };
        clause.statements.forEach(inner);
        add(PROVIDER_ROWS[provider] || [], names);
      }
      continue;
    }
    const match = PROVIDER_NAME.exec(name);
    if (!match) continue;
    const rows = PROVIDER_ROWS[match[1].toLowerCase()] || [];
    for (const init of calls) {
      for (const property of init.properties) {
        const key = ts.isShorthandPropertyAssignment(property) ? property.name.text : (ts.isPropertyAssignment(property) ? propertyName(property.name) : null);
        if (key !== 'headers') continue;
        const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        const literal = ts.isObjectLiteralExpression(value) ? value : (ts.isIdentifier(value) ? localObject(method, value.text) : null);
        if (literal) add(rows, headerNames(literal, (id) => localObject(method, id)));
      }
    }
  }
  return sent;
}

/**
 * What the ledger gets wrong about `found`: a call no row covers, a count that changed, and a
 * row whose call is gone
 * @param {ReturnType<typeof networkCalls>} found
 * @param {{calls: Array<{file: string, function: string, count: number}>}} ledger
 * @returns {string[]}
 */
function ledgerProblems(found, ledger) {
  /** @type {string[]} */
  const problems = [];
  for (const [key, call] of found) {
    const row = ledger.calls.find((entry) => entry.file === call.file && entry.function === call.function);
    if (!row) problems.push(`${key}: ${call.count} network calls no ledger row covers (lines ${call.lines.join(', ')})`);
    else if (row.count !== call.count) problems.push(`${key}: ${call.count} calls, the ledger says ${row.count}`);
  }
  for (const entry of ledger.calls) {
    if (!found.has(`${entry.file}#${entry.function}`)) problems.push(`${entry.file}#${entry.function}: a ledger row whose call is gone`);
  }
  return problems;
}

module.exports = { networkCalls, scanSource, firstPartyFiles, sentHeaders, ledgerProblems };
