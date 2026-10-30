/**
 * ESLint config: the kernel boundary rules (#12, docs/adr/0001-kernel-stack.md, decision 3).
 * `npm run check:boundaries` runs them over js/ and compares each file's hits per rule with
 * docs/architecture/kernel-ledger.json; #12's "Boundaries and the ledger" has the rules.
 * #29 (PR CI) adds the rest of the lint config and leaves these to check:boundaries.
 *
 * Every message starts with the ledger rule it counts under, in brackets. no-undef's can't
 * carry one, and check:boundaries counts it as registry-global in js/kernel/registry/ and as
 * core-global everywhere else.
 */

import fs from 'node:fs';
import path from 'node:path';

// Real paths on both sides, since ESLint may name files through a symlinked directory
const realDir = dir => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};
const ROOT = realDir(import.meta.dirname);

// Parsed as classic scripts, the way they load: offscreen.html's and sidepanel.html's
// <script src> without type="module", and the search indexer's new Worker()
const CLASSIC_SCRIPTS = ['js/offscreen.js', 'js/insights-summary.js', 'js/workers/indexer.js'];

// The controllers App wires up, whose on* and get* callbacks count under app-callback
const CONTROLLERS = [
  'sidebarController',
  'tabController',
  'aiChatController',
  'settingsController',
  'themeBuilderController',
  'analyticsController',
  'notesManager',
  'shortcutsManager',
  'exportImportService',
];

/** A MemberExpression selector for `.property` or `['property']` on objects matching `object` */
const member = (object, property) =>
  `MemberExpression${object}:matches([computed=false][property.name='${property}'], [computed=true][property.value='${property}'])`;

// Free identifiers (and window., self., or globalThis. reads of them) outside js/kernel/
const LEGACY_GLOBALS = [
  { name: 'indexedDB', message: '[indexedDB] Only js/kernel/ and js/storage.js open IndexedDB; use a kernel command or query.' },
  { name: 'Storage', message: '[Storage] Only js/kernel/ and js/storage.js use the Storage global; use a kernel command or query.' },
  { name: 'app', message: '[window.app] Take what you need from your composition root, not from the global App.' },
  { name: 'opener', message: "[window.opener] Reach the opener's App or LLM through an injected port." },
  { name: 'LLM', message: '[LLM] AI calls go through an injected AI port, which #11 replaces.' },
  { name: 'fetch', message: '[fetch] Network calls belong in an adapter (#11 for AI providers, #19 for sync).' },
];

const LEGACY_SYNTAX = [
  {
    selector: member("[object.type='ThisExpression']", 'storage'),
    message: '[this.storage] Reach notes through a kernel client, not an injected Storage.',
  },
  {
    selector: member("[object.type='Identifier'][object.name='chrome']", 'storage'),
    message: "[chrome.storage] Settings and session state go through the kernel's settings port.",
  },
  {
    selector: member("[object.type='MemberExpression'][object.property.name='chrome'][object.object.name=/^(window|self|globalThis)$/]", 'storage'),
    message: "[chrome.storage] Settings and session state go through the kernel's settings port.",
  },
  {
    selector: "AssignmentExpression[left.property.name=/^(autoTitleIntervalId|insightsIntervalId)$/][right.type='CallExpression'][right.callee.name='setInterval']",
    message: "[scheduler-timer] A page's own auto-title or insights timer; #35 schedules these as jobs and #8 deletes them.",
  },
];

const APP_CALLBACK = {
  selector: `AssignmentExpression[operator='='][left.type='MemberExpression'][left.computed=false][left.property.name=/^(on|get)[A-Z]/][left.object.type='MemberExpression'][left.object.object.type='ThisExpression'][left.object.property.name=/^(${CONTROLLERS.join('|')})$/]`,
  message: '[app-callback] A controller callback into App; #12 replaces the domain ones with projections, and the UI-only rest go to #2 or #3.',
};

/**
 * The package root as a URL. Chrome registers chrome-extension: as a standard scheme, so its
 * URL parser reads a backslash in a path as a slash. Node's URL keeps the backslash, since
 * chrome-extension: isn't special to it, but parses https: the way Chrome parses
 * chrome-extension:.
 */
