import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/dictation.js', import.meta.url), 'utf8');
const create = vm.runInNewContext(`${source}\ncreateDictationController`);

function setup() {
  const instances = [], sent = [], states = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  const controller = create(Recognition, {
    language: () => 'es-AR',
    send: (target, text) => { sent.push([target, text]); return true; },
    update: (state) => states.push(state),
  });
  return { controller, instances, sent, states };
}

test('sends final speech exactly once on end, never interim speech', () => {
  const { controller, instances, sent, states } = setup();
  controller.start('terminal-a');
  const rec = instances[0];
  assert.equal(rec.lang, 'es-AR');
  rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'partial' } }] });
  assert.equal(sent.length, 0);
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hola\n mundo' } }] });
  controller.stop();
  controller.stop();
  assert.equal(rec.stopped, true);
  rec.onend();
  rec.onend();
  assert.deepEqual(sent, [['terminal-a', 'hola mundo']]);
  assert.equal(states.at(-1).phase, 'sent');
});

test('cancellation ignores late results and never sends to another tab', () => {
  const { controller, instances, sent } = setup();
  controller.start('terminal-a');
  const first = instances[0];
  controller.cancel();
  assert.equal(first.aborted, true);
  controller.start('terminal-b');
  first.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'wrong' } }] });
  first.onend();
  const second = instances[1];
  second.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'right' } }] });
  second.onend();
  assert.deepEqual(sent, [['terminal-b', 'right']]);
});

test('push-to-talk waits for key release even if Chrome ends recognition first', () => {
  const { controller, instances, sent, states } = setup();
  controller.start('terminal-a', { pushToTalk: true });
  const rec = instances[0];
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hola' } }] });
  rec.onend();
  assert.equal(sent.length, 0);
  assert.match(states.at(-1).message, /Release/);
  controller.stop();
  controller.stop();
  assert.deepEqual(sent, [['terminal-a', 'hola']]);
});

test('push-to-talk release stops recognition, and blur cancels without sending', () => {
  const { controller, instances, sent } = setup();
  controller.start('terminal-a', { pushToTalk: true });
  controller.stop();
  assert.equal(instances[0].stopped, true);
  instances[0].onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'enviar' } }] });
  instances[0].onend();
  assert.deepEqual(sent, [['terminal-a', 'enviar']]);
  controller.start('terminal-a', { pushToTalk: true });
  controller.cancel();
  instances[1].onend();
  assert.equal(instances[1].aborted, true);
  assert.equal(sent.length, 1);
});

test('empty speech diagnosis distinguishes microphone, sound and interim results', () => {
  const { controller, instances, sent, states } = setup();
  controller.start('terminal-a');
  instances[0].onend();
  assert.match(states.at(-1).message, /no microphone audio/);
  controller.start('terminal-a');
  instances[1].onaudiostart();
  instances[1].onerror({ error: 'no-speech' });
  assert.match(states.at(-1).message, /no sound/);
  controller.start('terminal-a');
  instances[2].onaudiostart();
  instances[2].onsoundstart();
  instances[2].onend();
  assert.match(states.at(-1).message, /es-AR/);
  controller.start('terminal-a');
  instances[3].onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hola' } }] });
  instances[3].onend();
  assert.match(states.at(-1).message, /no final text/);
  assert.equal(sent.length, 0);
});

test('recognition errors and empty results do not send', () => {
  const { controller, instances, sent, states } = setup();
  controller.start('terminal-a');
  instances[0].onerror({ error: 'not-allowed' });
  instances[0].onend();
  assert.match(states.at(-1).message, /permission denied/);
  controller.start('terminal-a');
  instances[1].onend();
  assert.equal(states.at(-1).phase, 'error');
  assert.equal(sent.length, 0);
});

test('shows live words while listening, final and interim apart', () => {
  const { controller, instances, states } = setup();
  controller.start('terminal-a');
  const rec = instances[0];
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'revisá el bug' } }, { isFinal: false, 0: { transcript: 'de promedio' } }] });
  const { final, interim } = states.at(-1).live; // created in the vm context: compare fields
  assert.deepEqual([final, interim], ['revisá el bug', 'de promedio']);
});

test('inserts without Enter by default; submits only when asked', () => {
  const opts = [];
  const instances = [];
  class Recognition { constructor() { instances.push(this); } start() {} stop() {} abort() {} }
  const controller = create(Recognition, { language: () => 'es-AR', send: (t, text, o) => { opts.push([text, o.submit]); return true; }, update: () => {} });
  controller.start('a');
  instances[0].onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'uno' } }] });
  controller.stop();
  instances[0].onend();
  controller.start('a');
  instances[1].onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'dos' } }] });
  controller.stop({ submit: true });
  instances[1].onend();
  assert.deepEqual(opts, [['uno', false], ['dos', true]]);
});
