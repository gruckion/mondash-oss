/**
 * An action that did not work, with a message written for the person (it is shown in the app as it is). Thrown by the
 * Promise code behind the actions; the Effect services turn it into a typed failure. `cause` keeps what really
 * happened, for the log.
 */
export class ActionError extends Error {
  override readonly name = "ActionError";
  /** A review keeps its session reservation, so a retry reconnects to it. */
  readonly review?: { readonly sessionId?: string; readonly pending?: boolean };
  constructor(message: string, options: { readonly review?: ActionError["review"]; readonly cause?: unknown } = {}) {
    super(message, options);
    this.review = options.review;
  }
}
