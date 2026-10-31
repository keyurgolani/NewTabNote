/**
 * The Trust Center's operations as #13's router and client find them
 * (core/messaging/operations.js): each catalog entry with the payload and result schemas its
 * module exports. An MV3 worker can't import() a module, so a root that serves or sends these
 * imports this file, and Moment, which never shows trust state itself, never does
 * (test/kernel/trust-contracts.test.mjs holds capture-critical.js clear of it).
 */

import { operationOf } from '../../kernel/core/messaging/operations.js';
import { TRUST_COMMANDS, TRUST_QUERIES } from './contracts.js';
import * as diagnosticsExport from './operations/diagnostics-export.js';
import * as recoveryCheck from './operations/recovery-check.js';
import * as recoveryCopies from './operations/recovery-copies.js';
import * as recoveryDismiss from './operations/recovery-dismiss.js';
import * as recoveryIncidents from './operations/recovery-incidents.js';
import * as recoveryRaise from './operations/recovery-raise.js';
import * as recoveryRun from './operations/recovery-run.js';
import * as recoveryUndismiss from './operations/recovery-undismiss.js';
import * as trustReport from './operations/trust-report.js';
import * as trustSummary from './operations/trust-summary.js';
import * as trustVerify from './operations/trust-verify.js';

/** @typedef {import('../../kernel/core/contracts/validate.js').Operation} Operation */

/** @type {Readonly<Record<string, Operation>>} */
export const TRUST_OPERATIONS = Object.freeze({
  'trust.summary': operationOf(TRUST_QUERIES['trust.summary'], trustSummary),
  'trust.report': operationOf(TRUST_QUERIES['trust.report'], trustReport),
  'recovery.incidents': operationOf(TRUST_QUERIES['recovery.incidents'], recoveryIncidents),
  'recovery.copies': operationOf(TRUST_QUERIES['recovery.copies'], recoveryCopies),
  'trust.verify': operationOf(TRUST_COMMANDS['trust.verify'], trustVerify),
  'recovery.raise': operationOf(TRUST_COMMANDS['recovery.raise'], recoveryRaise),
  'recovery.run': operationOf(TRUST_COMMANDS['recovery.run'], recoveryRun),
  'diagnostics.export': operationOf(TRUST_COMMANDS['diagnostics.export'], diagnosticsExport),
  'recovery.dismiss': operationOf(TRUST_COMMANDS['recovery.dismiss'], recoveryDismiss),
  'recovery.undismiss': operationOf(TRUST_COMMANDS['recovery.undismiss'], recoveryUndismiss),
  'recovery.check': operationOf(TRUST_COMMANDS['recovery.check'], recoveryCheck),
});
