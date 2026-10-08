// Run: node --test src/lib/ticket-comments.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketReply, type TicketComment } from "./ticket-comments.ts";

const url = "https://linear.app/example/issue/DEMO-4214";
const at = (n: number) => new Date(`2026-09-${String(n).padStart(2, "0")}T10:00:00Z`);
const c = (id: string, author: string, day: number, parentId?: string, resolved = false): TicketComment => ({
  id,
  author,
  createdAt: at(day),
  parentId,
  resolved,
});

test("their reply to your thread waits on you, and links to it", () => {
  const reply = ticketReply([c("1", "me", 22), c("2", "morgan@example.com", 24, "1")], "me", false, url);
  assert.deepEqual(reply?.from, ["morgan@example.com"]);
  assert.equal(reply?.url, `${url}#comment-2`);
  assert.equal(
    ticketReply([c("1", "me", 22), c("2", "morgan@example.com", 24, "1"), c("3", "me", 25, "1")], "me", false, url),
    null,
    "you answered",
  );
});

test("on your own ticket, a thread you never joined still waits on you", () => {
  const started = [c("1", "morgan@example.com", 24)];
  assert.equal(ticketReply(started, "me", true, url)?.count, 1, "your ticket, so it is yours to answer");
  assert.equal(ticketReply(started, "me", false, url), null, "someone else's ticket and not your thread");
});

test("a resolved thread is done, and every waiting thread counts", () => {
  const comments = [
    c("1", "me", 22),
    c("2", "morgan@example.com", 23, "1"),
    c("3", "me", 22),
    c("4", "morgan@example.com", 24, "3", true),
  ];
  const reply = ticketReply(comments, "me", true, url);
  assert.equal(reply?.count, 1);
  assert.equal(reply?.url, `${url}#comment-2`);
});
