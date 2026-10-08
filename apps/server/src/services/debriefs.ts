import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { DebriefRange, DebriefReport, type DebriefState, type DebriefHistoryEntry } from "@mondash/shared/contract";
import { buildDebrief, REPORT_KEY } from "@/lib/debrief";
import { DebriefFailure } from "@/lib/debrief-model";
import { Store, storeKey } from "./store";
import { SlackFailure } from "./slack";
import { toActionFailure, type ActionFailure } from "./errors";

// One atomic SQLite write commits the complete archive. Unlike source caches this key never expires.
const ARCHIVE_KEY = storeKey("debrief:archive:v1", Schema.Array(DebriefReport));
const JOB_KEY = storeKey(
  "debrief:job:v1",
  Schema.Struct({
    range: DebriefRange,
    status: Schema.Literals(["running", "idle", "failed"]),
    error: Schema.NullOr(Schema.String),
  }),
);
type Build = (
  range: DebriefRange,
  progress: (stage: string) => Effect.Effect<void>,
) => Effect.Effect<DebriefReport, unknown>;

/** A single flight owned by the server scope; request cancellation cannot interrupt it. */
export const makeDebriefs = (build: Build) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const scope = yield* Effect.scope;
    const saved = (yield* store.read(ARCHIVE_KEY))?.value;
    const legacy = (yield* store.read(REPORT_KEY))?.value;
    if (!saved && legacy) yield* store.write(ARCHIVE_KEY, [legacy]);
    const archive = store.read(ARCHIVE_KEY).pipe(Effect.map((saved) => saved?.value ?? []));
    const history = archive.pipe(
      Effect.map((reports) =>
        reports.map(({ id, since, until, generatedAt, scannedThreads }) => ({
          id,
          since,
          until,
          generatedAt,
          scannedThreads,
        })),
      ),
      Effect.mapError(toActionFailure("debrief", "Could not read saved debriefs.")),
    );
    const report = (id: string) =>
      archive.pipe(
        Effect.map((reports) => reports.find((report) => report.id === id) ?? null),
        Effect.mapError(toActionFailure("debrief", "Could not read this debrief.")),
      );
    const previous = (yield* store.read(JOB_KEY))?.value;
    let range = previous?.range;
    let status: DebriefState["status"] = previous?.status === "running" ? "failed" : (previous?.status ?? "idle");
    let stage = status === "failed" ? "Could not finish" : "Ready";
    let error =
      previous?.status === "running"
        ? "The Mac restarted before generation finished. Retry to resume collection."
        : (previous?.error ?? null);
    const read = archive.pipe(
      Effect.map((reports) => ({ report: reports[0] ?? null, status, stage, error, ...(range ? { range } : {}) })),
      Effect.mapError(toActionFailure("debrief", "Could not read your saved debrief.")),
    );
    const generate = Effect.fn("Debriefs.generate")(function* (requested: DebriefRange) {
      if (status === "running") return yield* read;
      if (Date.parse(requested.until) > (yield* Clock.currentTimeMillis) + 60000)
        return yield* toActionFailure("debrief", "Choose a period ending now or earlier.")(new Error("Future date"));
      status = "running";
      stage = "Reading Slack";
      error = null;
      range = requested;
      yield* store.write(JOB_KEY, { range: requested, status: "running", error: null }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            status = "failed";
          }),
        ),
        Effect.mapError(toActionFailure("debrief", "Could not save the generation request.")),
      );
      yield* build(requested, (message) =>
        Effect.sync(() => {
          stage = message;
        }),
      ).pipe(
        Effect.flatMap((report) =>
          Effect.gen(function* () {
            const reports = yield* archive;
            yield* store.write(ARCHIVE_KEY, [report, ...reports.filter((saved) => saved.id !== report.id)]);
          }),
        ),
        Effect.tap(() => store.write(JOB_KEY, { range: requested, status: "idle", error: null })),
        Effect.tap(() =>
          Effect.sync(() => {
            status = "idle";
            stage = "Ready";
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("Debrief generation failed", cause);
            const failure = Cause.findErrorOption(cause);
            const known = Option.isSome(failure) ? failure.value : undefined;
            status = "failed";
            stage = "Could not finish";
            error =
              known instanceof DebriefFailure
                ? known.message
                : known instanceof SlackFailure
                  ? `Slack could not finish collection (${known.error ?? "connection failed"}). Retry to resume.`
                  : "Generation could not finish. Your previous report is kept. Retry to resume; check Connections and the backend log if it repeats.";
            yield* store.write(JOB_KEY, { range: requested, status: "failed", error }).pipe(Effect.ignore);
          }),
        ),
        Effect.forkIn(scope),
      );
      return yield* read;
    });
    return { read, generate, history, report };
  });

export class Debriefs extends Context.Service<
  Debriefs,
  {
    read: Effect.Effect<DebriefState, ActionFailure>;
    history: Effect.Effect<readonly DebriefHistoryEntry[], ActionFailure>;
    report(id: string): Effect.Effect<DebriefReport | null, ActionFailure>;
    generate(range: DebriefRange): Effect.Effect<DebriefState, ActionFailure>;
  }
>()("mondash/server/Debriefs") {
  static readonly layer = Layer.effect(
    Debriefs,
    Effect.gen(function* () {
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof buildDebrief>>>();
      return yield* makeDebriefs((range, progress) =>
        buildDebrief(range, progress).pipe(Effect.provideContext(context)),
      );
    }),
  );
}
