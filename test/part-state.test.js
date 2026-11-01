'use strict';

// #27 slice 3b: js/ui/part-state.js, how a part that loads at its first use says how its load
// went where the part goes. The status line shows only past 400 ms and holds at least 300 ms;
// a failure says what fixes it, with Try again, then Reload beside it once Try again failed, or
// Reload alone when trying again can't help; Try again and Reload keep their place and focus while
// they run; Reload runs the page's save guards first and says when a save stopped it. Every state
// is said once through a live region that's on the page before its words. The status line's arc
// turns for its first 5 s, and not at all under reduced motion.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, settle } = require('./helpers/legacy-env');
const { parse, walk, splitTopLevel } = require('../scripts/css-parser.js');

/** A file that didn't load, as the loader answers it: with its retry, which fails again unless given */
const missing = (retry) => ({ status: 'failed', reason: 'chunk-missing', retry: retry || (async () => missing()) });

/** A PartState for the charts, in a fake page, with what its callbacks saw */
function charts(options = {}) {
  const env = createLegacyEnv();
  env.load('js/ui/part-state.js');
  const doc = env.document;
  const live = doc.createElement('div');
  const host = doc.createElement('div');
  doc.body.appendChild(live);
  doc.body.appendChild(host);
  const seen = { loaded: [], reloads: [] };
  const heading = doc.createElement('h3');
  const notice = options.notice ? doc.createElement('button') : null;
  const PartState = env.get('PartState');
  const part = new PartState({
    doc,
    words: env.get('PART_WORDS').charts,
    live,
    place: (element) => {
      for (const child of [...host.children]) host.removeChild(child);
      if (element) host.appendChild(element);
    },
    loaded: (result) => { seen.loaded.push(result.module); },
    focusAfter: () => heading,
    reload: {
      guarded: async () => {
        seen.reloads.push('guarded');
        return { reloaded: options.saves !== false };
      },
      now: () => seen.reloads.push('now'),
      ownNotice: () => notice,
    },
    ...options.part,
  });
  return { env, doc, live, host, part, seen, heading, notice };
}

/** The live region's words, and the panel's line, note, and shown buttons */
function shown({ part, host }) {
  const element = host.children[0] || null;
  return {
    placed: Boolean(element),
    state: part.state,
    form: element ? element.className : null,
    line: element ? part.line.textContent : null,
    note: element ? part.lineNote.textContent : null,
    // A button that keeps the width of a second label shows its first span; the second is hidden
    buttons: element ? [part.tryButton, part.reloadButton, part.anywayButton].filter((b) => !b.hidden)
      .map((b) => (b.children.length === 2 ? b.children[0].textContent : b.textContent)) : [],
    said: part.liveRegion.textContent,
  };
}

/** A button's shown label: its first span when it keeps the width of a second label */
const labelOf = (button) => (button.children.length === 2 ? button.children[0].textContent : button.textContent);

/**
 * The shown buttons in their order on the page, which is their order from where the buttons start
 * (the row's end beside the words, the line's start under them): "slot:label", with "·" for a
 * place kept empty at Try again's width
 */
function slots({ part }) {
  const placed = [...part.actions.children];
  return [part.tryButton, part.reloadButton, part.anywayButton, part.spacer]
    .filter((item) => item && !item.hidden && placed.includes(item))
    .sort((a, b) => placed.indexOf(a) - placed.indexOf(b))
    .map((item, at) => `${at}:${item === part.spacer ? '·' : labelOf(item)}`);
}

/** Everything the live region says from now on, in order, without the emptying before each */
function sayings(part) {
  const words = [];
  let text = part.liveRegion.textContent;
  Object.defineProperty(part.liveRegion, 'textContent', {
    configurable: true,
    get: () => text,
    set: (value) => {
      text = String(value);
      if (text) words.push(text);
    },
  });
  return words;
}

/** A load that answers when `finish(result)` is called */
function deferred() {
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  return { promise, finish: (result) => finish(result) };
}

