/**
 * The status shapes (#20 slice 4b): each status reads by its shape beside its words, so it
 * never rests on color alone, and still reads in grayscale. Packaged markup, drawn in
 * currentColor, which the tone's class sets.
 */

export const GLYPHS = Object.freeze({
  ok: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.4"/><path d="M5.1 8.3l2 2 3.9-4.4"/></svg>',
  unknown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.4" stroke-dasharray="2.3 2.7"/></svg>',
  absent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.4"/><path d="M5.3 8h5.4"/></svg>',
  partial: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6.4"/><path d="M8 1.6a6.4 6.4 0 0 0 0 12.8z" fill="currentColor" stroke="none"/></svg>',
  action: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.8l6.5 11.4H1.5z"/><path d="M8 6.3v3"/><circle cx="8" cy="11.25" r=".6" fill="currentColor" stroke="none"/></svg>',
  failed: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.4"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
  locked: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.2" y="7.2" width="9.6" height="6.6" rx="1.6"/><path d="M5.4 7.2V5.4a2.6 2.6 0 0 1 5.2 0v1.8"/></svg>',
  checking: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M14.4 8A6.4 6.4 0 1 1 8 1.6"/></svg>',
  todo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.6"/></svg>',
});
