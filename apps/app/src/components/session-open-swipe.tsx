import type { ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Session } from "@mondash/shared/contract";
import { latestSession } from "@/lib/latest-session";
import { useTheme } from "@/lib/theme";
import { useSessionLaunch } from "./use-session-launch";
import { useReviewLaunch } from "./use-review-launch";
import { SwipeClickGuard } from "./swipe-click-guard";

const ACTION_WIDTH = 80;
const buzz = () => {
  if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

/** Only the card's associated sessions are eligible. A new target resets any pending browser handoff. */
export function SessionOpenSwipe({
  sessions,
  review,
  children,
}: {
  sessions: readonly Session[];
  review?: { url: string; onStarted: () => void };
  children: ReactNode;
}) {
  const session = latestSession(sessions);
  return session ? (
    <SessionSwipe key={`${session.tool}:${session.id}`} session={session}>
      {children}
    </SessionSwipe>
  ) : review ? (
    <ReviewSwipe key={review.url} review={review}>
      {children}
    </ReviewSwipe>
  ) : (
    children
  );
}

function SessionSwipe({ session, children }: { session: Session; children: ReactNode }) {
  const launch = useSessionLaunch(session);
  return (
    <SessionActionSwipe action={launch} tool={session.tool} title={session.title}>
      {children}
    </SessionActionSwipe>
  );
}

function ReviewSwipe({ review, children }: { review: { url: string; onStarted: () => void }; children: ReactNode }) {
  const launch = useReviewLaunch(review.url, review.onStarted);
  return (
    <SessionActionSwipe action={launch} tool="claude" title="review" starting>
      {children}
    </SessionActionSwipe>
  );
}

function SessionActionSwipe({
  action: { busy, ready, error, canOpen, appName, launch },
  tool,
  title,
  starting = false,
  children,
}: {
  action: ReturnType<typeof useSessionLaunch>;
  tool: Session["tool"];
  title: string;
  starting?: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  const translation = useSharedValue(0);
  const armed = useSharedValue(false);
  const swiped = useSharedValue(false);
  const gesture = Gesture.Pan()
    .enabled(canOpen && !busy)
    .maxPointers(1)
    .activeOffsetX(-12)
    .failOffsetY([-12, 12])
    .onBegin(() => {
      armed.set(false);
      swiped.set(false);
    })
    .onStart(() => {
      swiped.set(true);
    })
    .onUpdate((event) => {
      const x = Math.max(-ACTION_WIDTH - 24, Math.min(0, event.translationX));
      translation.set(x);
      const reached = x <= -ACTION_WIDTH;
      if (reached && !armed.get()) scheduleOnRN(buzz);
      armed.set(reached);
    })
    .onEnd((_event, success) => {
      if (success && armed.get()) scheduleOnRN(launch);
    })
    .onFinalize(() => {
      armed.set(false);
      translation.set(withTiming(0, { duration: 180 }));
    });
  const moved = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.get() }],
    borderRadius: translation.get() < 0 ? 14 : 0,
  }));
  const action = useAnimatedStyle(() => ({
    opacity: translation.get() < 0 ? 1 : 0,
    transform: [{ scale: armed.get() ? 1 : 0.88 }],
  }));
  if (!canOpen) return children;
  return (
    <SwipeClickGuard swiped={swiped}>
      <View style={{ marginHorizontal: -16, overflow: "hidden" }}>
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: ACTION_WIDTH + 24,
            backgroundColor: tool === "claude" ? "#c96442" : "#4056c8",
            borderRadius: 14,
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <Animated.View style={[{ width: ACTION_WIDTH, alignItems: "center" }, action]}>
            <Image
              source={
                tool === "claude" ? require("../../assets/claude-symbol.svg") : require("../../assets/codex-logo.png")
              }
              tintColor={tool === "claude" ? "#ffffff" : undefined}
              contentFit="contain"
              style={{ width: 30, height: 30 }}
            />
          </Animated.View>
        </View>
        <GestureDetector gesture={gesture} touchAction="pan-y">
          <Animated.View
            style={[
              { paddingHorizontal: 16, backgroundColor: t.background, overflow: "hidden", borderCurve: "continuous" },
              moved,
            ]}
          >
            {children}
            {busy && (
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingBottom: 8 }}>
                <ActivityIndicator size="small" color={t.secondary} />
                <Text style={{ color: t.secondary, fontSize: 12 }}>
                  {starting ? "Starting review in" : "Opening in"} {appName}…
                </Text>
              </View>
            )}
            {ready && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${title} in ${appName}`}
                onPress={launch}
                style={{ paddingVertical: 10 }}
              >
                <Text style={{ color: t.accent, fontSize: 14 }}>Open in {appName} ↗</Text>
              </Pressable>
            )}
            {error && <Text style={{ color: t.warning, fontSize: 12, paddingBottom: 8 }}>{error}</Text>}
          </Animated.View>
        </GestureDetector>
      </View>
    </SwipeClickGuard>
  );
}
