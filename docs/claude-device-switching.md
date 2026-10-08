# Claude Desktop ↔ iPhone session switching

Investigated 7 October 2026. Scope: Claude Code sessions in Claude Desktop, opened from Mondash.

## Finding

The same running Mac session can be used from the iPhone. Remote Control attaches another interface to the existing local process; it does not require moving execution off the Mac. Anthropic explicitly supports using connected surfaces interchangeably. Desktop exposes both a per-session control and **Settings → Claude Code → Connect new sessions to Remote Control**. The Mac must remain awake and connected. [Official Remote Control documentation](https://code.claude.com/docs/en/remote-control)

The reported Mondash error was therefore a missing Remote Control connection, not a prohibition on using both devices. The important distinction is between the local conversation ID and its Remote Control bridge session ID. Mondash needs the latter to open the existing conversation on the phone. Its live-owner guard must preserve the running process when no bridge exists. [Mondash connection handling](../apps/server/src/lib/claude-remote.ts)

## What the installed code does

Two different control transports appear in Anthropic's shipped code:

| Path | Observed behavior | Implication for Mondash |
| --- | --- | --- |
| Desktop's native Remote Control action | `toggleRemoteControl` reaches `handleRemoteControlCommand`, captures the existing session's `query`, and calls `query.enableRemoteControl(...)`. It waits for the result and records the connection. [S3] | This is an in-place operation on the running session. |
| SDK control channel | `enableRemoteControl` sends a control request with subtype `remote_control` and `enabled: true` through the query's transport. [S4] | Knowing the message shape does not give Mondash ownership of Desktop's private SDK stdin transport. |
| Peer Unix socket | Both inspected CLI versions retain an `onEnableRemoteControl` setter, but their `be()` message dispatchers have no `enable_remote_control` action branch. [S1, S2] | Sending that action to this socket cannot be treated as enabling Remote Control in these builds. |
| Desktop helper for peer CLI sessions | Still writes the `enable_remote_control` action to the socket and reports success after the write completes, without receiving an enablement result. [S5] | A successful socket write is insufficient evidence that a remotely accessible session exists. |

The stale socket sender and absent receiver explain why copying that apparent integration does not solve the problem. The supported native Desktop control uses a different transport. This is version-specific evidence, not a claim that no future CLI version can expose an external enable command.

## Live verification

On the investigated Mac, **Connect new sessions to Remote Control** was off. It was enabled through Desktop's own settings during this investigation.

For one already-running Desktop session, enabling the native session control produced a bridge session ID while retaining PID `87893` and its original process start time, `Wed Oct 7 15:54:12 2026`. This directly verifies that enabling Remote Control need not restart the owning process. It does not, by itself, prove every in-flight tool continued uninterrupted or that the iPhone app successfully joined; that phone check remains outstanding.

All 18 live Desktop sessions present at the start of the migration were then connected through the native session controls. A registry check confirmed all 18 original PIDs were still alive and each now had a bridge. Mondash's `urlForSession` resolved all 18 links; its full `open` path was exercised against one of those sessions and returned its bridge while preserving the PID, process start time, and local session ID. The original Desktop conversation was restored in the UI afterward.

These are observations made during the investigation, not behavior inferred only from documentation. No credentials, transcript contents, or remote session URLs are included here.

## Mondash behavior and remaining gap

1. When an active session already has a bridge, open that bridge from Mondash. Preserve the Mac owner.
2. When an active Desktop or terminal session lacks a bridge, do not stop it, resume a competing copy, or replace it with a background process. Explain the native enable action and retry after a connection exists. For a background job, `claude attach <job-id>` opens its existing terminal interface; run `/remote-control` there. The installed CLI's `attach --help` explicitly says the session keeps running when attaching or detaching.
3. Use Desktop's default setting to make newly created sessions ready for the normal Mondash swipe/open workflow. Existing running sessions still need their own native toggle; the 18 live sessions on this Mac were migrated during the investigation.
4. Treat a socket write as a request attempt, never as proof of success. Discover and validate the resulting bridge before returning a phone link.

The live-owner stop/restart fallback was removed from [Mondash's connection handler](../apps/server/src/lib/claude-remote.ts) as part of this work. This protects continuity; it does **not** implement automatic on-demand enablement for every unconnected running session.

No supported external command or deep link that enables Remote Control inside an arbitrary already-running Desktop session was established by this investigation. A possible next implementation is a Mac Accessibility helper that invokes Desktop's native control, subject to the required OS permission, verifies the selected conversation's identity, and waits for a matching bridge. That needs implementation and validation. Injecting private SDK requests or relying on a debugging port is not an established integration.

For acceptance, test a session that is actively executing on the Mac: open it through Mondash on a physical iPhone, confirm both surfaces show the same conversation and progress, and verify the original PID/start time remain unchanged. Repeat for a new session with auto-connect enabled and an older session enabled manually.

## Primary source inventory and reproduction

The npm package `@anthropic-ai/claude-code@2.1.293` downloaded during the investigation contains a launcher/installer and platform dependencies, rather than the older single large `cli.js`. Its package manifest pins `@anthropic-ai/claude-code-darwin-arm64` to the same version. The installed native binaries were unpacked with `bun-unpacker` 0.12.1; Desktop's Electron ASAR was extracted separately. Vendor source remains outside the repository.

Scratch root: `/tmp/mondash-claude-investigation`. The listed JavaScript files may have been formatted for inspection; use original artifact hashes to identify the exact inputs.

| Reference | Primary artifact and inspection anchor |
| --- | --- |
| S1 | CLI **2.1.293**: `cli/chunk-8113nc0r.js`; `onEnableRemoteControl` setter and `be()` control dispatcher. |
| S2 | Desktop-bundled CLI **2.1.289**: `desktop-cli/chunk-gqbxs78b.js`; same setter and dispatcher. |
| S3 | Desktop **2.26454.0**: `desktop/.vite/build/index.chunk-AgchhrPF.js`; `toggleRemoteControl`, `handleRemoteControlCommand`, and `x.enableRemoteControl` around formatted lines 30874–31117. |
| S4 | CLI **2.1.293**: `cli/chunk-tzb749yr.js`; SDK `enableRemoteControl` and `request` methods. |
| S5 | Desktop **2.26454.0**: `desktop/.vite/build/index.chunk-m09JdlOI.js`; `enable_remote_control` payload and socket write completion around formatted lines 46–83. |

SHA-256 of original inputs:

| Input | SHA-256 |
| --- | --- |
| Installed CLI 2.1.293 native binary | `4e21122a227857da1178aca3299700c1fd7f2b77c93f12e73c2c76db796a105e` |
| Desktop-bundled CLI 2.1.289 native binary | `e0380393e10ecabdc01658349598ba99aae9b85565ffa6b4253d83756361622e` |
| `/Applications/Claude.app/Contents/Resources/app.asar` | `d69630c554f1b41f88c6ea1d0da8202784dac7d16ac8c4cf66ef7906f3c797f9` |
| Downloaded `cli.tgz` npm package | `a96c76dfce0fd4b0449201ac16e6ac4f6517330a9a046b0f53197088f9a1dff4` |

To repeat the analysis, obtain these versions, verify the hashes, unpack the native binaries into separate directories, extract Desktop's ASAR, and search for the identifiers in the inventory. Recheck both sender and receiver before assuming a control action is implemented. Avoid committing extracted vendor source or inspecting/emitting authentication values.
