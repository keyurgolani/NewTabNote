/**
 * The states catalog's chunks (#26 slice 1): the kernel's, with the causes' messages, the states'
 * headlines and the actions' labels, and Moment's, small, with its save state and its incident
 * entry. Each loads lazily, so importing this list loads no strings. Background gets an eager
 * chunk of its own when slice 3 moves its capture notices onto the catalog, since the kit refuses a
 * dynamic loader there.
 */

import { HOSTS } from '../../kernel/registry/vocabulary.js';

const SHARED = { version: 1, apiVersion: 1, owner: 26 };

export const CHUNKS = Object.freeze([
  Object.freeze({
    ...SHARED,
    id: 'kernel',
    group: 'kernel',
    rank: 1,
    label: "The kernel's state strings",
    hosts: HOSTS.filter(host => host !== 'background'),
    holds: ['cause', 'state', 'action'],
    parameters: {
      'state.offline.headline': { host: 'host' },
      'state.blocked.headline': { subsystem: 'subsystem' },
      'state.partial.headline': { committed: 'count', total: 'count' },
    },
    load: () => import('./kernel.js'),
  }),
  Object.freeze({
    ...SHARED,
    id: 'moment',
    group: 'surface',
    rank: 1,
    label: "Moment's state strings",
    hosts: ['moment'],
    holds: ['moment'],
    parameters: {},
    load: () => import('./moment.js'),
  }),
]);
