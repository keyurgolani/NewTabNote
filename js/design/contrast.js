/**
 * Quiet Atlas validator (#16). WCAG 2.x contrast after compositing alpha and
 * disabled opacity, plus the static checks on type, targets, reduced motion,
 * focus, and forced colors. Pure, with no I/O and no browser globals. It takes
 * the data js/design/tokens.generated.js exports, so the generator, the tests,
 * and (from #16 slice 2) the Theme Builder report share one implementation.
 *
 * What a static token check can't see is listed in STATIC_LIMITS, for the
 * rendered checks in later #16 slices and #24's theme matrix.
 */

/**
 * A color: sRGB channels from 0 to 255 and alpha from 0 to 1
 * @typedef {{r: number, g: number, b: number, a: number}} Rgba
 */

/**
 * One resolved appearance: what the generated CSS applies for a set of root
 * attributes and media features. Values come from DesignTokenData.variants.
 * @typedef {object} Variant
 * @property {string} scheme
 * @property {string} contrast
 * @property {string} forcedColors
 * @property {string} motion
 * @property {string} density
 * @property {string} readingFont
 * @property {string} canvasWidth
 */

/**
 * @typedef {object} TokenRecord
 * @property {string} type
 * @property {string} axis
 * @property {string} status
 * @property {boolean} overridable
 * @property {string} [role]
 * @property {Record<string, string>} values Resolved value per cell
 * @property {ReadonlyArray<string>} [candidateCells] Cells whose value is a candidate though the token is approved
 * @property {Record<string, string>} [refs] Cells whose source value names another token
 */

/**
 * @typedef {object} PairRecord
 * @property {string} id component/state/part
 * @property {string} component
 * @property {string} state
 * @property {string} part
 * @property {string} kind text, non-text, or focus
 * @property {string} fg
 * @property {string} bg
 * @property {string} [over] Opaque backdrop under a translucent bg or a disabled control
 * @property {string} [inner] Inner ring of a two-tone focus ring
 */

/**
 * @typedef {object} DesignTokenData
 * @property {string} name
 * @property {number} version
 * @property {Record<string, {label: string, dimensions: ReadonlyArray<string>}>} axes
 * @property {Record<string, any>} dimensions The source's dimensions: attributes, values, media
 * @property {{
 *   dimensions: Record<string, ReadonlyArray<string>>,
 *   default: Variant,
 *   colorAxis: string,
 *   colorCells: Record<string, Record<string, string>>,
 *   forced: {dimension: string, value: string, cell: string},
 *   axisDimension: Record<string, string | null>,
 *   baseCell: string,
 * }} variants
 * @property {Record<string, TokenRecord>} tokens
 * @property {ReadonlyArray<PairRecord>} pairs
 * @property {Record<string, any>} rules
 * @property {{schemes: ReadonlyArray<string>, pairs: ReadonlyArray<string>}} legacyDark
 */

/**
 * A rejection, a reported legacy pair, or an advisory
 * @typedef {object} Finding
 * @property {string} rule
 * @property {string | null} token The token to change: the foreground for a pair
 * @property {string | null} background
 * @property {string | null} pair
 * @property {string} variant
 * @property {string | null} state
 * @property {number | string | null} measured
 * @property {number | string | null} required
 * @property {string} message
 */

/**
 * @typedef {object} Report
 * @property {boolean} ok No failures; reported pairs and advisories don't block
 * @property {string} variant
 * @property {Finding[]} failures
 * @property {Finding[]} reported Pairs that fail on legacy dark values today
 * @property {Finding[]} advisories
 * @property {ReadonlyArray<string>} limits
 */

/** Checks a static token check can't make, left to rendered checks */
export const STATIC_LIMITS = Object.freeze([
  'Rendered contrast of each component on each surface, in every state (#24\'s theme matrix).',
  'Every interactive element\'s rendered box is at least 44 by 44 CSS px.',
  'No component animates transform, translation, scaling, or scrolling under reduced motion.',
  'Planes, cards, inputs, and selected states draw a 1px solid transparent border or outline in forced colors, and focus renders in Highlight.',
  'Focus rings draw the inner ring wherever Focus Blue alone is under 3:1: on slate and sage, and on every dark surface.',
]);

