# Mondash agent notes

- A Bun workspace: `apps/app` (Expo, iOS and web), `apps/server` (Bun, Effect v4), `packages/shared` (`@mondash/shared`).
- Use `bun` and `bunx`. For app packages, use `bunx expo install <package>`. Do not use npm.
- Run `bun run check` before you commit. It runs Prettier, types in every workspace, the app lint and the tests.
- Effect is stable v4 (`effect@4.0.1`). Keep `effect` and its platform packages on matching versions. Before changing Effect code, read `node_modules/effect/AGENTS.md` and the examples in `node_modules/effect/ai-docs/`. HTTP modules are in `effect/http` and `effect/http-api`; these APIs remain tagged unstable in the documentation.
- Declare a new endpoint in `packages/shared/src/api.ts`, then implement it in `apps/server/src/http.ts`. The app client gets it from the declaration.
- Data types for the app are Effect Schemas in `packages/shared/src/contract.ts`. They are readonly. Build new objects. Do not change them in place.
- Shared code runs on Hermes on the iPhone. Do not use `Array.prototype.toSorted`.
- The app has its own notes in `apps/app/AGENTS.md`.
