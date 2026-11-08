/**
 * The status pages' words (#20 slice 4c): the new tab's sidebar line and Settings' Trust Center
 * lines, as signed on 2026-11-07 and in round 2 on 2026-11-08, and what every
 * surface says alike with recovery.html, which reads them from here (copy.js): the groups' names
 * (the design review's change 6), the rows' labels the lines name, and the four capture-risk
 * consequences. So each thing keeps one name on every surface. It imports nothing, so a status
 * page loads it with its lines and no more.
 */

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

/**
 * The verb each group's name takes in the one-group sidebar line, "{a} {verb} your attention":
 * "need" for a plural name (round 2, from the design review's S4)
 */
export const GROUP_VERB = Object.freeze({
  storage: 'needs',
  vault: 'need',
  backup: 'need',
  sync: 'needs',
  indexing: 'needs',
  inference: 'needs',
  permissions: 'need',
  recovery: 'need',
  platform: 'need',
});

/**
 * The rows whose labels aren't their group's name, as recovery.html labels them, which reads
 * them from here: when a group's one problem sits on one of them, the lines name the row, and it
 * takes "needs" (round 2, from the design review's S2)
 */
export const ROW_LABEL = Object.freeze({
  'local-inference': 'Local model',
  'remote-ai': 'Cloud AI',
  'ai-scope-grants': 'AI access to notes',
});

/** The verb a row's label takes */
export const ROW_VERB = 'needs';

/** What capture at risk means, by its cause's consequence, as recovery.html's rows say it */
export const CAPTURE_CONSEQUENCE = Object.freeze({
  'storage.capture-at-risk': "NewTabNote couldn't save a test entry, so new notes and captures may not be saved.",
  'storage.quota': "This device is out of space for NewTabNote, so new notes and changes can't be saved.",
  'storage.version-too-new': "A newer version of NewTabNote changed your notes database, so this version won't write to it.",
  'storage.unavailable': "NewTabNote couldn't open your notes database, so notes can't be read or saved here.",
});

/** The lines' own words */
export const STATUS = Object.freeze({
  // The sidebar line: what needs attention, by group, past two the first and how many more (n1, n4,
  // the verdict's answer 7), with the verb a name takes for one (round 2), or the state of saving
  sidebarOne: '{a} {verb} your attention',
  sidebarTwo: '{a} and {b} need your attention',
  sidebarMore: '{a} and {count} more need your attention',
  atRisk: 'New notes may not be saved',
  cantConfirm: "NewTabNote can't confirm your notes are saving",
  // Settings' first line (g1 to g4), and the headline ladder's words with no fresh check (Q5)
  saving: 'Your notes are saving normally. Checked {when}.',
  notVerifiedYet: "Saving isn't verified yet.",
  notCheckedRecently: "Saving hasn't been checked recently. Last checked {when}.",
  atRiskLine: 'New notes may not be saved.',
  cantConfirmLine: "NewTabNote can't confirm your notes are saving.",
  // Settings' second line, which counts the groups it names (g2), and counts them as other after
  // a first line that leads with a problem (round 4)
  attentionOne: '1 thing needs your attention: {names}.',
  attentionMany: '{count} things need your attention: {names}.',
  attentionOtherOne: '1 other thing needs your attention: {names}.',
  attentionOtherMany: '{count} other things need your attention: {names}.',
  attentionMore: '{first} and {count} more need your attention.',
  // In place of the section's sentence wherever its button opens the Recovery Center (change 7, round 2)
  recoveryShows: 'The Recovery Center shows what went wrong and can save a copy of everything that can still be read.',
  openTrust: 'Open Trust Center',
  openRecovery: 'Open Recovery Center',
});

/** Where each of the summary's routes opens: the one map #3 changes when it mounts the views in the new tab */
export const ROUTE_HREF = Object.freeze({
  trust: 'recovery.html#trust',
  recovery: 'recovery.html#recovery',
});
