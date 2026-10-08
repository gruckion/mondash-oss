import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { Group } from "@mondash/shared/contract";
import { applyView } from "@mondash/shared/view-options";
import { searchCandidates, rankSessionGroups } from "@mondash/shared/session-search";
import { useSettings, useSection } from "@/lib/provider";
import { useViewOptions } from "@/lib/view-options";
import { useSessionSearch } from "@/lib/session-search";
import { searchSessions } from "@/lib/api";
import { sessionDateGroups } from "@/lib/session-date-groups";
import { ThemeSurface, useTheme } from "@/lib/theme";
import { SessionSearchInput } from "./session-search-input";
import { SessionSearchBar } from "./session-search-bar";
import { DashboardScreen } from "./dashboard-screen";
import { NEW_MENU_CLEARANCE, NewMenu } from "./new-menu";
import { useHasBottomControls } from "@/lib/mobile-view";

export function SessionsScreen() {
  return (
    <ThemeSurface value="session-sidebar">
      <SessionsContent />
    </ThemeSurface>
  );
}

function SessionsContent() {
  const t = useTheme();
  const { server } = useSettings();
  const { data } = useSection("sessions");
  const { view } = useViewOptions("sessions");
  const { query } = useSessionSearch();
  const text = query.trim();
  const [submitted, setSubmitted] = useState("");
  const [calendarDay, setCalendarDay] = useState(() => new Date().setHours(0, 0, 0, 0));
  useEffect(() => {
    const timer = setInterval(() => setCalendarDay(new Date().setHours(0, 0, 0, 0)), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSubmitted(text), 600);
    return () => clearTimeout(timer);
  }, [text]);
  const showPreview = !view.hidden.includes("preview");
  const candidates = useMemo(
    () => searchCandidates(applyView("sessions", data?.groups ?? [], view), showPreview),
    [data, view, showPreview],
  );
  // Text, not timestamps: a live refresh with unchanged visible content reuses the ranking.
  const revision = JSON.stringify(candidates);
  const ranking = useQuery({
    queryKey: ["session-search", server, submitted, revision],
    queryFn: ({ signal }) => searchSessions(server, { query: submitted, candidates }, signal),
    enabled: !!server && submitted.length >= 2 && candidates.length > 0 && submitted === text,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  const scores = submitted === text ? ranking.data?.scores : undefined;
  const dateHeadings = !text && view.sort === "default";
  const transform = useCallback(
    (groups: readonly Group[]) =>
      dateHeadings
        ? sessionDateGroups(groups, new Date(calendarDay))
        : rankSessionGroups(groups, text, scores ?? [], showPreview),
    [text, scores, showPreview, dateHeadings, calendarDay],
  );
  const accessory = useHasBottomControls();
  const archived =
    data?.groups.flatMap((group) => group.cards).filter((card) => card.sessions.some((session) => session.archived))
      .length ?? 0;
  const hideArchives = view.filters.archive?.length === 1 && view.filters.archive[0] === "Not archived";
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: t.background }}>
      <SessionSearchBar />
      <DashboardScreen
        section="sessions"
        bottomSpace={NEW_MENU_CLEARANCE + (accessory ? 60 : 0)}
        transformGroups={transform}
        sessionDateHeadings={dateHeadings}
        banner={
          <View style={{ paddingHorizontal: 16, gap: 5, paddingBottom: 8 }}>
            {!accessory && (
              <View style={{ backgroundColor: t.chip, borderRadius: 12 }}>
                <SessionSearchInput />
              </View>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {text && ranking.isFetching ? <ActivityIndicator size="small" color={t.secondary} /> : null}
              <Text style={{ color: t.secondary, fontSize: 12 }}>
                {text
                  ? !candidates.length
                    ? "No sessions match your filters"
                    : submitted === text && ranking.error
                      ? "Jev unavailable · Text matches first"
                      : scores?.length
                        ? "Best matches first · Jev"
                        : text.length < 2
                          ? "Type at least 2 characters"
                          : "Finding best matches…"
                  : `Last 7 days · ${candidates.length} sessions${hideArchives && archived ? ` · ${archived} archived hidden` : ""}`}
              </Text>
            </View>
          </View>
        }
      />
      <NewMenu bottomOffset={accessory ? 52 : 0} />
    </View>
  );
}
