import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { router, Stack, useIsFocused, useIsPreview, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionConversation } from "@mondash/shared/contract";
import * as Clipboard from "expo-clipboard";
import { Button, errorMessage, openUrl } from "@/components/ui";
import { loadConversation, loadSessionAttachment, loadSessionFiles, loadSessionPullRequests } from "@/lib/api";
import { useSettings } from "@/lib/provider";
import { ThemeSurface, useTheme } from "@/lib/theme";

import { SessionsScreen } from "@/components/sessions-screen";
import { SessionSelectionContext } from "@/lib/session-selection";
import { Icon } from "@/components/icon";

// Markdown rendering is a large download on the web, so it loads with this screen, not with the app.
const Conversation = lazy(() => import("@/components/conversation"));

// Two panes fit in the Mac window before the three-column Work layout does.
const SESSION_SIDEBAR_WIDTH = 900;

const toolOf = (value: string | undefined) => (value === "claude" || value === "codex" ? value : undefined);

/** A session's recent conversation, read from its transcript on the Mac. A long press on a session row previews it. */
export default function SessionConversationScreen() {
  return (
    <ThemeSurface value="session">
      <SessionConversationContent />
    </ThemeSurface>
  );
}

function SessionConversationContent() {
  const t = useTheme();
  const preview = useIsPreview();
  const { width: windowWidth } = useWindowDimensions();
  const desktop = Platform.OS === "web" && windowWidth >= SESSION_SIDEBAR_WIDTH && !preview;
  const { server } = useSettings();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ tool: string; id: string; title?: string }>();
  const tool = toolOf(params.tool);
  const { id } = params;
  const query = useQuery({
    queryKey: ["sessionConversation", server, tool, id],
    queryFn: ({ signal }) => {
      if (!tool) throw new Error("This link does not name a Claude or Codex session.");
      return loadConversation(server, tool, id, signal);
    },
    // The preview and the screen it opens read the same conversation.
    staleTime: 5_000,
    refetchInterval: (query) => (focused && !preview ? (query.state.data?.running ? 5_000 : 30_000) : false),
    retry: false,
  });
  const title = query.data ? query.data.title : params.title ? params.title : "Session";
  const content = (
    <View style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: t.background }}>
      {!preview && <Stack.Screen options={{ title, headerShown: !desktop }} />}
      {desktop && (!query.data?.turns.length || query.isError) && (
        <View
          style={{
            height: 64,
            borderBottomWidth: 1,
            borderBottomColor: t.line,
            paddingHorizontal: 24,
            justifyContent: "center",
          }}
        >
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>
            {title}
          </Text>
        </View>
      )}
      {preview && (
        <Text
          numberOfLines={1}
          style={{ color: t.text, fontSize: 17, fontWeight: "600", paddingHorizontal: 16, paddingTop: 14 }}
        >
          {title}
        </Text>
      )}
      {query.isPending ? (
        <Reading />
      ) : query.isError ? (
        <Centered>
          <Text accessibilityRole="alert" selectable style={{ color: t.warning, fontSize: 15, textAlign: "center" }}>
            Could not read the conversation: {errorMessage(query.error)}
          </Text>
          {!preview && <Button title="Try again" subtle onPress={() => void query.refetch()} />}
        </Centered>
      ) : query.data.turns.length === 0 ? (
        <Centered>
          <Text style={{ color: t.secondary, fontSize: 15 }}>No messages yet.</Text>
        </Centered>
      ) : (
        <Turns key={`${tool}:${id}`} conversation={query.data} dark={t.dark} title={desktop ? title : undefined} />
      )}
    </View>
  );
  if (!desktop) return content;
  return (
    <SessionSelectionContext
      value={{
        tool: params.tool,
        id,
        select: (session) => router.setParams({ tool: session.tool, id: session.id, title: session.title }),
      }}
    >
      <View style={{ flex: 1, minHeight: 0, flexDirection: "row", backgroundColor: t.background }}>
        <View
          accessibilityLabel="Session switcher"
          style={{
            width: Math.min(420, Math.max(340, windowWidth * 0.25)),
            backgroundColor: t.sessionSidebar,
            borderRightWidth: 1,
            borderRightColor: t.line,
          }}
        >
          <View style={{ height: 64, paddingHorizontal: 16, flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to Work"
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/issues"))}
              style={{ width: 32, height: 44, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="chevron.left" size={18} color={t.secondary} />
            </Pressable>
            <Text accessibilityRole="header" style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>
              Sessions
            </Text>
          </View>
          <SessionsScreen />
        </View>
        {content}
      </View>
    </SessionSelectionContext>
  );
}

function Turns({ conversation, dark, title }: { conversation: SessionConversation; dark: boolean; title?: string }) {
  const { server } = useSettings();
  const focused = useIsFocused();
  const prs = useQuery({
    queryKey: ["sessionPullRequests", server, conversation.tool, conversation.id],
    queryFn: ({ signal }) => loadSessionPullRequests(server, conversation.tool, conversation.id, signal),
    staleTime: 60_000,
    refetchInterval: focused ? 60_000 : false,
    retry: false,
  });
  const client = useQueryClient();
  const loadAttachment = useCallback(
    (attachmentId: string) =>
      client.fetchQuery({
        queryKey: ["sessionAttachment", server, conversation.tool, conversation.id, attachmentId],
        queryFn: ({ signal }) =>
          loadSessionAttachment(server, conversation.tool, conversation.id, attachmentId, signal),
        staleTime: 30_000,
        gcTime: 5 * 60_000,
      }),
    [client, server, conversation.tool, conversation.id],
  );
  const loadFiles = useCallback(
    () =>
      client.fetchQuery({
        queryKey: ["sessionFiles", server, conversation.tool, conversation.id],
        queryFn: ({ signal }) => loadSessionFiles(server, conversation.tool, conversation.id, signal),
        staleTime: 30_000,
      }),
    [client, server, conversation.tool, conversation.id],
  );
  const copyText = useCallback(async (text: string) => {
    await Clipboard.setStringAsync(text);
  }, []);
  const [width, setWidth] = useState(0);
  const view = (
    <Conversation
      turns={conversation.turns}
      title={title}
      running={conversation.running}
      pullRequests={prs.data?.prs}
      pullRequestsTruncated={prs.data?.truncated}
      pullRequestsError={prs.isError ? "Could not load pull requests." : undefined}
      retryPullRequests={async () => {
        await prs.refetch();
      }}
      copyText={copyText}
      loadAttachment={loadAttachment}
      loadFiles={loadFiles}
      dark={dark}
      note={conversation.truncated ? "Earlier messages are not shown." : undefined}
      openLink={openUrl}
      width={width}
      dom={{ style: { flex: 1 }, scrollEnabled: false }}
    />
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Suspense fallback={<Reading />}>{Platform.OS === "web" ? view : width > 0 ? view : <Reading />}</Suspense>
    </View>
  );
}

function Centered({ children }: { children?: ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>{children}</View>
  );
}

function Reading() {
  const t = useTheme();
  return (
    <Centered>
      <ActivityIndicator color={t.secondary} />
      <Text style={{ color: t.secondary, fontSize: 15 }}>Reading the conversation…</Text>
    </Centered>
  );
}