describe('whileLoading (js/ui/part-state.js)', () => {
  it('shows nothing for a load under 400 ms, and answers what the load answers', async () => {
    const { env } = charts();
    const whileLoading = env.get('whileLoading');
    const load = deferred();
    let shows = 0;
    const answer = whileLoading(load.promise, { show: () => { shows += 1; } });
    env.clock.tick(399);
    load.finish('drawn');
    assert.equal(await answer, 'drawn');
    env.clock.tick(1000);
    assert.equal(shows, 0);
  });

  it('shows the status once a load has run 400 ms, and holds it at least 300 ms after it shows', async () => {
    const { env } = charts();
    const whileLoading = env.get('whileLoading');
    const load = deferred();
    const events = [];
    let settled = false;
    const answer = whileLoading(load.promise, { show: () => events.push(`shown at ${env.clock.now}`), hide: () => events.push(`hidden at ${env.clock.now}`) })
      .then((value) => { settled = true; return value; });
    env.clock.tick(400);
    assert.deepEqual(events, ['shown at 400']);
    env.clock.tick(50);
    load.finish('drawn at 450');
    await settle();
    assert.equal(settled, false, 'it holds the status');
    env.clock.tick(249);
    await settle();
    assert.equal(settled, false);
    env.clock.tick(1);
    assert.equal(await answer, 'drawn at 450');
    assert.deepEqual(events, ['shown at 400', 'hidden at 700']);
  });
});