const PACKAGE = 'https://package.invalid/';

/** A specifier that names a URL of another protocol, so no file in the package */
const ELSEWHERE = Symbol('elsewhere');
/** A bare specifier, which nothing resolves without an import map, or one that doesn't parse or decode */
const UNRESOLVED = Symbol('unresolved');

/**
 * The package path an import specifier names, resolved the way Chrome resolves a module
 * specifier in an extension: one that starts with /, ./, or ../ against the importing file's
 * URL, and anything else as an absolute URL, which must be chrome-extension: to land in the
 * package. Dot segments stop at the root, any extension ID counts as this one, and the path
 * is percent-decoded once, as Chrome does before it opens the file. Repeated slashes count
 * as one, as they do when the file system opens the path.
 */
const resolveSpecifier = (specifier, fileUrl) => {
  try {
    let url;
    if (/^\.{0,2}\//.test(specifier)) {
      url = new URL(specifier, fileUrl);
    } else {
      if (new URL(specifier).protocol !== 'chrome-extension:') return ELSEWHERE;
      // Parse it again as https:, after the URL parser's own cleanup: no leading or trailing
      // C0 control or space, and no tab or newline anywhere
      const clean = specifier.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
      url = new URL(clean.replace(/^chrome-extension:/i, 'https:'));
    }
    return decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/').replace(/^\//, '');
  } catch {
    return UNRESOLVED;
  }
};

/**
 * The specifier an import's source spells out: a string literal, or a template literal with
 * no ${}. Null when it's built at run time.
 */
const specifierOf = source => {
  if (source.type === 'Literal' && typeof source.value === 'string') return source.value;
  if (source.type === 'TemplateLiteral' && source.expressions.length === 0) return source.quasis[0].value.cooked;
  return null;
};

/**
 * Imports checked against where they land: `deny` lists directories nothing may import
 * from, and `allow`, when given, the only directories imports may come from. Static
 * imports, `export ... from`, and import() count. An import() whose specifier is built at
 * run time could name anything, so it always counts, and so does a bare or malformed
 * specifier. A URL of another protocol names nothing in the package, so `deny` lets it be
 * (MV3's CSP won't load it anyway), and `allow` counts it. `deny` matches in any case,
 * since macOS and Windows open a file however its path is cased.
 */
const importsRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          rule: { type: 'string' },
          message: { type: 'string' },
          allow: { type: 'array', items: { type: 'string' } },
          deny: { type: 'array', items: { type: 'string' } },
        },
        required: ['rule', 'message'],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { rule, message, allow, deny = [] } = context.options[0];
    const inside = (file, dirs) => dirs.some(dir => file === dir.replace(/\/$/, '') || file.startsWith(dir));
    const denied = file => inside(file.toLowerCase(), deny.map(dir => dir.toLowerCase()));
    const file = path.join(realDir(path.dirname(context.filename)), path.basename(context.filename));
    const fileUrl = new URL(path.relative(ROOT, file).split(path.sep).map(encodeURIComponent).join('/'), PACKAGE);
    const check = (node, source) => {
      if (!source) return;
      const report = (why = '') => context.report({ node, message: `[${rule}] ${message}${why}` });
      const specifier = specifierOf(source);
      if (specifier === null) {
        report(" This import() builds its specifier at run time, so it can't be checked.");
        return;
      }
      const target = resolveSpecifier(specifier, fileUrl);
      if (target === UNRESOLVED) report(" This specifier is bare or malformed, so it can't be checked.");
      else if (target === ELSEWHERE) {
        if (allow) report();
      } else if (denied(target) || (allow && !inside(target, allow))) report();
    };
    return {
      ImportDeclaration: node => check(node, node.source),
      ExportNamedDeclaration: node => check(node, node.source),
      ExportAllDeclaration: node => check(node, node.source),
      ImportExpression: node => check(node, node.source),
    };
  },
};

