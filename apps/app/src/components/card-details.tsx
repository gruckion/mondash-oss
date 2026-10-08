import { Icon } from "./icon";
import { use, useMemo, type ReactNode } from "react";
import { Image } from "expo-image";
import { Pressable, Text, View } from "react-native";
import type { Badge, Person, Row } from "@mondash/shared/contract";
import { ago, useTheme } from "@/lib/theme";
import { useOpenUrl } from "./ui";
import { PriorityIcon, SourceIcon, StatusIcon } from "./web-icons";
import { JevScore } from "./jev-score";
import { ThreadLink } from "./thread-link";
import { PRRow, prKeyFromUrl, rowPRState } from "./pr-row";
import { isReplyBadge, replyAuthor } from "./reply-lip";
import { prFooterBadges } from "@mondash/shared/pr-presentation";
import { rowScope } from "@mondash/shared/linked-items";
import { ContainingItem } from "@/lib/link-highlights";
import { LinkedItem } from "./linked-item";

export function Pill({ children, backgroundColor }: { children: ReactNode; backgroundColor?: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 4,
        minHeight: 24,
        borderRadius: 20,
        maxWidth: "100%",
        backgroundColor: backgroundColor ?? (t.dark ? "#ffffff0d" : "#00000006"),
      }}
    >
      {children}
    </View>
  );
}

export function People({ people, names = false }: { people: readonly Person[]; names?: boolean }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        flexShrink: 1,
      }}
    >
      {people
        .slice(0, 3)
        .map((person, i) =>
          person.avatar ? (
            <Image
              key={`${person.name}-${i}`}
              source={person.avatar}
              accessible
              accessibilityLabel={person.name}
              style={{ width: 15, height: 15, borderRadius: 8 }}
            />
          ) : null,
        )}
      {names && (
        <Text
          selectable
          style={{
            color: t.secondary,
            fontSize: 12,
            lineHeight: 16,
            flexShrink: 1,
          }}
        >
          {people.map((p) => p.name).join(", ")}
        </Text>
      )}
    </View>
  );
}

export function BadgePill({ badge }: { badge: Badge }) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  const colors = {
    amber: [t.dark ? "#fbbf24" : "#b45309", "#f59e0b26"],
    violet: [t.dark ? "#a78bfa" : "#7c3aed", "#8b5cf626"],
    sky: [t.dark ? "#38bdf8" : "#0369a1", "#0ea5e926"],
    green: [t.dark ? "#22c55e" : "#15803d", "#22c55e26"],
    red: [t.dark ? "#f87171" : "#b91c1c", "#ef444426"],
    neutral: [t.secondary, "#71717a1a"],
  };
  const [color, backgroundColor] = colors[badge.tone];
  const repliedBy = replyAuthor(badge);
  const content = (
    <Pill backgroundColor={backgroundColor}>
      {!!badge.people?.length && <People people={badge.people} />}
      <Text
        selectable={!badge.url}
        style={{
          color,
          fontSize: 12,
          lineHeight: 16,
          fontWeight: "500",
          flexShrink: 1,
        }}
      >
        {repliedBy ? `${repliedBy} Replied` : badge.text}
      </Text>
      {badge.jev !== undefined && <JevScore value={badge.jev} />}
    </Pill>
  );
  return badge.url ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={badge.text}
      hitSlop={5}
      onPress={() => void openUrl(badge.url!)}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function Badges({ badges }: { badges: readonly Badge[] }) {
  return badges.length ? (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
      }}
    >
      {badges.map((badge, i) => (
        <BadgePill key={`${badge.text}-${i}`} badge={badge} />
      ))}
    </View>
  ) : null;
}

/** Additional PR metadata; replies use the attached lip and time sits below the reference. */
export function PRFooter({ badges = [] }: { badges?: readonly Badge[] }) {
  const details = prFooterBadges(badges).filter((badge) => !isReplyBadge(badge));
  if (!details.length) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        paddingBottom: 9,
      }}
    >
      {details.map((badge, i) => (
        <BadgePill key={`${badge.text}-${i}`} badge={badge} />
      ))}
    </View>
  );
}

export function DetailRow({ row, onLinked, scope = true }: { row: Row; onLinked: () => void; scope?: boolean }) {
  const parent = use(ContainingItem);
  const item = useMemo(() => ({ ...rowScope(row), links: parent?.item.keys ?? [] }), [row, parent?.item.keys]);
  const content = <DetailRowContent row={row} onLinked={onLinked} />;
  return scope ? (
    <LinkedItem item={item} bleed>
      {content}
    </LinkedItem>
  ) : (
    content
  );
}

