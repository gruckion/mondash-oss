import { Image } from "expo-image";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { Badge, PRChanges, Person } from "@mondash/shared/contract";
import { useTheme } from "@/lib/theme";
import { TooltipButton } from "./tooltip-button";
import { useOpenUrl } from "./ui";

export function replyAuthor(badge: Badge) {
  return (
    badge.text.match(/^(?:reply|\d+ replies) from (.+)$/i)?.[1] ??
    badge.text.match(/^\d+ repl(?:y|ies) waiting · (.+)$/i)?.[1]
  );
}

export function isReplyBadge(badge: Badge) {
  return !!replyAuthor(badge) || /^(replied to you|\d+ replies to you)$/i.test(badge.text);
}

export function isReviewedBadge(badge: Badge) {
  return /^(?:approved|changes requested|commented|reviewed) by /i.test(badge.text) && !!badge.people?.length;
}

export function isYourReviewBadge(badge: Badge) {
  return /^you (?:approved|asked for changes|commented)$/i.test(badge.text);
}

/** Attached footer: square at the join and rounded only along its bottom edge. */
export function ReplyLip({ badges }: { badges: readonly Badge[] }) {
  return <CardLip badges={badges} reviewed={[]} />;
}

/**
 * Lips hang under the card, side by side: the PR author, amber "<name> replied" while a reply waits,
 * then each reviewer's latest review, then yours.
 */