describe('PartState (js/ui/part-state.js)', () => {
  it('puts its live region on the page when it is made, before any words, and says nothing yet', () => {
    const { live, part } = charts();
    assert.ok(part.liveRegion.parentNode === live, 'its live region is on the page');
    assert.equal(part.liveRegion.getAttribute('role'), 'status');
    assert.equal(part.liveRegion.className, 'part-state-live');
    assert.equal(part.liveRegion.textContent, '');
  });

  it('draws the part from a load that worked, and places nothing', async () => {
    const ctx = charts();
    await ctx.part.load(async () => ({ status: 'loaded', module: 'Chart' }));
    assert.deepEqual(ctx.seen.loaded, ['Chart']);
    assert.equal(shown(ctx).placed, false);
  });

  it('shows "Loading charts…" as a line of its own for a first load past 400 ms, then the charts', async () => {
    const ctx = charts();
    const load = deferred();
    const done = ctx.part.load(() => load.promise);
    ctx.env.clock.tick(400);
    assert.deepEqual(shown(ctx), {
      placed: true, state: 'loading', form: 'part-state is-line', line: 'Loading charts…', note: '', buttons: [], said: 'Loading charts…',
    });
    assert.match(ctx.part.glyph.innerHTML, /class="part-state-spin"/);
    load.finish({ status: 'loaded', module: 'Chart' });
    ctx.env.clock.tick(300);
    await done;
    assert.equal(shown(ctx).placed, false);
    assert.deepEqual(ctx.seen.loaded, ['Chart']);
  });

  it('says a failure once, with Try again, and focus stays where it was', async () => {
    const ctx = charts();
    const elsewhere = ctx.doc.createElement('input');
    elsewhere.focus();
    await ctx.part.load(async () => missing(async () => missing()));
    assert.deepEqual(shown(ctx), {
      placed: true, state: 'failed', form: 'part-state', line: 'Failed to load the charts. Please try again.', note: '', buttons: ['Try again'],
      said: 'Failed to load the charts. Please try again.',
    });
    assert.ok(ctx.doc.activeElement === elsewhere, 'focus stays where it was');
  });

  it('keeps Try again in its place and its focus while it runs, with the loading line past 400 ms, then says the second failure', async () => {
    const ctx = charts();
    const retry = deferred();
    await ctx.part.load(async () => missing(() => retry.promise));
    ctx.part.tryButton.focus();
    ctx.part.tryButton.click();
    assert.equal(ctx.part.tryButton.getAttribute('aria-disabled'), 'true');
    ctx.env.clock.tick(400);
    assert.deepEqual(shown(ctx), {
      placed: true, state: 'loading', form: 'part-state', line: 'Loading charts…', note: '', buttons: ['Try again'], said: 'Loading charts…',
    });
    retry.finish(missing(async () => missing()));
    ctx.env.clock.tick(300);
    await settle();
    assert.deepEqual(shown(ctx), {
      placed: true,
      state: 'again',
      form: 'part-state',
      line: 'Failed to load the charts again.',
      note: "Reloading the page may fix it, and doesn't delete your notes.",
      buttons: ['Try again', 'Reload'],
      said: "Failed to load the charts again. Reloading the page may fix it, and doesn't delete your notes.",
    });
    assert.equal(ctx.part.tryButton.getAttribute('aria-disabled'), null);
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus stays on Try again');
  });

  it('a press while Try again runs does nothing, and a Try again that worked draws the part and moves focus to it', async () => {
    const ctx = charts();
    let retries = 0;
    await ctx.part.load(async () => missing(async () => { retries += 1; return { status: 'loaded', module: 'Chart' }; }));
    ctx.part.tryButton.focus();
    ctx.part.tryButton.click();
    ctx.part.tryButton.click();
    await settle();
    assert.equal(retries, 1);
    assert.equal(shown(ctx).placed, false);
    assert.deepEqual(ctx.seen.loaded, ['Chart']);
    assert.ok(ctx.doc.activeElement === ctx.heading, "focus is on the part's heading");
  });

  it('a file that threw, or another build on disk, says so with Reload alone', async () => {
    for (const reason of ['evaluation-failed', 'build-mismatch']) {
      const ctx = charts();
      await ctx.part.load(async () => ({ status: 'failed', reason, retry: async () => missing() }));
      assert.deepEqual(shown(ctx), {
        placed: true,
        state: 'threw',
        form: 'part-state',
        line: 'Failed to load the charts.',
        note: "Reloading the page may fix it, and doesn't delete your notes.",
        buttons: ['Reload'],
        said: "Failed to load the charts. Reloading the page may fix it, and doesn't delete your notes.",
      }, reason);
    }
  });

  it('moves focus to Reload when the throw followed a Try again', async () => {
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null })));
    ctx.part.tryButton.focus();
    ctx.part.tryButton.click();
    await settle();
    assert.equal(ctx.part.state, 'threw');
    assert.ok(ctx.doc.activeElement === ctx.part.reloadButton, 'focus is on Reload');
  });

  it('a new load shows the first failure again until Try again is pressed', async () => {
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => missing()));
    ctx.part.tryButton.click();
    await settle();
    assert.equal(ctx.part.state, 'again');
    await ctx.part.load(async () => missing(async () => missing()));
    assert.equal(shown(ctx).line, 'Failed to load the charts. Please try again.');
  });

  it("takes the second failure's words only when the place says so", async () => {
    const ctx = charts({ part: { again: (failure) => failure.reason === 'chunk-missing' && failure.library === true } });
    await ctx.part.load(async () => missing(async () => missing()));
    ctx.part.tryButton.click();
    await settle();
    assert.equal(shown(ctx).line, 'Failed to load the charts. Please try again.');
  });

  it("Reload says Saving… at Reload's width while the guards run, and reloads", async () => {
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => missing()));
    ctx.part.tryButton.click();
    await settle();
    const [label, reserved] = ctx.part.reloadButton.children;
    assert.deepEqual([label.textContent, reserved.textContent, reserved.getAttribute('aria-hidden')], ['Reload', 'Saving…', 'true']);
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    assert.equal(ctx.part.reloadButton.getAttribute('aria-disabled'), 'true');
    assert.deepEqual([label.textContent, reserved.textContent], ['Saving…', 'Reload']);
    assert.equal(ctx.part.liveRegion.textContent, 'Saving your changes before reloading.');
    await settle();
    assert.deepEqual(ctx.seen.reloads, ['guarded']);
  });

  it("when a save stops the reload it says so where Reload was, with Try again focused and Reload anyway", async () => {
    const ctx = charts({ saves: false });
    await ctx.part.load(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null }));
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    assert.deepEqual(shown(ctx), {
      placed: true,
      state: 'save-failed',
      form: 'part-state',
      line: "Failed to save your changes, so the page didn't reload.",
      note: 'Please try again. If it keeps failing, copy anything you need, then reload.',
      buttons: ['Try again', 'Reload anyway'],
      said: "Failed to save your changes, so the page didn't reload. Please try again. If it keeps failing, copy anything you need, then reload.",
    });
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus is on Try again');
    // Try again is the reload again, and Reload anyway reloads without the guards
    ctx.part.tryButton.click();
    await settle();
    ctx.part.anywayButton.click();
    assert.deepEqual(ctx.seen.reloads, ['guarded', 'guarded', 'now']);
  });

  it("Try again after a failed save reads Saving… at its own width while the guards run, and a save that fails again says so in its own words", async () => {
    const failed = "Failed to save your changes, so the page didn't reload.";
    const tryLine = 'Please try again. If it keeps failing, copy anything you need, then reload.';
    const failedAgain = "Failed to save your changes again, so the page didn't reload.";
    const copyLine = 'Copy anything you need, then reload.';
    const saving = 'Saving your changes before reloading.';
    const ctx = charts({ saves: false });
    await ctx.part.load(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null }));
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    assert.deepEqual([shown(ctx).line, shown(ctx).note], [failed, tryLine]);
    const words = sayings(ctx.part);
    ctx.part.tryButton.click();
    // Try again keeps its place, its width and its focus, aria-disabled, and reads Saving… as
    // Reload does, with what the guards do where "Please try again." was
    assert.equal(ctx.part.tryButton.children.length, 2, 'Try again keeps the width of Saving… and of itself');
    const [label, reserved] = ctx.part.tryButton.children;
    assert.deepEqual([label.textContent, reserved.textContent, reserved.getAttribute('aria-hidden')], ['Saving…', 'Try again', 'true']);
    assert.equal(ctx.part.tryButton.getAttribute('aria-disabled'), 'true');
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus is on Try again');
    assert.deepEqual([shown(ctx).line, shown(ctx).note, shown(ctx).said], [failed, saving, saving]);
    await settle();
    // The save failed again, in words that say so, with Try again pressable and focused
    assert.deepEqual(shown(ctx), {
      placed: true,
      state: 'save-failed',
      form: 'part-state',
      line: failedAgain,
      note: copyLine,
      buttons: ['Try again', 'Reload anyway'],
      said: `${failedAgain} ${copyLine}`,
    });
    assert.deepEqual([label.textContent, reserved.textContent], ['Try again', 'Saving…']);
    assert.equal(ctx.part.tryButton.getAttribute('aria-disabled'), null);
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus is on Try again');
    // From the third failure the words don't change, and they're said again each time
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual([shown(ctx).line, shown(ctx).note], [failedAgain, copyLine]);
    assert.deepEqual(words, [saving, `${failedAgain} ${copyLine}`, saving, `${failedAgain} ${copyLine}`]);
    assert.deepEqual(ctx.seen.reloads, ['guarded', 'guarded', 'guarded']);
  });

  it("a part's failure that comes again from the third Try again on is said again, by the place pressed", async () => {
    const again = "Failed to load the charts again. Reloading the page may fix it, and doesn't delete your notes.";
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => missing()));
    ctx.part.tryButton.click();
    await settle();
    const words = sayings(ctx.part);
    ctx.part.tryButton.click();
    await settle();
    assert.equal(shown(ctx).said, again);
    assert.deepEqual(words, [again]);
  });

  it("the model's failure from the third Try again on is said again only in the place pressed", async () => {
    const env = createLegacyEnv();
    env.load('js/ui/part-state.js');
    const doc = env.document;
    const PartState = env.get('PartState');
    const group = new (env.get('PartGroup'))();
    const part = (name) => {
      const live = doc.createElement('div');
      const host = doc.createElement('div');
      doc.body.appendChild(live);
      doc.body.appendChild(host);
      const state = new PartState({
        doc, words: env.get('PART_WORDS').semantic, live, group,
        place: (element) => { for (const child of [...host.children]) host.removeChild(child); if (element) host.appendChild(element); },
      });
      return { name, part: state };
    };
    const search = part('search');
    const related = part('related');
    const failure = missing(async () => missing());
    search.part.fail(failure);
    related.part.fail(failure);
    search.part.tryButton.click();
    await settle();
    const searchSaid = sayings(search.part);
    const relatedSaid = sayings(related.part);
    search.part.tryButton.click();
    await settle();
    assert.equal(search.part.state, 'again');
    assert.equal(related.part.state, 'again');
    assert.equal(searchSaid.length, 1, 'the place pressed says it again');
    assert.deepEqual(relatedSaid, [], 'the other place says nothing new');
  });

  it("Try again after a failed save gives way to an editor's own notice that now explains it, with the save's words back", async () => {
    let notice = null;
    const reloads = [];
    const ctx = charts({
      part: { reload: { guarded: async () => { reloads.push('guarded'); return { reloaded: false }; }, now: () => {}, ownNotice: () => notice } },
    });
    await ctx.part.load(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null }));
    ctx.part.reloadButton.click();
    await settle();
    notice = ctx.doc.createElement('button');
    ctx.doc.body.appendChild(notice);
    ctx.part.tryButton.focus();
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual([ctx.part.state, ctx.part.lineNote.textContent], ['save-failed', 'Please try again. If it keeps failing, copy anything you need, then reload.']);
    assert.ok(ctx.doc.activeElement === notice, "focus is on the notice's button");
    assert.deepEqual(reloads, ['guarded', 'guarded']);
  });

  it("lets an editor's own notice speak when it explains the failed save, and moves focus to its button", async () => {
    const ctx = charts({ saves: false, notice: true });
    await ctx.part.load(async () => ({ status: 'failed', reason: 'build-mismatch', retry: async () => missing() }));
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    assert.equal(ctx.part.state, 'threw', 'the row stays as it was');
    assert.ok(ctx.doc.activeElement === ctx.notice, "focus is on the notice's button");
  });

  it("keeps a failed save in the row, with focus on Try again, when the editor's notice that explains it can't take focus, as on Stats where the editor is hidden", async () => {
    const ctx = charts({ saves: false, notice: true });
    // A notice in a hidden editor takes no focus
    ctx.notice.focus = () => {};
    await ctx.part.load(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null }));
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    assert.deepEqual([shown(ctx).state, shown(ctx).line], ['save-failed', "Failed to save your changes, so the page didn't reload."]);
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus is on Try again');
    // Its Try again, stopped the same way, keeps the save's words and focus
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual([shown(ctx).state, shown(ctx).line], ['save-failed', "Failed to save your changes again, so the page didn't reload."]);
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus is on Try again');
  });

  it('a step of its own that throws is a failure trying again cannot help', async () => {
    const ctx = charts();
    await ctx.part.load(async () => { throw new Error('the place threw'); });
    assert.equal(ctx.part.state, 'threw');
  });
});

