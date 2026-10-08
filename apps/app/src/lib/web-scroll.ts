import { Platform } from "react-native";

/** React Native Web's dataSet marks scroll surfaces for the global gutter style. */
export const webScrollProps = Platform.OS === "web" ? { dataSet: { scrollContainer: "true" } } : {};