export function CardLip({
  badges,
  author,
  reviewed,
  yours,
  changes,
}: {
  badges: readonly Badge[];
  author?: Person;
  reviewed: readonly Badge[];
  /** Your own last review: "you commented", "you approved" or "you asked for changes". */
  yours?: Badge;
  changes?: PRChanges;
}) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  if (!badges.length && !author && !reviewed.length && !yours && !changes) return null;
  const shell = (backgroundColor: string): ViewStyle => ({
    backgroundColor,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    alignSelf: "flex-start",
    flexShrink: 1,
    marginTop: -10,
    paddingTop: 10,
    overflow: "hidden",
  });
  const row: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 28,
  };
  const text = (color: string): TextStyle => ({
    color,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    flexShrink: 1,
  });
  // Several people bunch up, each avatar tucked under the one before.
  const faces = (people: readonly Person[]) =>
    people.length > 0 && (
      <View style={{ flexDirection: "row" }}>
        {people.slice(0, 3).map((person, i) =>
          person.avatar ? (
            <Image
              key={`${person.name}-${i}`}
              source={person.avatar}
              style={{
                width: 15,
                height: 15,
                borderRadius: 8,
                marginLeft: i ? -5 : 0,
                borderWidth: i ? 1 : 0,
                borderColor: t.dark ? "#16281c" : "#dcfce7",
              }}
            />
          ) : null,
        )}
      </View>
    );
  const tones = {
    green: [t.dark ? "#16281c" : "#dcfce7", t.dark ? "#22c55e" : "#15803d"],
    red: [t.dark ? "#3a1a1a" : "#fee2e2", t.dark ? "#f87171" : "#b91c1c"],
    neutral: [t.dark ? "#29292c" : "#e4e4e7", t.secondary],
  };
  const reviewLip = (key: string, people: readonly Person[], label: string, tone: Badge["tone"], url?: string) => {
    const [background, color] = tone === "green" || tone === "red" ? tones[tone] : tones.neutral;
    return (
      <Pressable
        key={key}
        disabled={!url}
        accessibilityRole={url ? "link" : "text"}
        accessibilityLabel={label}
        onPress={() => url && void openUrl(url)}
        style={({ pressed }) => [shell(background), row, { opacity: pressed ? 0.65 : 1 }]}
      >
        {faces(people)}
        <Text numberOfLines={1} style={text(color)}>
          {label}
        </Text>
      </Pressable>
    );
  };
  const verb = (text: string) =>
    /^approved/i.test(text)
      ? "approved"
      : /^changes requested/i.test(text)
        ? "asked for changes"
        : /^commented/i.test(text)
          ? "commented"
          : "reviewed";
  const reviews = [
    ...reviewed.map((badge) => {
      const people = badge.people ?? [];
      return {
        label: `${people.map((person) => person.name).join(", ")} ${verb(badge.text)}`,
        people,
        tone: badge.tone,
        url: badge.url,
      };
    }),
    ...(yours
      ? [
          {
            label: /^you asked for changes$/i.test(yours.text)
              ? "Changes asked"
              : yours.text.replace(/^you (\w)/i, (_, c: string) => c.toUpperCase()),
            people: yours.people ?? [],
            tone: yours.tone,
            url: yours.url,
          },
        ]
      : []),
  ];
  // Past two review lips the text no longer fits: fold them into faces with a status dot each.
  const crowded = reviews.length > 2;
  const dot = (tone: Badge["tone"]) => (tone === "green" || tone === "red" ? tones[tone][1] : t.secondary);
  return (
    <View style={{ marginHorizontal: 8, flexDirection: "row", gap: 4, alignItems: "flex-start" }}>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: 4 }}>
        {author && (
          <View
            accessible
            accessibilityLabel={`PR author: ${author.name}`}
            style={[shell(t.dark ? "#29292c" : "#e4e4e7"), row, { flexShrink: 0, maxWidth: "35%" }]}
          >
            {faces([author])}
            <Text numberOfLines={1} style={text(t.secondary)}>
              {author.name}
            </Text>
          </View>
        )}
        {badges.map((badge, i) => {
          const people = badge.people?.length ? badge.people : author ? [author] : [];
          const name = replyAuthor(badge) ?? people.map((person) => person.name).join(", ");
          const label = name ? `${name} replied` : badge.text;
          return (
            <Pressable
              key={`${badge.text}-${i}`}
              disabled={!badge.url}
              accessibilityRole={badge.url ? "link" : "text"}
              accessibilityLabel={label}
              onPress={() => badge.url && void openUrl(badge.url)}
              style={({ pressed }) => [shell(t.dark ? "#352b18" : "#fff0ce"), row, { opacity: pressed ? 0.65 : 1 }]}
            >
              {faces(people)}
              <Text numberOfLines={1} style={text(t.dark ? "#fbbf24" : "#b45309")}>
                {label}
              </Text>
            </Pressable>
          );
        })}
        {crowded ? (
          <View style={[shell(tones.neutral[0]), row, { gap: 3, paddingVertical: 0 }]}>
            {reviews.flatMap((review) =>
              review.people.map((person, i) => (
                <TooltipButton
                  key={`${review.label}-${person.name}-${i}`}
                  disabled={!review.url}
                  accessibilityRole={review.url ? "link" : "text"}
                  accessibilityLabel={review.label}
                  onPress={() => review.url && void openUrl(review.url)}
                  style={({ pressed }) => ({
                    minWidth: 28,
                    minHeight: 28,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <View>
                    {person.avatar ? (
                      <Image source={person.avatar} style={{ width: 16, height: 16, borderRadius: 8 }} />
                    ) : (
                      <View
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 8,
                          backgroundColor: t.secondary,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          style={{
                            color: tones.neutral[0],
                            fontSize: 9,
                            fontWeight: "700",
                          }}
                        >
                          {person.name.slice(0, 1)}
                        </Text>
                      </View>
                    )}
                    <View
                      style={{
                        position: "absolute",
                        right: -2,
                        bottom: -2,
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        borderWidth: 1,
                        borderColor: tones.neutral[0],
                        backgroundColor: dot(review.tone),
                      }}
                    />
                  </View>
                </TooltipButton>
              )),
            )}
          </View>
        ) : (
          reviews.map((review) => reviewLip(review.label, review.people, review.label, review.tone, review.url))
        )}
      </View>
      {changes && (
        <View
          accessible
          accessibilityLabel={`${changes.additions} ${changes.additions === 1 ? "line" : "lines"} added, ${changes.deletions} ${changes.deletions === 1 ? "line" : "lines"} deleted, ${changes.files} ${changes.files === 1 ? "file" : "files"} changed`}
          style={[shell(tones.neutral[0]), row, { flexShrink: 0, gap: 8 }]}
        >
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[text(tones.green[1]), { fontVariant: ["tabular-nums"], fontSize: 8, lineHeight: 8 }]}>
              +{changes.additions.toLocaleString("en-US")}
            </Text>
            <Text style={[text(tones.red[1]), { fontVariant: ["tabular-nums"], fontSize: 8, lineHeight: 8 }]}>
              −{changes.deletions.toLocaleString("en-US")}
            </Text>
          </View>
          <Text style={text(t.secondary)}>
            {changes.files.toLocaleString("en-US")} {changes.files === 1 ? "file" : "files"}
          </Text>
        </View>
      )}
    </View>
  );
}
