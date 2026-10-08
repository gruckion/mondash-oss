import { NativeTabs } from "expo-router/unstable-native-tabs";
import { SegmentBar } from "@/components/segment-bar";
import { useSegments } from "@/lib/segments";
import { useTheme } from "@/lib/theme";
import { useBottomViewSection } from "@/lib/mobile-view";
import { View } from "react-native";

function BottomControls() {
  const { segments } = useSegments();
  const placement = NativeTabs.BottomAccessory.usePlacement();
  // Native screens mounts both placements: never leave a second interactive copy in the inactive one.
  if (placement !== "regular") return null;
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "stretch", justifyContent: "center" }}>
      {segments && <SegmentBar />}
    </View>
  );
}
export default function TabsLayout() {
  const t = useTheme();
  const section = useBottomViewSection();
  return (
    <NativeTabs tintColor={t.accent} minimizeBehavior="never">
      {section && section !== "reviews" && section !== "sessions" && (
        <NativeTabs.BottomAccessory>
          <BottomControls />
        </NativeTabs.BottomAccessory>
      )}
      <NativeTabs.Trigger name="issues">
        <NativeTabs.Trigger.Icon sf="dot.viewfinder" />
        <NativeTabs.Trigger.Label>Issues</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="scoping">
        <NativeTabs.Trigger.Icon sf="square.stack.3d.up" />
        <NativeTabs.Trigger.Label>Scoping</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reviews">
        <NativeTabs.Trigger.Icon src={require("../../../assets/reviews-branch.png")} renderingMode="template" />
        <NativeTabs.Trigger.Label>Reviews</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf="clock" />
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sessions" role="search">
        <NativeTabs.Trigger.Icon sf="terminal" />
        <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
