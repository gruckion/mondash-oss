import { router } from "expo-router";
import { Sheet } from "@/components/sheet";
import { DebriefHistoryList } from "@/components/debrief-history-list";

export default function DebriefHistory() {
  return (
    <Sheet>
      <DebriefHistoryList
        onClose={() => router.back()}
        onSelect={(id) => router.dismissTo({ pathname: "/debrief", params: { id } })}
      />
    </Sheet>
  );
}
