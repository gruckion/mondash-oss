import { Context } from "effect";

/** Explicit setup reads can discover an account before its dashboard source is activated. */
export const ConnectionSetup = Context.Reference<boolean>("mondash/server/ConnectionSetup", {
  defaultValue: () => false,
});
