# Browser tab title for sessions

The browser tab shows `fox` on the session list/overview and `<displayed session name> · fox` when viewing a session. Use the same display-name precedence as the session list, including custom names and subagent names. Recompute after selection, rename, overview polling, navigation between mobile views, and restoring a deep link. Missing or untitled sessions fall back to `fox`.

Implement this in the existing frontend state, without changing server APIs or navigation URLs. The separate phone reader uses its own displayed session name and restores `fox` when returning home. Verify the title after entering a session, renaming it, and returning to the session list.
