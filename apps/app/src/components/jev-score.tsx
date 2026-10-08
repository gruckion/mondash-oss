import { Image } from "expo-image";
import { Text, View } from "react-native";
import { useTheme } from "@/lib/theme";

/** Jev's face and how sure it is, e.g. "(Jev) 84%" or "(Jev) 57% needs you". */
export function JevScore({ value, suffix }: { value: number; suffix?: string }) {
  const t = useTheme();
  const percent = `${Math.round(value * 100)}%`;
  return (
    <View
      accessible
      accessibilityLabel={`Jev ${percent}${suffix ? ` ${suffix}` : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        flexShrink: 0,
      }}
    >
      <Image source={require("../../assets/jev.svg")} style={{ width: 12, height: 12, borderRadius: 6 }} />
      <Text style={{ color: t.secondary, fontSize: 11 }}>
        {percent}
        {suffix ? ` ${suffix}` : ""}
      </Text>
    </View>
  );
}
