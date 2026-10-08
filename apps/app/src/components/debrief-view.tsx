import { webScrollProps } from "@/lib/web-scroll";
import { lazy, Suspense, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSettings } from "@/lib/provider";
import { loadDebrief, loadDebriefReport, generateDebrief } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { Body, Button, Heading, Panel, openUrl } from "./ui";
import { HapticRefreshControl } from "./haptic-refresh-control";

const DebriefContent = lazy(() => import("./debrief-content"));

export function DebriefView({ id }: { id?: string }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const { server, ready } = useSettings();
  const focused = useIsFocused();
  const client = useQueryClient();
  const key = ["debrief", server];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => loadDebrief(server, signal),
    enabled: ready && !!server && focused,
    refetchInterval: (q) => (focused && q.state.data?.status === "running" ? 2000 : false),
  });
  const latestId = query.data?.report?.id;
  useEffect(() => {
    if (latestId) void client.invalidateQueries({ queryKey: ["debriefHistory", server] });
  }, [client, latestId, server]);
  const [since, setSince] = useState<string | undefined>();
  const [initialSince] = useState(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [validation, setValidation] = useState("");
  const [retryRange, setRetryRange] = useState<{ since: string; until: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (range: { since: string; until: string }) => generateDebrief(server, range.since, range.until),
    onSuccess: (state) => {
      router.setParams({ id: undefined });
      client.setQueryData(key, state);
      void query.refetch();
    },
  });
  const saved = useQuery({
    queryKey: ["debriefReport", server, id],
    queryFn: ({ signal }) => loadDebriefReport(server, id!, signal),
    enabled: ready && !!server && !!id && focused,
  });
  const report = id ? saved.data : query.data?.report;
  const defaultStart =
    (query.data?.status !== "idle" ? query.data?.range?.since : undefined) ??
    query.data?.report?.until ??
    `${initialSince}T00:00:00.000Z`;
  const defaultSince = defaultStart.slice(0, 10);
  const busy = mutation.isPending || query.data?.status === "running";
  function generate(retry = false) {
    const value = since ?? defaultSince;
    const start = new Date(`${value}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(start.getTime()) ||
      start.toISOString().slice(0, 10) !== value ||
      start.getTime() >= Date.now() ||
      Date.now() - start.getTime() > 31 * 86400000
    ) {
      setValidation("Enter a valid date within the last 31 days (YYYY-MM-DD).");
      return;
    }
    setValidation("");
    const range =
      retry && (retryRange || query.data?.range)
        ? retryRange || query.data!.range!
        : { since: since === undefined ? defaultStart : start.toISOString(), until: new Date().toISOString() };
    setRetryRange(range);
    mutation.mutate(range);
  }
  return (
    <ScrollView
      {...webScrollProps}
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
      refreshControl={
        <HapticRefreshControl
          refreshing={(id ? saved.isRefetching : query.isRefetching) && !busy}
          onRefresh={() => {
            if (!ready || !server) return;
            void query.refetch();
            if (id) void saved.refetch();
          }}
          tintColor={t.accent}
        />
      }
    >
      <View style={{ width: "100%", maxWidth: 960, alignSelf: "center", gap: 16 }}>
        {ready && !server && (
          <Panel>
            <Body muted>Connect your Mac in Settings to read and save debriefs.</Body>
            <Button title="Open Settings" onPress={() => router.push("/settings")} />
          </Panel>
        )}
        <View style={{ gap: 12, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <Body muted>Review Slack since (UTC)</Body>
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <TextInput
              accessibilityLabel="Debrief start date"
              value={since ?? defaultSince}
              onChangeText={setSince}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              style={{
                minHeight: 44,
                minWidth: 145,
                borderWidth: 1,
                borderColor: t.line,
                borderRadius: 10,
                paddingHorizontal: 12,
                color: t.text,
                fontSize: 15,
              }}
            />
            <Button
              title={busy ? "Working…" : "Update debrief"}
              disabled={busy || !server}
              onPress={() => generate()}
            />
          </View>
          <Text style={{ fontSize: 13, color: t.secondary }}>
            Public channels, private channels and DMs · Every report is saved
          </Text>
          {validation ? <Body>{validation}</Body> : null}
          {busy && (
            <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
              <ActivityIndicator color={t.accent} />
              <Body>{query.data?.stage ?? "Starting…"}</Body>
            </View>
          )}
        </View>
        {(query.error || mutation.error || query.data?.error) && (
          <Panel>
            <Body>{query.error?.message ?? mutation.error?.message ?? query.data?.error}</Body>
            <Button
              subtle
              title="Try again"
              disabled={busy}
              onPress={() => (query.error ? void query.refetch() : generate(true))}
            />
          </Panel>
        )}
        {query.isLoading && <ActivityIndicator color={t.accent} />}
        {!id && !report && !busy && !query.isPending && !query.data?.error && (
          <Panel>
            <Heading>Your next catch-up starts here</Heading>
            <Body muted>
              Choose when you were last caught up. Jev filters and ranks the threads, then your debrief is written with
              links to the evidence.
            </Body>
          </Panel>
        )}
        {id && saved.isLoading && <ActivityIndicator color={t.accent} />}
        {id && saved.error && (
          <Panel>
            <Body>{saved.error.message}</Body>
            <Button title="Try again" onPress={() => void saved.refetch()} />
          </Panel>
        )}
        {id && saved.isSuccess && !report && <Body>This saved debrief was not found.</Body>}
        {report && (
          <Suspense fallback={<ActivityIndicator color={t.accent} />}>
            <DebriefContent
              key={report.id}
              report={report}
              width={Math.min(width - 32, 960)}
              dark={t.dark}
              openLink={openUrl}
              dom={{ matchContents: true, scrollEnabled: false }}
            />
          </Suspense>
        )}
      </View>
    </ScrollView>
  );
}
