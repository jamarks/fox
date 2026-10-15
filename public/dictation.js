// Browser speech recognition. While listening, `update` gets the live words (final + interim) to show;
// when it ends the final transcript goes to `send` once: inserted into fx's input, or submitted on request.
function createDictationController(Recognition, { send, update, language }) {
  let active = null;
  const status = (phase, message, live = null) => update({ phase, message, live, pushToTalk: active?.pushToTalk ?? false });
  const errors = {
    'not-allowed': 'Microphone permission denied.',
    'service-not-allowed': 'Speech recognition is not allowed here.',
    'audio-capture': 'No microphone found.',
    network: 'Speech recognition needs a network connection.',
    'language-not-supported': 'This language is not supported.',
  };
  function emptyMessage(current) {
    if (current.interimSeen) return 'Speech heard, but Chrome returned no final text.';
    if (current.speechDetected) return 'Speech detected, but Chrome returned no text.';
    if (current.soundDetected) return `Sound heard, but not recognized as speech (${current.recognition.lang}).`;
    if (current.audioStarted) return 'Mic opened, but Chrome detected no sound. Check its input device.';
    return 'Chrome received no microphone audio. Check its input device.';
  }
  function finish(current) {
    if (active !== current) return;
    active = null;
    // A single line avoids speech recognition introducing terminal control keys or extra commands.
    const text = [...current.results].sort(([a], [b]) => a - b).map(([, part]) => part)
      .join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) { status('error', emptyMessage(current)); return; }
    const sent = send(current.target, text, { submit: current.submit });
    status(sent ? 'sent' : 'error', sent ? (current.submit ? 'Dictation sent.' : 'Dictation inserted.') : 'Terminal disconnected; dictation not sent.');
  }
  return {
    start(target, { pushToTalk = false } = {}) {
      if (!Recognition || active) return;
      const recognition = new Recognition();
      const current = { recognition, target, results: new Map(), interim: '', submit: false, stopping: false, pushToTalk, ended: false,
        audioStarted: false, soundDetected: false, speechDetected: false, interimSeen: false };
      active = current;
      recognition.lang = language();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onaudiostart = () => { if (active === current) { current.audioStarted = true; status('listening', 'Microphone connected…'); } };
      recognition.onsoundstart = () => { if (active === current) { current.soundDetected = true; status('listening', 'Sound detected…'); } };
      recognition.onspeechstart = () => { if (active === current) { current.speechDetected = true; status('listening', 'Speech detected…'); } };
      recognition.onresult = (event) => {
        if (active !== current) return;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) current.results.set(i, event.results[i][0].transcript);
          else if (event.results[i][0]?.transcript) { current.interimSeen = true; interim += event.results[i][0].transcript; }
        }
        current.interim = interim;
        const final = [...current.results].sort(([a], [b]) => a - b).map(([, part]) => part).join(' ');
        status('listening', 'Transcribing…', { final: final.trim(), interim: interim.trim() });
      };
      recognition.onerror = (event) => {
        if (active !== current) return;
        active = null;
        status('error', event.error === 'no-speech' ? emptyMessage(current) : (errors[event.error] || 'Could not recognize speech.'));
      };
      recognition.onend = () => {
        if (active !== current) return;
        current.ended = true;
        // Chrome can finish recognition on its own before the key is released.
        if (current.pushToTalk && !current.stopping) {
          status('stopping', 'Release ⌥D to send');
          return;
        }
        finish(current);
      };
      status('listening', pushToTalk ? 'Listening… release ⌥D to send' : 'Listening… tap to send');
      try { recognition.start(); }
      catch { active = null; status('error', 'Could not start the microphone.'); }
    },
    // submit: also press Enter in fx; otherwise the words wait in fx's input for you to edit.
    stop({ submit = false } = {}) {
      if (!active || active.stopping) return;
      active.stopping = true;
      active.submit = submit;
      if (active.ended) { finish(active); return; }
      status('stopping', 'Finishing dictation…');
      try { active.recognition.stop(); }
      catch { active = null; status('error', 'Could not finish dictation.'); }
    },
    cancel() {
      if (!active) return;
      const previous = active;
      active = null;
      try { previous.recognition.abort(); } catch {}
      status('idle', '');
    },
    get active() { return !!active; },
  };
}