describe("PartState's buttons keep their places (js/ui/part-state.js)", () => {
  it('after a failed Try again, Try again stays in its place and Reload goes on the far side', async () => {
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => missing()));
    assert.deepEqual(slots(ctx), ['0:Try again']);
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual(slots(ctx), ['0:Try again', '1:Reload']);
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual(slots(ctx), ['0:Try again', '1:Reload']);
  });

  it("a Try again whose file then threw keeps its place empty at Try again's width, with Reload on the far side", async () => {
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null })));
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual(slots(ctx), ['0:·', '1:Reload']);
    // The empty place is Try again's twin, there for its width alone
    const { spacer, tryButton } = ctx.part;
    assert.deepEqual([spacer.getAttribute('aria-hidden'), spacer.tabIndex], ['true', -1]);
    assert.match(spacer.className, /\bpart-state-spacer\b/);
    assert.deepEqual([...spacer.children].map((span) => span.textContent), [...tryButton.children].map((span) => span.textContent));
    assert.equal(spacer.className.replace(/\s*part-state-spacer\b/, ''), tryButton.className.replace(/\s*part-state-try\b/, ''));
  });

  it("after a failed save, Try again takes the place of the Reload just pressed, and the quiet Reload anyway goes on the far side", async () => {
    const ctx = charts({ saves: false });
    await ctx.part.load(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null }));
    assert.deepEqual(slots(ctx), ['0:Reload']);
    ctx.part.reloadButton.click();
    await settle();
    assert.deepEqual(slots(ctx), ['0:Try again', '1:Reload anyway']);
    assert.match(ctx.part.anywayButton.className, /\bpart-state-anyway\b/);
    // With no place kept empty, the buttons share one row
    assert.doesNotMatch(ctx.part.actions.className, /\bis-split\b/);
  });

  it("after a failed save from the Reload beside Try again, Try again takes that Reload's place, and its own stays empty", async () => {
    const ctx = charts({ saves: false });
    await ctx.part.load(async () => missing(async () => missing()));
    ctx.part.tryButton.focus();
    ctx.part.tryButton.click();
    await settle();
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    assert.deepEqual(slots(ctx), ['0:·', '1:Try again', '2:Reload anyway']);
    // A place kept empty beside the words puts Reload anyway on a line of its own (css/editor.css)
    assert.match(ctx.part.actions.className, /\bis-split\b/);
    // Its Try again, failing again, leaves every button where it is
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual(slots(ctx), ['0:·', '1:Try again', '2:Reload anyway']);
    assert.match(ctx.part.actions.className, /\bis-split\b/);
  });

  it('never moves the button with focus on the page, which would take its focus, and moves the others around it', async () => {
    const ctx = charts({ saves: false });
    await ctx.part.load(async () => missing(async () => missing()));
    const { actions } = ctx.part;
    const moved = [];
    for (const method of ['appendChild', 'insertBefore']) {
      const move = actions[method].bind(actions);
      actions[method] = (child, ...rest) => {
        if (child === ctx.doc.activeElement) moved.push(labelOf(child));
        return move(child, ...rest);
      };
    }
    ctx.part.tryButton.focus();
    ctx.part.tryButton.click();
    await settle();
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    ctx.part.tryButton.click();
    await settle();
    assert.deepEqual(moved, []);
    assert.deepEqual(slots(ctx), ['0:·', '1:Try again', '2:Reload anyway']);
    assert.ok(ctx.doc.activeElement === ctx.part.tryButton, 'focus is on Try again');
  });

  it('a redraw leaves the buttons where they are, and a new load starts them again', async () => {
    const ctx = charts();
    await ctx.part.load(async () => missing(async () => ({ status: 'failed', reason: 'evaluation-failed', retry: null })));
    ctx.part.tryButton.click();
    await settle();
    ctx.part.redraw();
    assert.deepEqual(slots(ctx), ['0:·', '1:Reload']);
    await ctx.part.load(async () => missing(async () => missing()));
    assert.deepEqual(slots(ctx), ['0:Try again']);
  });
});

