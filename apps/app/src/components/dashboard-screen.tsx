import { ReviewStackGroup } from "./review-stack";
import { webScrollProps } from "@/lib/web-scroll";
import { ToolbarTabs } from "./segment-bar";
import { Icon, type IconName } from "./icon";
import { ViewControls, ViewControlsRow, ViewSectionContext } from "./view-controls";
import {
  createContext,
  use,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View, type ListRenderItemInfo } from "react-native";
import { router, useIsFocused } from "expo-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Card, Group, SectionResponse } from "@mondash/shared/contract";
import { applyView, isFiltered, type ViewSection } from "@mondash/shared/view-options";
import { DisplayProvider, useViewOptions } from "@/lib/view-options";
import { useConnection, useSection, useSettings } from "@/lib/provider";
import { useSetSegments, type Segments } from "@/lib/segments";
import { ago, useTheme } from "@/lib/theme";
import { Body, Button, Heading, Panel } from "./ui";
import { DashboardCard } from "./dashboard-card";
import { NotificationRow } from "./notification-row";
import { SessionRow } from "./session-row";
import { SessionOpenSwipe } from "./session-open-swipe";
import { issueEntries, type IssueStack } from "@mondash/shared/issue-stacks";
import { cardScope } from "@mondash/shared/linked-items";
import { IssueStackCard } from "./issue-stack";
import { LinkedItem } from "./linked-item";
import { useHasBottomControls } from "@/lib/mobile-view";
import { HapticRefreshControl } from "./haptic-refresh-control";

const StackIssues = createContext(false);

/**
 * Inbox items are compact rows; everything else is a full card. Memoised: a refresh keeps unchanged cards as the same
 * objects, so only the cards that changed render again.
 */
const CardView = memo(function CardView({
  contained = false,
  ...props
}: ComponentProps<typeof DashboardCard> & { contained?: boolean }) {
  const item = useMemo(() => cardScope(props.card), [props.card]);
  return props.card.kind === "notification" ? (
    <NotificationRow card={props.card} last={props.embedded} />
  ) : (
    <SessionOpenSwipe
      sessions={props.card.sessions}
      review={
        props.card.kind === "review" && props.card.url ? { url: props.card.url, onStarted: props.onRefresh } : undefined
      }
    >
      <LinkedItem item={item} bleed={!contained}>
        <DashboardCard {...props} />
      </LinkedItem>
    </SessionOpenSwipe>
  );
});

/** Sessions and linked review PRs draw as one block; other groups list their cards under a header that folds. */
const isBlock = (group: Group) =>
  (group.cards.length > 0 && group.cards.every((card) => card.kind === "session")) ||
  ["review-group", "review-stack"].includes(group.presentation ?? "");

