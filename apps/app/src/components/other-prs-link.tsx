import type { ComponentProps } from "react";
import { View } from "react-native";
import { rowPRState } from "@mondash/shared/pr-rows";
import { PRStateIcon } from "./pr-row";
import { RowsLink } from "./rows-link";

/** One or both state glyphs describe the actual PRs in this history sheet. */
export function OtherPRsLink(props: Omit<ComponentProps<typeof RowsLink>, "heading" | "icon">) {
  const merged = props.rows.some((row) => rowPRState(row) === "MERGED");
  const closed = props.rows.some((row) => rowPRState(row) === "CLOSED");
  return (
    <RowsLink
      {...props}
      heading="Other PRs"
      icon={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          {merged && <PRStateIcon state="MERGED" />}
          {closed && <PRStateIcon state="CLOSED" />}
        </View>
      }
    />
  );
}
