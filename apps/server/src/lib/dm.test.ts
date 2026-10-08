import assert from "node:assert/strict";
import { test } from "node:test";
import { prFacts, type DmPR } from "./dm.ts";
import { yourLastActivity } from "./github.ts";

const at = (iso: string) => new Date(iso).getTime();
const by = (login: string, createdAt: string) => ({
  author: { login, __typename: "User" },
  createdAt,
  url: `u/${login}/${createdAt}`,
});
// Their DM at 10:00. updatedAt would move with anyone's review, so it is not part of the check.
const dmAt = at("2026-09-20T10:00:00Z");
const pr = (committedDate: string, comments: ReturnType<typeof by>[] = []): DmPR => ({
  key: "web#1856",
  title: "Fix it",
  state: "open",
  createdAt: new Date("2026-09-19T00:00:00Z"),
  yourLastActivityAt: yourLastActivity(
    {
      commits: { nodes: [{ commit: { committedDate } }] },
      reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [by("me", "2026-09-19T12:00:00Z")] } }] },
      comments: { nodes: comments },
    },
    "me",
  ),
  people: ["alice"],
  approvedBy: [],
  waitingBy: {},
});

test("someone else's activity after the DM is not your reply; your push or comment is", () => {
  const reviewedLater = pr("2026-09-19T09:00:00Z", [by("alice", "2026-09-20T11:00:00Z")]);
  assert.equal(prFacts(reviewedLater, "alice", dmAt).you_updated_it_after_their_last_message, false);
  assert.equal(prFacts(pr("2026-09-20T11:00:00Z"), "alice", dmAt).you_updated_it_after_their_last_message, true);
  const commentedLater = pr("2026-09-19T09:00:00Z", [by("me", "2026-09-20T11:00:00Z")]);
  assert.equal(prFacts(commentedLater, "alice", dmAt).you_updated_it_after_their_last_message, true);
  assert.equal(prFacts(pr("2026-09-20T11:00:00Z"), "alice", undefined).you_updated_it_after_their_last_message, false);
});