/** CSS Color 4 system colors */
export const SYSTEM_COLORS = Object.freeze([
  'AccentColor', 'AccentColorText', 'ActiveText', 'ButtonBorder', 'ButtonFace', 'ButtonText',
  'Canvas', 'CanvasText', 'Field', 'FieldText', 'GrayText', 'Highlight', 'HighlightText',
  'LinkText', 'Mark', 'MarkText', 'SelectedItem', 'SelectedItemText', 'VisitedText',
]);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i;
const RGB = /^rgba?\(([^()]*)\)$/i;
const REM = /^(\d*\.?\d+)rem$/;
const PX = /^(\d*\.?\d+)px$/;
const CLAMP = /^clamp\(([^,]+),([^,]+),([^,]+)\)$/;
const DURATION = /^(\d*\.?\d+)(ms|s)$/;
const TRANSFORM = /\b(?:translate|scale|rotate|skew|matrix|perspective)(?:[xyz]|3d)?\(/i;

/**
 * A color in the theme grammar: #rgb, #rrggbb, #rrggbbaa, or rgb()/rgba() with
 * numbers or percentages. Anything else, url() and var() included, is null.
 * @param {unknown} text
 * @returns {Rgba | null}
 */
export function parseColor(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (HEX.test(value)) return parseHex(value);
  const fn = RGB.exec(value);
  return fn ? parseRgbArguments(fn[1]) : null;
}

/**
 * @param {string} hex
 * @returns {Rgba}
 */
function parseHex(hex) {
  let digits = hex.slice(1);
  if (digits.length === 3) digits = digits.split('').map(digit => digit + digit).join('');
  const byte = (/** @type {number} */ at) => parseInt(digits.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
}

/**
 * @param {string} text
 * @returns {Rgba | null}
 */
function parseRgbArguments(text) {
  let channels;
  let alpha;
  if (text.includes(',')) {
    const parts = text.split(',').map(part => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    channels = parts.slice(0, 3);
    alpha = parts[3];
  } else {
    const halves = text.split('/');
    if (halves.length > 2) return null;
    channels = halves[0].trim().split(/\s+/);
    if (halves.length === 2) {
      alpha = halves[1].trim();
      if (alpha === '') return null;
    }
  }
  if (channels.length !== 3) return null;
  const rgb = channels.map(channel => number(channel, 255));
  const a = alpha === undefined ? 1 : number(alpha, 1);
  if (rgb.some(value => value === null) || a === null) return null;
  return { r: rgb[0], g: rgb[1], b: rgb[2], a };
}

/**
 * A number or percentage scaled to 0..max, or null when it's neither or out of range
 * @param {string} text
 * @param {number} max
 * @returns {number | null}
 */
function number(text, max) {
  const match = NUMBER.exec(text);
  if (!match) return null;
  const value = match[2] ? (Number(match[1]) / 100) * max : Number(match[1]);
  return value >= 0 && value <= max ? value : null;
}

/**
 * Lowercase #rrggbb, or #rrggbbaa when the color isn't opaque
 * @param {Rgba} color
 * @returns {string}
 */
export function formatHex(color) {
  const hex = (/** @type {number} */ value) => Math.round(value).toString(16).padStart(2, '0');
  const alpha = Math.round(color.a * 255);
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}${alpha === 255 ? '' : hex(alpha)}`;
}

/**
 * Source-over compositing in sRGB, as browsers paint
 * @param {Rgba} top
 * @param {Rgba} bottom
 * @returns {Rgba}
 */
export function compositeOver(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (/** @type {number} */ t, /** @type {number} */ b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/**
 * @param {number} channel 0..255
 * @returns {number}
 */
function linear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.x relative luminance of an opaque color
 * @param {Rgba} color
 * @returns {number}
 */
export function relativeLuminance(color) {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * WCAG 2.x contrast ratio, compositing the foreground over the background first.
 * The background must be opaque: composite it over its backdrop before calling.
 * @param {Rgba} foreground
 * @param {Rgba} background
 * @returns {number}
 */
export function contrastRatio(foreground, background) {
  if (background.a < 1) throw new Error('contrastRatio needs an opaque background');
  const a = relativeLuminance(compositeOver(foreground, background));
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Whether a value is a CSS system color keyword
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSystemColor(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim().toLowerCase();
  return SYSTEM_COLORS.some(color => color.toLowerCase() === name);
}

/**
 * A short name for a variant: the scheme, then each dimension that isn't at its default
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @returns {string}
 */
export function variantName(data, variant) {
  const parts = [variant.scheme];
  for (const dimension of Object.keys(data.variants.dimensions)) {
    if (dimension === 'scheme') continue;
    const value = variant[/** @type {keyof Variant} */ (dimension)];
    if (value !== data.variants.default[/** @type {keyof Variant} */ (dimension)]) parts.push(`${dimension}=${value}`);
  }
  return parts.join(', ');
}

/**
 * Every combination of variant values, in dimension order
 * @param {DesignTokenData} data
 * @returns {Variant[]}
 */
export function allVariants(data) {
  /** @type {Array<Record<string, string>>} */
  let combinations = [{}];
  for (const [dimension, values] of Object.entries(data.variants.dimensions)) {
    combinations = combinations.flatMap(partial => values.map(value => ({ ...partial, [dimension]: value })));
  }
  return combinations.map(partial => /** @type {Variant} */ (/** @type {unknown} */ (partial)));
}

/**
 * @param {string} rule
 * @param {string} variant
 * @param {string} message
 * @param {Partial<Finding>} [fields]
 * @returns {Finding}
 */
function finding(rule, variant, message, fields = {}) {
  return {
    rule,
    token: null,
    background: null,
    pair: null,
    variant,
    state: null,
    measured: null,
    required: null,
    ...fields,
    message,
  };
}

/**
 * Fill a partial variant with defaults and check each value
 * @param {DesignTokenData} data
 * @param {Partial<Variant>} [partial]
 * @returns {{variant: Variant, failures: Finding[]}}
 */
export function completeVariant(data, partial = {}) {
  const variant = /** @type {Variant} */ ({ ...data.variants.default });
  /** @type {Finding[]} */
  const failures = [];
  const known = data.variants.dimensions;
  for (const [dimension, value] of Object.entries(partial)) {
    if (!Object.prototype.hasOwnProperty.call(known, dimension)) {
      failures.push(finding('variant', variant.scheme, `Unknown variant dimension ${JSON.stringify(dimension)}`, {
        measured: dimension, required: Object.keys(known).join(', '),
      }));
      continue;
    }
    if (!known[dimension].includes(value)) {
      failures.push(finding('variant', variant.scheme, `${dimension} ${JSON.stringify(value)} isn't one of ${known[dimension].join(', ')}`, {
        measured: value, required: known[dimension].join(', '),
      }));
      continue;
    }
    variant[/** @type {keyof Variant} */ (dimension)] = value;
  }
  return { variant, failures };
}

