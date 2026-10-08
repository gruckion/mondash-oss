import { Schema } from "effect";
import { ActionError } from "@/lib/action-error";
import { ReviewScopeError } from "@/lib/review-scope";

/**
 * An action (open a session, start a review, link a thread, mark read) that did not work. `message` is for the
 * person; `cause` keeps what really happened, for the log.
 */
export class ActionFailure extends Schema.TaggedError<ActionFailure>()("ActionFailure", {
  action: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A source could not build a section or the connection state, and nothing stored could stand in. */
export class SourceFailure extends Schema.TaggedError<SourceFailure>()("SourceFailure", {
  source: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The words for the person in a failure, if it carries any: an ActionError or ReviewScopeError, or one wrapped in a cause. */
const said = (error: unknown): string | undefined => {
  if (error instanceof ActionError || error instanceof ReviewScopeError) return error.message;
  return error instanceof Error && error.cause !== undefined ? said(error.cause) : undefined;
};

/** Turns any failure of an action into an ActionFailure: its own words when it has them, `fallback` otherwise. */
export const toActionFailure =
  (action: string, fallback: string) =>
  (cause: unknown): ActionFailure =>
    new ActionFailure({ action, message: said(cause) ?? fallback, cause });

/** A cause in words, for the message of a failure that wraps it. */
export const causeText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