/** Options every storage-access rule takes: its ledger rule and its message */
const ACCESS_SCHEMA = [
  {
    type: 'object',
    properties: { rule: { type: 'string' }, message: { type: 'string' } },
    required: ['rule', 'message'],
    additionalProperties: false,
  },
];

/** The name a member expression's property spells out, or null when it's built at run time */
const propertyName = member => {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null;
  return specifierOf(member.property);
};

/** The name a destructuring property's key spells out, or null when it's built at run time */
const keyName = property => {
  if (property.computed) return specifierOf(property.key);
  if (property.key.type === 'Identifier') return property.key.name;
  return property.key.type === 'Literal' ? String(property.key.value) : null;
};

/** `node` without the optional chain around it, as in `chrome?.storage` */
const unchained = node => (node && node.type === 'ChainExpression' ? node.expression : node);

/**
 * What a destructuring pattern takes apart: the right side of its declaration, assignment, or
 * default value. Null for a parameter without a default, or a pattern nested in another.
 */
const sourceOf = pattern => {
  const { parent } = pattern;
  const right =
    (parent.type === 'VariableDeclarator' && parent.id === pattern && parent.init) ||
    ((parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern') && parent.left === pattern && parent.right);
  return unchained(right || null);
};

/** The property a nested pattern is the value of, as `storage` is in `{ storage: { local } }`, or null */
const holderOf = pattern => {
  const node = pattern.parent.type === 'AssignmentPattern' && pattern.parent.left === pattern ? pattern.parent : pattern;
  return node.parent.type === 'Property' && node.parent.value === node ? node.parent : null;
};

/** Whether a destructured property's value is itself a pattern, as `{ local }` is in `{ storage: { local } }` */
const destructuresFurther = property => {
  const value = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
  return value.type === 'ObjectPattern' || value.type === 'ArrayPattern';
};

/** The name a destructured property binds, as `area` in `{ storage: area }`, or null for a pattern */
const boundName = property => {
  const value = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
  return value.type === 'Identifier' ? value : null;
};

/** The name an import or export specifier spells out: an identifier, or a string such as `'a-b'` */
const specifierName = node => (node.type === 'Identifier' ? node.name : String(node.value));

/**
 * #17's storage-access rules (#17 slice 1, "The architecture test"): any use of a function
 * named `name` but where it's defined. A call of `name(...)`, a read of `x.name` with any
 * spelling of the property, whether it's called there or bound, passed on, or called through
 * `.call` or `.apply`, `name` taken apart from an object, as in `const { name } = x`, and
 * `name` imported or re-exported under any name, as in `import { name as other }`.
 */
const accessRule = name => ({
  meta: { type: 'problem', schema: ACCESS_SCHEMA },
  create(context) {
    const { rule, message } = context.options[0];
    const report = node => context.report({ node, message: `[${rule}] ${message}` });
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === name) report(node);
      },
      MemberExpression(node) {
        // `x.name = function () {}` defines it
        const defined = node.parent.type === 'AssignmentExpression' && node.parent.left === node;
        if (!defined && propertyName(node) === name) report(node);
      },
      'ObjectPattern > Property'(node) {
        if (keyName(node) === name) report(node);
      },
      ImportSpecifier(node) {
        if (specifierName(node.imported) === name) report(node);
      },
      'ExportNamedDeclaration[source] > ExportSpecifier'(node) {
        if (specifierName(node.local) === name) report(node);
      },
    };
  },
});

/**
 * chrome.storage.local, reached through any object, any name bound to a storage or to chrome,
 * or taken apart: `chrome.storage.local`, `self.chrome.storage.local`, an alias such as
 * `this._chromeApi().storage.local`, `area.local` once `const area = chrome.storage` (or `let`,
 * or an assignment, or a chain of them), `local` taken from a storage (`const { local } =
 * chrome.storage`, `const { storage: { local } } = chrome`), and `storage` taken from chrome
 * under any name (`const { storage } = chrome`), along with `storage.local` on it. Names are
 * followed through the file's scopes once it's all read, so a use before its binding counts.
 */
