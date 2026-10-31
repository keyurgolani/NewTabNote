/**
 * The Trust Center's and Recovery Center's words (#20 slice 4b), keyed by the contracts' own
 * codes, as the design review approved them with its changes: one name for each thing on
 * every surface (6), the words it gave (7), and a resolved title for every problem a repair
 * can fix (1). Placeholders take evidence fields only (counts and times), never note text.
 * The house style for a failure is "Failed to X: reason."
 */

/** What a capability is called in "Still works:" and "Not working:" lines */
export const CAPABILITY = Object.freeze({
  capture: 'saving new notes',
  editing: 'editing',
  reading: 'reading',
  search: 'search',
  backup: 'backups',
  restore: 'restoring',
  sync: 'sync',
  export: 'export',
  ai: 'AI features',
  indexing: 'indexing',
  'context-menus': 'right-click capture',
  'side-panel': 'the side panel',
});

/** Each row, in the user's words: its label, and what it is, shown when nothing else is */
export const PROVIDER = Object.freeze({
  capture: { label: 'Saving new notes', about: 'New notes, quick notes, and captured pages.' },
  storage: { label: 'Notes database', about: 'Everything you write, kept in this browser profile on this device.' },
  'recovery-readiness': { label: 'Recovery points', about: 'Checked copies NewTabNote makes before it changes how notes are stored.' },
  backup: { label: 'Backups', about: 'Files you export and automatic backups.' },
  sync: { label: 'Sync', about: 'Copies of your notes kept on a service you choose.' },
  credentials: { label: 'Saved keys', about: 'API keys and sync passwords NewTabNote keeps for you.' },
  permissions: { label: 'Permissions', about: 'What Chrome lets NewTabNote do, and every place it can connect to.' },
  'ai-scope-grants': { label: 'AI access to notes', about: 'Which AI features may read which notes.' },
  'remote-ai': { label: 'Cloud AI', about: 'An AI provider you set up, such as OpenAI or Anthropic.' },
  'local-inference': { label: 'Local model', about: 'The model semantic search runs on this device.' },
  index: { label: 'Search', about: 'What makes your notes searchable.' },
  platform: { label: "NewTabNote's own parts", about: 'Its background worker, built-in features, and block types.' },
  messaging: { label: 'Background worker', about: "Passes saves and captures between NewTabNote's pages." },
  contributions: { label: 'Built-in features', about: 'The parts of NewTabNote that load when it starts.' },
  'block-types': { label: 'Block types', about: 'Text, to-dos, headings, and the other blocks a note holds.' },
});

/** A receipt's verification operation, in plain words: the sentence in "How this was checked" */
export const OPERATION = Object.freeze({
  'capture.probe-commit': 'Saved a test entry where new notes go, read it back, and removed it.',
  'storage.probe-readwrite': 'Saved a test entry in your notes database, read it back, and removed it.',
  'recovery.verify-newest-points': 'Read the newest recovery point back and matched it against its record of what it holds.',
  'backup.read-legacy-settings': "Read when a backup last started. NewTabNote doesn't open backup files yet.",
  'sync.read-legacy-settings': "Read your sync settings. NewTabNote doesn't test the connection yet.",
  'credentials.find-legacy-secrets': 'Looked for keys saved as plain text, without reading any of them.',
  'permissions.compare-manifest': 'Compared what Chrome grants with what NewTabNote asks for.',
  'ai-scope-grants.read-grants': 'Read the list of AI access grants.',
  'remote-ai.read-legacy-settings': "Read your AI settings. NewTabNote doesn't test the provider yet.",
  'local-inference.read-load-history': 'Looked for model load failures, and for search data the model made since.',
  'index.measure-lag': 'Compared what the search index has with your latest changes.',
  'messaging.query-health': 'Asked the background worker how its connections are doing.',
  'contributions.read-resolution-report': 'Read which built-in features loaded.',
  'block-types.read-resolution-report': 'Read which block types loaded.',
});

/** The status words, by vocabulary.js's PROVIDER_STATUSES */
export const STATUS = Object.freeze({
  verified: 'Verified',
  stale: 'Not checked recently',
  unverified: 'Not verified yet',
  checking: 'Checking…',
  'not-configured': 'Not set up',
  off: 'Off',
  unsupported: 'Not supported here',
  locked: 'Locked',
  degraded: 'Partly working',
  'action-required': 'Needs action',
  failed: 'Not working',
});

