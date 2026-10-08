import { ScrollView, Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useActivityPreferences } from "@/lib/activity-preferences";
import { useTheme } from "@/lib/theme";
import { webScrollProps } from "@/lib/web-scroll";
import { Sheet } from "@/components/sheet";
import { Block, Row, Header, Button } from "@/components/view-option-primitives";
import { Toggle } from "@/components/toggle";
import type { ActivityPreferences, ActivitySource } from "@mondash/shared/contract";

const sources: readonly ActivitySource[] = ["linear", "github", "slack", "notion", "claude", "codex"];
const names = {
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
  notion: "Notion",
  claude: "Claude Code",
  codex: "Codex",
};
export default function ActivityOptions() {
  const { panel } = useLocalSearchParams<{ panel?: string }>();
  const { preferences: p, update } = useActivityPreferences();
  const t = useTheme();
  const range = panel === "range",
    display = panel === "display";
  const hidden = p.hidden ?? [];
  const properties = [
    { key: "snippets" as const, title: "Message previews" },
    { key: "links" as const, title: "Linked work" },
    { key: "history" as const, title: "Item history in details" },
  ];
  return (
    <Sheet>
      <ScrollView
        {...webScrollProps}
        contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 24 }}
        style={{ backgroundColor: t.background, flexGrow: 0 }}
      >
        <Header title={range ? "Time range" : display ? "Display" : "Activity filters"} />
        {range ? (
          <Block>
            {([1, 3, 7, 30, 90] as const).map((days, i) => (
              <Row
                key={days}
                title={days === 1 ? "Today" : `${days} days`}
                checked={p.days === days}
                last={i === 4}
                onPress={() => update({ days })}
              />
            ))}
          </Block>
        ) : display ? (
          <>
            <Text style={{ color: t.secondary, fontSize: 13, paddingHorizontal: 4 }}>What each event shows</Text>
            <Block>
              {properties.map((property, i) => (
                <Row
                  key={property.key}
                  title={property.title}
                  switchOn={!hidden.includes(property.key)}
                  trailing={<Toggle on={!hidden.includes(property.key)} />}
                  last={i === properties.length - 1}
                  onPress={() =>
                    update({
                      hidden: hidden.includes(property.key)
                        ? hidden.filter((key) => key !== property.key)
                        : [...hidden, property.key],
                    })
                  }
                />
              ))}
            </Block>
            {!!hidden.length && <Button title="Show everything" onPress={() => update({ hidden: [] })} />}
          </>
        ) : (
          <>
            <Block>
              <Row
                title="Needs me"
                about="Replies, reviews, failed checks, conflicts and unread activity that still needs your attention."
                switchOn={p.needs}
                trailing={<Toggle on={p.needs} />}
                last
                onPress={() => update({ needs: !p.needs })}
              />
            </Block>
            <Text style={{ color: t.secondary, fontSize: 13, paddingHorizontal: 4 }}>Sources</Text>
            <Block>
              {sources.map((source, i) => (
                <Row
                  key={source}
                  title={names[source]}
                  checked={!p.sources.length || p.sources.includes(source)}
                  last={i === sources.length - 1}
                  onPress={() => {
                    const chosen = p.sources.length ? p.sources : sources;
                    const next = chosen.includes(source)
                      ? chosen.filter((value) => value !== source)
                      : [...chosen, source];
                    if (next.length)
                      update({
                        sources: next.length === sources.length ? [] : (next as ActivityPreferences["sources"]),
                      });
                  }}
                />
              ))}
            </Block>
            {(p.sources.length > 0 || p.needs) && (
              <Button title="Reset filters" onPress={() => update({ sources: [], needs: false })} />
            )}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}
