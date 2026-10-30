/**
 * Keyboard chords as contributions declare them (#15, "Accessibility and performance"). A chord
 * is modifiers and one key joined by `+`, as in `Mod+Shift+K`. `Mod` is Cmd on macOS and Ctrl
 * elsewhere. Keys are named as KeyboardEvent.code names them, without the `Key` and `Digit`
 * prefixes, so a chord means the same physical key on every layout.
 *
 * A chord matches only its exact modifier set, so it's spelled with each modifier once, in the
 * order Mod (or Ctrl), Meta, Alt, Shift, and `Mod` never sits beside the Ctrl or Meta it stands
 * for. A descriptor's `chords` lists them per platform: `default` applies wherever a platform
 * lists none of its own. The validator rejects every chord on #24's Chrome-reserved list.
 * Matching a keydown against a chord (AltGraph, dead keys) is the command family's (slice 2).
 */

/** @typedef {'mac' | 'windows' | 'linux' | 'chromeos'} Platform */

/** @type {readonly Platform[]} */
export const PLATFORMS = Object.freeze(['mac', 'windows', 'linux', 'chromeos']);

/** The keys a `chords` object may list under: each platform, and `default` */
export const CHORD_LISTS = Object.freeze(['default', ...PLATFORMS]);

/** Modifiers in the order a chord spells them; Mod and Ctrl share a place */
const MODIFIER_ORDER = { Mod: 0, Ctrl: 0, Meta: 1, Alt: 2, Shift: 3 };

const NAMED_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backslash',
  'Slash',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Semicolon',
  'Quote',
  'Backquote',
  'Minus',
  'Equal',
];
const KEY = new RegExp(`^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|${NAMED_KEYS.join('|')})$`);

/**
 * Chords Chrome keeps for itself (#24, "No default binding uses a Chrome-reserved chord"):
 * new tab, new window, close tab, and tab switching, each with or without Shift, quit, and
 * next or previous tab by page key.
 */
export const CHROME_RESERVED_CHORDS = Object.freeze([
  'Mod+T',
  'Mod+Shift+T',
  'Mod+N',
  'Mod+Shift+N',
  'Mod+W',
  'Mod+Shift+W',
  'Mod+Tab',
  'Mod+Shift+Tab',
  'Mod+Shift+Q',
  'Mod+PageUp',
  'Mod+PageDown',
]);

/**
 * A chord's modifiers and key, or null when it isn't spelled as above
 * @param {unknown} text
 * @returns {{modifiers: string[], key: string} | null}
 */
export function parseChord(text) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const parts = text.split('+');
  const key = parts.pop();
  if (key === undefined || !KEY.test(key)) return null;
  let last = -1;
  for (const modifier of parts) {
    if (!Object.hasOwn(MODIFIER_ORDER, modifier)) return null;
    const place = MODIFIER_ORDER[/** @type {keyof MODIFIER_ORDER} */ (modifier)];
    if (place <= last) return null;
    last = place;
  }
  if (parts.includes('Mod') && parts.includes('Meta')) return null;
  return { modifiers: parts, key };
}

/**
 * The chord as one platform presses it, with `Mod` replaced, so two spellings of one chord
 * compare equal: `Mod+K` on macOS is `Meta+K`, and elsewhere `Ctrl+K`
 * @param {{modifiers: string[], key: string}} chord
 * @param {Platform} platform
 */
export function pressedOn(chord, platform) {
  const pressed = chord.modifiers.map(modifier =>
    modifier === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Ctrl') : modifier,
  );
  const order = ['Ctrl', 'Meta', 'Alt', 'Shift'];
  return [...new Set(pressed)]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .concat(chord.key)
    .join('+');
}

/** The reserved chords as each platform presses them */
const RESERVED = new Map(
  PLATFORMS.map(platform => [
    platform,
    new Set(
      CHROME_RESERVED_CHORDS.map(text =>
        pressedOn(/** @type {{modifiers: string[], key: string}} */ (parseChord(text)), platform),
      ),
    ),
  ]),
);

/**
 * Whether `pressed` (as pressedOn gives it) is one Chrome keeps for itself on `platform`
 * @param {string} pressed
 * @param {Platform} platform
 */
export function isReserved(pressed, platform) {
  return /** @type {Set<string>} */ (RESERVED.get(platform)).has(pressed);
}

/**
 * The chords a descriptor's `chords` field binds on each platform, as pressed there, or the
 * problem with it: `invalid-chord` for a malformed field or chord, a chord listed twice for one
 * platform, or more than `max` on one; `reserved-chord` for one Chrome keeps
 * @param {unknown} chords
 * @param {number} max
 * @returns {{ok: true, pressed: Readonly<Record<Platform, readonly string[]>>} | {ok: false, code: 'invalid-chord' | 'reserved-chord'}}
 */
export function checkChords(chords, max) {
  if (chords === null || typeof chords !== 'object' || Array.isArray(chords))
    return { ok: false, code: 'invalid-chord' };
  const lists = /** @type {Record<string, unknown>} */ (chords);
  for (const [name, list] of Object.entries(lists)) {
    if (!CHORD_LISTS.includes(name) || !Array.isArray(list) || list.length > max)
      return { ok: false, code: 'invalid-chord' };
  }
  /** @type {Partial<Record<Platform, readonly string[]>>} */
  const pressed = {};
  let reserved = false;
  for (const platform of PLATFORMS) {
    const list = /** @type {unknown[]} */ (lists[platform] ?? lists.default ?? []);
    const seen = new Set();
    for (const text of list) {
      const chord = parseChord(text);
      if (!chord) return { ok: false, code: 'invalid-chord' };
      const key = pressedOn(chord, platform);
      if (seen.has(key)) return { ok: false, code: 'invalid-chord' };
      seen.add(key);
      if (isReserved(key, platform)) reserved = true;
    }
    pressed[platform] = Object.freeze([...seen]);
  }
  if (reserved) return { ok: false, code: 'reserved-chord' };
  return { ok: true, pressed: Object.freeze(/** @type {Record<Platform, readonly string[]>} */ (pressed)) };
}
