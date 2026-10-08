import { test, expect } from "bun:test";
import { defaultProfile } from "./profile";
import { inspectNotionRows } from "./notion-setup";

test("view inspection validates renamed columns, optional omissions, statuses and incomplete pages", () => {
  const mapping = {
    ...defaultProfile().notion,
    properties: {
      title: "Task",
      status: "Stage",
      owner: "Owners",
      reviewer: null,
      priority: null,
      effort: null,
      effortDays: null,
      created: null,
      updated: null,
    },
  };
  const row = {
    Task: "Plan checkout",
    Stage: "Discovery",
    Owners: '["user://alex"]',
    url: "https://notion.so/example",
  };
  expect(inspectNotionRows([row], false, mapping)).toEqual({
    columns: ["Owners", "Stage", "Task"],
    missing: [],
    statuses: ["Discovery"],
    rows: 1,
    truncated: false,
  });
  expect(inspectNotionRows([{ Task: "Plan checkout" }], false, mapping).missing).toEqual([
    "status: Stage",
    "owner: Owners",
  ]);
  expect(inspectNotionRows(Array(100).fill(row), false, mapping).truncated).toBe(true);
  expect(inspectNotionRows([], true, mapping).truncated).toBe(true);
});
