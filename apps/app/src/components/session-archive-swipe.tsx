import { useRef, type ReactNode } from "react";
import { Platform, Text } from "react-native";
import * as Haptics from "expo-haptics";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";

const THRESHOLD = 72;
const buzz = () => {
  if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};
function ArchiveAction({
  translation,
  drag,
  archived,
}: {
  translation: SharedValue<number>;
  drag: SharedValue<number>;
  archived: boolean;
}) {
  const t = useTheme();
  useAnimatedReaction(
    () => translation.value,
    (value) => {
      drag.set(value);
    },
  );
  useAnimatedReaction(
    () => translation.value >= THRESHOLD,
    (past, before) => {
      if (past && before === false) scheduleOnRN(buzz);
    },
  );
  const visible = useAnimatedStyle(() => ({ opacity: translation.value > 0 ? 1 : 0 }));
  return (
    <Animated.View
      style={[
        {
          width: 150,
          backgroundColor: t.dark ? "#2f5f8f" : "#3478c6",
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 16,
        },
        visible,
      ]}
    >
      <Icon name={archived ? "arrow.uturn.backward" : "archivebox"} color="#ffffff" size={18} />
      <Text style={{ color: "#ffffff", fontSize: 14, fontWeight: "600" }}>{archived ? "Unarchive" : "Archive"}</Text>
    </Animated.View>
  );
}

/** Right swipe uses the same threshold and haptics as Inbox. Only the provider acknowledgement changes the list. */
export function SessionArchiveSwipe({
  children,
  archived,
  pending,
  onArchive,
}: {
  children: ReactNode;
  archived: boolean;
  pending: boolean;
  onArchive: () => void;
}) {
  const t = useTheme();
  const swipe = useRef<SwipeableMethods>(null);
  const drag = useSharedValue(0);
  const rounded = useAnimatedStyle(() => ({ borderRadius: withTiming(drag.value > 0 ? 14 : 0, { duration: 150 }) }));
  return (
    <Swipeable
      ref={swipe}
      enabled={!pending}
      leftThreshold={THRESHOLD}
      overshootLeft={false}
      containerStyle={{ marginHorizontal: -16 }}
      onSwipeableOpen={(direction) => {
        swipe.current?.close();
        if (direction === "right" && !pending) onArchive();
      }}
      renderLeftActions={(_progress, translation) => (
        <ArchiveAction translation={translation} drag={drag} archived={archived} />
      )}
    >
      <Animated.View
        style={[
          { paddingHorizontal: 16, overflow: "hidden", borderCurve: "continuous", backgroundColor: t.background },
          rounded,
        ]}
      >
        {children}
      </Animated.View>
    </Swipeable>
  );
}
