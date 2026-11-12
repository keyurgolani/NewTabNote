/**
 * Moment's state strings (#26, "Product and interaction requirements"): its note's save state, and
 * the one entry its local-save proof area shows while an open incident touches user data. Its
 * actions' labels are the kernel chunk's. Provisional until slice 2's Design gate.
 */

export default Object.freeze({
  'moment.save.pending': 'Saving',
  'moment.save.committed': 'Saved',
  'moment.save.failed': 'Not saved yet. Your text is kept here.',
  'moment.incident.entry': 'An open incident touches your notes',
});
