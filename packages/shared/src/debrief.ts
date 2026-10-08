import { Schema } from "effect";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12000));
const Time = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/),
  Schema.makeFilter((s) => Number.isFinite(Date.parse(s))),
);
export const DebriefRange = Schema.Struct({ since: Time, until: Time }).check(
  Schema.makeFilter(
    ({ since, until }) =>
      Date.parse(until) > Date.parse(since) && Date.parse(until) - Date.parse(since) <= 31 * 86400000,
  ),
);
export type DebriefRange = typeof DebriefRange.Type;
export const DebriefCategory = Schema.Literals(["action", "context", "resolved", "noise", "uncertain"]);
export const DebriefUrgency = Schema.Literals(["today", "soon", "later"]);
export const DebriefSource = Schema.Struct({
  title: Text,
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\//),
    Schema.makeFilter((s) => URL.canParse(s)),
  ),
});
export const DebriefItem = Schema.Struct({
  id: Text,
  title: Text,
  detail: Text,
  nextStep: Text,
  category: DebriefCategory,
  urgency: DebriefUrgency,
  incomplete: Schema.optional(Schema.Boolean),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  sources: Schema.Array(DebriefSource),
});
export type DebriefItem = typeof DebriefItem.Type;
export const DebriefReport = Schema.Struct({
  id: Text,
  since: Time,
  until: Time,
  generatedAt: Time,
  summary: Text,
  items: Schema.Array(DebriefItem),
  scannedMessages: Schema.Int,
  scannedThreads: Schema.Int,
  warnings: Schema.Array(Schema.String),
});
export type DebriefReport = typeof DebriefReport.Type;
export const DebriefState = Schema.Struct({
  report: Schema.NullOr(DebriefReport),
  range: Schema.optional(DebriefRange),
  status: Schema.Literals(["idle", "running", "failed"]),
  stage: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type DebriefState = typeof DebriefState.Type;

export const DebriefHistoryEntry = Schema.Struct({
  id: Text,
  since: Time,
  until: Time,
  generatedAt: Time,
  scannedThreads: Schema.Int,
});
export type DebriefHistoryEntry = typeof DebriefHistoryEntry.Type;