/** Where a provider's `not-configured` means something narrower than "not set up" */
export const STATUS_BY_PROVIDER = Object.freeze({
  credentials: { 'not-configured': 'None saved' },
  'ai-scope-grants': { 'not-configured': 'None granted' },
  index: { 'not-configured': 'Not tracked yet' },
  contributions: { 'not-configured': 'Nothing to check' },
  'block-types': { 'not-configured': 'Nothing to check' },
});

/** A receipt's consequence: a row's second line when it isn't fine, by provider/key or key */
export const CONSEQUENCE = Object.freeze({
  'storage.capture-at-risk': "NewTabNote couldn't save a test entry, so new notes and captures may not be saved.",
  'storage.quota': "This device is out of space for NewTabNote, so new notes and changes can't be saved.",
  'storage.version-too-new': "A newer version of NewTabNote changed your notes database, so this version won't write to it.",
  'storage.unavailable': "NewTabNote couldn't open your notes database, so notes can't be read or saved here.",
  'storage.trust-records-unavailable':
    "Notes save normally, but NewTabNote can't keep its own health records right now, so this page may miss recent problems.",
  'backup.not-verified':
    "The last backup started {since}. NewTabNote can't open backup files yet, so it can't say whether that file is complete.",
  'sync.not-verified': "Sync is set up and last ran {since}. NewTabNote can't test it yet.",
  'remote-ai/inference.not-verified':
    "A cloud AI provider is set up. When you use an AI feature, the text it works on goes to that provider. NewTabNote can't test the connection yet.",
  'local-inference/inference.not-verified': "The model has loaded on this device before. NewTabNote can't check it yet.",
  'inference.load-failed': "The local model failed to load {since}, so semantic search isn't working.",
  'vault.legacy-secret':
    'A key is saved as plain text in {count} places in this browser profile, so other software on this computer, or anyone with a copy of this profile, could read it.',
  'permissions.changed': "Chrome's permissions for NewTabNote changed, so some features may stop working.",
  'permissions.site-access-limited': "Chrome limits NewTabNote's site access, so requests to cloud AI providers will fail.",
  'indexing.lagging': 'Search is {lag} changes behind, so recent changes may not show up in search.',
  'indexing.resync-required': 'Search stopped updating and has to start over, so recent notes may not show up in search.',
  'recovery.no-verified-point': 'No checked recovery point stands behind your notes yet.',
  'recovery.point-unverified': 'A recovery point no longer matches what it was made to hold. NewTabNote keeps it until you decide.',
  'platform.coordinator-unreachable': "The background worker didn't answer. Writing and reading in this tab still work.",
  'platform.contribution-unavailable': "{count} of {records} built-in parts didn't load.",
});

/** A row's second line when it's fine or not set up, by provider/status */
export const NOTE = Object.freeze({
  'backup/not-configured': "NewTabNote hasn't made a backup on this device.",
  'sync/not-configured': "Sync isn't set up, so NewTabNote keeps your notes only in this browser profile.",
  'credentials/not-configured': 'No API key or password is saved as plain text.',
  'ai-scope-grants/not-configured': 'No AI feature has been given access to your notes.',
  'remote-ai/not-configured': 'No AI provider is set up, so no note text is sent to one.',
  'local-inference/not-configured': 'The model downloads the first time you use semantic search.',
  'index/not-configured': "This version doesn't measure the search index yet.",
  'recovery-readiness/verified': '{count} checked recovery point, newest from {verifiedAt}.',
  'recovery-readiness/legacy': "This browser profile also keeps {records} older copies from NewTabNote 1.4, which aren't checked.",
  'permissions/verified': 'Chrome grants exactly what NewTabNote asks for, and nothing more.',
  'platform/verified': 'Every part it checked is working.',
});

/** The interim providers' limit, under "How this was checked" (legacy.js never records `verified`) */
export const INTERIM_LIMIT = "This version of NewTabNote can't verify this, so the row never shows Verified.";

/** Places NewTabNote reaches that no Chrome permission covers (providers/egress.js), in words */
export const EGRESS = Object.freeze({
  favicons: { what: 'Site icons', sends: 'The address of a site you link to, to show its icon.' },
  'video-embeds': { what: 'Video blocks', sends: 'The video you embed, when the note shows it.' },
  'embedding-model': { what: 'Local model download', sends: "A request for the model's files, the first time semantic search runs." },
  'model-runtime': { what: 'Model runtime download', sends: "A request for the runtime's files, with the model." },
});

