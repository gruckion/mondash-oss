import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { activityIdentity } from "@mondash/shared/activity";
import type { Card, Row } from "@mondash/shared/contract";
import { isOtherPR } from "@mondash/shared/pr-rows";
import { useTheme } from "@/lib/theme";
import { useShows } from "@/lib/view-options";
import { WorkCardIdentity } from "./work-card-identity";
import { Badges, DetailRow, PRFooter } from "./card-details";
import { MissingLinks } from "./missing-links";
import { PRRow, prKeyFromUrl } from "./pr-row";
import { OtherPRsLink } from "./other-prs-link";
import { isReplyBadge } from "./reply-lip";
import { RowsLink } from "./rows-link";
import { SessionsLink } from "./sessions-link";
import { StartPrSession, StartReview, StartTicketSession, linearTicket, pullRequest } from "./start-review";
import { SourceIcon } from "./web-icons";

export function DashboardCard({
  card,
  onRefresh,
  embedded = false,
  firstInSection = false,
  stacked = false,
  hideStack = false,
}: {
  card: Card;
  onRefresh: () => void;
  embedded?: boolean;
  firstInSection?: boolean;
  /** A stack renders its shared PRs and activity once around the ordinary ticket identity/details. */
  stacked?: boolean;
  /** The enclosing native review stack already presents the chain. */
  hideStack?: boolean;
}) {
  const t = useTheme();
  const shows = useShows();
  const { kind } = card;
  const rows: readonly Row[] = card.rows ?? [];
  const mainRows = rows.filter((row) => !isOtherPR(row) && row.kind !== "notion" && row.kind !== "ticket");
  // Merged and closed PRs fold straight under the open ones, before Slack threads.
  const openPRs = mainRows.filter((row) => row.kind === "pr");
  const otherRows = mainRows.filter((row) => row.kind !== "pr");
  const doc = kind === "scoping" ? rows.find((row) => row.kind === "notion" && row.url === card.url) : undefined;
  const chips = rows.filter((row) => row !== doc && (row.kind === "notion" || row.kind === "ticket"));
  const otherPRs = rows.filter(isOtherPR);
  const badges = card.badges ?? [];
  const replies = kind === "issue" || kind === "scoping" ? badges.filter(isReplyBadge) : [];
  const latest = card.sessions[0];
  const missing =
    kind === "issue" || kind === "pr" || kind === "review" || kind === "scoping"
      ? [
          ...(!rows.some((row) => row.kind === "slack") &&
          !card.links.some((link) => /https:\/\/[^/]+\.slack\.com\//.test(link.url))
            ? ["slack" as const]
            : []),
          ...(!rows.some((row) => row.kind === (kind === "issue" ? "pr" : "ticket"))
            ? [kind === "issue" ? ("github" as const) : ("linear" as const)]
            : []),
          ...(!latest ? ["sessions" as const] : []),
        ]
      : [];
  // With no agent session yet, a review, ticket or PR offers to start one; otherwise the sessions sheet does.
  const ticket = kind === "issue" && !latest ? linearTicket(card) : undefined;
  const pr = !latest ? pullRequest(card) : undefined;
  const action =
    kind === "review" && card.url && !latest ? (
      <StartReview url={card.url} onStarted={onRefresh} />
    ) : ticket ? (
      <StartTicketSession ticketId={ticket.id} url={ticket.url} prs={ticket.prs} onStarted={onRefresh} />
    ) : pr ? (
      <StartPrSession url={pr} onStarted={onRefresh} />
    ) : undefined;
  // Switching off "Missing links" hides the None markers, never the action. A review's action stands in for its None.
  const missingLinks = shows("none")
    ? missing.filter((source) => !(source === "sessions" && kind === "review" && action))
    : [];
  const metadataBadges =
    kind === "scoping" ? badges.filter((badge) => badge.tone === "neutral" && !!badge.people?.length) : [];
  return (
    <View
      style={{
        borderBottomWidth: embedded ? 0 : 1,
        borderBottomColor: t.line,
        paddingTop: firstInSection ? 0 : 12,
        paddingBottom: 12,
        gap: 10,
      }}
    >
      {kind === "issue" ? (
        <WorkCardIdentity card={card} />
      ) : kind === "review" || kind === "pr" ? (
        <>
          <PRRow
            title={card.title}
            reference={card.prKey ?? prKeyFromUrl(card.url, kind === "review" ? card.id : card.subtitle)}
            url={card.url}
            state={
              card.prState ??
              (card.status.toUpperCase() === "MERGED"
                ? "MERGED"
                : card.status.toUpperCase() === "CLOSED"
                  ? "CLOSED"
                  : card.status.toUpperCase() === "DRAFT" || badges.some((badge) => badge.text === "draft")
                    ? "DRAFT"
                    : "OPEN")
            }
            updatedAt={card.updatedAt}
            checks={card.checks}
            summary={card.checksSummary}
            stack={hideStack ? undefined : card.stack}
            aiCheckFailures={card.aiCheckFailures}
            changes={card.changes}
            status={card.status}
            reviewDecision={card.reviewDecision}
            badges={badges}
            author={card.author}
            conflictFix={card.conflictFix}
            footer={shows("reviewers") ? <PRFooter badges={badges} /> : undefined}
          />
        </>
      ) : kind === "scoping" ? (
        <WorkCardIdentity card={card} />
      ) : (
        <Text style={{ color: t.secondary, fontSize: 12 }}>{card.subtitle}</Text>
      )}
      {kind !== "review" && kind !== "pr" && (
        <Badges badges={badges.filter((badge) => !metadataBadges.includes(badge) && !replies.includes(badge))} />
      )}
      {shows("linked") && chips.length > 0 && (
        <View style={{ gap: 6 }}>
          {chips.map((row, i) => (
            <DetailRow key={`${row.url}-${i}`} row={row} onLinked={onRefresh} />
          ))}
        </View>
      )}
      {!stacked && ((shows("prs") && openPRs.length > 0) || (shows("merged") && otherPRs.length > 0)) && (
        <View style={{ gap: 4 }}>
          <View style={{ gap: 8 }}>
            {(shows("prs") ? openPRs : []).map((row, i) => (
              <DetailRow key={`${row.url}-${i}`} row={row} onLinked={onRefresh} />
            ))}
          </View>
          <OtherPRsLink card={card} rows={shows("merged") ? otherPRs : []} onLinked={onRefresh} />
        </View>
      )}
      {!stacked && (
        <RowsLink
          card={card}
          rows={shows("slack") ? otherRows : []}
          heading="Slack threads"
          icon={<SourceIcon source="slack" size={18} />}
          onLinked={onRefresh}
        />
      )}
      {!stacked && latest && shows("sessions") && <SessionsLink card={card} />}
      {action ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <MissingLinks sources={missingLinks} />
          </View>
          {action}
        </View>
      ) : (
        <MissingLinks sources={missingLinks} />
      )}
      {(kind === "issue" || kind === "scoping" || kind === "pr" || kind === "review") && (
        <Pressable
          accessibilityRole="link"
          onPress={() =>
            router.navigate({ pathname: "/activity", params: { work: activityIdentity(card), view: "trails" } })
          }
          style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }}
        >
          <Text style={{ fontSize: 12, color: t.secondary }}>View activity ›</Text>
        </Pressable>
      )}
    </View>
  );
}
