// #13's legacy channels that went (#13, "Current problem"): nothing in js/ sends, emits,
// listens for, or builds them again. PING was answered and never sent; sync:remoteApplied
// was emitted and never heard; note:saved was heard and never emitted; sync:stateChanged is
// SyncService's typed sync.stateChanged now; createEventBus let one throwing handler stop the
// rest, and had nothing left to carry.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Every script under `dir`, js/lib/ left out */
function scripts(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return file === 'js/lib' ? [] : scripts(file);
    return /\.m?js$/.test(entry.name) ? [file] : [];
  });
}

describe("#13's legacy channels stay gone", () => {
  it('no script names PING, sync:remoteApplied, note:saved, or sync:stateChanged as a message or event', () => {
    const names = /['"`](?:PING|sync:remoteApplied|note:saved|sync:stateChanged)['"`]/;
    assert.deepEqual(scripts('js').filter((file) => names.test(fs.readFileSync(path.join(ROOT, file), 'utf8'))), []);
  });

  it('createEventBus is gone, and nothing builds or loads it', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'js/core/event-bus.js')), false);
    const naming = scripts('js').filter((file) => /createEventBus|event-bus\.js/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    assert.deepEqual(naming, []);
  });
});
