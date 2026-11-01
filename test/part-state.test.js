'use strict';

// #27 slice 3b: js/ui/part-state.js, how a part that loads at its first use says how its load
// went where the part goes. The status line shows only past 400 ms and holds at least 300 ms;
// a failure says what fixes it, with Try again, then Reload beside it once Try again failed, or
// Reload alone when trying again can't help; Try again and Reload keep their place and focus while
// they run; Reload runs the page's save guards first and says when a save stopped it. Every state
// is said once through a live region that's on the page before its words.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, settle } = require('./helpers/legacy-env');

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
    assert.equal(part.liveRegion.parentNode, live);
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
    assert.equal(ctx.doc.activeElement, elsewhere);
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
    assert.equal(ctx.doc.activeElement, ctx.part.tryButton, 'focus stays on Try again');
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
    assert.equal(ctx.doc.activeElement, ctx.heading);
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
    assert.equal(ctx.doc.activeElement, ctx.part.reloadButton);
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
    assert.equal(ctx.doc.activeElement, ctx.part.tryButton);
    // Try again is the reload again, and Reload anyway reloads without the guards
    ctx.part.tryButton.click();
    await settle();
    ctx.part.anywayButton.click();
    assert.deepEqual(ctx.seen.reloads, ['guarded', 'guarded', 'now']);
  });

  it("lets an editor's own notice speak when it explains the failed save, and moves focus to its button", async () => {
    const ctx = charts({ saves: false, notice: true });
    await ctx.part.load(async () => ({ status: 'failed', reason: 'build-mismatch', retry: async () => missing() }));
    ctx.part.reloadButton.focus();
    ctx.part.reloadButton.click();
    await settle();
    assert.equal(ctx.part.state, 'threw', 'the row stays as it was');
    assert.equal(ctx.doc.activeElement, ctx.notice);
  });

  it('a step of its own that throws is a failure trying again cannot help', async () => {
    const ctx = charts();
    await ctx.part.load(async () => { throw new Error('the place threw'); });
    assert.equal(ctx.part.state, 'threw');
  });
});
