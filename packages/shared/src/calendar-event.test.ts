import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarEventPresentation } from "./calendar-event";

const start = new Date(2026, 9, 1, 15, 30);
const end = new Date(2026, 9, 1, 16, 30);
const event = { startsAt: start.toISOString(), endsAt: end.toISOString() };

test("event countdown is recomputed from exact times, including start and end boundaries", () => {
  assert.equal(calendarEventPresentation(event, new Date(start.getTime() - 15 * 60_000)).status, "Starts in 15 min");
  assert.equal(calendarEventPresentation(event, new Date(start.getTime() - 1)).status, "Starts in 1 min");
  assert.equal(calendarEventPresentation(event, start).status, "In progress");
  assert.equal(calendarEventPresentation(event, end).status, "Ended");
  assert.equal(calendarEventPresentation(event, new Date(start.getTime() - 2 * 60 * 60_000)).status, "Upcoming");
});

test("event dates distinguish today's meetings, old reminders and overnight events", () => {
  assert.match(calendarEventPresentation(event, start).when, /^Today, 3:30 PM – 4:30 PM$/);
  assert.match(calendarEventPresentation(event, new Date(2026, 9, 2)).when, /^Thu,? 1 Oct,/);
  assert.match(
    calendarEventPresentation({ ...event, endsAt: new Date(2026, 9, 2, 1).toISOString() }, start).when,
    /2 Oct, 1:00 AM$/,
  );
  assert.equal(calendarEventPresentation({ startsAt: event.startsAt }, start).status, "Started");
});
