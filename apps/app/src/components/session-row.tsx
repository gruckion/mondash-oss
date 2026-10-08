import { TooltipButton as Pressable } from "./tooltip-button";
import { useShows } from "@/lib/view-options";
import { Icon } from "./icon";
import { memo, use, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Link, router } from "expo-router";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import type { Session } from "@mondash/shared/contract";
import { openInTerminal } from "@/lib/api";
import { SessionArchiveSwipe } from "./session-archive-swipe";
import { useArchiveSession, useSettings } from "@/lib/provider";
import { ago, useTheme } from "@/lib/theme";
import { JevScore } from "./jev-score";
import { SessionContextUsage } from "./session-context-usage";
import { useSessionLaunch } from "./use-session-launch";
import { SvgIcon } from "./web-icons";
import { Tooltip } from "./tooltip";
import { PR_STATE_TIPS, prStateSvg } from "@mondash/shared/pr-icons";

import { SessionSelectionContext } from "@/lib/session-selection";

export const SessionRow = memo(function SessionRow({
  session,
  last = false,
  allowArchive = false,
}: {
  session: Session;
  /** The last row in the list has no divider under it. */
  last?: boolean;
  allowArchive?: boolean;
}) {
  const t = useTheme();
  const selection = use(SessionSelectionContext);
  const selected = selection?.tool === session.tool && selection.id === session.id;
  const shows = useShows();
  const { server, macDesktop } = useSettings();
  const claude = session.tool === "claude";
  const { busy, ready, error, launch, appName, canOpen } = useSessionLaunch(session);
  const archive = useArchiveSession();
  const canArchive = allowArchive && session.canArchive === true;
  const archiveLabel = session.archived ? "Unarchive" : "Archive";
  const changeArchive = () => archive.mutate({ tool: session.tool, id: session.id, archived: !session.archived });
  const terminal = useMutation({ mutationFn: () => openInTerminal(server, session.id) });
  // Resumes the session in the Mac's terminal: for when you are at the Mac, or want it waiting there.
  const onMac = claude && !macDesktop && (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Resume in the Mac's terminal"
      disabled={terminal.isPending}
      hitSlop={8}
      onPress={() => terminal.mutate()}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        minHeight: 22,
      }}
    >
      <Icon name="terminal" color={t.secondary} size={12} />
      <Text style={{ color: t.secondary, fontSize: 13, lineHeight: 18 }}>
        {terminal.isPending ? "Opening…" : terminal.isSuccess ? "Opened on Mac" : "Mac"}
      </Text>
    </Pressable>
  );
  const open = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${session.title} in ${appName}`}
      accessibilityState={{ disabled: busy || !canOpen, busy }}
      accessibilityHint={claude ? undefined : "In ChatGPT, choose this session under Codex Remote"}
      disabled={busy || !canOpen}
      hitSlop={8}
      onPress={launch}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        minHeight: 22,
        flexShrink: 0,
        opacity: pressed || !canOpen ? 0.6 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={t.text} />
      ) : (
        <Image
          source={claude ? require("../../assets/claude-symbol.svg") : require("../../assets/codex-logo.png")}
          contentFit="contain"
          style={{ width: 12, height: 12 }}
        />
      )}
      <Text
        style={{
          color: canOpen ? t.text : t.secondary,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: "500",
        }}
      >
        {busy ? "Opening…" : ready ? `Open in ${appName}` : "Open"}
      </Text>
      {!busy && <Icon name="arrow.up.right" color={t.secondary} size={10} />}
    </Pressable>
  );
  const actions = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
      {canArchive && Platform.OS !== "ios" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${archiveLabel} ${session.title}`}
          disabled={archive.isPending}
          onPress={changeArchive}
          hitSlop={8}
        >
          <Icon name="archivebox" color={t.secondary} size={14} />
        </Pressable>
      )}
      {onMac}
      {open}
    </View>
  );
  const href = {
    pathname: "/session/[tool]/[id]",
    params: { tool: session.tool, id: session.id, title: session.title },
  } as const;
  const row = (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Show the conversation of ${session.title}`}
      // On iOS the Link around the row opens the conversation, and a long press previews it.
      onPress={Platform.OS === "ios" ? undefined : () => (selection ? selection.select(session) : router.push(href))}
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        gap: 4,
        paddingVertical: 12,
        backgroundColor: selected ? t.tint : "transparent",
        borderRadius: selected ? 10 : 0,
        paddingHorizontal: selection ? 10 : 0,
        borderBottomWidth: last ? 0 : 0.5,
        borderBottomColor: t.line,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              color: t.text,
              fontSize: 15,
              lineHeight: 20,
              fontWeight: "500",
            }}
          >
            {session.title}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
          }}
        >
          {session.running && (
            <ActivityIndicator size="small" color={t.secondary} accessibilityLabel="Session is running" />
          )}
          {[...new Set((session.pullRequests ?? []).flatMap((pr) => (pr.state ? [pr.state] : [])))].map((state) => {
            const prs = session.pullRequests?.filter((pr) => pr.state === state) ?? [];
            const label = `${PR_STATE_TIPS[state]}: ${prs.map((pr) => pr.title).join("; ")}`;
            return (
              <Tooltip key={state} text={label}>
                <View accessibilityLabel={label} accessibilityRole="image">
                  <SvgIcon
                    size={16}
                    label={label}
                    svg={prStateSvg(state, { secondary: t.secondary, unreviewed: t.line })}
                  />
                </View>
              </Tooltip>
            );
          })}
          {session.jev !== undefined && <JevScore value={session.jev} />}
          <SessionContextUsage usage={session.contextUsage} />
          <Text style={{ color: t.secondary, fontSize: 11, lineHeight: 16 }}>{ago(session.updatedAt)}</Text>
        </View>
      </View>
      {archive.isPending && (
        <Text style={{ color: t.secondary, fontSize: 12 }}>{session.archived ? "Unarchiving…" : "Archiving…"}</Text>
      )}
      {archive.error && <Text style={{ color: t.warning, fontSize: 12 }}>{archive.error.message}</Text>}
      {!!error && (
        <Text style={{ color: t.warning, fontSize: 12, lineHeight: 16 }}>
          Could not open in {appName}: {error}
        </Text>
      )}
      {terminal.error && (
        <Text style={{ color: t.warning, fontSize: 12, lineHeight: 16 }}>
          Could not open on the Mac: {terminal.error.message}
        </Text>
      )}
      {shows("preview") ? (
        <SessionPreview
          key={session.preview}
          text={session.preview || (claude ? "No recap yet" : "No response yet")}
          action={actions}
        />
      ) : (
        <View style={{ alignSelf: "flex-end" }}>{actions}</View>
      )}
    </Pressable>
  );
  const linked =
    Platform.OS !== "ios" ? (
      row
    ) : (
      <Link href={href} asChild>
        <Link.Trigger>{row}</Link.Trigger>
        <Link.Preview />
        <Link.Menu>
          {canArchive && (
            <Link.MenuAction icon="archivebox" disabled={archive.isPending} onPress={changeArchive}>
              {archiveLabel}
            </Link.MenuAction>
          )}
          <Link.MenuAction icon="arrow.up.right" disabled={busy || !canOpen} onPress={launch}>
            {`Open in ${appName}`}
          </Link.MenuAction>
          {claude && (
            <Link.MenuAction icon="terminal" disabled={terminal.isPending} onPress={() => terminal.mutate()}>
              Resume on the Mac
            </Link.MenuAction>
          )}
        </Link.Menu>
      </Link>
    );
  return canArchive ? (
    <SessionArchiveSwipe archived={session.archived ?? false} pending={archive.isPending} onArchive={changeArchive}>
      {linked}
    </SessionArchiveSwipe>
  ) : (
    linked
  );
});

/** Full-width opening lines; the final line reserves room for the action. */
function SessionPreview({ text, action }: { text: string; action: ReactNode }) {
  const t = useTheme();
  const [lines, setLines] = useState<{ text: string; width: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [actionWidth, setActionWidth] = useState(80);
  // Short previews keep all their text: move the action onto the next line
  // only when it cannot fit, rather than truncating a one- or two-line recap.
  const actionNeedsLine = width > 0 && lines.length < 3 && (lines.at(-1)?.width ?? 0) + actionWidth + 7 > width;
  const lead = lines.slice(0, Math.min(2, Math.max(0, lines.length - (actionNeedsLine ? 0 : 1))));
  const tail = lines.length
    ? lines
        .slice(lead.length)
        .map((line) => line.text)
        .join(" ")
    : text;
  const textStyle = { color: t.secondary, fontSize: 13, lineHeight: 18 };
  // The web never reports text lines, so it wraps the preview to three lines and puts the action under it.
  if (Platform.OS === "web")
    return (
      <View style={{ gap: 4 }}>
        <Text numberOfLines={3} style={textStyle}>
          {text}
        </Text>
        <View style={{ alignSelf: "flex-end" }}>{action}</View>
      </View>
    );
  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
      <Text
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={{
          ...textStyle,
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          opacity: 0,
        }}
        onTextLayout={({ nativeEvent }) => {
          const next = nativeEvent.lines.map((line) => ({
            text: line.text.trim(),
            width: line.width,
          }));
          setLines((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
        }}
      >
        {text}
      </Text>
      {lead.map((line, i) => (
        <Text key={i} numberOfLines={1} style={textStyle}>
          {line.text}
        </Text>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        {!!tail && (
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ ...textStyle, flexShrink: 1 }}>
            {tail}
          </Text>
        )}
        <View
          onLayout={({ nativeEvent }) => setActionWidth(nativeEvent.layout.width)}
          style={{ flexShrink: 0, marginLeft: "auto" }}
        >
          {action}
        </View>
      </View>
    </View>
  );
}
