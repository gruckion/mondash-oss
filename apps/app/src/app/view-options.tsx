import { Block, Row, Header, Button } from "@/components/view-option-primitives";
import { webScrollProps } from "@/lib/web-scroll";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  DEFAULT_VIEW,
  viewOptionsFor,
  isFiltered,
  propertyValues,
  VIEW_CONFIG,
  type ViewSection,
} from "@mondash/shared/view-options";
import { Image } from "expo-image";
import type { Card } from "@mondash/shared/contract";
import { Toggle } from "@/components/toggle";
import { LabelChips, People, Pill } from "@/components/card-details";
import { NotionStatus } from "@/components/notion-status";
import { notionPriorityColor } from "@mondash/shared/notion-status";
import { PriorityIcon, SourceIcon, StatusIcon } from "@/components/web-icons";
import { Sheet } from "@/components/sheet";
import { useSection } from "@/lib/provider";
import { useTheme } from "@/lib/theme";
import { useViewOptions } from "@/lib/view-options";

const SECTIONS = Object.keys(VIEW_CONFIG);
const isSection = (value: unknown): value is ViewSection => typeof value === "string" && SECTIONS.includes(value);

type Step = { kind: "root" } | { kind: "sort" } | { kind: "property"; key: string };

const LINEAR_PRIORITY: Record<string, number> = {
  Urgent: 1,
  High: 2,
  Medium: 3,
  Low: 4,
};

/** A filter value drawn as the cards draw it: status icon, priority bars, a label's pill, a face, an app icon. */
function ValueLabel({
  section,
  property,
  value,
  card,
}: {
  section: ViewSection;
  property: string;
  value: string;
  card: Card;
}) {
  const t = useTheme();
  const text = (
    <Text numberOfLines={1} style={{ flexShrink: 1, color: t.text, fontSize: 15 }}>
      {value}
    </Text>
  );
  if (property === "status" && section === "scoping") return <NotionStatus status={value} />;
  if (property === "status")
    return (
      <Pill>
        <StatusIcon status={value} statusType={card.statusType} />
        <Text style={{ color: t.text, fontSize: 12, lineHeight: 16 }}>{value}</Text>
      </Pill>
    );
  if (property === "priority")
    return (
      <Pill>
        <PriorityIcon
          priority={{
            value: card.priority === value && card.priorityValue ? card.priorityValue : (LINEAR_PRIORITY[value] ?? 0),
            name: value,
          }}
          color={section === "scoping" ? notionPriorityColor(value, t.dark) : undefined}
        />
        <Text style={{ color: t.text, fontSize: 12, lineHeight: 16 }}>{value}</Text>
      </Pill>
    );
  if (property === "label") return <LabelChips labels={[value]} colors={card.labelColors} inline />;
  if (property === "author" && card.author)
    return (
      <Pill>
        <People people={[card.author]} names />
      </Pill>
    );
  const icon =
    property === "source" ? (
      <SourceIcon
        source={value === "Github" ? "github" : value === "Slack" ? "slack" : value === "Notion" ? "notion" : "linear"}
      />
    ) : property === "repo" ? (
      <SourceIcon source="github" />
    ) : property === "tool" ? (
      <Image
        source={value === "Codex" ? require("../../assets/codex-logo.png") : require("../../assets/claude-symbol.svg")}
        contentFit="contain"
        style={{ width: 14, height: 14 }}
      />
    ) : property === "read" ? (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: value === "Unread" ? t.accent : "transparent",
          borderWidth: value === "Unread" ? 0 : 1,
          borderColor: t.secondary,
        }}
      />
    ) : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        flexShrink: 1,
      }}
    >
      {icon}
      {text}
    </View>
  );
}