/**
 * Every rule in css/ whose selector `matches`, with the at-rules around it
 * @param {RegExp} matches
 */
function cssRules(matches) {
  const dir = path.join(__dirname, '..', 'css');
  const rules = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.css')).sort()) {
    walk(parse(fs.readFileSync(path.join(dir, file), 'utf8')), (node, ancestors) => {
      if (node.type !== 'rule') return;
      const selectors = splitTopLevel(node.prelude).map((selector) => selector.trim().replace(/\s+/g, ' '));
      if (!selectors.some((selector) => matches.test(selector))) return;
      rules.push({
        file,
        selectors,
        at: ancestors.filter((ancestor) => ancestor.type === 'at-rule').map((ancestor) => `@${ancestor.name} ${ancestor.prelude}`),
        values: Object.fromEntries(node.declarations.map(({ property, value, important }) => [property, important ? `${value} !important` : value])),
      });
    });
  }
  return rules;
}

/** Every rule in css/ that names the status line's arc, with the at-rules around it */
function arcRules() {
  return cssRules(/\.part-state-spin(?![\w-])/).map(({ file, at, values }) => ({ file, at, values }));
}

/**
 * How long an `animation` shorthand turns, in seconds: its duration times its iteration count
 * @param {string} animation
 */
function turnsFor(animation) {
  const words = animation.split(/\s+/);
  const duration = words.find((word) => /^\d*\.?\d+m?s$/.test(word));
  const count = words.find((word) => /^(\d*\.?\d+|infinite)$/.test(word));
  if (!duration) return 0;
  if (count === 'infinite') return Infinity;
  const seconds = duration.endsWith('ms') ? parseFloat(duration) / 1000 : parseFloat(duration);
  return seconds * (count ? Number(count) : 1);
}

