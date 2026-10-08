# Mondash

Mondash brings Linear tickets, GitHub reviews, Notion scoping, Slack conversations and local Claude/Codex sessions into one view of work that needs your attention. Tickets link to their PRs, conversations and sessions; reviews group related PRs and highlight replies, requested changes and conflicts.

Each user runs their own copy on their Mac. The Mac stores the data and connects to their accounts. The Expo app runs in a desktop browser or on an iPhone. See the [release checklist](docs/open-source-release.md) for installation and publication verification.

Licensed under the [MIT License](LICENSE).

## Start on your Mac

Requirements: macOS, Bun **1.4.2 or newer**, Node **24.14.0 or newer**, Python 3 for service installation. These exact minimum versions are tested. GitHub integration additionally needs GitHub CLI. Desktop use needs no Tailscale, Metro, Expo account or Apple signing.

```sh
git clone https://github.com/gruckion/mondash-oss.git
cd mondash-oss
bun install --frozen-lockfile
bun run setup
cp .env.example .env
bun run build
bun run start
```

Open **http://localhost:3456/settings**. Add your own identity and enable at least two work sources. GitHub + Linear is the simplest setup when your team uses both: add your GitHub login, run `gh auth login`, put your own `LINEAR_API_KEY` in `.env`, and configure organization scope, ticket prefixes and Linear workspace in Settings. Other combinations are supported; one source is useful temporarily while setting up or recovering a connection.

Save the workspace profile and restart the backend (Ctrl-C, then `bun run start`). Connect Slack and Notion in Settings after the restart. `bun run doctor` reports missing prerequisites with exit code 1 until setup is complete. It never prints tokens. Sources start disabled and saved data remains intact when you turn them off. Classification, notifications and tracing require separate opt-in.

[Setup details](docs/setup.md) cover identity joins, team scopes, Notion columns, OAuth prerequisites and coverage. [Data flows](docs/data-flows.md) explain what leaves your Mac.

## Keep it running

After building and setting up:

```sh
bun run services install backend
bun run services start backend
bun run services status backend
bun run services logs backend
# After changing settings or updating the checkout:
bun run services restart backend
# Remove the launch agent, retain private data:
bun run services uninstall backend
```

Run these commands from the checkout you want launchd to use. `preview backend` produces a private plist without installing it. A running job is never silently replaced. An occupied port blocks startup before any service starts. Phone/Metro setup is optional: [mobile operations](docs/mobile-operations.md).

## Develop

Bun workspaces: `apps/app` (Expo), `apps/server` (Effect v4/Bun), `packages/shared` (typed API and schemas). Declare endpoints in `packages/shared/src/api.ts`, implement them in `apps/server/src/http.ts`; the app uses the same declaration. Provider identifiers remain on the Mac; card responses use display names.

```sh
bun run check    # formatting, types, app lint, all tests
bun run build    # web export and 4 MB JavaScript budget
bun test
```

Run the server from the repository root. `.env`, `mondash.local.json`, `.mcp-auth/` and `.cache/` are private and ignored. Read [CONTRIBUTING](CONTRIBUTING.md) and the package AGENTS.md files before changes. Test profiles and provider payloads are synthetic. Keep real account data and experiment transcripts outside the tracked source tree.
