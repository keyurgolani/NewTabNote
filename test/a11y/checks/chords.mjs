/**
 * Bindings against the chords Chrome keeps for itself (#24, "Keyboard map"), on each platform the kit
 * knows, through #15's own chord rules (js/kernel/registry/chords.js), so the check and the registry
 * agree on what a chord is.
 */

import { PLATFORMS, isReserved, parseChord, pressedOn } from '../../../js/kernel/registry/chords.js';

/**
 * The bindings that press a reserved chord, once per platform it's reserved on, and the ones the kit
 * can't read
 * @param {readonly {id: string, chord: string}[]} bindings
 * @returns {{id: string, chord: string, platform?: string, reason: 'reserved' | 'unreadable'}[]}
 */
export function reservedBindings(bindings) {
  return bindings.flatMap(({ id, chord }) => {
    const parsed = parseChord(chord);
    if (!parsed) return [{ id, chord, reason: /** @type {const} */ ('unreadable') }];
    return PLATFORMS.filter(platform => isReserved(pressedOn(parsed, platform), platform)).map(platform => ({
      id,
      chord,
      platform,
      reason: /** @type {const} */ ('reserved'),
    }));
  });
}
