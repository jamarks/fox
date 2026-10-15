const status = document.getElementById('status');
const token = new URLSearchParams(location.hash.slice(1)).get('pair');
// Strip the secret immediately so screenshots, history and copied URLs do not keep it.
history.replaceState(null, '', '/');
if (!token) status.textContent = 'This pairing link is missing or expired. Generate a fresh QR code on the Mac.';
else {
  (async () => {
    try {
      const start = await fetch('/api/pair/request', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, name: navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Phone' }),
      });
      if (!start.ok) throw new Error('The QR code has expired or was already used. Generate a new one on the Mac.');
      const { id, claim, code } = await start.json();
      document.getElementById('digits').textContent = code;
      document.getElementById('code').hidden = false;
      status.textContent = 'Compare the code on both screens before approving.';
      const timer = setInterval(async () => {
        try {
          const res = await fetch('/api/pair/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, claim }) });
          if (!res.ok) throw new Error('Pairing failed. Scan a new QR code.');
          const result = await res.json();
          if (result.status === 'pending') return;
          clearInterval(timer);
          if (result.status === 'approved') location.replace('/');
          else status.textContent = result.status === 'expired' ? 'Pairing expired. Scan a new QR code.' : 'Pairing was rejected on the Mac.';
        } catch (error) { clearInterval(timer); status.textContent = error.message; }
      }, 2000);
    } catch (error) { status.textContent = error.message; }
  })();
}
