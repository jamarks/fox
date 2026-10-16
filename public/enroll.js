const form = document.querySelector('#enroll');
const button = form.querySelector('button');
const status = document.querySelector('#status');
const codeInput = document.querySelector('#code');
const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (ch) => ch.charCodeAt(0));
const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function post(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
if (!window.isSecureContext || !window.PublicKeyCredential) {
  button.disabled = true;
  status.textContent = 'A secure HTTPS connection and a passkey-capable browser are required.';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = '';
  const code = codeInput.value.trim();
  try {
    const { id, options } = await post('/api/auth/register/options', { code });
    const publicKey = { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: decode(item.id) })) };
    const key = await navigator.credentials.create({ publicKey });
    if (!key) throw new Error('No passkey was created');
    const response = { id: key.id, rawId: encode(key.rawId), type: key.type,
      response: { clientDataJSON: encode(key.response.clientDataJSON), attestationObject: encode(key.response.attestationObject), transports: key.response.getTransports?.() ?? [] },
      clientExtensionResults: key.getClientExtensionResults() };
    await post('/api/auth/register/verify', { id, code, response });
    codeInput.value = '';
    location.replace('/');
  } catch (error) { status.textContent = error.message; button.disabled = false; }
});
