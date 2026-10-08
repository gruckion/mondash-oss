import { ActionError } from "./action-error.ts";

/** An action's outcome as one value, so a test can compare it whole. */
export type Settled<T> =
  | (T & { readonly ok: true })
  | { readonly ok: false; readonly message: string; readonly sessionId?: string; readonly pending?: boolean };

/** For tests: resolves with the action's value or its ActionError as data. Other errors still reject. */
export const settle = <T extends object>(action: Promise<T>): Promise<Settled<T>> =>
  action.then(
    (value): Settled<T> => ({ ...value, ok: true }),
    (error: unknown): Settled<T> => {
      if (!(error instanceof ActionError)) throw error;
      return { ok: false, message: error.message, ...error.review };
    },
  );
