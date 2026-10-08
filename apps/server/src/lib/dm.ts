import { enabled } from "../profile";
import { Duration, Effect, Schema } from "effect";
import { dmContext, dmPermalink } from "@/lib/dm-context";
import { choice } from "@/lib/jev";
import { person } from "@/lib/people";
import { dmChannels, dmMessages, myWorkspace, mySlackId } from "@/lib/slack-web";
import { Store, storeKey } from "@/services/store";

/** A PR that someone has reviewed or commented on, as far as DM matching cares. */
export type DmPR = {
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly createdAt: Date;
  /** Your last push or comment on it; see PullRequest. */
  readonly yourLastActivityAt: Date | undefined;
  readonly people: ReadonlyArray<string>;
  readonly approvedBy: ReadonlyArray<string>;
  /** Open review threads per person, by GitHub login. */
  readonly waitingBy: Readonly<Record<string, number>>;
};
/** Something in a DM that is still waiting on you about that PR. */
export const DmHint = Schema.Struct({ from: Schema.String, at: Schema.Date, url: Schema.String, jev: Schema.Finite });
export type DmHint = typeof DmHint.Type;

const DAY = 24 * 60 * 60 * 1000;
// The DM is read from a week before their earliest PR: the conversation usually starts before the PR does.
const LEAD_DAYS = 7;
// Below this, the DM is about something else.
const THRESHOLD = 0.6;
const NONE = "none";
// Part of the cache key: bump it when the question or the facts change, so stored answers are not reused.
const ASK = 3;

const Scores = Schema.Record(Schema.String, Schema.Finite);

/** What Jev is told about a PR besides the conversation. */
type PrFacts = {
  title: string;
  review: string;
  their_open_review_threads: number;
  you_updated_it_after_their_last_message: boolean;
};

/** What Jev is told about `pr`, given the time of `login`'s last message in the DM (ms), if they wrote one. */
export const prFacts = (pr: DmPR, login: string, theirLastAt: number | undefined): PrFacts => ({
  title: pr.title,
  review: pr.approvedBy.includes(login) ? "approved by them" : pr.state,
  their_open_review_threads: pr.waitingBy[login] ? pr.waitingBy[login] : 0,
  you_updated_it_after_their_last_message:
    theirLastAt !== undefined && pr.yourLastActivityAt !== undefined && pr.yourLastActivityAt.getTime() > theirLastAt,
});

/**
 * For each person who reviewed or commented on your open PRs, one Jev question over your DM with them:
 * which of their PRs, if any, has a point you have not answered or acted on. Interleaved topics are why Jev
 * reads the conversation instead of just checking who spoke last.
 * Jev sees about 550 tokens: the work part of the DM (see dm-context) and each PR's title and state.
 */
export const getPrDMs = Effect.fn("dm.getPrDMs")(function* (prs: ReadonlyArray<DmPR>) {
  if (!enabled("slack") || !enabled("classification")) return new Map<string, DmHint>();
  const [me, channels, workspace] = yield* Effect.all([mySlackId(), dmChannels(), myWorkspace()], {
    concurrency: "unbounded",
  });
  if (!me || !workspace) return new Map<string, DmHint>();

  const byPerson = new Map<string, DmPR[]>();
  for (const pr of prs) {
    for (const login of pr.people) {
      const p = person(login);
      if (!p || p.slack === me) continue;
      byPerson.set(p.slack, [...(byPerson.get(p.slack) ? byPerson.get(p.slack)! : []), pr]);
    }
  }

  const hints = yield* Effect.forEach(
    byPerson,
    ([slack, theirPRs]) =>
      Effect.gen(function* () {
        const none: [string, DmHint][] = [];
        const login = theirPRs[0].people.find((l) => person(l)?.slack === slack);
        if (!login) return none;
        const channel = channels.get(slack);
        if (!channel) return none;
        const oldest = (Math.min(...theirPRs.map((pr) => pr.createdAt.getTime())) - LEAD_DAYS * DAY) / 1000;
        const messages = yield* dmMessages(channel, oldest);
        const context = dmContext(messages, me);
        const last = messages.at(-1);
        if (context.length === 0 || !last) return none;

        // What happened outside Slack: a DM asking for a review is settled by their approval, not by a reply.
        const theirLast = messages.filter((m) => m.user !== me).at(-1);
        const theirLastAt = theirLast ? Number(theirLast.ts) * 1000 : undefined;
        const facts: Record<string, PrFacts> = Object.fromEntries(
          theirPRs.map((pr) => [pr.key, prFacts(pr, login, theirLastAt)]),
        );
        const answer = yield* ask(slack, theirPRs, context, last.ts, facts).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Jev could not read the DM with ${slack}.`, error).pipe(Effect.as(undefined)),
          ),
        );
        if (!answer) return none;
        return theirPRs.flatMap((pr): [string, DmHint][] => {
          const jev = answer[pr.key];
          return jev !== undefined && jev >= THRESHOLD
            ? [
                [
                  pr.key,
                  {
                    from: slack,
                    at: new Date(Number(last.ts) * 1000),
                    url: dmPermalink(workspace, channel, last.ts),
                    jev,
                  },
                ],
              ]
            : [];
        });
      }),
    { concurrency: 3 },
  );
  return new Map(hints.flat());
});

/** Cached per person, PRs and last message: the answer only changes when one of those does. */
const ask = (
  slack: string,
  prs: ReadonlyArray<DmPR>,
  context: string[],
  lastTs: string,
  facts: Record<string, PrFacts>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const criteria = Object.fromEntries([
      ...prs.map((pr) => [
        pr.key,
        `They raised something about ${pr.key} (${pr.title}) in this DM, and it has not been answered or acted on yet.`,
      ]),
      [
        NONE,
        "Nothing about these pull requests is still waiting on you. Anything they asked for was handled: you answered it, or the pull request facts show it (they approved it, their review threads are closed, or you updated it after their last message).",
      ],
    ]);
    const state = { dm: context, their_pull_requests: facts };
    // The facts are in the key: an approval or a push has to be asked again, not answered from the store.
    return yield* store.cached(
      storeKey(["jev-dm", ASK, slack, lastTs, JSON.stringify(facts)].join(":"), Scores),
      Duration.days(1),
      choice(
        state,
        criteria,
        "Decide whether this direct message leaves something outstanding for you. Only what they raised in the DM counts: open review threads on a pull request they never mentioned here are shown elsewhere and are not your answer. Several topics can be interleaved, so do not go by who spoke last. The facts say what happened outside Slack, where the work usually gets done; use them to rule out anything already handled, for example they approved it, their threads are closed, or you updated it after their message.",
      ),
    );
  });