/** The Recovery Center's severity groups */
export const SEVERITY = Object.freeze({
  'capture-risk': 'New notes at risk',
  'data-risk': 'Data at risk',
  degraded: 'Partly working',
});

/** A problem's title: provider/fault/subject, or provider/fault */
export const INCIDENT = Object.freeze({
  'capture/quota': 'This device is out of space for NewTabNote',
  'storage/quota': 'This device is out of space for NewTabNote',
  'capture/version-too-new': 'Your notes database is from a newer NewTabNote',
  'storage/version-too-new': 'Your notes database is from a newer NewTabNote',
  'storage/open-failed/CanvasTabDB': "Your notes database won't open",
  'storage/open-failed/NewTabNoteTrust': "NewTabNote can't keep its health records",
  'storage/write-failed': "Some health records weren't saved",
  'capture/probe-failed': 'A test save failed',
  'storage/probe-failed': 'A test save failed',
  'capture/capture-failed': "A page capture wasn't saved",
  'storage/scan-findings': "{count} blocks aren't in any note",
  'backup/auto-backup-failed': "An automatic backup didn't finish",
  'index/indexer-start-failed': "Search indexing didn't start",
  'index/lagging': 'Search is behind',
  'index/stalled': 'Search stopped updating',
  'local-inference/load-failed': "The local model didn't load",
  'credentials/legacy-secret': 'A key is saved as plain text',
  'permissions/grant-missing': 'Site access is limited',
  'permissions/permission-changed': 'Chrome grants NewTabNote more than it asks for',
  'recovery-readiness/point-unverified': 'A recovery point failed its check',
  'messaging/unreachable': "The background worker didn't answer",
  'contributions/contribution-unavailable': "Part of NewTabNote didn't load",
  'block-types/contribution-unavailable': "A block type didn't load",
});

/** The title a problem takes under "Fixed just now", so its own title never sits there (change 1) */
export const RESOLVED = Object.freeze({
  'storage/open-failed': 'Your notes database opens again',
  'storage/quota': "There's room to save again",
  'capture/quota': "There's room to save again",
  'storage/scan-findings': 'Every block is in a note again',
  'index/lagging': 'Search is updating again',
  'index/stalled': 'Search is updating again',
  'index/indexer-start-failed': 'Search is updating again',
  'credentials/legacy-secret': 'No key is saved as plain text',
  'permissions/grant-missing': 'Site access is back',
});

/** A problem's own sentence, under its title, by provider/fault */
export const INCIDENT_TEXT = Object.freeze({
  // When the receipt doesn't say how far behind: the second half of 'indexing.lagging'
  'index/lagging': 'Recent changes may not show up in search.',
  'index/stalled': 'It has to start over, so recent notes may not show up in search until it does.',
  'index/indexer-start-failed': 'Search may miss notes you changed until indexing starts again.',
  'credentials/legacy-secret':
    "Other software on this computer, or anyone with a copy of this browser profile, could read it. It's kept in {count} places:",
});

/** Where a legacy secret is kept, never its value */
export const SECRET_PLACE = Object.freeze({
  setting_llmApiKey: "your AI provider's API key, in NewTabNote's settings",
  setting_syncWebdavConfig: "your WebDAV sync password, in NewTabNote's settings",
  settings: 'an API key left in the notes database by NewTabNote 1.1',
});

/** The search index's repair, the one this slice runs: its button, its steps, and how it ends */
export const REBUILD = Object.freeze({
  action: 'Rebuild the search index',
  confirm: 'Rebuild',
  preview:
    "Rebuilding writes {creates} new search entries and updates {updates}. It doesn't change your notes, and it removes nothing. Search may miss some notes until it finishes.",
  previewChanged: 'Your notes changed after the preview, so these numbers are new. Check them, then rebuild.',
  running: 'Rebuilding the search index…',
  keepOpen: 'Keep this page open until it finishes.',
  checking: "Checking that it's fixed…",
  stillThere: 'The repair finished, but NewTabNote still finds this problem.',
  notChecked: "The repair finished, but NewTabNote couldn't check that it's fixed yet.",
  checkAgain: 'Check again',
  nothingToDo: "Nothing to do: it's already up to date.",
  failed: 'Failed to rebuild the search index: {reason}.',
  unchanged: "Your notes didn't change.",
  tryAgain: 'Try again',
  steps: { preview: 'Preview', apply: 'Rebuild', verify: 'Check' },
});

