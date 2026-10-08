import assert from "node:assert/strict";
import { test } from "node:test";
import { isCodexAppServer } from "./codex-remote-host";

test("desktop readiness detects legacy and bundled Codex app servers without accepting other CLI processes", () => {
  assert.equal(isCodexAppServer("/Applications/ChatGPT.app/Contents/Resources/codex -c option=true app-server"), true);
  assert.equal(isCodexAppServer("/Applications/Codex.app/Contents/Resources/codex app-server"), true);
  assert.equal(
    isCodexAppServer(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
    ),
    true,
  );
  assert.equal(
    isCodexAppServer(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec-server --remote https://example.com",
    ),
    false,
  );
  assert.equal(isCodexAppServer("/Users/example/.local/bin/codex app-server"), false);
});
