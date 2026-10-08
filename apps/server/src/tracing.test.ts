import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Tracer } from "effect";
import { withIoSpan } from "./tracing";

test("a provider call keeps its span where the caller turned tracing off", () => {
  const made: string[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      made.push(options.name);
      return new Tracer.NativeSpan(options);
    },
  });
  Effect.runSync(
    Effect.void.pipe(
      withIoSpan("Linear.query"),
      Effect.withSpan("Dashboard.section"),
      Effect.withTracerEnabled(false),
      Effect.withTracer(tracer),
    ),
  );
  assert.deepEqual(made, ["Linear.query"]);
});