/** Why a run stopped, in the "Failed to X: reason." slot */
export const REASON = Object.freeze({
  'not-verified': "the result didn't pass its check",
  'verify-failed': "the result couldn't be checked",
  'open-failed': 'it gave the same error again',
  'apply-failed': 'it stopped before it finished',
  'preview-failed': "the preview couldn't be made",
  'not-applicable': 'this problem has changed since the page opened',
  quota: "there isn't enough free space",
  'remediation-running': "it's already running in another NewTabNote tab",
  'not-recorded': "NewTabNote couldn't record the repair, so it didn't start",
  'no-locks': "this browser can't keep it to one tab",
  'run-expired': 'the confirmation expired',
  'transaction-failed': 'the database refused the change',
  'timed-out': 'it took too long',
});

/** A reason no entry above names */
export const REASON_FALLBACK = "it didn't finish";

/** What a step of a stored run was doing, for "Cut off while …" */
export const STEP = Object.freeze({
  plan: 'planning',
  preview: 'previewing',
  protect: 'making a recovery point',
  apply: 'making the change',
  verify: 'checking the result',
  record: 'recording the result',
});

/** "How this was checked": each evidence field's label, by provider.field or field */
export const EVIDENCE = Object.freeze({
  'permissions.count': 'Granted by Chrome',
  'permissions.records': 'Places reached without a permission',
  'permissions.pending': 'Asked for but not granted',
  'credentials.count': 'Places a key is saved as plain text',
  'ai-scope-grants.count': 'Grants',
  'recovery-readiness.count': 'Checked recovery points',
  'recovery-readiness.records': 'Older copies from NewTabNote 1.4',
  'recovery-readiness.verifiedAt': 'Newest point checked',
  'recovery-readiness.attempts': 'Points read back',
  'messaging.count': 'Connections made',
  'messaging.attempts': 'Reconnects',
  'contributions.records': 'Built-in parts',
  'contributions.count': "Parts that didn't load",
  'block-types.records': 'Block types',
  'index.records': 'Pipelines measured',
  'index.lag': 'Changes behind',
  'index.seq': 'Latest change',
  'index.count': 'Pipelines behind or stopped',
  'storage.count': 'Blocks outside any note',
  since: 'Last started',
  errorCode: 'Error code',
  exception: 'Error name',
  cause: 'Cause',
  subjectId: 'About',
  durationMs: 'Took',
  timeoutMs: 'Time limit',
});

/** The named databases a subject can be */
export const SUBJECT = Object.freeze({
  CanvasTabDB: 'your notes database (CanvasTabDB)',
  NewTabNoteTrust: "NewTabNote's health records (NewTabNoteTrust)",
  NewTabNoteRecovery: 'recovery points (NewTabNoteRecovery)',
});

/** A preview's targets, for "What changes" */
export const TARGET = Object.freeze({
  canvases: 'Notes',
  elements: 'Blocks',
  search_index: 'Search index',
  links: 'Links between notes',
  vectors: 'Semantic search data',
});

/** The groups trust.summary names, as every status page says them (change 6) */
export const GROUP = Object.freeze({
  storage: 'Notes database',
  vault: 'Saved keys',
  backup: 'Backups',
  sync: 'Sync',
  indexing: 'Search',
  inference: 'AI',
  permissions: 'Permissions',
  recovery: 'Recovery points',
  platform: "NewTabNote's own parts",
});

