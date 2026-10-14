# `fox` launcher

Add a small Node executable exposed as the package's `fox` binary. Running `fox` without arguments checks `http://127.0.0.1:${PORT || 4848}/`. If fox is already there, open the browser. If the port is free, start the server in the same foreground Node process, wait until it serves the panel, then open the browser. Ctrl+C stops only fox; tmux-backed fx sessions survive. Never open an unrelated server on that port or spawn a background daemon.

Use the native browser opener (`open` on macOS, `xdg-open` on Linux). Report invalid ports, startup/browser failures, and port conflicts clearly. Test running/offline/unrelated-server cases with injected HTTP/browser operations, then document `npm link` (optional) and `node bin/fox.mjs` for direct use. Do not commit without explicit request.