/**
 * Whether a variant applies forced colors
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @returns {boolean}
 */
function isForced(data, variant) {
  const { dimension, value } = data.variants.forced;
  return variant[/** @type {keyof Variant} */ (dimension)] === value;
}

/**
 * The cell a token reads in a variant
 * @param {DesignTokenData} data
 * @param {TokenRecord} record
 * @param {Variant} variant
 * @returns {string | undefined}
 */
function cellOf(data, record, variant) {
  const { variants } = data;
  if (record.axis === variants.colorAxis) {
    if (isForced(data, variant) && record.values[variants.forced.cell] !== undefined) return variants.forced.cell;
    const byContrast = variants.colorCells[variant.scheme];
    return byContrast ? byContrast[variant.contrast] : undefined;
  }
  const dimension = variants.axisDimension[record.axis];
  return dimension ? variant[/** @type {keyof Variant} */ (dimension)] : variants.baseCell;
}

/**
 * Every token's value in a variant, with overrides applied as inline style would
 * apply them: over every variant except forced colors, whose values are !important.
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @param {Record<string, string>} [overrides] Token name to a color in the theme grammar
 * @returns {{values: Record<string, string>, failures: Finding[]}}
 */
export function resolveTokens(data, variant, overrides = {}) {
  const name = variantName(data, variant);
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Finding[]} */
  const failures = [];
  for (const [token, record] of Object.entries(data.tokens)) {
    const cell = cellOf(data, record, variant);
    const value = cell === undefined ? undefined : record.values[cell];
    if (value === undefined) {
      failures.push(finding('complete', name, `${token} has no value in ${name}`, { token, required: 'a value' }));
      continue;
    }
    values[token] = value;
  }
  const forced = isForced(data, variant);
  for (const [token, raw] of Object.entries(overrides)) {
    const record = Object.prototype.hasOwnProperty.call(data.tokens, token) ? data.tokens[token] : null;
    if (!record) {
      failures.push(finding('unknown-token', name, `Override ${token} isn't a token`, { token, measured: raw }));
    } else if (!record.overridable) {
      failures.push(finding('not-overridable', name, `${token} can't be overridden`, { token, measured: raw }));
    } else {
      const color = record.type === 'color' ? parseColor(raw) : null;
      if (!color) {
        failures.push(finding('invalid-value', name, `Override ${token} ${JSON.stringify(raw)} isn't a color in #rgb, #rrggbb, #rrggbbaa, or rgb() form`, {
          token, measured: raw, required: 'a color',
        }));
      } else if (!(forced && record.values[data.variants.forced.cell] !== undefined)) {
        values[token] = formatHex(color);
      }
    }
  }
  return { values, failures };
}