const storageLocalRule = {
  meta: { type: 'problem', schema: ACCESS_SCHEMA },
  create(context) {
    const { rule, message } = context.options[0];
    const { sourceCode } = context;
    const report = node => context.report({ node, message: `[${rule}] ${message}` });
    /** Names bound to a value: `const name = value`, `let name = value`, or `name = value` */
    const bindings = [];
    /** Every property a pattern takes apart */
    const properties = [];
    /** Every `.local` read */
    const locals = [];
    /** The variables bound to a storage, and to chrome */
    const storages = new Set();
    const chromes = new Set();

    /** The variable an identifier names, or null for a global such as `chrome` */
    const variableOf = identifier => {
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const reference = scope.references.find(candidate => candidate.identifier === identifier);
        if (reference) return reference.resolved;
        const variable = scope.set.get(identifier.name);
        if (variable && variable.identifiers.includes(identifier)) return variable;
      }
      return null;
    };

    /** A `.storage` read, a name bound to one, or a value named `storage` */
    const isStorage = node => {
      const value = unchained(node);
      if (!value) return false;
      if (value.type === 'MemberExpression') return propertyName(value) === 'storage';
      return value.type === 'Identifier' && (value.name === 'storage' || storages.has(variableOf(value)));
    };

    /** `chrome`, a `.chrome` read such as `self.chrome`, or a name bound to one */
    const isChrome = node => {
      const value = unchained(node);
      if (!value) return false;
      if (value.type === 'MemberExpression') return propertyName(value) === 'chrome';
      if (value.type !== 'Identifier') return false;
      const variable = variableOf(value);
      return variable ? chromes.has(variable) : value.name === 'chrome';
    };

    return {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init) bindings.push({ identifier: node.id, value: node.init });
      },
      AssignmentExpression(node) {
        if (node.operator === '=' && node.left.type === 'Identifier') bindings.push({ identifier: node.left, value: node.right });
      },
      'ObjectPattern > Property'(node) {
        properties.push(node);
      },
      MemberExpression(node) {
        if (propertyName(node) === 'local') locals.push(node);
      },
      'Program:exit'() {
        // Which names hold a storage or chrome, through as many bindings as it takes
        let grew = true;
        const mark = (set, identifier) => {
          const variable = variableOf(identifier);
          if (variable && !set.has(variable)) {
            set.add(variable);
            grew = true;
          }
        };
        while (grew) {
          grew = false;
          for (const { identifier, value } of bindings) {
            if (isStorage(value)) mark(storages, identifier);
            else if (isChrome(value)) mark(chromes, identifier);
          }
          for (const property of properties) {
            const bound = boundName(property);
            if (!bound || holderOf(property.parent)) continue;
            const key = keyName(property);
            if (key === 'storage' && isChrome(sourceOf(property.parent))) mark(storages, bound);
            else if (key === 'chrome') mark(chromes, bound);
          }
        }
        for (const node of locals) if (isStorage(node.object)) report(node);
        for (const property of properties) {
          const key = keyName(property);
          const holder = holderOf(property.parent);
          if (key === 'local') {
            if (holder ? keyName(holder) === 'storage' : isStorage(sourceOf(property.parent))) report(property);
          } else if (key === 'storage' && !holder && !destructuresFurther(property) && isChrome(sourceOf(property.parent))) {
            report(property);
          }
        }
      },
    };
  },
};

const kernel = {
  rules: {
    imports: importsRule,
    'object-store': accessRule('objectStore'),
    'get-store': accessRule('getStore'),
    'legacy-blind-write': accessRule('legacyBlindWrite'),
    'chrome-storage-local': storageLocalRule,
  },
};

