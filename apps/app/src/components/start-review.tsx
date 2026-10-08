import { TooltipButton as Pressable } from "./tooltip-button";
import { Icon } from "./icon";
import { Image } from "expo-image";
import { router } from "expo-router";
import { Text, View } from "react-native";
import { useReviewLaunch } from "./use-review-launch";
import { Schema } from "effect";
import { PullRequestUrl } from "@mondash/shared/api";
import type { Card } from "@mondash/shared/contract";
import { type PromptSheet, useOpenSheet } from "@/lib/session-sheet";
import { useTheme } from "@/lib/theme";
import { prKeyFromUrl } from "./pr-row";

/** Opens the prompt sheet for a start, which shows the prompt to read and edit before Start. */
function useOpenPrompt() {
  const { setPrompt } = useOpenSheet();
  return (sheet: PromptSheet) => {
    setPrompt(sheet);
    router.push("/claude-prompt");
  };
}

export function StartReview({
  url,
  startNew = false,
  title = "Review",
  onStarted,
}: {
  url: string;
  /** Start another review even when one already exists (the sessions sheet); otherwise that one reopens. */
  startNew?: boolean;
  title?: string;
  onStarted: () => void;
}) {
  const launch = useReviewLaunch(url, onStarted, startNew);
  const t = useTheme();
  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      <ClaudeButton
        label={startNew ? "New review in Claude" : "Review in Claude"}
        hint="Starts a PR risk review of this pull request and its related PRs directly in Claude"
        title={launch.busy ? "Starting…" : title}
        disabled={launch.busy}
        onPress={launch.launch}
      />
      {launch.error && (
        <Text accessibilityRole="alert" style={{ color: t.warning, fontSize: 12 }}>
          {launch.error}
        </Text>
      )}
    </View>
  );
}

const isPullRequestUrl = Schema.is(PullRequestUrl);

/** A card's Linear ticket, when its link is one the Mac accepts for a ticket session, with the PRs already made for it. */
export const linearTicket = (card: Pick<Card, "id" | "url" | "rows" | "related">) =>
  card.url?.startsWith("https://linear.app/")
    ? {
        id: card.id,
        url: card.url,
        prs: (card.rows?.filter((row) => row.kind === "pr") ?? card.related)
          .map((row) => row.url)
          .filter(isPullRequestUrl),
      }
    : undefined;

/** Starts a Claude session on the Mac that reads a Linear ticket and plans the change (or what its PRs leave), then opens it. */
export function StartTicketSession({
  ticketId,
  url,
  prs,
  title = "Claude",
  onStarted,
}: {
  ticketId: string;
  /** The ticket's https://linear.app/…/issue/… link. */
  url: string;
  prs: readonly string[];
  title?: string;
  onStarted: () => void;
}) {
  const openPrompt = useOpenPrompt();
  return (
    <ClaudeButton
      label={`Plan ${ticketId} in Claude`}
      hint={
        prs.length
          ? "Shows the prompt to read and edit, then starts a Claude session that reads this ticket and its PRs and plans what is left"
          : "Shows the prompt to read and edit, then starts a Claude session that reads this ticket and plans the change"
      }
      title={title}
      onPress={() =>
        openPrompt({
          title: `Plan ${ticketId} in Claude`,
          detail: prs.length
            ? "Claude reads this ticket and its PRs, and plans what is left without changing anything."
            : "Claude reads this ticket and plans the change without making it.",
          request: { kind: "ticket", ticketId, url, prs },
          onStarted,
        })
      }
    />
  );
}

/** A PR card's link, when it is one the Mac accepts for a PR session. */
export const pullRequest = (card: Pick<Card, "kind" | "url">) =>
  card.kind === "pr" && card.url && isPullRequestUrl(card.url) ? card.url : undefined;

/** Starts a Claude session on the Mac that reads a PR with no known ticket and works out what is left, then opens it. */
export function StartPrSession({
  url,
  title = "Claude",
  onStarted,
}: {
  url: string;
  title?: string;
  onStarted: () => void;
}) {
  const openPrompt = useOpenPrompt();
  return (
    <ClaudeButton
      label="Catch up on this PR in Claude"
      hint="Shows the prompt to read and edit, then starts a Claude session that reads this PR and works out what is left"
      title={title}
      onPress={() =>
        openPrompt({
          title: `Catch up on ${prKeyFromUrl(url, url)} in Claude`,
          detail: "Claude reads this PR and its reviews, and works out what is left without changing anything.",
          request: { kind: "pr", url },
          onStarted,
        })
      }
    />
  );
}

function ClaudeButton({
  label,
  hint,
  title,
  onPress,
  disabled = false,
}: {
  label: string;
  hint: string;
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled, busy: disabled }}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        minHeight: 24,
        flexShrink: 1,
        opacity: disabled || pressed ? 0.6 : 1,
      })}
    >
      <Image
        source={require("../../assets/claude-symbol.svg")}
        contentFit="contain"
        style={{ width: 12, height: 12 }}
      />
      <Text style={{ color: t.text, fontSize: 12, flexShrink: 1 }}>{title}</Text>
      <Icon name="chevron.right" color={t.secondary} size={10} />
    </Pressable>
  );
}
