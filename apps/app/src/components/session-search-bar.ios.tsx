import { useCallback, useEffect, useRef } from "react";
import { Stack, useIsFocused } from "expo-router";
import type { SearchBarCommands, SearchBarProps } from "react-native-screens";
import { useHasBottomControls } from "@/lib/mobile-view";
import { useSessionSearch } from "@/lib/session-search";
import { useTheme } from "@/lib/theme";

/** UIKit owns the search field and moves it above the keyboard while editing. */
function NativeSessionSearch() {
  const { query, setQuery } = useSessionSearch();
  const t = useTheme();
  const focused = useIsFocused();
  const search = useRef<SearchBarCommands>(null);
  const nativeText = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focused) search.current?.blur();
    else if (search.current && nativeText.current !== query) {
      search.current.setText(query);
      nativeText.current = query;
    }
  }, [focused, query]);
  const changeText = useCallback<NonNullable<SearchBarProps["onChangeText"]>>(
    ({ nativeEvent: { text } }) => {
      const next = text.slice(0, 400);
      nativeText.current = next;
      if (next !== text) search.current?.setText(next);
      setQuery(next);
    },
    [setQuery],
  );
  return (
    <Stack.SearchBar
      ref={search}
      placeholder="Search sessions"
      placement="automatic"
      allowToolbarIntegration
      hideWhenScrolling={false}
      obscureBackground={false}
      autoCapitalize="none"
      tintColor={t.accent}
      textColor={t.text}
      onChangeText={changeText}
      onSearchButtonPress={() => search.current?.blur()}
    />
  );
}

export function SessionSearchBar() {
  const supported = useHasBottomControls();
  return supported ? <NativeSessionSearch /> : null;
}