export default [
  // Frozen release files kept as #17's test fixtures (test/fixtures/storage/releases/), never linted
  { ignores: ['js/lib/**', 'test/fixtures/storage/releases/**'] },
  {
    files: ['js/**/*.js', 'js/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Declared so no-restricted-globals sees window.X and self.X as the global X
      globals: { window: 'readonly', self: 'readonly' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off', reportUnusedInlineConfigs: 'off' },
  },
  { files: CLASSIC_SCRIPTS, languageOptions: { sourceType: 'script' } },
  {
    files: ['js/**/*.js', 'js/**/*.mjs'],
    ignores: ['js/kernel/**', 'js/storage.js'],
    plugins: { kernel },
    rules: {
      'no-restricted-globals': ['error', { globals: LEGACY_GLOBALS, checkGlobalObject: true }],
      'no-restricted-syntax': ['error', ...LEGACY_SYNTAX],
      'kernel/imports': ['error', {
        rule: 'adapter-import',
        message: 'Only js/kernel/ imports from js/kernel/adapters/; take a client from your composition root.',
        deny: ['js/kernel/adapters/'],
      }],
    },
  },
  {
    files: ['js/app.js'],
    rules: { 'no-restricted-syntax': ['error', ...LEGACY_SYNTAX, APP_CALLBACK] },
  },
  {
    files: ['js/kernel/core/**/*.js', 'js/kernel/core/**/*.mjs'],
    plugins: { kernel },
    languageOptions: { globals: { window: 'off', self: 'off' } },
    rules: {
      // Only ECMAScript's own globals: anything else is a browser API or a legacy global
      'no-undef': ['error', { typeof: true }],
      'no-restricted-globals': ['error', {
        name: 'globalThis',
        message: '[core-global] js/kernel/core/ is host-neutral: no browser API or legacy global, globalThis included.',
      }],
      'kernel/imports': ['error', {
        rule: 'core-import',
        message: 'js/kernel/core/ imports only from itself and js/lib/valibot/.',
        allow: ['js/kernel/core/', 'js/lib/valibot/'],
      }],
    },
  },
  // #15's registry kit is host-neutral like core: no browser API, no legacy global, and no
  // import from outside itself and the vendored Valibot. Families get chrome.* and storage
  // only through what their composition root injects.
  {
    files: ['js/kernel/registry/**/*.js', 'js/kernel/registry/**/*.mjs'],
    plugins: { kernel },
    languageOptions: { globals: { window: 'off', self: 'off' } },
    rules: {
      'no-undef': ['error', { typeof: true }],
      'no-restricted-globals': ['error', {
        name: 'globalThis',
        message: '[registry-global] js/kernel/registry/ is host-neutral: no browser API or legacy global, globalThis included.',
      }],
      'kernel/imports': ['error', {
        rule: 'registry-import',
        message: 'js/kernel/registry/ imports only from itself and js/lib/valibot/.',
        allow: ['js/kernel/registry/', 'js/lib/valibot/'],
      }],
    },
  },
  // #17's storage access: only its IndexedDB adapter opens object stores, and only the
  // adapters and composition roots reach chrome.storage.local. js/storage.js and the legacy
  // adapter count too. The kernel ledger's rows for these only shrink (shrinkOnly).
  {
    files: ['js/**/*.js', 'js/**/*.mjs'],
    ignores: ['js/kernel/adapters/indexeddb/**'],
    plugins: { kernel },
    rules: {
      'kernel/object-store': ['error', {
        rule: 'objectStore',
        message: "Only #17's IndexedDB adapter opens object stores; use a kernel command or query.",
      }],
      'kernel/get-store': ['error', {
        rule: 'getStore',
        message: "DatabaseManager.getStore hands out a raw store; #17 slice 6 moves its readers to read-only queries.",
      }],
      'kernel/legacy-blind-write': ['error', {
        rule: 'legacyBlindWrite',
        message: 'A write that skips its expected version; only the callers the ledger lists may make one, until #17 slice 6.',
      }],
    },
  },
  {
    files: ['js/**/*.js', 'js/**/*.mjs'],
    ignores: ['js/kernel/adapters/**', 'js/kernel/composition/**'],
    plugins: { kernel },
    rules: {
      'kernel/chrome-storage-local': ['error', {
        rule: 'chrome.storage.local',
        message: "Settings and session state go through the kernel's settings repository, which #17 keeps in chrome.storage.local.",
      }],
    },
  },
];
