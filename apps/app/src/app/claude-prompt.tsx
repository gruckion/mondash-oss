import { TooltipButton } from "@/components/tooltip-button";
import { webScrollProps } from "@/lib/web-scroll";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Image } from "expo-image";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/icon";
import { prKeyFromUrl } from "@/components/pr-row";
import { Sheet } from "@/components/sheet";
import { Button, errorMessage, touchWeb } from "@/components/ui";
import { useLaunch } from "@/components/use-launch";
import { previewPrompt, startClaudeReview, startPrSession, startTicketSession } from "@/lib/api";
import { useSettings } from "@/lib/provider";
import { type PromptSheet, useSessionSheet } from "@/lib/session-sheet";
import { useTheme } from "@/lib/theme";

/** Starts what the sheet was opened for. `prompt` is undefined only for a review that reopens, which sends none. */
function start(server: string, { request }: PromptSheet, prompt: string | undefined): Promise<{ url: string }> {
  switch (request.kind) {
    case "ticket":
      return startTicketSession(server, request.ticketId, request.url, request.prs ?? [], prompt);
    case "pr":
      return startPrSession(server, request.url, prompt);
    case "review":
      return startClaudeReview(server, request.url, request.startNew === true, prompt);
  }
}

/** Shows the prompt a Claude start would send, to read and edit, then starts it with what the person left there. */
export default function ClaudePromptSheet() {
  const t = useTheme();
  const { prompt: sheet } = useSessionSheet();
  return (
    <Sheet>
      <ScrollView
        {...webScrollProps}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: t.background }}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: "600" }}>
            {sheet ? sheet.title : "Start in Claude"}
          </Text>
          <TooltipButton
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => router.back()}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="xmark.circle.fill" color={t.secondary} size={28} />
          </TooltipButton>
        </View>
        {sheet ? (
          // A new request starts again from its own prompt, not from an edit of the last one.
          <PromptEditor key={JSON.stringify(sheet.request)} sheet={sheet} />
        ) : (
          <Text style={{ color: t.secondary, fontSize: 15 }}>Open this from a ticket, PR or review.</Text>
        )}
      </ScrollView>
    </Sheet>
  );
}

function PromptEditor({ sheet }: { sheet: PromptSheet }) {
  const t = useTheme();
  const { server, refreshSection } = useSettings();
  const [draft, setDraft] = useState<string>();
  const preview = useQuery({
    queryKey: ["promptPreview", server, sheet.request],
    queryFn: ({ signal }) => previewPrompt(server, sheet.request, signal),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const reopens = preview.data?.review?.reopens === true;
  const text = draft === undefined ? preview.data?.prompt : draft;
  const launch = useLaunch(
    "Could not start",
    () => start(server, sheet, reopens ? undefined : text),
    () => {
      sheet.onStarted();
      // A phone browser keeps the link for a second tap, so the sheet stays open to show it.
      if (!touchWeb()) router.back();
    },
    () => {
      if (sheet.request.kind !== "review") refreshSection("sessions");
    },
    true,
  );
  const review = preview.data?.review;
  const blank = !reopens && !text?.trim();
  const edited = draft !== undefined && draft !== preview.data?.prompt;
  return (
    <>
      <Text style={{ color: t.secondary, fontSize: 14, lineHeight: 20 }}>
        {reopens
          ? "A review of these pull requests already exists, so Start opens it and sends no new prompt. Use New review in its agent sessions to start another."
          : sheet.detail}
      </Text>
      {review && (
        <View style={{ gap: 2 }}>
          <Text selectable style={{ color: t.secondary, fontSize: 13, lineHeight: 18 }}>
            Covers {review.prs.map((url) => prKeyFromUrl(url, url)).join(", ")}
          </Text>
          {review.notReady.length > 0 && (
            <Text selectable style={{ color: t.secondary, fontSize: 13, lineHeight: 18 }}>
              Leaves alone, not ready for review: {review.notReady.map((url) => prKeyFromUrl(url, url)).join(", ")}
            </Text>
          )}
        </View>
      )}
      {preview.isPending ? (
        <View
          accessibilityLiveRegion="polite"
          style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 }}
        >
          <ActivityIndicator size="small" color={t.secondary} />
          <Text style={{ color: t.secondary, fontSize: 15 }}>
            {sheet.request.kind === "review" ? "Gathering the related pull requests…" : "Getting the prompt…"}
          </Text>
        </View>
      ) : preview.isError ? (
        <View style={{ gap: 10, alignItems: "flex-start" }}>
          <Text accessibilityRole="alert" selectable style={{ color: t.warning, fontSize: 14, lineHeight: 20 }}>
            Could not get the prompt: {errorMessage(preview.error)}
          </Text>
          <Button title="Try again" subtle onPress={() => void preview.refetch()} />
        </View>
      ) : (
        <>
          {!reopens && (
            <View style={{ gap: 6 }}>
              <TextInput
                accessibilityLabel="Prompt for Claude"
                accessibilityHint="Claude reads this first. Edit it before you start."
                value={text}
                onChangeText={setDraft}
                editable={!launch.busy}
                multiline
                textAlignVertical="top"
                autoCapitalize="sentences"
                placeholder="What Claude reads first"
                placeholderTextColor={t.secondary}
                style={{
                  height: 280,
                  padding: 12,
                  borderColor: t.line,
                  borderWidth: 1,
                  borderRadius: 12,
                  borderCurve: "continuous",
                  color: t.text,
                  fontSize: 15,
                  lineHeight: 22,
                  backgroundColor: t.background,
                }}
              />
              {edited && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDraft(undefined)}
                  hitSlop={8}
                  style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }}
                >
                  <Text style={{ color: t.accent, fontSize: 14, fontWeight: "500" }}>Reset to the usual prompt</Text>
                </Pressable>
              )}
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={launch.ready ? "Open in Claude" : reopens ? "Open review" : "Start"}
            accessibilityState={{ busy: launch.busy, disabled: launch.busy || blank }}
            disabled={launch.busy || blank}
            onPress={launch.launch}
            style={({ pressed }) => ({
              flexDirection: "row",
              gap: 8,
              minHeight: 48,
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor: t.accent,
              alignItems: "center",
              justifyContent: "center",
              opacity: blank ? 0.45 : pressed ? 0.7 : 1,
            })}
          >
            {launch.busy ? (
              <ActivityIndicator size="small" color={t.dark ? "#0a0a0a" : "#ffffff"} />
            ) : (
              <Image
                source={require("../../assets/claude-symbol.svg")}
                contentFit="contain"
                style={{ width: 16, height: 16 }}
              />
            )}
            <Text style={{ color: t.dark ? "#0a0a0a" : "#ffffff", fontSize: 16, fontWeight: "600" }}>
              {launch.busy ? "Starting…" : launch.ready ? "Open in Claude" : reopens ? "Open review" : "Start"}
            </Text>
          </Pressable>
          {launch.error && !launch.busy && (
            <Text accessibilityRole="alert" selectable style={{ color: t.warning, fontSize: 14, lineHeight: 20 }}>
              Could not start: {launch.error}
            </Text>
          )}
        </>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: t.accent, fontSize: 15, fontWeight: "500" }}>Cancel</Text>
      </Pressable>
    </>
  );
}
