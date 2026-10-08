import { Platform, useWindowDimensions, View } from "react-native";
import type { Group } from "@mondash/shared/contract";
import { useTheme } from "@/lib/theme";
import { DashboardScreen } from "./dashboard-screen";
import { LinkHighlightsProvider } from "@/lib/link-highlights";

/** Three useful columns need at least 350px each after the sidebar. */
export const DESKTOP_WORK_WIDTH = 1280;
const OTHER = ["Backlog", "other-prs"];
const issuePages = (groups: readonly Group[]) => [
  {
    title: "Now",
    description: "Your urgent, assigned, and new issues.",
    groups: groups.filter((g) => !OTHER.includes(g.id) && g.id !== "draft-prs"),
  },
  {
    title: "Other",
    description: "Backlog issues and your other pull requests.",
    groups: groups.filter((g) => OTHER.includes(g.id)),
  },
  {
    title: "Drafts",
    description: "Your draft pull requests, with checks, replies, and agent sessions.",
    groups: groups.filter((g) => g.id === "draft-prs"),
  },
];
const scopingPages = (groups: readonly Group[]) =>
  [
    { id: "mine", title: "Mine" },
    { id: "to-review", title: "To review" },
  ].map((page) => ({
    title: page.title,
    description: page.id === "mine" ? "Scoping documents you own." : "Scoping documents you have been asked to review.",
    groups: groups.filter((group) => group.id === page.id),
  }));
const sections = [
  { section: "issues", title: "Issues", pages: issuePages },
  { section: "scoping", title: "Scoping", pages: scopingPages },
  { section: "reviews", title: "Reviews", pages: undefined },
] as const;

/** Each column owns its scrolling, filters and tab selection. */
export function WorkScreen({ section }: { section: "issues" | "scoping" | "reviews" }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= DESKTOP_WORK_WIDTH;
  const selected = sections.find((item) => item.section === section)!;
  const content = !desktop ? (
    <DashboardScreen section={section} pages={selected.pages} />
  ) : (
    <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
      {sections.map((item, index) => (
        <View
          key={item.section}
          accessibilityLabel={`${item.title} column`}
          style={{ flex: 1, minWidth: 0, borderLeftWidth: index ? 1 : 0, borderLeftColor: t.line }}
        >
          <DashboardScreen section={item.section} pages={item.pages} title={item.title} />
        </View>
      ))}
    </View>
  );
  return Platform.OS === "web" ? <LinkHighlightsProvider>{content}</LinkHighlightsProvider> : content;
}
