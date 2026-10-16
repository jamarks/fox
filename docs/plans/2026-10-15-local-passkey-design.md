# Fox local passkey

Scope: local browser access only, no VPS or public-domain release. Fox starts locked; only localhost on a loopback socket may enroll the first credential. WebAuthn binds the credential to the `localhost` RP ID and exact HTTP origin including port. First enrollment is allowed only when no credential record exists; once registered, authentication requires a challenge-bound signed assertion with user verification. Challenge IDs are short-lived and consumed once. Passkey credential and counter persist in `~/.config/fox/passkey.json` (mode 0600); browser sessions remain in memory and expire after 12 hours.

All HTTP endpoints that expose panel data require a valid session; the only exceptions are the login HTML/assets and auth endpoints. WebSocket upgrades check the same session before accepting the terminal, and logout closes existing sockets. Pairing and mobile listeners cannot expose panel data without session authentication. Nonlocal hosts fail closed in this phase; remote/WebAuthn-domain support needs its own design and tests before deployment.

Alternatives considered: a login screen without backend enforcement (unsafe), a standalone authentication reverse proxy (extra process and potential bypass), and built-in WebAuthn (chosen). The legacy remote tests explicitly disable auth in isolated test processes; production auth is enabled by default.

Verification: HTTP and WebSocket denial, one-time enrollment, simulated valid registration and signed assertion, replay rejection, logout, persistent credential across restart, plus focused legacy listener tests. Expiry is enforced in the session guard but has not been time-advanced in an automated test. Manual browser validation of the OS passkey prompt remains necessary.