function FilterPanel({ section }: { section: ViewSection }) {
  const t = useTheme();
  const config = VIEW_CONFIG[section];
  const { view, update } = useViewOptions(section);
  const groups = useSection(section).data?.groups ?? [];
  const [step, setStep] = useState<Step>({ kind: "root" });
  const back = () => setStep({ kind: "root" });
  if (step.kind === "sort")
    return (
      <>
        <Header title="Sort" onBack={back} />
        <Block>
          {config.sorts.map((sort, i) => (
            <Row
              key={sort.key}
              title={sort.title}
              checked={view.sort === sort.key}
              last={i === config.sorts.length - 1}
              onPress={() => {
                update((current) => ({ ...current, sort: sort.key }));
                back();
              }}
            />
          ))}
        </Block>
      </>
    );
  if (step.kind === "property") {
    const property = config.properties.find((p) => p.key === step.key);
    const values = propertyValues(section, step.key, groups);
    const chosen = view.filters[step.key] ?? [];
    const toggle = (value: string) =>
      update((current) => {
        const selected = current.filters[step.key] ?? [];
        return {
          ...current,
          filters: {
            ...current.filters,
            [step.key]: selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
          },
        };
      });
    return (
      <>
        <Header title={property ? property.title : "Filter"} onBack={back} />
        <Block>
          {values.map(({ value, count, card }, i) => (
            <Row
              key={value}
              title={value}
              label={<ValueLabel section={section} property={step.key} value={value} card={card} />}
              detail={String(count)}
              checked={chosen.includes(value)}
              last={i === values.length - 1}
              onPress={() => toggle(value)}
            />
          ))}
          {values.length === 0 && <Row title="Nothing to filter on this screen" last />}
        </Block>
        {chosen.length > 0 && (
          <Button
            title="Show all"
            onPress={() =>
              update((current) => ({
                ...current,
                filters: { ...current.filters, [step.key]: [] },
              }))
            }
          />
        )}
      </>
    );
  }
  const sort = config.sorts.find((s) => s.key === view.sort);
  return (
    <>
      <Header title={config.title} />
      <Block>
        <Row
          title="Sort"
          detail={sort ? sort.title : undefined}
          chevron
          last
          onPress={() => setStep({ kind: "sort" })}
        />
      </Block>
      <Text style={{ color: t.secondary, fontSize: 13, paddingHorizontal: 4 }}>Filter by</Text>
      <Block>
        {config.properties.map((property, i) => {
          const chosen = view.filters[property.key] ?? [];
          const toggle = property.toggle;
          if (toggle) {
            const on = chosen.includes(toggle.value);
            return (
              <Row
                key={property.key}
                title={property.title}
                about={toggle.about}
                switchOn={on}
                trailing={<Toggle on={on} />}
                last={i === config.properties.length - 1}
                onPress={() =>
                  update((current) => ({
                    ...current,
                    filters: {
                      ...current.filters,
                      [property.key]: current.filters[property.key]?.includes(toggle.value) ? [] : [toggle.value],
                    },
                  }))
                }
              />
            );
          }
          return (
            <Row
              key={property.key}
              title={property.title}
              detail={chosen.length ? chosen.join(", ") : undefined}
              chevron
              last={i === config.properties.length - 1}
              onPress={() => setStep({ kind: "property", key: property.key })}
            />
          );
        })}
      </Block>
      {(view.sort !== "default" || isFiltered(view)) && (
        <Button
          title="Reset sort and filters"
          onPress={() =>
            update((current) => ({
              ...current,
              sort: DEFAULT_VIEW.sort,
              filters: viewOptionsFor(section).filters,
            }))
          }
        />
      )}
    </>
  );
}

function DisplayPanel({ section }: { section: ViewSection }) {
  const t = useTheme();
  const config = VIEW_CONFIG[section];
  const { view, update } = useViewOptions(section);
  const toggle = (key: string, shown: boolean) =>
    update((current) => ({
      ...current,
      hidden: shown ? current.hidden.filter((k) => k !== key) : [...current.hidden, key],
    }));
  return (
    <>
      <Header title="Display" />
      <Text style={{ color: t.secondary, fontSize: 13, paddingHorizontal: 4 }}>
        What each {config.title === "Inbox" ? "item" : "card"} on {config.title} shows
      </Text>
      <Block>
        {config.display.map((option, i) => {
          const shown = !view.hidden.includes(option.key);
          return (
            <Row
              key={option.key}
              title={option.title}
              about={option.about}
              switchOn={shown}
              last={i === config.display.length - 1}
              onPress={() => toggle(option.key, !shown)}
              // The row takes the tap, so the switch only shows the state.
              trailing={<Toggle on={shown} />}
            />
          );
        })}
      </Block>
      {view.hidden.length > 0 && (
        <Button title="Show everything" onPress={() => update((current) => ({ ...current, hidden: [] }))} />
      )}
    </>
  );
}

/** Each menu item or desktop shortcut opens its panel directly. */
export default function ViewOptionsSheet() {
  const t = useTheme();
  const { section, panel } = useLocalSearchParams<{
    section: string;
    panel: string;
  }>();
  return (
    <Sheet>
      <ScrollView
        {...webScrollProps}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 24,
          gap: 12,
        }}
        // Let the native content detent measure the options, rather than filling an arbitrary sheet height.
        style={{ backgroundColor: t.background, flexGrow: 0 }}
      >
        {!isSection(section) ? (
          <Header title="View options" />
        ) : panel === "display" ? (
          <DisplayPanel section={section} />
        ) : (
          <FilterPanel section={section} />
        )}
      </ScrollView>
    </Sheet>
  );
}
