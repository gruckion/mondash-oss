# Contributing

Use Bun and bunx; install app dependencies with `bunx expo install`. Run `bun install --frozen-lockfile`, `bun run check` and `bun run build` before a PR. Read AGENTS.md and package notes. Effect is v4: use its installed AGENTS.md/ai-docs rather than v3 examples. Shared schemas are readonly and run on Hermes; avoid Array.prototype.toSorted there.

Keep personal profiles, provider credentials, cached work and screenshots containing real work out of commits. Use synthetic fixtures. Preserve joined multi-source attention behavior: an unavailable enrichment must not hide base work, disabled sources must make zero calls, and partial coverage must remain explicit. Include verification appropriate to the behavior, plus browser/native evidence for UI changes. Declare typed endpoints in packages/shared before implementing them. All checked-in account and task fixtures must remain synthetic; preserve their behavioral coverage when changing examples.
