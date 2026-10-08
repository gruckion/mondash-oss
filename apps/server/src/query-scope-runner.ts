// Disposable-process characterization of the actual production query builders; no GitHub calls.
import { Effect, Schema } from "effect";
import { Gh } from "./services/gh";
import { Store } from "./services/store";
import { getMyOpenPRs, getMyOtherPRs, getReviewFeed, probeGitHub } from "./lib/github";
const queries: string[] = [];
const empty = { nodes: [], issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
const gh = Gh.of({
  json: (args, schema) => {
    queries.push(args.find((arg) => arg.startsWith("query=")) ?? "");
    return Schema.decodeUnknownEffect(schema)({
      data: {
        viewer: { login: "alex" },
        mine: empty,
        search: empty,
        requested: empty,
        team: empty,
        reviewed: empty,
        humans: empty,
      },
    }).pipe(Effect.orDie);
  },
});
await Effect.runPromise(
  Effect.gen(function* () {
    yield* getMyOpenPRs();
    yield* getMyOtherPRs();
    yield* getReviewFeed();
    yield* probeGitHub();
  }).pipe(Effect.provide(Store.layerMemory), Effect.provideService(Gh, gh)),
);
console.log(JSON.stringify(queries));