function DetailRowContent({ row, onLinked }: { row: Row; onLinked: () => void }) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  if (row.kind === "pr")
    return (
      <PRRow
        title={row.subtitle ?? row.title}
        reference={row.prKey ?? prKeyFromUrl(row.url, row.title)}
        url={row.url}
        state={rowPRState(row)}
        checks={row.checks}
        summary={row.checksSummary}
        stack={row.stack}
        aiCheckFailures={row.aiCheckFailures}
        changes={row.changes}
        updatedAt={row.updatedAt}
        status={row.status}
        badges={row.badges}
        conflictFix={row.conflictFix}
        footer={prFooterBadges(row.badges ?? []).length ? <PRFooter badges={row.badges} /> : undefined}
      />
    );
  if (row.kind === "slack")
    return (
      <View style={{ gap: 3 }}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={[row.title, row.subtitle].filter(Boolean).join(". ")}
          accessibilityHint="Opens this thread in Slack"
          onPress={() => void openUrl(row.url)}
          style={{ gap: 4, paddingVertical: 4, minHeight: 44 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <SourceIcon source="slack" />
            <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, flex: 1 }}>
              {row.title}
            </Text>
            {!!row.updatedAt && <Text style={{ color: t.secondary, fontSize: 11 }}>{ago(row.updatedAt)}</Text>}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              numberOfLines={2}
              style={{
                color: t.secondary,
                fontSize: 12,
                lineHeight: 17,
                flex: 1,
              }}
            >
              {row.subtitle ?? "Open thread"}
            </Text>
            <Icon name="chevron.right" color={t.secondary} size={12} />
          </View>
        </Pressable>
        {!!row.linkTicketId && <ThreadLink ticketId={row.linkTicketId} url={row.url} onLinked={onLinked} />}
        {!!row.badges?.length && <Badges badges={row.badges} />}
      </View>
    );
  return <LinkedDocumentRow row={row} />;
}

/** Shared compact treatment for linked Linear tickets and Notion documents. */
export function LinkedDocumentRow({ row, onOpen }: { row: Row; onOpen?: () => void }) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  const ticket = row.kind === "ticket";
  const reference = ticket ? (row.reference ?? row.title.match(/^[A-Z]+-\d+$/)?.[0]) : undefined;
  const title = ticket && row.subtitle ? row.subtitle : row.title;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={[
        ticket ? "Linear" : "Notion",
        title,
        reference,
        row.priority,
        row.status,
        row.owner ? `Owner: ${row.owner.name}` : undefined,
        row.assignees?.length ? `Assigned: ${row.assignees.map((person) => person.name).join(", ")}` : undefined,
        row.reviewers?.length ? `Reviewers: ${row.reviewers.map((person) => person.name).join(", ")}` : undefined,
        row.effort ? `Effort: ${row.effort}` : undefined,
        row.createdAt ? `Created: ${new Date(row.createdAt).toLocaleString()}` : undefined,
        row.kind === "notion" && row.updatedAt ? `Edited: ${new Date(row.updatedAt).toLocaleString()}` : undefined,
      ]
        .filter(Boolean)
        .join(". ")}
      onPress={onOpen ?? (() => void openUrl(row.url))}
      style={{
        backgroundColor: t.dark ? "#1c1c1e" : "#f4f4f5",
        borderRadius: 12,
        borderCurve: "continuous",
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <SourceIcon source={ticket ? "linear" : "notion"} size={18} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: t.text, fontSize: 14, flex: 1, minWidth: 0 }}>
        {title}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          flexShrink: 0,
        }}
      >
        {ticket && row.jev !== undefined && <JevScore value={row.jev} />}
        {!ticket && <DocumentPeople people={row.assignees} role="Assigned" />}
        {!ticket && <DocumentPeople people={row.reviewers} role="Reviewer" />}
        {!ticket && !!row.effort && (
          <Text numberOfLines={1} style={{ color: t.secondary, fontSize: 11, maxWidth: 42 }}>
            {row.effort}
          </Text>
        )}
        {!ticket && (!!row.createdAt || !!row.updatedAt) && (
          <View style={{ alignItems: "flex-end" }}>
            {!!row.createdAt && (
              <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>Created {ago(row.createdAt)}</Text>
            )}
            {!!row.updatedAt && (
              <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>Edited {ago(row.updatedAt)}</Text>
            )}
          </View>
        )}
        {row.owner?.avatar && (
          <Image source={row.owner.avatar} contentFit="cover" style={{ width: 16, height: 16, borderRadius: 8 }} />
        )}
        {ticket && row.priorityValue !== undefined && (
          <PriorityIcon
            priority={{
              value: row.priorityValue,
              name: row.priority ?? "No priority",
            }}
          />
        )}
        {!!row.status && <StatusIcon status={row.status} statusType={row.statusType} />}
        {!!reference && (
          // The reference with its last update below it, as on PR rows.
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>{reference}</Text>
            {ticket && !!row.updatedAt && (
              <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>{ago(row.updatedAt)}</Text>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}

function DocumentPeople({ people, role }: { people?: readonly Person[]; role: string }) {
  const t = useTheme();
  if (!people?.length) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {people.slice(0, 2).map((person, index) => (
        <View key={`${person.name}-${index}`} accessible accessibilityLabel={`${role}: ${person.name}`}>
          {person.avatar ? (
            <Image source={person.avatar} contentFit="cover" style={{ width: 16, height: 16, borderRadius: 8 }} />
          ) : (
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: t.dark ? "#3f3f46" : "#d4d4d8",
              }}
            >
              <Text style={{ color: t.text, fontSize: 9 }}>{person.name.charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </View>
      ))}
      {people.length > 2 && <Text style={{ color: t.secondary, fontSize: 10 }}>+{people.length - 2}</Text>}
    </View>
  );
}

export function LabelChips({
  labels,
  colors,
  inline = false,
}: {
  labels: readonly string[];
  colors?: Record<string, string>;
  inline?: boolean;
}) {
  const t = useTheme();
  const chips = (
    <>
      {labels.map((label) => (
        <Pill key={label}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: colors?.[label.toLowerCase()] ?? colors?.[label] ?? "#95a2b3",
            }}
          />
          <Text
            selectable
            style={{
              color: t.dark ? "#d4d4d8" : "#52525b",
              fontSize: 12,
              lineHeight: 16,
            }}
          >
            {label}
          </Text>
        </Pill>
      ))}
    </>
  );
  return inline ? chips : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{chips}</View>;
}
