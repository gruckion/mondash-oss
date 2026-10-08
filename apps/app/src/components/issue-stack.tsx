import { useMemo } from "react";
import { Text, View } from "react-native";
import { cardScope, rowScope } from "@mondash/shared/linked-items";
import { hasStackPR, prIdentity, stackActivity, type IssueStack } from "@mondash/shared/issue-stacks";
import { useAllHighlighted } from "@/lib/link-highlights";
import { useTheme } from "@/lib/theme";
import { useShows } from "@/lib/view-options";
import { DetailRow } from "./card-details";
import { DashboardCard } from "./dashboard-card";
import { StackCard, StackCardHeader } from "./stack-card";
import { HighlightBox, LinkedItem } from "./linked-item";
import { OtherPRsLink } from "./other-prs-link";
import { RowsLink } from "./rows-link";
import { SessionSummary } from "./sessions-link";
import { SessionOpenSwipe } from "./session-open-swipe";
import { linearTicket } from "./start-review";
import { SourceIcon } from "./web-icons";

/** PRs once, full ticket identities, then shared activity. No folding: replies stay attached to their ticket. */
export function IssueStackCard({ stack, onRefresh }: { stack: IssueStack; onRefresh: () => void }) {
  const t = useTheme();
  const shows = useShows();
  const items = useMemo(() => stack.cards.map(cardScope), [stack.cards]);
  const allHighlighted = useAllHighlighted(items);
  const { threads, sessions, otherPRs } = useMemo(() => stackActivity(stack.cards), [stack.cards]);
  const title = stack.cards.map((card) => card.id).join(" · ");
  const tickets = stack.cards.flatMap((card) => {
    const ticket = linearTicket(card);
    return ticket ? [ticket] : [];
  });
  return (
    <SessionOpenSwipe sessions={sessions}>
      <StackCard>
        <StackCardHeader
          title={`${stack.cards.length} tickets`}
          detail={shows("prs") ? `· ${stack.prs.length} linked PRs` : undefined}
        />
        {shows("prs") &&
          stack.prs.map((row) => {
            const members = stack.cards.filter((card) => hasStackPR(card, row));
            return (
              <LinkedItem key={prIdentity(row)} item={rowScope(row, members)}>
                <DetailRow row={row} onLinked={onRefresh} scope={false} />
                <Text style={{ color: t.secondary, fontSize: 11, lineHeight: 15, paddingHorizontal: 4 }}>
                  {members.length === stack.cards.length ? "All tickets" : members.length === 1 ? "Only" : "Tickets"}
                  {" · "}
                  {members.map((card) => card.id).join(" · ")}
                </Text>
              </LinkedItem>
            );
          })}
        <HighlightBox highlighted={allHighlighted} padding={0} gap={8}>
          {stack.cards.map((card, index) => (
            <LinkedItem key={card.id} item={items[index]} outlined={!allHighlighted}>
              <DashboardCard
                card={card}
                onRefresh={onRefresh}
                stacked
                embedded={index === stack.cards.length - 1}
                firstInSection
              />
            </LinkedItem>
          ))}
        </HighlightBox>
        {((shows("merged") && otherPRs.length > 0) ||
          (shows("slack") && threads.length > 0) ||
          (shows("sessions") && sessions.length > 0)) && (
          <View style={{ padding: 8, gap: 8, borderTopWidth: 1, borderTopColor: t.line }}>
            <OtherPRsLink title={title} rows={shows("merged") ? otherPRs : []} onLinked={onRefresh} />
            <RowsLink
              title={title}
              rows={shows("slack") ? threads : []}
              heading="Slack threads"
              icon={<SourceIcon source="slack" size={18} />}
              onLinked={onRefresh}
            />
            {shows("sessions") && sessions.length > 0 && (
              <SessionSummary
                group={{
                  id: `stack:${title}`,
                  label: "Shared PR tickets",
                  title,
                  sessions,
                  tickets,
                }}
              />
            )}
          </View>
        )}
      </StackCard>
    </SessionOpenSwipe>
  );
}
