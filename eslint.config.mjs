/**
 * ESLint config: the kernel boundary rules (#12, docs/adr/0001-kernel-stack.md, decision 3).
 * `npm run check:boundaries` runs them over js/ and compares each file's hits per rule with
 * docs/architecture/kernel-ledger.json; #12's "Boundaries and the ledger" has the rules.
 * #29 (PR CI) adds the rest of the lint config and leaves these to check:boundaries.
 *
 * Every message starts with the ledger rule it counts under, in brackets. no-undef's can't
 * carry one, and check:boundaries counts it as core-global.
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

const kernel = { rules: { imports: importsRule } };

export default [
  { ignores: ['js/lib/**'] },
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
];
