# Release checklist

Mondash is licensed under MIT. Publishing the repository is a separate maintainer action from preparing its source.

## Source and data

- Use synthetic identities, provider identifiers and task descriptions in tests and examples.
- Keep account profiles, tokens, database copies, session transcripts, benchmarks and screenshots of real work outside tracked source.
- Review Git history and hosting metadata, including pull requests, cached commit views, releases and build artifacts, before changing visibility. A rewritten default branch does not remove every hosting reference.
- Run `bun run check` and `bun run build` before release.

## Installation verification

Verify setup on another Mac with separate provider accounts, including OAuth callbacks, private token storage, restart and upgrade behavior. Verify the native iPhone connection separately when distributing it. Synthetic provider tests and browser builds do not replace these checks.

Review third-party asset licenses and the vulnerability reporting instructions in `SECURITY.md` before distributing binaries.
