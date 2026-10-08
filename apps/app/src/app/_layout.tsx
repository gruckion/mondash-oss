import { Stack } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Platform } from "react-native";
import { sheetOptions } from "@/components/sheet";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { Provider } from "@/lib/provider";
import { SegmentsProvider } from "@/lib/segments";
import { SessionSheetProvider } from "@/lib/session-sheet";
import { useTheme } from "@/lib/theme";
import { ViewOptionsProvider } from "@/lib/view-options";
import { SessionSearchProvider } from "@/lib/session-search";
import { ActivityPreferencesProvider } from "@/lib/activity-preferences";
// Expo emits global CSS only for web; a direct import survives production tree shaking.
import "../styles/scrollbars.css";

// Keep Work underneath sheets opened directly or after a web refresh.
export const unstable_settings = { anchor: "(tabs)" };

export default function RootLayout() {
  const t = useTheme();
  const { dark } = t;
  return (
    // Swipeable Inbox rows need gesture handling from the root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Provider>
        <ActivityPreferencesProvider>
          <ViewOptionsProvider>
            <SessionSearchProvider>
              <SessionSheetProvider>
                <SegmentsProvider>
                  <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
                    <StatusBar style="auto" />
                    <Stack>
                      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                      {/* Singular: taps that land while a sheet opens reuse it instead of stacking copies. */}
                      <Stack.Screen
                        name="settings"
                        dangerouslySingular
                        options={Platform.OS === "web" ? sheetOptions : { title: "Settings", presentation: "modal" }}
                      />
                      <Stack.Screen name="debrief-history" dangerouslySingular options={sheetOptions} />
                      <Stack.Screen name="agent-sessions" dangerouslySingular options={sheetOptions} />
                      <Stack.Screen
                        name="session/[tool]/[id]"
                        options={{
                          title: "Session",
                          headerShadowVisible: false,
                          headerStyle: { backgroundColor: t.background },
                          headerTintColor: t.accent,
                          headerTitleStyle: { color: t.text },
                        }}
                      />
                      <Stack.Screen name="linked-rows" dangerouslySingular options={sheetOptions} />
                      <Stack.Screen
                        name="view-options"
                        dangerouslySingular
                        options={
                          Platform.OS === "web"
                            ? sheetOptions
                            : { ...sheetOptions, sheetAllowedDetents: "fitToContents" }
                        }
                      />
                      <Stack.Screen name="activity-options" dangerouslySingular options={sheetOptions} />
                      <Stack.Screen name="fix-conflicts" dangerouslySingular options={sheetOptions} />
                      {/* Opens tall on iOS, with room to read and edit the prompt. */}
                      <Stack.Screen
                        name="claude-prompt"
                        dangerouslySingular
                        options={Platform.OS === "web" ? sheetOptions : { ...sheetOptions, sheetInitialDetentIndex: 1 }}
                      />
                    </Stack>
                  </ThemeProvider>
                </SegmentsProvider>
              </SessionSheetProvider>
            </SessionSearchProvider>
          </ViewOptionsProvider>
        </ActivityPreferencesProvider>
      </Provider>
    </GestureHandlerRootView>
  );
}
