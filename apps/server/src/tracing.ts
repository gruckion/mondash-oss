import { enabled } from "./profile";
import { Effect, Layer, Option, type Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import { ServerConfig } from "@/config";

/** Exports every span (HTTP requests, services, live checks) over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
export const Tracing = Layer.unwrap(
  Effect.gen(function* () {
    const { otlpUrl } = yield* ServerConfig;
    if (!enabled("tracing") || Option.isNone(otlpUrl)) return Layer.empty;
    return OtlpTracer.layer({
      url: `${otlpUrl.value}/v1/traces`,
      resource: { serviceName: "mondash-server" },
    }).pipe(Layer.provide([FetchHttpClient.layer, OtlpSerialization.layerJson]));
  }),
);

/**
 * The span of provider I/O: a provider call, or a store refresh that makes one. It is kept even where the caller turns
 * tracing off, as the app's stream does, so provider calls always show.
 */
export const withIoSpan =
  (name: string, options?: Tracer.SpanOptionsNoTrace) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.withSpan(name, options), Effect.withTracerEnabled(true));