describe("the status line's arc (css/editor.css)", () => {
  it('turns for its first 5 s, then holds still beside the words, and not at all under reduced motion', () => {
    const rules = arcRules();
    assert.deepEqual(rules, [
      { file: 'editor.css', at: [], values: { animation: 'spin 1s linear 5' } },
      { file: 'editor.css', at: ['@media (prefers-reduced-motion: reduce)'], values: { animation: 'none' } },
    ]);
    // Motion past 5 s beside content needs a way to stop it (WCAG 2.2.2), and the model's load
    // can run a minute
    assert.equal(turnsFor(rules[0].values.animation), 5);
  });
});

describe("a part's panel and its buttons (css/editor.css)", () => {
  it("takes its place's width, never its words', so a long failure doesn't widen the stats view", () => {
    const panel = cssRules(/^\.part-state$/).filter(({ at }) => at.length === 0);
    assert.ok(panel.some(({ values }) => values['container-type'] === 'inline-size'), 'its own width is its place\'s');
  });

  it("puts the buttons under the words, adding to their right, unless the second failure's words and both its buttons fit in one row", () => {
    // Under the words: the words take a line of their own
    const text = cssRules(/^\.part-state-text$/).filter(({ at }) => at.length === 0);
    assert.equal(text[text.length - 1].values.flex, '1 1 100%');
    // Beside them, where the second failure fits in one row: the buttons end the row, start from
    // its end, and keep to its top, where the words grow from
    const beside = cssRules(/^\.part-state:not\(\.is-narrow\) > \.part-state-(text|actions)$/).map(({ selectors, at, values }) => ({ selectors, at, values }));
    assert.deepEqual(beside, [
      { selectors: ['.part-state:not(.is-narrow) > .part-state-text'], at: ['@container (min-width: 470px)'], values: { 'flex-basis': '0' } },
      {
        selectors: ['.part-state:not(.is-narrow) > .part-state-actions'],
        at: ['@container (min-width: 470px)'],
        values: { 'flex-direction': 'row-reverse', 'flex-wrap': 'nowrap', 'align-self': 'flex-start' },
      },
    ]);
    // The page's order is the buttons' order (js/ui/part-state.js), which no CSS order redraws late
    assert.deepEqual(cssRules(/^\.part-state-(actions|try|reload|anyway|spacer|btn)\b/).filter(({ values }) => 'order' in values), []);
  });

  it("beside the words, a row with a place kept empty puts Reload anyway on a line of its own under the buttons, at the row's end, so the words keep their room", () => {
    const at = ['@container (min-width: 470px)'];
    const split = cssRules(/^\.part-state:not\(\.is-narrow\) > \.part-state-actions\.is-split\b/).map(({ selectors, at: where, values }) => ({ selectors, at: where, values }));
    assert.deepEqual(split, [
      { selectors: ['.part-state:not(.is-narrow) > .part-state-actions.is-split'], at, values: { display: 'grid', 'grid-template-columns': 'auto auto', 'justify-content': 'end' } },
      { selectors: ['.part-state:not(.is-narrow) > .part-state-actions.is-split > .part-state-try'], at, values: { 'grid-area': '1 / 1' } },
      { selectors: ['.part-state:not(.is-narrow) > .part-state-actions.is-split > .part-state-spacer'], at, values: { 'grid-area': '1 / 2' } },
      { selectors: ['.part-state:not(.is-narrow) > .part-state-actions.is-split > .part-state-anyway'], at, values: { 'grid-area': '2 / 1 / 3 / 3', 'justify-self': 'end' } },
    ]);
  });

  it("keeps the words to the row's top, level with Try again, where Reload anyway takes a line of its own, so they don't drop as the row grows that line", () => {
    const words = cssRules(/\.part-state-actions\.is-split\) > \.part-state-text$/).map(({ selectors, at, values }) => ({ selectors, at, values }));
    assert.deepEqual(words, [
      {
        selectors: ['.part-state:not(.is-narrow):has(> .part-state-actions.is-split) > .part-state-text'],
        at: ['@container (min-width: 470px)'],
        values: { 'align-self': 'flex-start' },
      },
    ]);
  });

  it('draws Reload anyway quiet, with no fill or border and the secondary label, still 44 px, and keeps an empty place empty', () => {
    const anyway = cssRules(/^\.part-state-anyway(:hover)?$/).map(({ selectors, values }) => ({ selectors, values }));
    assert.deepEqual(anyway, [
      { selectors: ['.part-state-anyway'], values: { 'border-color': 'transparent', background: 'none', color: 'var(--text-secondary)' } },
      { selectors: ['.part-state-anyway:hover'], values: { background: 'none', color: 'var(--text-primary)', 'text-decoration': 'underline' } },
    ]);
    const target = cssRules(/^\.part-state-btn$/).find(({ values }) => values['min-height']);
    assert.deepEqual([target.values['min-width'], target.values['min-height']], ['44px', '44px']);
    assert.deepEqual(cssRules(/^\.part-state-spacer$/).map(({ values }) => values), [{ visibility: 'hidden' }]);
  });
});
