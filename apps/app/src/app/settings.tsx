import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet } from "@/components/sheet";
import { Icon } from "@/components/icon";
import { SourceIcon } from "@/components/web-icons";
import { Body, Button, errorMessage, touchWeb } from "@/components/ui";
import { webScrollProps } from "@/lib/web-scroll";
import { useConnection, useProviderHealth, useSettings } from "@/lib/provider";
import { needsAttention } from "@/lib/provider-health";
import { ConnectionStatus } from "@/components/connection-status";
import { usesIroh } from "@/lib/transport";
import { useTheme } from "@/lib/theme";
import { loadConnections, discoverAccount, applySettings, startClaudeSignIn } from "@/lib/api";
import type { Account, SettingsCommand, SettingsResponse, WorkSource } from "@mondash/shared/settings";
import { NotionPicker } from "@/components/notion-picker";
import ClaudePhoneAuth from "../../modules/claude-phone-auth/src/ClaudePhoneAuthModule";

const NAMES = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  notion: "Notion",
  claude: "Claude",
  codex: "Codex",
} as const;
type ConnectionName = keyof typeof NAMES;
const SOURCES: readonly ConnectionName[] = ["github", "linear", "slack", "notion", "claude", "codex"];
const WORK: readonly WorkSource[] = ["github", "linear", "slack", "notion"];
const isWork = (name: string): name is WorkSource => WORK.some((n) => n === name);
const WEB = Platform.OS === "web";
function nativeCommand(command: string) {
  if (!WEB) return false;
  const native = window as unknown as {
    webkit?: { messageHandlers?: { mondash?: { postMessage(value: string): void } } };
  };
  const handler = native.webkit?.messageHandlers?.mondash;
  if (!handler) return false;
  handler.postMessage(command);
  return true;
}

function Row({
  title,
  subtitle,
  icon,
  onPress,
  trailing,
  badge,
  badgeAction,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  onPress(): void;
  trailing?: React.ReactNode;
  badge?: React.ReactNode;
  badgeAction?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 58,
        borderBottomWidth: 1,
        borderColor: t.line,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          opacity: pressed ? 0.65 : 1,
          paddingVertical: 8,
        })}
      >
        {icon && <View style={{ width: 26, alignItems: "center" }}>{icon}</View>}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: "500" }}>{title}</Text>
          {subtitle && (
            <Text numberOfLines={2} style={{ color: t.secondary, fontSize: 12 }}>
              {subtitle}
            </Text>
          )}
        </View>
        {badge && <View>{badge}</View>}
        {!trailing && <Icon name="chevron.right" color={t.secondary} size={14} />}
      </Pressable>
      {badgeAction}
      {trailing}
    </View>
  );
}
function ConnectionSwitch({
  title,
  enabled,
  disabled,
  onChange,
}: {
  title: string;
  enabled: boolean;
  disabled: boolean;
  onChange(enabled: boolean): void;
}) {
  const t = useTheme();
  return (
    <View style={{ minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: "500" }}>{title}</Text>
      <Switch
        accessibilityLabel={title}
        value={enabled}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: t.line, true: t.dark ? "#4ade80" : "#15803d" }}
      />
    </View>
  );
}
function SourceImage({ name }: { name: ConnectionName }) {
  if (isWork(name)) return <SourceIcon source={name} size={23} />;
  return (
    <Image
      source={name === "claude" ? require("../../assets/claude-symbol.svg") : require("../../assets/codex-logo.png")}
      contentFit="contain"
      style={{ width: 23, height: 23 }}
    />
  );
}
function Choice({
  title,
  selected,
  onPress,
  radio = false,
}: {
  title: string;
  selected: boolean;
  radio?: boolean;
  onPress(): void;
}) {
  const t = useTheme();
  return (
    <Row
      title={title}
      onPress={onPress}
      trailing={
        <Pressable
          accessibilityRole={radio ? "radio" : "checkbox"}
          accessibilityLabel={title}
          aria-checked={selected}
          onPress={onPress}
          style={{ width: 44, height: 44, justifyContent: "center", alignItems: "center" }}
        >
          <Icon name={selected ? "checkmark.circle" : "plus"} color={selected ? t.accent : t.secondary} size={19} />
        </Pressable>
      }
    />
  );
}