/**
 * A ratio for display, floored so a failing ratio never prints as the required one
 * @param {number} ratio
 * @returns {number}
 */
function shown(ratio) {
  return Math.floor(ratio * 100) / 100;
}

/**
 * A ratio for a message, with two decimals
 * @param {number} ratio
 * @returns {string}
 */
function format(ratio) {
  return shown(ratio).toFixed(2);
}

/**
 * Measure one pair as rendered: a translucent bg over its backdrop, the foreground
 * over that, and a disabled control faded onto its backdrop
 * @param {{fg: Rgba, bg: Rgba, over: Rgba | null, inner: Rgba | null}} colors
 * @param {number} opacity
 * @returns {{ratio: number, outer: number, innerOnOuter: number | null, innerOnSurface: number | null}}
 */
function measure(colors, opacity) {
  let bg = colors.bg.a < 1 ? compositeOver(colors.bg, colors.over) : colors.bg;
  let fg = compositeOver(colors.fg, bg);
  let inner = colors.inner ? compositeOver(colors.inner, bg) : null;
  if (opacity < 1) {
    const fade = (/** @type {Rgba} */ color) => compositeOver({ ...color, a: opacity }, colors.over);
    fg = fade(fg);
    bg = fade(bg);
    inner = inner ? fade(inner) : null;
  }
  const outer = contrastRatio(fg, bg);
  if (!inner) return { ratio: outer, outer, innerOnOuter: null, innerOnSurface: null };
  const innerOnOuter = contrastRatio(inner, fg);
  const innerOnSurface = contrastRatio(inner, bg);
  return { ratio: Math.max(outer, Math.min(innerOnOuter, innerOnSurface)), outer, innerOnOuter, innerOnSurface };
}

/**
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @param {Record<string, string>} values
 * @param {Report} report
 */
function checkPairs(data, variant, values, report) {
  const name = report.variant;
  const opacityText = values[data.rules.disabled.opacity];
  const opacity = Number(opacityText);
  if (!(opacity > 0 && opacity <= 1)) {
    report.failures.push(finding('invalid-value', name, `${data.rules.disabled.opacity} ${JSON.stringify(opacityText)} isn't an opacity above 0 and up to 1`, {
      token: data.rules.disabled.opacity, measured: opacityText === undefined ? null : opacityText, required: '0 < opacity <= 1',
    }));
    return;
  }
  const legacy = data.legacyDark.schemes.includes(variant.scheme);
  const unparsed = new Set();
  for (const pair of data.pairs) {
    const tokens = { fg: pair.fg, bg: pair.bg, over: pair.over, inner: pair.inner };
    /** @type {Record<string, Rgba | null>} */
    const colors = {};
    let complete = true;
    for (const [part, token] of Object.entries(tokens)) {
      if (token === undefined) {
        colors[part] = null;
        continue;
      }
      if (values[token] === undefined) {
        complete = false;
        continue;
      }
      const color = parseColor(values[token]);
      if (!color) {
        complete = false;
        if (!unparsed.has(token)) {
          unparsed.add(token);
          report.failures.push(finding('invalid-value', name, `${token} ${JSON.stringify(values[token])} isn't a color the validator can measure`, {
            token, measured: values[token], required: 'a color',
          }));
        }
        continue;
      }
      colors[part] = color;
    }
    if (!complete) continue;
    const disabled = pair.state === data.rules.disabled.state;
    const needsBackdrop = disabled || colors.bg.a < 1;
    if (needsBackdrop && (!colors.over || colors.over.a < 1)) {
      report.failures.push(finding('complete', name, `${pair.id} needs an opaque backdrop (over) in ${name}`, {
        token: pair.over || null, background: pair.bg, pair: pair.id, state: pair.state, required: 'an opaque backdrop',
      }));
      continue;
    }
    const result = measure({ fg: colors.fg, bg: colors.bg, over: colors.over, inner: colors.inner }, disabled ? opacity : 1);
    const required = data.rules.ratios[pair.kind];
    const ratio = shown(result.ratio);
    const fields = { token: pair.fg, background: pair.bg, pair: pair.id, state: pair.state, measured: ratio, required };
    const what = `${pair.fg} on ${pair.bg}${pair.over ? ` over ${pair.over}` : ''} (${pair.id}) in ${name}, ${pair.state}`;
    if (disabled) {
      report.advisories.push(finding('disabled-contrast', name, `${what}: ${format(result.ratio)}:1 at ${opacityText} opacity. WCAG sets no contrast requirement for inactive components.`, fields));
      continue;
    }
    if (result.ratio >= required) continue;
    const detail = result.innerOnOuter === null ? '' : ` (outer ring ${format(result.outer)}:1 on the surface, inner ring ${format(result.innerOnOuter)}:1 on the outer ring and ${format(result.innerOnSurface)}:1 on the surface)`;
    const message = `${what} fails ${pair.kind} contrast: ${format(result.ratio)}:1${detail}, needs ${required}:1`;
    const rule = `${pair.kind}-contrast`;
    if (legacy && data.legacyDark.pairs.includes(pair.id)) {
      report.reported.push(finding(rule, name, `${message}. A legacy dark pair, reported until the owner's dark values land.`, fields));
    } else {
      report.failures.push(finding(rule, name, message, fields));
    }
  }
}

