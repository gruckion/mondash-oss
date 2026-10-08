import assert from "node:assert/strict";
import { test } from "node:test";
import { Data, Effect } from "effect";
import type { Group, Row } from "@mondash/shared/contract";
import { enrichTicketRows } from "./ticket-rows.ts";

const row = (id: string): Row => ({
  kind: "ticket",
  reference: id,
  title: id,
  url: `https://linear.app/example/issue/${id}`,
});
const group = (rows: Row[]): Group => ({
  id: "prs",
  title: "",
  collapsed: false,
  cards: [
    {
      id: "pr",
      kind: "pr",
      title: "PR",
      subtitle: "",
      status: "",
      attention: [],
      labels: [],
      links: [],
      related: [],
      sessions: [],
      rows,
    },
  ],
});

class Offline extends Data.TaggedError("Offline") {}

const lookupWith = (calls: string[][], answer: (id: string) => Row | undefined) => (ids: ReadonlyArray<string>) =>
  Effect.sync(() => {
    calls.push([...ids]);
    return new Map(
      ids.flatMap((id) => {
        const found = answer(id);
        return found ? [[id, found] as const] : [];
      }),
    );
  });

test("ticket enrichment looks every referenced ticket up in one call and leaves rich rows intact", async () => {
  const rich = { ...row("DEMO-2"), title: "Saved ticket", owner: { name: "Taylor R" } };
  const rows = [row("DEMO-1"), row("DEMO-1"), row("DEMO-3"), rich];
  const calls: string[][] = [];
  const enriched = await Effect.runPromise(
    enrichTicketRows(
      [group(rows)],
      lookupWith(calls, (id) => ({
        ...row(id),
        title: "Actual ticket title",
        status: "Todo",
        statusType: "unstarted",
        priorityValue: 2,
      })),
    ),
  );
  assert.equal(rows[0].title, "DEMO-1", "readonly input is untouched");
  const updated = enriched[0].cards[0].rows!;
  assert.deepEqual(calls, [["DEMO-1", "DEMO-3"]]);
  assert.equal(updated[0].title, "Actual ticket title");
  assert.equal(updated[1].priorityValue, 2);
  assert.equal(updated[2].title, "Actual ticket title");
  assert.equal(rows[3], rich);
  assert.equal(rows[3].title, "Saved ticket");
  assert.deepEqual(rows[3].owner, { name: "Taylor R" });
});

test("a missing or inaccessible Linear ticket keeps its existing valid link", async () => {
  const rows = [row("DEMO-1"), row("DEMO-2")];
  await Effect.runPromise(enrichTicketRows([group(rows)], () => Effect.fail(new Offline())));
  await Effect.runPromise(
    enrichTicketRows(
      [group(rows)],
      lookupWith([], (id) => (id === "DEMO-2" ? row("DEMO-999") : undefined)),
    ),
  );
  assert.deepEqual(rows, [row("DEMO-1"), row("DEMO-2")]);
});

test("no ticket rows means no lookup", async () => {
  const calls: string[][] = [];
  await Effect.runPromise(
    enrichTicketRows(
      [group([])],
      lookupWith(calls, () => undefined),
    ),
  );
  assert.deepEqual(calls, []);
});
