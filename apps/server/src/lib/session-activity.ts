import { Option, Schema } from "effect";
const Event = Schema.Struct({
  type: Schema.Literal("event_msg"),
  payload: Schema.Struct({ type: Schema.String }),
});
const decode = Schema.decodeUnknownOption(Event);
/** Native turn lifecycle markers, including cancellation; timestamps alone do not mean running. */
export function codexRunning(records: readonly unknown[], fallback?: boolean): boolean | undefined {
  let running = fallback;
  for (const record of records) {
    const event = decode(record);
    if (Option.isNone(event)) continue;
    switch (event.value.payload.type) {
      case "task_started":
        running = true;
        break;
      case "task_complete":
      case "task_failed":
      case "turn_aborted":
        running = false;
        break;
    }
  }
  return running;
}