function GroupHeader({ group, collapsed, onToggle }: { group: Group; collapsed: boolean; onToggle: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${group.title}, ${group.cards.length} items`}
        accessibilityState={{ expanded: !collapsed }}
        onPress={onToggle}
        hitSlop={{ top: 6, bottom: 6 }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          flexShrink: 1,
          minHeight: 44,
        }}
      >
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            color: t.text,
            fontSize: 14,
            fontWeight: "600",
            flexShrink: 1,
          }}
        >
          {group.title}
        </Text>
        <Text
          style={{
            color: t.secondary,
            fontSize: 14,
            fontVariant: ["tabular-nums"],
          }}
        >
          {group.cards.length}
        </Text>
        {/* Right by the title, so it reads as the title's own fold. */}
        <View style={{ transform: [{ rotate: collapsed ? "0deg" : "90deg" }] }}>
          <Icon name="chevron.right" color={t.secondary} size={12} />
        </View>
      </Pressable>
    </View>
  );
}

function GroupView({
  group,
  onRefresh,
  hideLastDivider = false,
  sessionDateHeadings = false,
}: {
  group: Group;
  onRefresh: () => void;
  hideLastDivider?: boolean;
  sessionDateHeadings?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(group.collapsed);
  const stacked = use(StackIssues);
  const entries = useMemo(() => issueEntries(group.cards, stacked), [group.cards, stacked]);
  const t = useTheme();
  if (group.cards.length && group.cards.every((card) => card.kind === "session"))
    return (
      <View>
        {sessionDateHeadings && (
          <Text
            accessibilityRole="header"
            style={{
              color: t.secondary,
              fontSize: 12,
              fontWeight: "500",
              paddingTop: 14,
              paddingBottom: 2,
              paddingHorizontal: 10,
            }}
          >
            {group.title}
          </Text>
        )}
        {group.cards
          .flatMap((card) => card.sessions)
          .map((session, index, all) => (
            <SessionRow
              key={`${session.tool}:${session.id}`}
              session={session}
              allowArchive
              last={(hideLastDivider || sessionDateHeadings) && index === all.length - 1}
            />
          ))}
      </View>
    );
  if (group.presentation === "review-stack")
    return (
      <ReviewStackGroup
        group={group}
        renderCard={(card) => (
          <CardView card={card} onRefresh={onRefresh} contained embedded firstInSection hideStack />
        )}
      />
    );
  if (group.presentation === "review-group")
    return (
      <View
        style={{
          gap: 0,
        }}
      >
        {group.cards.length > 1 && (
          <Text style={{ color: t.secondary, fontSize: 12, paddingTop: 8 }}>
            {group.cards.length} PRs, one change: {group.cards.map((card) => card.id).join(" + ")}
          </Text>
        )}
        {group.cards.map((card, index) => (
          <View
            key={card.id}
            style={{
              borderBottomWidth: hideLastDivider && index === group.cards.length - 1 ? 0 : 1,
              borderBottomColor: t.line,
            }}
          >
            <CardView card={card} onRefresh={onRefresh} embedded />
          </View>
        ))}
      </View>
    );
  if (!group.cards.length)
    return group.title === "To review" ? (
      <View style={{ gap: 6 }}>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: "600" }}>To review</Text>
        <Text style={{ color: t.secondary, fontSize: 13 }}>No one has asked you to review a card.</Text>
      </View>
    ) : null;
  return (
    <View>
      <GroupHeader group={group} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      {!collapsed &&
        entries.map((entry, index) =>
          "stack" in entry ? (
            <IssueStackCard key={`stack:${entry.stack.cards[0].id}`} stack={entry.stack} onRefresh={onRefresh} />
          ) : (
            <CardView
              key={entry.card.id}
              card={entry.card}
              onRefresh={onRefresh}
              firstInSection={index === 0}
              embedded={hideLastDivider && index === entries.length - 1}
            />
          ),
        )}
    </View>
  );
}
function SectionContent({
  query,
  groups,
  onRefresh,
  sessionDateHeadings,
}: {
  query: UseQueryResult<SectionResponse>;
  /** The groups after the screen's filters and sort. */
  groups: readonly Group[];
  onRefresh: () => void;
  sessionDateHeadings: boolean;
}) {
  const t = useTheme();
  const count = groups.reduce((sum, group) => sum + group.cards.length, 0);
  return (
    <View style={{ gap: 16 }}>
      {query.error && (
        <Panel>
          <Body>
            {query.data
              ? "Showing saved data. Could not refresh from your Mac."
              : "Could not reach Mondash on your Mac."}
          </Body>
          <Body muted>{query.error.message}</Body>
          <Button subtle title="Try again" onPress={() => void query.refetch()} />
        </Panel>
      )}
      {query.isPending && !query.error && (
        <Panel>
          <ActivityIndicator color={t.accent} />
          <Body muted>Gathering your work…</Body>
        </Panel>
      )}
      {query.data && (
        <>
          {query.data.threadsState === "error" && (
            <Text style={{ color: t.secondary, fontSize: 12 }}>Could not check Slack conversations.</Text>
          )}
          {count === 0 && query.data.groups.some((g) => g.cards.length) ? (
            <EmptyPage title="" filtered />
          ) : count === 0 ? (
            <Panel>
              <Heading>
                {query.data.updatedAt &&
                !query.data.coverage?.some((source) => source.enabled && source.status !== "ready") &&
                (!query.data.coverage || query.data.coverage.some((source) => source.enabled))
                  ? "All clear"
                  : "Check source coverage"}
              </Heading>
              <Body muted>
                {query.data.updatedAt
                  ? "No items to show here right now."
                  : "The Mac is gathering the first snapshot. If this stays, check Connections in Settings."}
              </Body>
            </Panel>
          ) : (
            <View>
              {groups.map((group, index) => (
                <GroupView
                  key={group.id}
                  group={group}
                  onRefresh={onRefresh}
                  sessionDateHeadings={sessionDateHeadings}
                  hideLastDivider={!groups.slice(index + 1).some((next) => next.cards.length)}
                />
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}
export type Page = {
  title: string;
  description?: string;
  groups: readonly Group[];
  /** Shown next to the title instead of the item count, e.g. unread items; 0 shows the title alone. */
  count?: number;
  /** Groups that start folded, e.g. Saved's Done. Everything else in a tab starts open. */
  folded?: string[];
};

const EMPTY: Record<string, { icon: IconName; title: string; body: string }> = {
  "To review": {
    icon: "checkmark.circle",
    title: "Nothing to review",
    body: "When someone asks you to review a scoping doc, it shows up here.",
  },
  Mine: {
    icon: "doc.text",
    title: "No scoping docs",
    body: "Roadmap cards assigned to you show up here while you scope them.",
  },
};

function EmptyPage({ title, filtered = false }: { title: string; filtered?: boolean }) {
  const t = useTheme();
  const copy: { icon: IconName; title: string; body: string } = filtered
    ? {
        icon: "line.3.horizontal.decrease",
        title: "No matches",
        body: "Nothing here matches your filters. Change them in the view options.",
      }
    : (EMPTY[title] ?? {
        icon: "tray",
        title: "Nothing here",
        body: "New items show up here when they arrive.",
      });
  return (
    <View
      style={{
        alignItems: "center",
        paddingTop: 96,
        paddingHorizontal: 32,
        gap: 8,
      }}
    >
      <View style={{ marginBottom: 4 }}>
        <Icon name={copy.icon} color={t.secondary} size={44} />
      </View>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>{copy.title}</Text>
      <Text
        style={{
          color: t.secondary,
          fontSize: 14,
          lineHeight: 20,
          textAlign: "center",
          maxWidth: 280,
        }}
      >
        {copy.body}
      </Text>
    </View>
  );
}

function DashboardHeader({ title, tabs }: { title?: string; tabs?: Segments }) {
  const t = useTheme();
  const bottomControls = useHasBottomControls();
  const section = use(ViewSectionContext);
  if (bottomControls && !title) return null;
  if (section === "inbox")
    return tabs ? (
      <View style={{ paddingHorizontal: 16 }}>
        <ToolbarTabs tabs={tabs} />
      </View>
    ) : null;
  return (
    <View style={{ paddingHorizontal: 16 }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", minHeight: 52, gap: 4 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: "600" }}
          >
            {title}
          </Text>
          {tabs && <ToolbarTabs tabs={tabs} />}
          <ViewControls />
        </View>
      ) : (
        <ViewControlsRow tabs={tabs} />
      )}
    </View>
  );
}

const count = (page: Page) => page.groups.reduce((sum, group) => sum + group.cards.length, 0);

/**
 * One page at a time: desktop web puts controls above the list; phones use the bottom accessory.
 * No sideways swipe between pages: Inbox rows use that gesture.
 */
function PagedGroups({
  pages,
  title,
  filtered,
  onRefresh,
  refreshControl,
  fallback,
}: {
  /** Loading and connection feedback replace the list, while its tabs stay mounted. */
  fallback?: ReactElement;
  pages: Page[];
  title?: string;
  /** Filters are on, so an empty page means nothing matched. */
  filtered: boolean;
  onRefresh: () => void;
  refreshControl: () => ReactElement<ComponentProps<typeof HapticRefreshControl>>;
}) {
  const available: Page[] = pages.length ? pages : [{ title: title ?? "Work", groups: [] }];
  const [page, setPage] = useState(0);
  const setSegments = useSetSegments();
  const current = available[Math.min(page, available.length - 1)];
  const labels = available.map((p) => p.title).join("\n");
  const counts = available.map((p) => (fallback ? "" : (p.count ?? count(p)))).join("\n");
  const key = available.map((p) => p.title).join("|");
  const descriptions = available.map((p) => p.description ?? "").join("\n");
  const tabs = useMemo<Segments>(
    () => ({
      key,
      titles: labels.split("\n"),
      counts: counts.split("\n").map((value) => (value === "" ? undefined : Number(value))),
      descriptions: descriptions.split("\n"),
      selected: page,
      onSelect: setPage,
    }),
    [key, labels, counts, descriptions, page],
  );
  const focused = useIsFocused();
  const inlineTabs = !useHasBottomControls();
  const showTabs = !inlineTabs && focused;
  // Only phone layouts publish a bottom accessory. Desktop controls belong to this page, even behind a modal.
  useEffect(() => {
    if (!showTabs) return;
    setSegments(tabs);
    return () => setSegments((current) => (current?.key === key ? null : current));
  }, [showTabs, key, tabs, setSegments]);
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <DashboardHeader title={title} tabs={inlineTabs ? tabs : undefined} />
      {fallback ?? (
        <PageList
          key={current.title}
          page={current}
          filtered={filtered}
          onRefresh={onRefresh}
          refreshControl={refreshControl}
        />
      )}
    </View>
  );
}

/** One line of a page's list: the list only draws the lines on screen, so a long Inbox opens at once. */
type Line =
  | { type: "empty"; key: string }
  | { type: "header"; key: string; group: Group; collapsed: boolean }
  | { type: "card"; key: string; card: Card; first: boolean; last: boolean }
  | { type: "stack"; key: string; stack: IssueStack }
  | { type: "block"; key: string; group: Group; last: boolean };

function entryLines(group: Group, stacked: boolean, last: boolean): Line[] {
  return issueEntries(group.cards, stacked).map((entry, index, entries): Line =>
    "stack" in entry
      ? {
          type: "stack",
          key: `${group.id}:stack:${entry.stack.cards[0].id}`,
          stack: entry.stack,
        }
      : {
          type: "card",
          key: `${group.id}:${entry.card.id}`,
          card: entry.card,
          first: index === 0,
          last: last && index === entries.length - 1,
        },
  );
}

function pageLines(page: Page, toggled: ReadonlySet<string>, stacked: boolean): Line[] {
  const lone = page.groups.length === 1 && !page.folded?.includes(page.groups[0].id);
  if (!count(page)) return [{ type: "empty", key: "empty" }];
  // A lone group is named by its tab, so its cards need no collapsible header.
  if (lone) return entryLines(page.groups[0], stacked, true);
  const shown = page.groups.filter((group) => group.cards.length);
  return shown.flatMap((group, index): Line[] => {
    const last = index === shown.length - 1;
    if (isBlock(group)) return [{ type: "block", key: `block:${group.id}`, group, last }];
    const collapsed = (page.folded?.includes(group.id) ?? false) !== toggled.has(group.id);
    return [
      { type: "header", key: `header:${group.id}`, group, collapsed },
      ...(collapsed ? [] : entryLines(group, stacked, last)),
    ];
  });
}

function PageList({
  page,
  filtered,
  onRefresh,
  refreshControl,
}: {
  page: Page;
  filtered: boolean;
  onRefresh: () => void;
  refreshControl: () => ReactElement<ComponentProps<typeof HapticRefreshControl>>;
}) {
  const t = useTheme();
  // Groups you folded or opened on this page; the rest keep the page's default.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const stacked = use(StackIssues);
  const lines = useMemo(() => pageLines(page, toggled, stacked), [page, toggled, stacked]);
  const toggle = useCallback(
    (id: string) =>
      setToggled((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Line>) => {
      switch (item.type) {
        case "empty":
          return <EmptyPage title={page.title} filtered={filtered} />;
        case "header":
          return <GroupHeader group={item.group} collapsed={item.collapsed} onToggle={() => toggle(item.group.id)} />;
        case "card":
          return <CardView card={item.card} onRefresh={onRefresh} firstInSection={item.first} embedded={item.last} />;
        case "stack":
          return <IssueStackCard stack={item.stack} onRefresh={onRefresh} />;
        case "block":
          return <GroupView group={item.group} onRefresh={onRefresh} hideLastDivider={item.last} />;
      }
    },
    [filtered, onRefresh, page.title, toggle],
  );
  return (
    <FlatList
      {...webScrollProps}
      data={lines}
      keyExtractor={(line) => line.key}
      renderItem={renderItem}
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: t.background }}
      // iOS already clears the tab bar; this clears the accessory above it.
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 88 }}
      refreshControl={refreshControl()}
    />
  );
}

export function DashboardScreen({
  section,
  title,
  pages,
  bottomSpace = 40,
  transformGroups,
  banner,
  sessionDateHeadings = false,
}: {
  section: ViewSection;
  /** Desktop column heading; controls always belong to the whole section. */
  title?: string;
  /** Splits the groups into swipeable tabs. */
  pages?: (groups: readonly Group[]) => Page[];
  /** Room under the last row, e.g. to clear a button floating over the list. */
  bottomSpace?: number;
  transformGroups?: (groups: readonly Group[]) => readonly Group[];
  banner?: ReactNode;
  /** Muted calendar headings for the Sessions list's recency view. */
  sessionDateHeadings?: boolean;
}) {
  const t = useTheme();
  const query = useSection(section);
  const { server, ready, refreshSection } = useSettings();
  const live = useConnection() === "live";
  const { view } = useViewOptions(section);
  const { data } = query;
  const groups = useMemo(() => {
    const shown = data ? applyView(section, data.groups, view) : [];
    return transformGroups ? transformGroups(shown) : shown;
  }, [data, section, view, transformGroups]);
  const paged = useMemo(() => (pages ? pages(groups) : undefined), [pages, groups]);
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const onRefresh = useCallback(() => refreshSection(section), [refreshSection, section]);
  const [pulling, setPulling] = useState(false);
  const times = data
    ? `${data.stale ? "Cached · " : ""}${data.updatedAt ? `Updated ${ago(data.updatedAt)}` : "Waiting for the first source refresh"}`
    : undefined;
  // While live the Mac pushes each change, and asking again would read the same copy, so a pull only shows the times.
  const refreshTitle = live ? (times ? `Live · ${times}` : "Live") : (times ?? "Pull to refresh");
  async function refresh() {
    if (live) return;
    setPulling(true);
    try {
      await query.refetch();
    } finally {
      setPulling(false);
    }
  }
  const refreshControl = () => (
    <HapticRefreshControl
      refreshing={pulling}
      onRefresh={() => void refresh()}
      tintColor={t.accent}
      title={refreshTitle}
      titleColor={t.secondary}
    />
  );
  const screen = (content: ReactElement, hasHeader = false) => (
    <ViewSectionContext value={section}>
      <DisplayProvider value={hidden}>
        <StackIssues value={section === "issues"}>
          <View style={{ flex: 1, minHeight: 0 }}>
            {!hasHeader && <DashboardHeader title={title} />}
            {banner}
            {content}
          </View>
        </StackIssues>
      </DisplayProvider>
    </ViewSectionContext>
  );
  const fallback = (
    <ScrollView
      {...webScrollProps}
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: bottomSpace,
        gap: 16,
      }}
      refreshControl={refreshControl()}
    >
      {!ready ? (
        <ActivityIndicator color={t.accent} />
      ) : !server ? (
        <Panel>
          <Heading>Your work, in one place</Heading>
          <Body muted>Connect to Mondash running on your Mac to see your issues, scoping and reviews.</Body>
          <Button title="Connect your Mac" onPress={() => router.push("/settings")} />
        </Panel>
      ) : (
        <SectionContent query={query} groups={groups} onRefresh={onRefresh} sessionDateHeadings={sessionDateHeadings} />
      )}
    </ScrollView>
  );
  return paged
    ? screen(
        <PagedGroups
          title={title}
          pages={paged}
          filtered={isFiltered(view)}
          onRefresh={onRefresh}
          refreshControl={refreshControl}
          fallback={server && data && !query.error ? undefined : fallback}
        />,
        true,
      )
    : screen(fallback);
}
