import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type { NotionCandidate, NotionProposal, NotionSelection } from "@mondash/shared/settings";
import { inspectNotionBoard, searchNotionBoards } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { Body, Button, errorMessage } from "./ui";

const labels = {
  title: "Title",
  status: "Workflow",
  owner: "Owner",
  reviewer: "Reviewer",
  priority: "Priority",
  effort: "Effort",
  effortDays: "Effort in days",
  created: "Created",
  updated: "Updated",
};
const stages = { scoping: "Scoping", open: "In progress", review: "Ready to review", ignore: "Other" } as const;

/** A board is chosen from provider results; field and workflow choices use existing schema identifiers. */
export function NotionPicker({
  server,
  currentView,
  onApply,
}: {
  server: string;
  currentView: string;
  onApply(selection: NotionSelection): Promise<void>;
}) {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly (typeof NotionCandidate.Type)[]>([]);
  const [incomplete, setIncomplete] = useState(false);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [proposal, setProposal] = useState<NotionProposal>();
  const [roles, setRoles] = useState<NotionSelection["roles"]>();
  const [unusedPeopleRoles, setUnusedPeopleRoles] = useState<NotionSelection["unusedPeopleRoles"]>([]);
  const [workflow, setWorkflow] = useState<NotionSelection["stages"]>({});
  const [workflowField, setWorkflowField] = useState<string>();
  const [field, setField] = useState<keyof typeof labels>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    const result = await inspectNotionBoard(server, id);
    setItems(result.views);
    setWarnings(result.warnings);
    setIncomplete(false);
    setProposal(result.proposal ?? undefined);
    setField(undefined);
    setWorkflowField(undefined);
    setWorkflow(
      Object.fromEntries(result.proposal?.stages.flatMap((s) => (s.selected ? [[s.id, s.selected]] : [])) ?? []),
    );
    setUnusedPeopleRoles([]);
    if (result.proposal)
      setRoles(Object.fromEntries(result.proposal.roles.map((r) => [r.role, r.selected])) as NotionSelection["roles"]);
  }
  const status = proposal?.properties.find((p) => p.id === roles?.status);
  const unresolvedPeopleRoles =
    proposal?.roles.filter(
      (r) =>
        (r.role === "owner" || r.role === "reviewer") &&
        r.candidates.length > 0 &&
        !roles?.[r.role] &&
        !unusedPeopleRoles.includes(r.role),
    ) ?? [];
  const selectedField = proposal?.roles.find((r) => r.role === field);
  const option = (name: string, action: () => void, selected?: boolean, expanded?: boolean) => (
    <Pressable
      accessibilityRole="button"
      aria-pressed={selected}
      aria-expanded={expanded}
      onPress={action}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingVertical: 8,
        borderBottomColor: t.line,
        borderBottomWidth: 1,
      }}
    >
      <Text style={{ color: selected ? t.accent : t.text, fontSize: 15 }}>
        {selected ? "✓  " : ""}
        {name}
      </Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 12 }}>
      <Body muted>
        {currentView
          ? "Choose a saved board view, then confirm how its workflow appears in Mondash."
          : "Find your roadmap or board in Notion. Select its saved view to keep its filters."}
      </Body>
      {!proposal && (
        <>
          <TextInput
            accessibilityLabel="Search Notion boards"
            value={query}
            onChangeText={setQuery}
            placeholder="Find a roadmap or board"
            placeholderTextColor={t.secondary}
            style={{ color: t.text, borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 44 }}
          />
          <Button
            title="Find boards"
            disabled={busy || !query.trim()}
            onPress={() =>
              void run(async () => {
                const result = await searchNotionBoards(server, query.trim());
                setItems(result.items);
                setIncomplete(result.incomplete);
                setWarnings([]);
              })
            }
          />
          {currentView && (
            <Button
              subtle
              title="Browse current board"
              disabled={busy}
              onPress={() => void run(() => inspect(currentView))}
            />
          )}
          {items.map((item) => (
            <View key={item.id}>{option(item.name, () => void run(() => inspect(item.id)))}</View>
          ))}
          {incomplete && <Body muted>More results may be available. Refine your search to find the board.</Body>}
        </>
      )}
      {proposal && roles && (
        <>
          <Body>Confirm your workflow</Body>
          <Body muted>Choose what each status means here. Other statuses stay outside your active work.</Body>
          {!roles.status && option("Choose the workflow field", () => setField("status"))}
          {status?.options.map((state) => (
            <View key={state.id} style={{ gap: 6 }}>
              {option(
                `${state.name} · ${stages[workflow[state.id]] ?? "Choose meaning"}`,
                () => setWorkflowField(workflowField === state.id ? undefined : state.id),
                undefined,
                workflowField === state.id,
              )}
              {workflowField === state.id && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {Object.entries(stages).map(([id, name]) => (
                    <Pressable
                      key={id}
                      accessibilityRole="radio"
                      accessibilityLabel={`${state.name}: ${name}`}
                      aria-checked={workflow[state.id] === id}
                      onPress={() => {
                        setWorkflow({ ...workflow, [state.id]: id as keyof typeof stages });
                      }}
                      style={{
                        minHeight: 44,
                        paddingHorizontal: 10,
                        justifyContent: "center",
                        borderRadius: 8,
                        backgroundColor: workflow[state.id] === id ? t.line : "transparent",
                      }}
                    >
                      <Text style={{ color: workflow[state.id] === id ? t.accent : t.secondary, fontSize: 12 }}>
                        {name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          ))}
          {unresolvedPeopleRoles.length > 0 && (
            <Body muted>
              Choose who owns and reviews this work. Leaving both unused means it will not appear in your personal
              Scoping list.
            </Body>
          )}
          {unresolvedPeopleRoles.map((r) => (
            <View key={r.role}>{option(`Choose ${labels[r.role].toLowerCase()} field`, () => setField(r.role))}</View>
          ))}
          {option(
            editing ? "Hide field matches" : "Review field matches",
            () => setEditing(!editing),
            undefined,
            editing,
          )}
          {editing &&
            proposal.roles.map((r) => (
              <View key={r.role}>
                {option(
                  `${labels[r.role]} · ${r.candidates.find((c) => c.id === roles[r.role])?.name ?? "Unused"}`,
                  () => setField(r.role),
                )}
              </View>
            ))}
          {selectedField && (
            <View style={{ gap: 4 }}>
              <Body>{labels[selectedField.role]}</Body>
              {selectedField.candidates.map((candidate) => (
                <View key={candidate.id}>
                  {option(
                    candidate.name,
                    () => {
                      setRoles({ ...roles, [selectedField.role]: candidate.id });
                      if (selectedField.role === "status") setWorkflow({});
                      setField(undefined);
                    },
                    roles[selectedField.role] === candidate.id,
                  )}
                </View>
              ))}
              {selectedField.role !== "title" &&
                selectedField.role !== "status" &&
                option("Unused", () => {
                  setRoles({ ...roles, [selectedField.role]: null });
                  if (selectedField.role === "owner" || selectedField.role === "reviewer")
                    setUnusedPeopleRoles([...unusedPeopleRoles, selectedField.role]);
                  setField(undefined);
                })}
            </View>
          )}
          <Button
            title="Use this board"
            disabled={
              busy ||
              unresolvedPeopleRoles.length > 0 ||
              !roles.title ||
              !roles.status ||
              !status?.options.length ||
              status.options.some((o) => !workflow[o.id])
            }
            onPress={() =>
              void run(async () => {
                await onApply({
                  view: proposal.view,
                  sourceId: proposal.sourceId,
                  fingerprint: proposal.fingerprint,
                  roles,
                  stages: workflow,
                  unusedPeopleRoles,
                });
                setProposal(undefined);
                setItems([]);
              })
            }
          />
          <Button
            subtle
            title="Choose another board"
            disabled={busy}
            onPress={() => {
              setProposal(undefined);
              setItems([]);
              setWarnings([]);
            }}
          />
        </>
      )}
      {warnings.map((warning) => (
        <Body key={warning} muted>
          {warning}
        </Body>
      ))}
      {busy && <ActivityIndicator color={t.accent} />}
      {error && (
        <View accessibilityRole="alert">
          <Body>{error}</Body>
        </View>
      )}
    </View>
  );
}
