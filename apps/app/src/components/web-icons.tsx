import { Image } from "expo-image";
import { useTheme } from "@/lib/theme";

import { linearStatusIcon, linearPriorityIcon } from "@mondash/shared/linear-icons";
import { SOURCES, type Source } from "@mondash/shared/source-icons";

export function SvgIcon({
  svg,
  label,
  size = 14,
}: {
  svg: string;
  /** Read out by screen readers; leave it out for decoration. */
  label?: string;
  size?: number;
}) {
  return (
    <Image
      source={{
        uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      }}
      accessible={!!label}
      accessibilityLabel={label}
      contentFit="contain"
      cachePolicy="memory"
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

export function SourceIcon({
  source,
  size = 14,
  color: tint,
}: {
  source: Source | "linear";
  size?: number;
  color?: string;
}) {
  const t = useTheme();
  if (source === "linear")
    return (
      <Image
        source={t.dark ? require("../../assets/linear-light.svg") : require("../../assets/linear-dark.svg")}
        accessible
        accessibilityLabel="Linear"
        contentFit="contain"
        style={{ width: size, height: size, flexShrink: 0 }}
      />
    );
  const color = tint ?? (source === "bot" ? "#a78bfa" : t.text);
  const labels = {
    github: "GitHub",
    slack: "Slack",
    notion: "Notion",
    bot: "AI review",
  };
  return <SvgIcon svg={SOURCES[source].replaceAll("currentColor", color)} label={labels[source]} size={size} />;
}

export function StatusIcon({ status, statusType }: { status: string; statusType?: string }) {
  return <SvgIcon svg={linearStatusIcon(status, statusType)} label={`Status: ${status}`} />;
}
export function PriorityIcon({ priority, color }: { priority: { value: number; name: string }; color?: string }) {
  const t = useTheme();
  return (
    <SvgIcon svg={linearPriorityIcon({ priority, color: color ?? t.secondary })} label={`Priority: ${priority.name}`} />
  );
}
