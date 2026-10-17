import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The dictation level meter opens its own mic stream. Every stream it opens must be stopped, or a phone keeps
// showing the mic as in use after you send.
test('the level meter opens one mic stream however often it is asked, and stops every stream it opened', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const meter = {'), source.indexOf('// The pill floats over the terminal'));
  const streams = [], pending = [];
  const track = () => ({ live: true, stop() { this.live = false; } });
  const ctx = {
    dictation: { active: true },
    dictationButton: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => pending.push(() => { const s = { tracks: [track()], getTracks() { return this.tracks; } }; streams.push(s); resolve(s); })) } },
    AudioContext: class { createAnalyser() { return { fftSize: 0, getByteTimeDomainData() {} }; } createMediaStreamSource() { return { connect() {} }; } close() { return Promise.resolve(); } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  vm.runInNewContext(code + '\nthis.startMeter = startMeter; this.stopMeter = stopMeter;', ctx);
  const settle = () => new Promise((r) => setImmediate(r));
  const live = () => streams.flatMap((s) => s.tracks).filter((t) => t.live).length;

  // Many status updates while you speak: one request.
  ctx.startMeter(); ctx.startMeter(); ctx.startMeter();
  assert.equal(pending.length, 1);
  pending.shift()(); await settle();
  assert.equal(live(), 1);
  ctx.stopMeter();
  assert.equal(live(), 0, 'stopping closes the mic');

  // Sent before the mic answered: the late stream is closed as soon as it arrives.
  ctx.startMeter();
  ctx.dictation.active = false;
  ctx.stopMeter();
  pending.shift()(); await settle();
  assert.equal(live(), 0, 'a late stream is closed too');
  assert.equal(pending.length, 0);
});