/**
 * @param {DesignTokenData} data
 * @param {Record<string, string>} values
 * @param {Report} report
 */
function checkForcedColors(data, values, report) {
  const name = report.variant;
  const rules = data.rules.forcedColors;
  for (const [token, record] of Object.entries(data.tokens)) {
    if (record.type !== 'color' || values[token] === undefined) continue;
    if (!isSystemColor(values[token])) {
      report.failures.push(finding('forced-colors', name, `${token} is ${JSON.stringify(values[token])} in forced colors, not a system color`, {
        token, measured: values[token], required: 'a system color',
      }));
    }
  }
  const focus = values[rules.focus.token];
  if (focus === undefined || focus.toLowerCase() !== rules.focus.value.toLowerCase()) {
    report.failures.push(finding('forced-colors', name, `${rules.focus.token} is ${JSON.stringify(focus)} in forced colors, not ${rules.focus.value}`, {
      token: rules.focus.token, measured: focus === undefined ? null : focus, required: rules.focus.value,
    }));
  }
  for (const token of rules.boundaries) {
    const value = values[token];
    if (value === undefined) continue;
    if (!isSystemColor(value) || value.toLowerCase() === 'canvas') {
      report.failures.push(finding('forced-colors', name, `${token} is ${JSON.stringify(value)} in forced colors, so a boundary drawn in it disappears`, {
        token, measured: value, required: 'a visible system color',
      }));
    }
  }
}

/**
 * Smallest size a font-size token can compute to, in rem, or null when it isn't rem
 * @param {string} value
 * @returns {number | null}
 */
function remFloor(value) {
  const rem = REM.exec(value.trim());
  if (rem) return Number(rem[1]);
  const clamp = CLAMP.exec(value.replace(/\s+/g, ' ').trim());
  if (!clamp) return null;
  const min = REM.exec(clamp[1].trim());
  const max = REM.exec(clamp[3].trim());
  return min && max && Number(max[1]) >= Number(min[1]) ? Number(min[1]) : null;
}

/**
 * @param {DesignTokenData} data
 * @param {Record<string, string>} values
 * @param {Report} report
 */
function checkTypography(data, values, report) {
  const name = report.variant;
  const floorToken = data.rules.typography.floor;
  const floor = values[floorToken] === undefined ? null : remFloor(values[floorToken]);
  for (const [token, record] of Object.entries(data.tokens)) {
    if (record.type !== 'font-size' || values[token] === undefined) continue;
    const min = remFloor(values[token]);
    if (min === null) {
      report.failures.push(finding('type-unit', name, `${token} is ${JSON.stringify(values[token])}, not rem or clamp() with rem bounds`, {
        token, measured: values[token], required: 'rem',
      }));
    } else if (floor !== null && min < floor) {
      report.failures.push(finding('type-floor', name, `${token} can compute to ${min}rem, below the label floor ${floor}rem (${floorToken})`, {
        token, measured: `${min}rem`, required: `${floor}rem`,
      }));
    }
  }
}

