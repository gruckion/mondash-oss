import { Text } from "react-native";
import { notionStatusSvg } from "@mondash/shared/notion-status";
import { useTheme } from "@/lib/theme";
import { Pill } from "./card-details";
import { SvgIcon } from "./web-icons";

/** A Roadmap status in Linear's style: Linear's shapes, Notion's colours, the same grey pill as issue statuses. */
export function NotionStatus({ status }: { status: string }) {
  const t = useTheme();
  return (
    <Pill>
      <SvgIcon svg={notionStatusSvg(status, t.dark)} label={`Status: ${status}`} />
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 12, lineHeight: 16, flexShrink: 1 }}>
        {status}
      </Text>
    </Pill>
  );
}
