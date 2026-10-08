# Data and permissions

Mondash is a single-user local Mac application. The backend has no application login. It binds to loopback by default. For phone use, publish it only to your private tailnet with Tailscale Serve; do not use public Funnel. Authorized JSON actions can change Slack read markers, link threads to Linear tickets, open desktop apps or start local agent sessions. Cross-site browser writes are rejected. Keep access limited to yourself.

| Feature | Leaves the Mac | Stored locally |
| --- | --- | --- |
| GitHub | Scoped queries through your authenticated CLI | PR metadata, comments, checks and change counts |
| Linear | Queries and explicit thread-link mutations with your API key | Tickets, notifications and joined work |
| Slack | MCP/Web API searches; explicit read-marker changes | Conversation excerpts, participants and read state |
| Notion | Saved-view, user and comment reads | Scoping documents and joined work |
| Local sessions | Mac app/CLI handoffs when requested | Local history references and review registry |
| Classification (opt-in) | Selected work text/context sent to TypeSafe | Decisions and relevance scores |
| Debrief (opt-in classification) | Selected evidence processed by the authenticated Claude CLI | Reports and generation state |
| Notifications (opt-in) | Work summaries sent to configured ntfy server/topic | Notification progress |
| Tracing (opt-in) | Spans sent to your configured OTLP collector | Local service logs |

Provider access is bounded by the accounts and app scopes you grant. Slack MCP admin approval and Notion workspace access are provider requirements. Use your own credentials; do not copy the maintainer's account. Secrets belong in ignored `.env` and private `.mcp-auth` files. Profiles contain non-secret identities and local directories but should still remain private. No analytics provider is enabled by default. Disabled sources retain private cache for recovery while being excluded from the dashboard.
