const button = document.querySelector('#enter');
const buttonLabel = document.querySelector('#enter-label');
const status = document.querySelector('#status');
const setupCopy = document.querySelector('#setup-copy');
const ring = document.querySelector('.aperture');
// The ring tells the state: turning while the passkey prompt is up, full when unlocked, still when idle.
const setRing = (phase) => { ring.classList.toggle('waiting', phase === 'waiting'); ring.classList.toggle('done', phase === 'done'); };
const showButton = (on) => button.classList.toggle('hidden', !on);
let setup = false;
const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (ch) => ch.charCodeAt(0));
const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function post(path, data = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
// auto: asked on load, without a click. Safari (and a cancelled prompt) refuse that; then the button shows,
// quietly, with no error.
async function start({ auto = false } = {}) {
  button.disabled = true;
  status.textContent = '';
  setRing('waiting');
  try {
    const route = setup ? 'register' : 'login';
    const { id, options } = await post(`/api/auth/${route}/options`);
    let response;
    if (setup) {
      const publicKey = { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: decode(item.id) })) };
      const key = await navigator.credentials.create({ publicKey });
      if (!key) throw new Error('No passkey was created');
      response = { id: key.id, rawId: encode(key.rawId), type: key.type,
        response: { clientDataJSON: encode(key.response.clientDataJSON), attestationObject: encode(key.response.attestationObject), transports: key.response.getTransports?.() ?? [] },
        clientExtensionResults: key.getClientExtensionResults() };
    } else {
      const publicKey = { ...options, challenge: decode(options.challenge), allowCredentials: options.allowCredentials?.map((item) => ({ ...item, id: decode(item.id) })) };
      const key = await navigator.credentials.get({ publicKey });
      if (!key) throw new Error('No passkey was selected');
      response = { id: key.id, rawId: encode(key.rawId), type: key.type,
        response: { clientDataJSON: encode(key.response.clientDataJSON), authenticatorData: encode(key.response.authenticatorData), signature: encode(key.response.signature), userHandle: key.response.userHandle ? encode(key.response.userHandle) : undefined },
        clientExtensionResults: key.getClientExtensionResults() };
    }
    await post(`/api/auth/${route}/verify`, { id, response });
    setRing('done');
    document.body.classList.add('unlocked');
    setTimeout(() => location.replace('/'), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420);
  } catch (error) {
    setRing('idle');
    const dismissed = error?.name === 'NotAllowedError' || error?.name === 'AbortError';
    if (!(auto && dismissed)) status.textContent = dismissed ? 'Unlock was cancelled.' : error.message;
    button.disabled = false;
    showButton(true);
    button.focus();
  }
}
async function init() {
  if (location.hostname === '127.0.0.1') { location.replace(`http://localhost:${location.port}/`); return; }
  if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) {
    status.textContent = 'Passkeys require a secure browser context. Open fox at http://localhost:4848.';
    buttonLabel.textContent = 'Unavailable'; showButton(true); return;
  }
  try {
    const response = await fetch('/api/auth/status');
    if (!response.ok) throw new Error('Cannot reach local Fox authentication');
    const info = await response.json();
    if (info.authenticated) { location.replace('/'); return; }
    setup = !info.registered;
    setupCopy.hidden = !setup;
    buttonLabel.textContent = setup ? 'Create passkey' : 'Unlock with passkey';
    button.disabled = false;
    // Unlocking asks right away; creating the first passkey waits for you to choose to.
    if (setup) showButton(true); else start({ auto: true });
  } catch (error) { status.textContent = error.message; buttonLabel.textContent = 'Unavailable'; showButton(true); }
}
button.addEventListener('click', () => start());
init();
