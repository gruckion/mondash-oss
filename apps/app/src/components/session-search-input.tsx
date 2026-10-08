import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSessionSearch } from "@/lib/session-search";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";
import "../styles/session-search.css";

const webSearchProps = Platform.OS === "web" ? { dataSet: { sessionSearch: "true" } } : {};

export function SessionSearchInput() {
  const { query, setQuery } = useSessionSearch();
  const t = useTheme();
  return (
    <View
      {...webSearchProps}
      style={{ flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 8 }}
    >
      <Icon name="magnifyingglass" color={t.secondary} size={18} />
      <TextInput
        accessibilityLabel="Search sessions"
        placeholder="Search sessions"
        placeholderTextColor={t.secondary}
        value={query}
        onChangeText={setQuery}
        maxLength={400}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        style={{ flex: 1, minWidth: 0, color: t.text, fontSize: 16, paddingVertical: 10 }}
      />
      {!!query && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear session search"
          onPress={() => setQuery("")}
          hitSlop={10}
          style={{ minWidth: 32, minHeight: 44, justifyContent: "center", alignItems: "center" }}
        >
          <Text style={{ color: t.secondary, fontSize: 20 }}>×</Text>
        </Pressable>
      )}
    </View>
  );
}
