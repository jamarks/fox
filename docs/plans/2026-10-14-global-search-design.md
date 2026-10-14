# Global search (Spotlight-style)

Search session names and user/assistant messages across all fx sessions without changing fx files. The existing per-conversation search remains available with ⌥F.

## Interaction

A compact floating palette opens with ⌥Space or a visible search button. It focuses its query, supports arrow-key selection, Enter to open, Escape/backdrop to close, and reports loading, empty and error states. Results identify workspace, session, author and a highlighted excerpt. Archived sessions and subagents are included. Choosing a message selects the session and reveals the matching message in its transcript; choosing a name selects the session. Neither action starts a dormant fx process.

## Data flow

A local HTTP search endpoint accepts a bounded query. On demand, the Node server builds an in-memory index from `~/.fx/sessions/*/{session.json,events.jsonl}` and fox custom names. Each session's index entry is refreshed when the event file's size/mtime or session title/custom name changes; missing sessions are removed. Only `user` and `assistant` event text is indexed. No tool arguments/results or artifacts are searched. Query scoring prioritizes matching names, then messages, and returns a bounded set of results with session id, event index, snippet and metadata. There is no persistent index and no model call.

## Failure and verification

A missing/unreadable event file yields name-only results; a transient HTTP failure is shown in the palette. Requests are debounced and stale responses ignored. Test title/message matches, exclusion of tool output, cache invalidation, highlighting and selection of archived/subagent results; run syntax and whitespace checks. Do not commit without explicit request.