/** The page's own words: its views, headlines, and states */
export const PAGE = Object.freeze({
  brand: 'NewTabNote',
  trust: 'Trust Center',
  recovery: 'Recovery Center',
  views: 'Trust and recovery',
  back: 'Back to your notes',
  skip: 'Skip to main content',
  sections: [
    { id: 'live', title: 'Where your notes live', rows: ['capture', 'storage', 'recovery-readiness'] },
    { id: 'protect', title: 'What protects them', rows: ['backup', 'sync', 'credentials'] },
    { id: 'leave', title: 'What can leave this device', rows: ['permissions', 'remote-ai', 'ai-scope-grants'] },
    { id: 'runs', title: 'What runs on your notes', rows: ['local-inference', 'index', 'platform'] },
  ],
  saving: 'Your notes are saving normally',
  savingProof: 'Checked {when} by saving a test entry and reading it back.',
  atRisk: 'New notes may not be saved',
  checkingNotes: 'Checking your notes…',
  checkingProof: 'This takes a few seconds.',
  cantConfirm: "NewTabNote can't confirm your notes are saving",
  cantConfirmProof: "Its health records can't be saved right now, so recent checks may be missing.",
  notCheckedRecently: "Saving hasn't been checked recently",
  notVerifiedYet: "Saving isn't verified yet",
  lastChecked: 'Last checked {when}.',
  neverChecked: "NewTabNote hasn't checked it on this device yet.",
  partOfDatabase: 'Part of your notes database needs a look.',
  attention: '{count} need your attention: {names}.',
  attentionOne: '1 thing needs your attention: {names}.',
  openRecovery: 'Open Recovery Center',
  seeInRecovery: 'See it in Recovery Center',
  seeInTrust: 'See {label} in Trust Center',
  howChecked: 'How this was checked',
  howCheckedAll: 'How these were checked',
  connect: 'Where NewTabNote can connect',
  connectLead: 'Places NewTabNote can reach without asking Chrome for a permission:',
  connectNote:
    'Chrome also lets NewTabNote reach the AI providers it lists and your own computer (localhost). Only the provider you choose in AI settings is contacted, when you use an AI feature.',
  connectLimited:
    "Chrome doesn't let NewTabNote reach any of its {count} AI provider sites right now, so no AI request can leave this device.",
  place: 'Place',
  usedFor: 'Used for',
  receives: 'What it receives',
  checked: 'Checked',
  took: 'Took',
  currentUntil: 'Current until',
  checkedOnOpen: '{until}. Checked again each time you open this page.',
  checkedLater: '{until}. Checked again while NewTabNote is idle.',
  check: 'Check',
  limits: 'Limits',
  stillWorks: 'Still works:',
  notWorking: 'Not working:',
  nothingToRecover: 'Nothing needs recovering',
  nothingToRecoverProof: 'NewTabNote found no open problems. Its last checks ran {when}.',
  noProblemsYet: 'NewTabNote found no open problems.',
  problems: '{count} to look at',
  problemsProof: 'Your notes are saving normally. Each problem below says what still works and what to do.',
  problemsProofUnsure: 'Each problem below says what still works and what to do.',
  othersBelow: '{count} below it.',
  fixedJustNow: 'Fixed just now',
  firstSeen: 'First seen',
  lastSeen: 'Last seen',
  timesSeen: 'Times seen',
  error: 'Error',
  ref: 'Ref',
  dismiss: 'Dismiss',
  dismissed: "Dismissed. It won't count as needing attention unless it changes.",
  undo: 'Undo',
  dismissedTitle: 'Dismissed',
  dismissedText: "Dismissed problems stay here until a check shows they're fixed. They don't count as needing attention.",
  dismissedWhen: 'Dismissed {when}',
  showAgain: 'Show it again',
  dismissFailed: "Couldn't dismiss it. Try again.",
  showFailed: "Couldn't show it again. Try again.",
  changedSinceShown: 'It was seen again since this page showed it, so it stays.',
  recentRepairs: 'Recent repairs',
  repair: 'Repair',
  result: 'Result',
  when: 'When',
  doneAndChecked: 'Done and checked',
  cutOff: 'Cut off while {step}',
  cancelled: 'Cancelled',
  failedRun: 'Failed: {reason}',
  whatChanges: 'What changes',
  where: 'Where',
  adds: 'Adds',
  changes: 'Changes',
  removes: 'Removes',
  cancel: 'Cancel',
  steps: 'Steps',
  stepDone: 'done',
  stepCurrent: 'in progress',
  stepFailed: 'stopped here',
  stepTodo: 'not started',
  readFailed: "NewTabNote couldn't read its health records. Reload the page to try again.",
  reload: 'Reload',
  opening: 'Opening your notes database…',
  openFailed: "NewTabNote couldn't open your notes",
  openFailedBody: "NewTabNote hasn't changed or deleted anything.",
  reloadKeeps: "Reloading doesn't delete your notes.",
  noDatabase: 'This browser profile has no NewTabNote notes database',
  noDatabaseBody: "NewTabNote didn't create one, so nothing here was overwritten.",
  newerSchema: 'Your notes database is from a newer NewTabNote',
  newerSchemaBody: "This version won't write to it, so nothing here changes it. Update NewTabNote to keep working.",
  fixed: ', fixed',
  problemsCount: ', {count}',
});