/**
 * @param {DesignTokenData} data
 * @param {Record<string, string>} values
 * @param {Report} report
 */
function checkTargets(data, values, report) {
  const { token, minimum } = data.rules.targets;
  const value = values[token];
  if (value === undefined) return;
  const px = PX.exec(value.trim());
  const required = Number(PX.exec(minimum)[1]);
  if (!px || Number(px[1]) < required) {
    report.failures.push(finding('target', report.variant, `${token} is ${JSON.stringify(value)}, under ${minimum} CSS px`, {
      token, measured: value, required: minimum,
    }));
  }
}

/**
 * @param {string} value
 * @returns {number | null}
 */
function milliseconds(value) {
  const match = DURATION.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

/**
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @param {Record<string, string>} values
 * @param {Report} report
 */
function checkMotion(data, variant, values, report) {
  const reduce = data.dimensions.motion.media.value;
  if (variant.motion !== reduce) return;
  const name = report.variant;
  const required = data.rules.motion.reducedDuration;
  for (const [token, record] of Object.entries(data.tokens)) {
    const value = values[token];
    if (value === undefined) continue;
    if (record.type === 'duration' && milliseconds(value) !== milliseconds(required)) {
      report.failures.push(finding('reduced-motion', name, `${token} is ${value} under reduced motion, not ${required}`, {
        token, measured: value, required,
      }));
    }
    if (record.axis === 'motion' && TRANSFORM.test(value)) {
      report.failures.push(finding('reduced-motion', name, `${token} moves or scales under reduced motion: ${value}`, {
        token, measured: value, required: 'no transform',
      }));
    }
  }
}

/**
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @param {Record<string, string>} values
 * @param {Report} report
 */
function checkFocus(data, variant, values, report) {
  const rules = data.rules.focus;
  const checks = [
    { token: rules.width, minimum: rules.minimumWidth[variant.contrast], rule: 'focus-width' },
    { token: rules.offset, minimum: rules.minimumOffset, rule: 'focus-offset' },
  ];
  for (const { token, minimum, rule } of checks) {
    const value = values[token];
    if (value === undefined || minimum === undefined) continue;
    const px = PX.exec(value.trim());
    if (!px || Number(px[1]) < Number(PX.exec(minimum)[1])) {
      report.failures.push(finding(rule, report.variant, `${token} is ${JSON.stringify(value)} in ${report.variant}, under ${minimum}`, {
        token, measured: value, required: minimum,
      }));
    }
  }
}

/**
 * @param {DesignTokenData} data
 * @param {Variant} variant
 * @param {Report} report
 */
function checkAdvisories(data, variant, report) {
  for (const [dimension, definition] of Object.entries(data.dimensions)) {
    const value = variant[/** @type {keyof Variant} */ (dimension)];
    const advisory = definition.advisory && value !== undefined ? definition.advisory[value] : undefined;
    if (advisory) {
      report.advisories.push(finding(`${dimension}-advisory`, report.variant, `${dimension} ${value}: ${advisory}`, { measured: value }));
    }
  }
}

/**
 * Validate one variant, with optional overrides. A failure blocks; a reported
 * legacy dark pair and an advisory don't.
 * @param {DesignTokenData} data
 * @param {{variant?: Partial<Variant>, overrides?: Record<string, string>}} [options]
 * @returns {Report}
 */
export function validate(data, options = {}) {
  const { variant, failures } = completeVariant(data, options.variant);
  /** @type {Report} */
  const report = {
    ok: false,
    variant: variantName(data, variant),
    failures,
    reported: [],
    advisories: [],
    limits: STATIC_LIMITS,
  };
  if (failures.length > 0) return report;
  const resolved = resolveTokens(data, variant, options.overrides);
  report.failures.push(...resolved.failures);
  if (isForced(data, variant)) checkForcedColors(data, resolved.values, report);
  else checkPairs(data, variant, resolved.values, report);
  checkTypography(data, resolved.values, report);
  checkTargets(data, resolved.values, report);
  checkMotion(data, variant, resolved.values, report);
  checkFocus(data, variant, resolved.values, report);
  checkAdvisories(data, variant, report);
  report.ok = report.failures.length === 0;
  return report;
}
