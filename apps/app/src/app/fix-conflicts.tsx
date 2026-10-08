import { TooltipButton } from "@/components/tooltip-button";
import { webScrollProps } from "@/lib/web-scroll";
import { useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { codexUrl, withReviewers } from "@mondash/shared/conflict-prompt";
import { Icon } from "@/components/icon";
import { Sheet } from "@/components/sheet";
import { Toggle } from "@/components/toggle";
import { openWebLink, touchWeb } from "@/components/ui";
import { useSessionSheet } from "@/lib/session-sheet";
import { useTheme } from "@/lib/theme";

/** Codex runs on the Mac, so its link only works in a desktop browser there. */
const canOpenCodex = Platform.OS === "web" && !touchWeb();

function Option({ title, detail, on, onToggle }: { title: string; detail: string; on: boolean; onToggle: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      onPress={onToggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 15 }}>{title}</Text>
        <Text style={{ color: t.secondary, fontSize: 12 }}>{detail}</Text>
      </View>
      <Toggle on={on} />
    </Pressable>
  );
}

/**
 * Hands a PR's merge conflicts to Codex: copy the prompt (or, on the Mac, open it in a new Codex thread), with an
 * optional step asking CodeRabbit and Greptile to review again after the push.
 */
export default function FixConflictsSheet() {
  const t = useTheme();
  const { conflict } = useSessionSheet();
  const [coderabbit, setCoderabbit] = useState(false);
  const [greptile, setGreptile] = useState(false);
  const [copied, setCopied] = useState(false);
  const prompt = conflict ? withReviewers(conflict.fix.prompt, { coderabbit, greptile }) : "";
  return (
    <Sheet>
      <ScrollView
        {...webScrollProps}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: t.background }}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: "600" }}>
            Fix conflicts{conflict ? ` · ${conflict.pr}` : ""}
          </Text>
          <TooltipButton
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => router.back()}
            style={{
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="xmark.circle.fill" color={t.secondary} size={28} />
          </TooltipButton>
        </View>
        {conflict ? (
          <>
            <Text style={{ color: t.secondary, fontSize: 14, lineHeight: 20 }}>
              Codex merges the latest main into the branch and its related PRs, never rebases or force pushes,
              regenerates generated types, runs the tests, then commits and pushes.
            </Text>
            <View
              style={{
                backgroundColor: t.dark ? "#1c1c1e" : "#f4f4f5",
                borderRadius: 12,
              }}
            >
              <Option
                title="CodeRabbit"
                detail="Comment @coderabbitai review after pushing"
                on={coderabbit}
                onToggle={() => setCoderabbit(!coderabbit)}
              />
              <View style={{ height: 1, backgroundColor: t.line, marginLeft: 14 }} />
              <Option
                title="Greptile"
                detail="Comment @greptileai review after pushing"
                on={greptile}
                onToggle={() => setGreptile(!greptile)}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void Clipboard.setStringAsync(prompt).then(() => setCopied(true));
              }}
              style={{
                minHeight: 48,
                borderRadius: 12,
                backgroundColor: t.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  color: t.dark ? "#0a0a0a" : "#ffffff",
                  fontSize: 16,
                  fontWeight: "600",
                }}
              >
                {copied ? "Copied" : "Copy prompt"}
              </Text>
            </Pressable>
            {canOpenCodex && (
              <Pressable
                accessibilityRole="link"
                onPress={() => openWebLink(codexUrl(prompt, conflict.fix.folder))}
                style={{
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: t.accent, fontSize: 15, fontWeight: "500" }}>Open in Codex</Text>
              </Pressable>
            )}
            <Text selectable style={{ color: t.secondary, fontSize: 12, lineHeight: 17 }}>
              {prompt}
            </Text>
          </>
        ) : (
          <Text style={{ color: t.secondary, fontSize: 15 }}>Open this from a PR with merge conflicts.</Text>
        )}
      </ScrollView>
    </Sheet>
  );
}
