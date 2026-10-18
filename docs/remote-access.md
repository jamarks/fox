# Open the same fox from another device

**VPS passkey mode is opt-in and not a deployment recipe.** From a Fox checkout on a fresh Linux VM with its own HOME, set `FOX_PUBLIC_ORIGIN=https://fox.your-domain` and run `npm start` (not `fox`, which opens a local browser). Fox continues listening only on `127.0.0.1:4848`; you must configure DNS, a TLS reverse proxy that preserves the original `Host` and forwards WebSockets, firewall rules that keep port 4848 private, process supervision and backups before exposing it. The public domain must be stable: a `localhost` passkey cannot be used on that domain, and Fox refuses to start if its credential belongs to a different RP ID. Do not copy `~/.config/fox/passkey.json` from the Mac to the VPS.

For **first enrollment only**, run `FOX_PUBLIC_ORIGIN=https://fox.your-domain node bin/fox-enroll.mjs` over SSH as the same user/HOME that runs Fox. It prints a single-use code valid for 10 minutes. Open the HTTPS Fox URL, type the code into the enrollment page, and create a new passkey. Never place the code in a URL or share it. Once registered, normal visits go straight to Fox's passkey login. This mode uses `Secure`, `HttpOnly`, `SameSite=Strict` cookies and checks the exact configured host and browser origin on requests and WebSockets; it cannot be combined with `FOX_SHARE_PORT`, `FOX_MOBILE_PORT` or `FOX_AUTH_DISABLED=1`. **Do not publish it until HTTPS, unauthorized HTTP/API/WebSocket rejection and a real browser passkey flow have been tested on the VPS.**

The access methods below describe the older Mac setup; they are not a substitute for the VPS configuration above. With local passkey mode enabled, nonlocal hosts are denied even if Tailscale Serve or phone pairing is configured.

Keep fox and fx running on the Mac. Install Tailscale on the Mac and each phone/computer you want to use, and sign in to the same tailnet. On the Mac, with fox running on its default port:

```bash
tailscale serve --bg http://127.0.0.1:4848
tailscale serve status
```

Open the HTTPS tailnet URL reported by `tailscale serve status` on the other device. This serves the **same full panel and live tmux sessions**; nothing is copied or migrated. The Mac must stay awake and fox must stay running. Tailscale Serve is private to your tailnet; do **not** use Funnel, which publishes a public URL. Tailscale is installed separately (check `tailscale serve --help` if your version has different syntax). Fox does not have its own user login: **any device/user allowed by your tailnet policies can control fx and read session contents**. To remove remote access, disable the Serve configuration in Tailscale.

## Personal phone pairing, no email or account

Restart fox with a **separate** local gateway (existing fox processes must be stopped first):

```bash
FOX_SHARE_PORT=4851 fox
```

Install `cloudflared` if needed (`brew install cloudflared`). On the **Mac**, open `http://127.0.0.1:4848` and click **Pair phone** (⌁). Fox starts a temporary Quick Tunnel to its protected `4851` gateway, waits for Cloudflare to connect, and displays a QR automatically. Scan it on your phone, compare the six-digit code on both screens, and **Accept** on the Mac. Use **New QR** if it expires, **Stop sharing** to close the tunnel and revoke all devices, or **Revoke** to remove one phone. Closing just the dialog does not stop sharing. If Cloudflare cannot connect, fox shows an error and keeps the gateway blocked. Without the one-time QR and local approval, the gateway refuses session data, panel actions, and terminal WebSockets. **Never tunnel port 4848 or the old mobile port 4850**: they do not enforce this pairing gate. Quick Tunnel gives a public, changing URL; Cloudflare carries the traffic (not end-to-end encrypted from Cloudflare), but fox only authorizes paired browsers. Access is lost when fox restarts or the tunnel ends, so pair again. The Mac and fox must stay running. Test the real phone/browser flow before relying on remote access.

`FOX_MOBILE_PORT` is an older optional separate mobile view; it is **not needed** for the responsive full panel. The full panel stays on `PORT` (default `4848`) locally, and only `FOX_SHARE_PORT` is intended for a public tunnel when using fox pairing. While `FOX_SHARE_PORT` is set, port 4848 also rejects nonlocal Host headers to reduce accidental bypass; the Tailscale Serve instructions above apply only when pairing mode is **off**.
