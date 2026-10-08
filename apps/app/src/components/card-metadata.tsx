import { Text, View } from "react-native";
import type { Badge, Card, Row } from "@mondash/shared/contract";
import { useTheme } from "@/lib/theme";
import { useShows } from "@/lib/view-options";
import { BadgePill, LabelChips, People, Pill } from "./card-details";
import { NotionStatus } from "./notion-status";
import { notionPriorityColor } from "@mondash/shared/notion-status";
import { PriorityIcon, StatusIcon } from "./web-icons";

/** The grey box under an issue or scoping title: status, priority, people, badges, estimate and labels. */
export function Metadata({
  card,
  badges,
  doc,
}: {
  card: Card;
  badges: readonly Badge[];
  /** A scoping card's own Notion page: who is assigned and the estimate. */
  doc?: Row;
}) {
  const t = useTheme();
  const shows = useShows();
  const issue = card.kind === "issue" || (!card.kind && !!card.linkTicketId);
  const people = issue ? (card.assigned?.people ?? card.people ?? []) : [];
  const details = shows("details");
  const labels = issue && shows("labels") && card.labels.length > 0;
  if (!details && !labels) return null;
  return (
    <View
      style={{
        backgroundColor: t.dark ? "#1c1c1e" : "#f4f4f5",
        borderRadius: 12,
        zIndex: 1,
        padding: 8,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        {details && (
          <>
            {!!card.status && card.kind === "scoping" && <NotionStatus status={card.status} />}
            {!!card.status && card.kind !== "scoping" && (
              <Pill>
                {issue && <StatusIcon status={card.status} statusType={card.statusType} />}
                <Text style={{ color: t.text, fontSize: 12, lineHeight: 16 }}>{card.status}</Text>
              </Pill>
            )}
            {!!card.priority && (
              <Pill>
                <PriorityIcon
                  priority={{
                    value: card.priorityValue ?? { Urgent: 1, High: 2, Medium: 3, Low: 4 }[card.priority] ?? 0,
                    name: card.priority,
                  }}
                  color={card.kind === "scoping" ? notionPriorityColor(card.priority, t.dark) : undefined}
                />
                <Text style={{ color: t.text, fontSize: 12, lineHeight: 16 }}>{card.priority}</Text>
              </Pill>
            )}
            {people.map((person, i) => (
              <Pill key={`${person.name}-${i}`}>
                <People people={[person]} names />
              </Pill>
            ))}
            {!!doc?.assignees?.length && (
              <Pill>
                <People people={doc.assignees} names />
              </Pill>
            )}
            {badges.map((badge, i) => (
              <BadgePill key={`${badge.text}-${i}`} badge={badge} />
            ))}
            {!!doc?.effort && (
              <Pill>
                <Text style={{ color: t.text, fontSize: 12, lineHeight: 16 }}>{doc.effort}</Text>
              </Pill>
            )}
          </>
        )}
        {labels && <LabelChips labels={card.labels} colors={card.labelColors} inline />}
      </View>
    </View>
  );
}
