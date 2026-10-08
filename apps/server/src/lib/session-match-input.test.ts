import assert from "node:assert/strict";
import { test } from "node:test";
import { matchInput } from "./session-match-input";
import type { AgentSession } from "./sessions";
import type { WorkItem } from "./session-match";

const session: AgentSession = {
  tool: "codex",
  id: "test",
  title: "Mixed work",
  firstPrompt: "Investigate",
  lastPrompt: "Thanks",
  cwd: "",
  refs: {},
  promptRefs: {},
  updatedAt: new Date(0),
};

test("Notion and Slack references keep an earlier work exchange after the topic changes", () => {
  for (const [ref, url] of [
    ["notion:03cf7d0610c1588a836f2fce81dd0b87", "https://notion.so/03cf7d0610c1588a836f2fce81dd0b87"],
    ["slack:CABC/2754275190.123456", "https://example.slack.com/archives/CABC/p2754275190123456"],
  ]) {
    const item: WorkItem = {
      key: "target",
      kind: "Notion Roadmap card",
      title: "Production accounting",
      status: "Open",
      refs: [ref],
    };
    const input = matchInput(session, item, [
      { role: "user", text: "Build the change described at " + url, at: "1" },
      { role: "assistant", text: "Implemented the requested change", at: "2" },
      { role: "user", text: "Explain a different subsystem", at: "3" },
      { role: "assistant", text: "Here is the explanation", at: "4" },
      { role: "user", text: "Run an unrelated chore", at: "5" },
      { role: "assistant", text: "Finished the chore", at: "6" },
    ]);
    assert.ok(
      input.paired.work_exchanges.some(
        (e) => e.user.includes(url) && e.assistant === "Implemented the requested change",
      ),
    );
  }
});

test("a ticket prefix is not a topic shared by unrelated work", () => {
  const item: WorkItem = {
    key: "APP-42",
    kind: "Linear ticket",
    title: "APP-42 encryption",
    status: "Open",
    refs: ["ticket:APP-42"],
  };
  const input = matchInput(session, item, [
    { role: "user", text: "Investigate encryption", at: "1" },
    { role: "assistant", text: "Encryption investigated", at: "2" },
    { role: "user", text: "APP-9 fonts", at: "3" },
    { role: "user", text: "APP-10 colors", at: "4" },
  ]);
  assert.ok(input.paired.work_exchanges.some((e) => e.user === "Investigate encryption"));
});
