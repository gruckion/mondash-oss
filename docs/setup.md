# Configure your own Mac

`bun run setup` creates `mondash.local.json` with mode 0600, without replacing an existing profile. Settings uses a typed API to save it atomically, keeping `.previous`. Settings displays both active connection coverage and a restart reminder when saved settings differ from the running backend. Invalid versions, unknown fields, duplicate identifiers, ambiguous mappings and relative project folders are rejected.

## People and self

Add your own name and available GitHub login, email and Slack member ID. Missing identifiers stay missing; Mondash never substitutes the maintainer's identity. The advanced profile editor accepts more people and `aliases`. Explicit provider IDs and aliases join accounts case-insensitively. Names only resolve if unique; duplicate names never guess an account. `directory.me` must resolve to one explicit row. Provider IDs can be incomplete: a GitHub-only person is valid. No automatic account discovery rewrites confirmed mappings.

## Workspace

`workspace.organizations` limits authored/merged PRs and broad human-review searches. Empty means personal/all accessible scope. Directly requested and already-reviewed PRs remain global. Configure each `reviewTeams` entry with its organization and slug; each team is queried separately. `ticketPrefixes` controls ticket extraction (for example APP, OPS), and `linearWorkspace` supplies ticket URLs. Absolute `directories` map an owner or owner/repository to a local folder; repository entries override owner entries. Session actions fail with setup guidance when their folder is missing, rather than opening someone else's project.

## Connections

- **GitHub:** your own `gh auth login` and login in Settings. Mondash reads through the CLI's permissions.
- **Linear:** your own `LINEAR_API_KEY` in root `.env`; enable it in Settings. API calls use your account's access.
- **Slack:** your own approved confidential Slack MCP app, with `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in `.env`, your Slack member ID in the profile, then interactive sign-in. Register exactly the callback address displayed by doctor. Workspace admin approval and app eligibility may be required. The shipped path uses `client_secret_post`; public-client PKCE has only experimental evidence and is not offered as a working substitute.
- **Notion:** choose a saved view URL, map its exact column names in the advanced editor, then sign in. Title and status are required; set optional columns to `null` when absent. Owner/reviewer are Notion people properties. Configure scoping/open/ready-to-review statuses to match your workflow. Missing required columns produce a connection error. User resolution comes from Notion's own user response.
- **Sessions:** local Claude Code/Codex history and Mac handoffs; enabled separately. No session registry is opened when disabled.

OAuth redirects default to `http://localhost:<port>/api/auth/<slack|notion>/callback`; an explicitly configured HTTPS private phone origin is also allowed. Use localhost for sign-in. Changing the port or phone origin may require updating the registered app and signing in again. Arbitrary forwarded hosts are rejected. Refresh tokens are preserved when omitted by the provider and replaced when rotated; issuer mismatches reject old credentials. Direct Slack API calls use the same refresh queue as MCP calls.

## Partial coverage

Work from available sources remains visible when another source fails. Disabled sources stop calling providers and disappear from cards, without deleting saved state. Pending, unknown, stale, failed and truncated coverage appears with the work. Missing/invalid timestamps do not count as fresh. Authored GitHub PRs and their probe paginate through the available search results; GitHub’s search ceiling still applies and excess authored results are disclosed. Other searches remain bounded (30 merged, 25 requested/team/reviewed, 60 broad); excess results are disclosed. Notion saved-view fetches stop at 100 and disclose possible truncation. Narrow the selected view/scope or inspect the provider directly; an empty result is not proof there is no work.

Classification uses TypeSafe only when enabled and both TYPESAFE variables are present. Explicit ticket/PR links continue to work without it. Unclassified session candidates remain in Sessions and are not guessed into unrelated cards. Debrief generation currently requires classification and the local Claude CLI; saved reports remain available without either.

## Recovery and updates

Stop the backend before restoring state. Back up `.env`, `mondash.local.json`, `.mcp-auth` and `.cache` privately; copy SQLite databases only after writers stop, or use SQLite's backup/VACUUM INTO API. Restore the previous checkout/build and corresponding state together for rollback. OAuth may rotate tokens: retain the newest valid credential store; never run two copied stores concurrently against one refresh token. Atomic profile/token writes sync the file and directory and serialize processes. A crashed writer leaves `.lock`; stop all writers and inspect/restore the main or `.previous` file before removing that lock. Never resolve contention by deleting a live writer's lock.
