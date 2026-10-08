import { use, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { ConflictFix, PRStack, Badge, ChecksSummary, PRChanges, Person } from "@mondash/shared/contract";
import { useSettings } from "@/lib/provider";
import { startPrSession } from "@/lib/api";
import { withReviewers } from "@mondash/shared/conflict-prompt";
import { useLaunch } from "./use-launch";
import { ViewSectionContext } from "./view-controls";
import { PRContextMenu } from "./pr-context-menu";
import { ago, useTheme } from "@/lib/theme";
import {
  checksDetails,
  hasPRConflicts,
  isAIReviewBadge,
  prReviewDecision,
  prReviewState,
  type ReviewDecision,
} from "@mondash/shared/pr-presentation";
import { useOpenUrl } from "./ui";
import { CardLip, isReplyBadge, isReviewedBadge, isYourReviewBadge } from "./reply-lip";
import { SourceIcon, SvgIcon } from "./web-icons";
import { Tip } from "./tip";
import {
  PR_STATE_TIPS,
  checksSvg,
  conflictsSvg,
  prStateSvg,
  rereviewSvg,
  type PRState,
} from "@mondash/shared/pr-icons";

import { PRStackDetails } from "./pr-stack";
export { rowPRState } from "@mondash/shared/pr-rows";

const greys = (t: ReturnType<typeof useTheme>) => ({
  secondary: t.secondary,
  unreviewed: t.dark ? "#3a3a3c" : "#d1d1d6",
});

export function PRStateIcon({ state, conflicts = false }: { state: PRState; conflicts?: boolean }) {
  const t = useTheme();
  return (
    <SvgIcon
      size={18}
      label={`Pull request ${state.toLowerCase()}${conflicts ? ". Merge conflicts with the base branch" : ""}`}
      svg={conflicts ? conflictsSvg(state, greys(t)) : prStateSvg(state, greys(t))}
    />
  );
}

function ChecksIcon({
  checks,
  summary,
  review,
}: {
  checks?: string;
  summary?: ChecksSummary;
  review?: ReviewDecision;
}) {
  const t = useTheme();
  const icon = checksSvg(checks, summary, review, greys(t));
  if (!icon) return null;
  const details = checksDetails(checks, summary, review);
  return (
    <Tip lines={details}>
      <SvgIcon svg={icon} size={18} label={details.join(". ")} />
    </Tip>
  );
}

export function prKeyFromUrl(url: string | undefined, fallback: string) {
  if (url) {
    try {
      const match = new URL(url).pathname.match(/^\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/);
      if (match) return `${match[1]}#${match[2]}`;
    } catch {
      /* Keep the cached reference when a URL is unavailable. */
    }
  }
  return fallback;
}

function RereviewIcon() {
  return <SvgIcon size={18} label="Updated since your review — review again" svg={rereviewSvg} />;
}

export type PRRowProps = {
  title: string;
  reference: string;
  updatedAt?: string;
  url?: string;
  state?: PRState;
  checks?: string;
  summary?: ChecksSummary;
  stack?: PRStack;
  aiCheckFailures?: readonly string[];
  changes?: PRChanges;
  status?: string;
  reviewDecision?: string;
  badges?: readonly Badge[];
  author?: Person;
  footer?: ReactNode;
  /** Repair instructions, supplied only for the authenticated author's conflicting PRs. */
  conflictFix?: ConflictFix;
};

export function PRRow(props: PRRowProps) {
  const { state = "OPEN", badges = [], conflictFix, url } = props;
  const { server, refreshSection } = useSettings();
  const section = use(ViewSectionContext);
  const active = state !== "MERGED" && state !== "CLOSED";
  const conflicts = active && hasPRConflicts(badges);
  const canFix = conflicts && !!conflictFix && !!url && section !== "reviews";
  const repair = useLaunch(
    "Could not start conflict repair",
    () => {
      if (!canFix || !url || !conflictFix) throw new Error("This PR is not available for conflict repair.");
      return startPrSession(server, url, withReviewers(conflictFix.prompt, { coderabbit: false, greptile: false }));
    },
    undefined,
    () => refreshSection("sessions"),
  );
  return <PRRowContent {...props} repair={repair} canFix={canFix} />;
}

/** Work's PR layout and controls, also usable across the Activity DOM boundary. */
export function PRRowContent({
  title,
  reference,
  updatedAt,
  url,
  state = "OPEN",
  checks,
  summary,
  stack,
  aiCheckFailures = [],
  status,
  changes,
  reviewDecision,
  badges = [],
  author,
  footer,
  onOpen,
  repair = { busy: false, ready: false, error: undefined, launch: () => {} },
  canFix = false,
}: PRRowProps & {
  onOpen?: () => void;
  repair?: ReturnType<typeof useLaunch>;
  canFix?: boolean;
}) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  const active = state !== "MERGED" && state !== "CLOSED";
  const review = active ? prReviewState(status, badges) : undefined;
  const decision = active ? prReviewDecision(reviewDecision, status, badges) : undefined;
  const conflicts = active && hasPRConflicts(badges);
  const aiReview = badges.find(isAIReviewBadge);
  const aiFailed = aiCheckFailures.length > 0;
  const aiDetails = [
    ...aiCheckFailures.map((name) => `${name}: failed`),
    ...(aiReview ? [aiReview.text, "Unresolved, from review bots"] : []),
  ];
  return (
    <View>
      <View
        style={{
          backgroundColor: t.dark ? "#1c1c1e" : "#f4f4f5",
          borderRadius: 12,
          borderCurve: "continuous",
          overflow: "hidden",
          minHeight: 48,
          zIndex: 1,
          paddingHorizontal: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <PRContextMenu
            url={url ?? ""}
            {...(onOpen ? { onOpen } : {})}
            state={state}
            onFix={canFix ? repair.launch : undefined}
            busy={repair.busy}
            accessibilityRole="link"
            accessibilityLabel={`GitHub. ${title}. ${reference}. ${state.toLowerCase()}. ${checksDetails(checks, summary, decision).join(". ")}${review ? ". Updated since your review" : ""}${conflicts ? ". Merge conflicts" : ""}`}
            disabled={!url}
            onPress={onOpen ?? (() => url && void openUrl(url))}
            style={({ pressed }) => ({
              flexDirection: "row",
              flex: 1,
              minWidth: 0,
              alignItems: "center",
              gap: 8,
              paddingVertical: 10,
              minHeight: 48,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <SourceIcon source="github" size={18} />
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{ flex: 1, color: t.text, fontSize: 14, lineHeight: 19 }}
            >
              {title}
            </Text>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                flexShrink: 1,
                maxWidth: "48%",
              }}
            >
              <View style={{ alignItems: "flex-end", flexShrink: 1 }}>
                <Text numberOfLines={1} style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>
                  {reference}
                </Text>
                {updatedAt && (
                  <Text numberOfLines={1} style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>
                    {ago(updatedAt)}
                  </Text>
                )}
              </View>
              <Tip
                lines={
                  conflicts ? [PR_STATE_TIPS[state], "Merge conflicts with the base branch"] : [PR_STATE_TIPS[state]]
                }
                action={
                  canFix
                    ? {
                        label: repair.busy ? "Starting repair…" : "Fix Merge Conflict",
                        onPress: repair.busy ? () => {} : repair.launch,
                      }
                    : undefined
                }
              >
                <PRStateIcon state={state} conflicts={conflicts} />
              </Tip>
              <ChecksIcon checks={checks} summary={summary} review={decision} />
            </View>
          </PRContextMenu>
          {(aiReview || aiFailed) && (
            <View style={{ minHeight: 44, justifyContent: "center" }}>
              <Tip
                lines={aiDetails}
                action={
                  aiReview?.url || url
                    ? {
                        label: aiReview ? "Open threads" : "Open review",
                        onPress: () => {
                          const target = aiReview?.url ?? url;
                          if (target) void openUrl(target);
                        },
                      }
                    : undefined
                }
              >
                <SourceIcon source="bot" size={18} color={aiFailed ? "#ff453a" : undefined} />
              </Tip>
            </View>
          )}
          {review && (
            <Tip lines={["They pushed since your review", "Look again"]}>
              <RereviewIcon />
            </Tip>
          )}
        </View>
        {repair.busy && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <ActivityIndicator size="small" color={t.secondary} />
            <Text style={{ color: t.secondary, fontSize: 12 }}>Starting repair…</Text>
          </View>
        )}
        {repair.ready && (
          <Pressable onPress={repair.launch} accessibilityRole="button" style={{ paddingVertical: 10 }}>
            <Text style={{ color: t.accent, fontSize: 14 }}>Open repair in Claude ↗</Text>
          </Pressable>
        )}
        {repair.error && <Text style={{ color: t.warning, fontSize: 12, paddingBottom: 8 }}>{repair.error}</Text>}
        {footer}
      </View>
      <CardLip
        badges={badges.filter(isReplyBadge)}
        author={author}
        reviewed={badges.filter(isReviewedBadge)}
        yours={badges.find(isYourReviewBadge)}
        changes={changes}
      />
      {stack && <PRStackDetails stack={stack} url={url} />}
    </View>
  );
}