export default function Settings() {
  const t = useTheme();
  const { server, setServer, macDesktop, claudeTarget, setClaudeTarget } = useSettings();
  const healthQuery = useProviderHealth();
  const macConnection = useConnection();
  const params = useLocalSearchParams<{ connection?: string }>();
  const requestedPage = typeof params.connection === "string" ? params.connection : "";
  const page = [...SOURCES, "claude-target", "smart-matching", "notifications", "devices"].includes(requestedPage)
    ? requestedPage
    : "";
  const navigate = (connection: string) => router.setParams({ connection });
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", server],
    queryFn: async ({ signal }) => {
      const snapshot = await loadConnections(server, signal);
      // The header warning, rows and option pages share the same current health snapshot.
      queryClient.setQueryData(["health", server], snapshot.health);
      return snapshot;
    },
    enabled: !!server,
    refetchInterval: 30_000,
  });
  const [busy, setBusy] = useState(false);
  const [macAddress, setMacAddress] = useState(server);
  const [error, setError] = useState<string>();
  const [discovered, setDiscovered] = useState<Account>();
  const [organizations, setOrganizations] = useState<readonly string[]>();
  const [personalOnly, setPersonalOnly] = useState(false);
  const data = settings.data;
  const connections = healthQuery.data?.connections ?? data?.health.connections ?? [];
  const history = connections.find((c) => c.name === "sessions");
  function statusFor(name: ConnectionName) {
    const connection = connections.find((c) => c.name === name);
    const active = isWork(name) ? data?.profile.integrations[name] : data?.profile.integrations.sessions;
    if (!active) return { state: "off", label: "Off" } as const;
    if (connection?.state === "error") return { state: "error", label: "Retry" } as const;
    if (connection?.state === "not-connected") return { state: "not-connected", label: "Disconnected" } as const;
    if (connection?.state !== "connected") return { state: "unknown", label: "Checking" } as const;
    if (name === "notion" && !data?.profile.notion.view) return { state: "setup", label: "Choose board" } as const;
    if (!isWork(name) && history && needsAttention(history)) return { state: "error", label: "History" } as const;
    return { state: "connected", label: "Connected" } as const;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  async function apply(command: SettingsCommand) {
    const result = await applySettings(server, command);
    if (result.restarting) await new Promise((resolve) => setTimeout(resolve, 1400));
    let next: SettingsResponse | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        next = await loadConnections(server);
        if (result.restarting && next.restartRequired) throw new Error("Mondash is still applying settings.");
        break;
      } catch (reason) {
        if (attempt === 5) throw reason;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    if (next?.restartRequired && !result.restarting)
      throw new Error("Settings saved. Restart Mondash on your Mac to apply them.");
    if (next) queryClient.setQueryData(["settings", server], next);
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "settings" });
  }
  async function connect(name: ConnectionName) {
    if (name === "claude" && usesIroh && !WEB) throw new Error("Sign in to Claude from Mondash on your Mac.");
    if (isWork(name)) {
      if (
        (name === "notion" || name === "slack") &&
        (!data?.accounts.some((a) => a.source === name) ||
          connections.find((c) => c.name === name)?.state === "not-connected")
      ) {
        if (nativeCommand(`connect-${name}`)) return;
        if (!WEB || touchWeb()) {
          navigate(name);
          throw new Error("Continue in Mondash on your Mac to connect this account.");
        }
        window.location.assign(`${server}/api/auth/${name}/start`);
        return;
      }
      const account = await discoverAccount(server, name);
      setDiscovered(account);
      if (name === "github" && !data?.profile.integrations.github) {
        setOrganizations(data?.profile.workspace.organizations ?? []);
        setPersonalOnly(data?.profile.workspace.githubPersonalOnly ?? false);
        navigate("github");
        return;
      }
      await apply({ kind: "connect", source: name });
      if (page) navigate(name);
    } else if (name === "claude") {
      if (!data?.profile.integrations.sessions) await apply({ kind: "feature", name: "sessions", active: true });
      if (nativeCommand("connect-claude")) return;
      if (Platform.OS === "ios" && ClaudePhoneAuth) {
        const attempt = await startClaudeSignIn(server);
        if (!attempt.url || attempt.state !== "waiting")
          throw new Error(attempt.message ?? "Claude sign-in is not available.");
        await ClaudePhoneAuth.signIn(
          `${server}/auth/claude?id=${attempt.id}`,
          `${server}/api/agent-auth/claude/${attempt.id}/callback`,
          attempt.url,
        );
        await settings.refetch();
      } else if (WEB && !touchWeb()) window.location.assign(`${server}/auth/claude`);
      else throw new Error("Connect Claude in Mondash on your Mac.");
    } else {
      throw new Error("Sign in to Codex on your Mac.");
    }
  }
  const source = isWork(page) ? page : undefined;
  const account = source
    ? discovered?.source === source
      ? discovered
      : data?.accounts.find((a) => a.source === source)
    : undefined;
  const connection = connections.find((c) => c.name === page);
  const feature = page === "smart-matching" ? "classification" : page === "notifications" ? "notifications" : undefined;
  const title =
    page && page in NAMES
      ? NAMES[page as ConnectionName]
      : ({
          "smart-matching": "Smart matching",
          notifications: "Notifications",
          devices: "Devices",
          "claude-target": "Open Claude sessions",
        }[page] ?? "Settings");
  const root = !page;
  return (
    <Sheet>
      {!WEB && <Stack.Screen options={{ sheetAllowedDetents: [1] }} />}
      {!WEB && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button icon="checkmark" tintColor={t.text} variant="plain" onPress={() => router.back()}>
            Done
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <ScrollView
        {...webScrollProps}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 20 }}
      >
        {(WEB || !root) && (
          <View style={{ flexDirection: "row", alignItems: "center", minHeight: 40, marginBottom: 14, gap: 10 }}>
            {!root && (
              <Pressable
                accessibilityLabel="Back to settings"
                accessibilityRole="button"
                onPress={() => {
                  setError(undefined);
                  navigate("");
                }}
                style={{ width: 36, height: 44, justifyContent: "center" }}
              >
                <Icon name="chevron.left" color={t.accent} size={20} />
              </Pressable>
            )}
            <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontWeight: "600", fontSize: 22 }}>
              {title}
            </Text>
            {WEB && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close settings"
                onPress={() => router.back()}
                style={{ height: 44, width: 44, alignItems: "center", justifyContent: "center" }}
              >
                <Icon name="checkmark" color={t.text} size={23} />
              </Pressable>
            )}
          </View>
        )}
        {!server && root && <Button title="Connect your Mac" onPress={() => navigate("devices")} />}
        {server && settings.isPending && <ActivityIndicator color={t.accent} />}
        {(error || settings.error) && (
          <View accessibilityRole="alert" style={{ paddingVertical: 12 }}>
            <Body>{error || settings.error?.message}</Body>
          </View>
        )}
        {busy && (
          <View style={{ flexDirection: "row", gap: 10, paddingBottom: 8 }}>
            <ActivityIndicator color={t.accent} />
            <Body muted>Working…</Body>
          </View>
        )}
        {data && root && (
          <>
            {SOURCES.map((name) => {
              const work = isWork(name);
              const self = work ? data.accounts.find((a) => a.source === name) : undefined;
              const status = statusFor(name);
              const context = work ? self?.workspace || self?.login || self?.name : undefined;
              return (
                <Row
                  key={name}
                  title={NAMES[name]}
                  subtitle={context}
                  accessibilityLabel={[NAMES[name], context, status.label].filter(Boolean).join(", ")}
                  badge={
                    status.state !== "connected" && status.state !== "not-connected" ? (
                      <ConnectionStatus {...status} />
                    ) : undefined
                  }
                  badgeAction={
                    status.state === "not-connected" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Reconnect ${NAMES[name]}`}
                        disabled={busy}
                        onPress={() => void run(() => connect(name))}
                        style={({ pressed }) => ({
                          minHeight: 44,
                          justifyContent: "center",
                          opacity: busy ? 0.5 : pressed ? 0.65 : 1,
                        })}
                      >
                        <ConnectionStatus {...status} />
                      </Pressable>
                    ) : undefined
                  }
                  icon={<SourceImage name={name} />}
                  onPress={() => {
                    setError(undefined);
                    navigate(name);
                  }}
                  trailing={
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${NAMES[name]} options`}
                      onPress={() => {
                        setError(undefined);
                        navigate(name);
                      }}
                      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
                    >
                      <Icon name="ellipsis" color={t.secondary} size={21} />
                    </Pressable>
                  }
                />
              );
            })}
            <View style={{ marginTop: 14, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              {[
                ["smart-matching", "Smart matching"],
                ["notifications", "Notifications"],
                ["devices", "Devices"],
              ].map(([id, name]) => (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  onPress={() => {
                    setError(undefined);
                    navigate(id);
                  }}
                  style={{ width: "48%", minHeight: 40, justifyContent: "center" }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: t.secondary, fontSize: 13 }}>{name}</Text>
                    {id === "devices" && (macConnection === "down" || healthQuery.isError) && (
                      <ConnectionStatus state="error" label={macConnection === "down" ? "Offline" : "Retry"} />
                    )}
                    <Icon name="chevron.right" color={t.secondary} size={12} />
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}
        {data && source && (
          <View style={{ gap: 12 }}>
            {account && (
              <Body muted>
                {account.name}
                {account.workspace ? ` · ${account.workspace}` : account.login ? ` · @${account.login}` : ""}
              </Body>
            )}
            {connection && needsAttention(connection) && (
              <>
                <ConnectionStatus
                  state={connection.state}
                  label={connection.state === "not-connected" ? "Disconnected" : "Needs attention"}
                />
                {connection.message && <Body>{connection.message}</Body>}
              </>
            )}
            <ConnectionSwitch
              title={`Use ${NAMES[source]}`}
              enabled={data.profile.integrations[source]}
              disabled={busy}
              onChange={(enabled) =>
                void run(() => (enabled ? connect(source) : apply({ kind: "disconnect", source })))
              }
            />
            {data.profile.integrations[source] &&
              (connection?.state === "not-connected" || connection?.state === "error") && (
                <Button
                  title={
                    connection?.state === "error"
                      ? "Check connection"
                      : `${data.profile.integrations[source] ? "Reconnect" : "Connect"} ${NAMES[source]}`
                  }
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      if (connection?.state === "error") {
                        await healthQuery.refetch();
                        await settings.refetch();
                      } else await connect(source);
                    })
                  }
                />
              )}
            {source === "github" && (
              <>
                <Row
                  title="Include work from"
                  subtitle={
                    data.profile.workspace.githubPersonalOnly
                      ? "Personal repositories"
                      : data.profile.workspace.organizations.join(", ") || "Existing scope: accessible repositories"
                  }
                  onPress={() =>
                    void run(async () => {
                      const value = await discoverAccount(server, "github");
                      setDiscovered(value);
                      setOrganizations(data.profile.workspace.organizations);
                      setPersonalOnly(data.profile.workspace.githubPersonalOnly ?? false);
                    })
                  }
                />
                {organizations && (
                  <>
                    <Choice
                      title="Personal repositories only"
                      selected={personalOnly}
                      onPress={() => {
                        setPersonalOnly(!personalOnly);
                        setOrganizations([]);
                      }}
                    />
                    {account?.options.map((org) => (
                      <Choice
                        key={org.id}
                        title={org.name}
                        selected={organizations.includes(org.id)}
                        onPress={() => {
                          setPersonalOnly(false);
                          setOrganizations(
                            organizations.includes(org.id)
                              ? organizations.filter((id) => id !== org.id)
                              : [...organizations, org.id],
                          );
                        }}
                      />
                    ))}
                    {account && !account.complete && (
                      <Body muted>
                        Some organizations may not be visible with this account&apos;s permissions. Existing selections
                        are retained.
                      </Body>
                    )}
                    <Button
                      title="Use this scope"
                      disabled={busy}
                      onPress={() =>
                        void run(async () => {
                          await apply(
                            data.profile.integrations.github
                              ? { kind: "scope", organizations, personalOnly }
                              : { kind: "connect", source: "github", organizations, personalOnly },
                          );
                          setOrganizations(undefined);
                        })
                      }
                    />
                  </>
                )}
              </>
            )}
            {source === "notion" && (
              <NotionPicker
                server={server}
                currentView={data.profile.notion.view}
                onApply={(selection) => apply({ kind: "notion", selection })}
              />
            )}
            {(source === "slack" || source === "notion") && (
              <Button
                subtle
                title={connection?.state === "connected" ? "Reconnect account" : "Sign in"}
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    if (nativeCommand(`connect-${source}`)) return;
                    if (!WEB || touchWeb()) throw new Error("Continue in Mondash on your Mac to sign in.");
                    window.location.assign(`${server}/api/auth/${source}/start`);
                  })
                }
              />
            )}
            {source === "linear" && !account && <Body muted>Add your Linear API key on your Mac.</Body>}
            {source === "github" && !account && <Body muted>Sign in with GitHub CLI on your Mac.</Body>}
          </View>
        )}
        {data && (page === "claude" || page === "codex" || page === "claude-target") && (
          <View style={{ gap: 12 }}>
            {page === "claude-target" ? (
              <>
                <Choice
                  title="Claude app"
                  radio
                  selected={claudeTarget === "claude-desktop"}
                  onPress={() =>
                    void run(async () => {
                      await setClaudeTarget("claude-desktop");
                      navigate("");
                    })
                  }
                />
                <Choice
                  title="Terminal"
                  radio
                  selected={claudeTarget === "terminal"}
                  onPress={() =>
                    void run(async () => {
                      await setClaudeTarget("terminal");
                      navigate("");
                    })
                  }
                />
                <Body muted>For this browser on your Mac.</Body>
              </>
            ) : (
              <>
                <ConnectionStatus
                  state={connection?.state ?? "unknown"}
                  label={
                    connection?.state === "connected"
                      ? "Signed in"
                      : connection?.state === "not-connected"
                        ? "Signed out"
                        : connection?.state === "error"
                          ? "Needs attention"
                          : "Checking"
                  }
                />
                {connection && needsAttention(connection) && connection.message && <Body>{connection.message}</Body>}
                {page === "claude" && connection?.state !== "connected" && (
                  <Button title="Sign in to Claude" disabled={busy} onPress={() => void run(() => connect("claude"))} />
                )}
                {page === "codex" && connection?.state !== "connected" && (
                  <Body muted>Sign in to Codex on your Mac.</Body>
                )}
                <Row
                  title="Local history"
                  subtitle={
                    !data.profile.integrations.sessions
                      ? "Paused"
                      : history?.state === "connected"
                        ? "Synced"
                        : history && needsAttention(history)
                          ? "Could not sync"
                          : "Checking"
                  }
                  onPress={() =>
                    void run(async () => {
                      await settings.refetch();
                    })
                  }
                  badge={
                    history && needsAttention(history) ? <ConnectionStatus state="error" label="Retry" /> : undefined
                  }
                  trailing={<Icon name="arrow.clockwise" color={t.secondary} size={18} />}
                />
                {page === "claude" && macDesktop && (
                  <Row
                    title="Open sessions in"
                    subtitle={claudeTarget === "terminal" ? "Terminal" : "Claude app"}
                    onPress={() => navigate("claude-target")}
                  />
                )}
                <ConnectionSwitch
                  title="Sync both local histories"
                  enabled={data.profile.integrations.sessions}
                  disabled={busy}
                  onChange={(active) => void run(() => apply({ kind: "feature", name: "sessions", active }))}
                />
              </>
            )}
          </View>
        )}
        {data && feature && (
          <View style={{ gap: 12 }}>
            <Body muted>
              {feature === "classification"
                ? "Jev connects related work and ranks relevant sessions. Selected context is sent to TypeSafe; usage may incur a charge."
                : "Receive work updates through the notification destination configured on your Mac."}
            </Body>
            <Body>{data.profile.integrations[feature] ? "On" : "Off"}</Body>
            {data.available[feature] ? (
              <Button
                title={data.profile.integrations[feature] ? "Turn off" : "Turn on"}
                disabled={busy}
                onPress={() =>
                  void run(() => apply({ kind: "feature", name: feature, active: !data.profile.integrations[feature] }))
                }
              />
            ) : (
              <Body muted>Configure this service on your Mac to use it.</Body>
            )}
          </View>
        )}
        {page === "devices" && (
          <View style={{ gap: 12 }}>
            {macConnection === "down" && <ConnectionStatus state="error" label="Mac offline" />}
            {healthQuery.isError && macConnection !== "down" && (
              <Button
                title="Check connection"
                onPress={() =>
                  void run(async () => {
                    await healthQuery.refetch();
                    await settings.refetch();
                  })
                }
              />
            )}
            <Body muted>Keep Mondash open on your Mac.</Body>
            {!WEB && !usesIroh && (
              <>
                <TextInput
                  accessibilityLabel="Mondash server address"
                  value={macAddress}
                  onChangeText={setMacAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="Your Mac’s Mondash address"
                  placeholderTextColor={t.secondary}
                  style={{
                    color: t.text,
                    borderColor: t.line,
                    borderWidth: 1,
                    borderRadius: 10,
                    padding: 12,
                    minHeight: 44,
                  }}
                />
                <Button
                  title="Connect to your Mac"
                  disabled={busy || !macAddress.trim()}
                  onPress={() =>
                    void run(async () => {
                      const url = new URL(macAddress.trim());
                      if (!["http:", "https:"].includes(url.protocol))
                        throw new Error("Enter your Mac’s Mondash web address.");
                      await setServer(url.href.replace(/\/$/, ""));
                    })
                  }
                />
              </>
            )}
            {WEB &&
              Boolean(
                (window as unknown as { webkit?: { messageHandlers?: { mondash?: unknown } } }).webkit?.messageHandlers
                  ?.mondash,
              ) && (
                <>
                  <Button
                    subtle
                    title="Paired devices"
                    onPress={() => {
                      if (!nativeCommand("manage-devices"))
                        setError("Manage paired devices from Mondash’s menu on your Mac.");
                    }}
                  />
                  <Button
                    subtle
                    title="Open in browser"
                    onPress={() => {
                      if (!nativeCommand("open-browser"))
                        setError("Choose Open in browser from Mondash’s menu on your Mac.");
                    }}
                  />
                </>
              )}
            {!WEB && <Body muted>Pair or remove devices from the Mac menu.</Body>}
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}
