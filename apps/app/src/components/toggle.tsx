import { View } from "react-native";

/**
 * An iOS-style switch, drawn here on every platform: iOS 26's own switch draws bigger than the box React Native lays
 * it out in, so it sits too high in the row, and the browser's default is teal.
 */
export function Toggle({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 50,
        height: 30,
        borderRadius: 15,
        padding: 2,
        backgroundColor: on ? "#34c759" : "#78788052",
        alignItems: on ? "flex-end" : "flex-start",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: "#ffffff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      />
    </View>
  );
}
