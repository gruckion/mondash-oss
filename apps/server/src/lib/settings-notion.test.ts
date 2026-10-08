import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseNotionDiscovery,
  parseNotionSchema,
  prepareMapping,
  finishMapping,
  notionMappingConfirmation,
} from "./settings-notion";

const sourceId = "27542751-ae60-52b5-a819-625829d26167";
const viewId = "07b772d2-1473-57de-88e8-97ca88d843c6";
// Synthetic fixture of the documented REST property-object contract, not a hosted MCP live fixture.
const source = {
  object: "data_source",
  id: sourceId,
  properties: {
    Headline: { id: "title", name: "Headline", type: "title", title: {} },
    Workflow: {
      id: "state",
      name: "Workflow",
      type: "status",
      status: {
        options: [
          { id: "draft", name: "Scoping" },
          { id: "review", name: "Ready for review" },
        ],
        groups: [{ name: "In progress", option_ids: ["draft", "review"] }],
      },
    },
    Responsible: { id: "own", name: "Responsible", type: "people", people: {} },
    Approver: { id: "rev", name: "Approver", type: "people", people: {} },
  },
};

test("discovery preserves real provider references and uncertainty without interpreting quoted page markup as boards", () => {
  const text = `<data-source url="collection://${sourceId}" name="Roadmap &amp; work"/><view url="view://${viewId}" name="This week"/>`;
  const database = parseNotionDiscovery(JSON.stringify({ metadata: { type: "database" }, text, truncated: true }));
  assert.deepEqual(
    database.items.map((x) => [x.kind, x.name, x.url]),
    [
      ["data_source", "Roadmap & work", `collection://${sourceId}`],
      ["view", "This week", `view://${viewId}`],
    ],
  );
  assert.equal(database.incomplete, true);
  assert.deepEqual(parseNotionDiscovery({ metadata: { type: "page" }, text }).items, []);
  assert.deepEqual(
    parseNotionDiscovery({ isError: true, structuredContent: { results: [{ id: sourceId }] } }).items,
    [],
  );
});

test("search candidates accept Notion origins while provider notices and malformed responses retain incomplete state", () => {
  const result = parseNotionDiscovery({
    results: [
      { id: sourceId, title: "Roadmap", url: `https://www.notion.so/${sourceId}`, type: "database" },
      { id: "evil", title: "Other", url: "https://notion.so.attacker.test/board" },
    ],
    notices: [{ code: "unsupported" }],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "database");
  assert.equal(result.incomplete, true);
  for (const input of [
    "{",
    { results: [{}] },
    {
      content: [
        { type: "text", text: "{}" },
        { type: "text", text: "{}" },
      ],
    },
    { text: "x".repeat(256 * 1024 + 1) },
  ])
    assert.equal(parseNotionDiscovery(input).incomplete, true);
});

test("schema extraction preserves property and option IDs/groups; page values and partial schemas cannot configure work", () => {
  const parsed = parseNotionSchema(source);
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(parsed.schema?.properties.find((p) => p.id === "state")?.options, [
    { id: "draft", name: "Scoping", group: "In progress" },
    { id: "review", name: "Ready for review", group: "In progress" },
  ]);
  for (const input of [
    { metadata: { type: "page" }, text: '<properties>{"Workflow":"Scoping"}</properties>' },
    {
      object: "data_source",
      id: sourceId,
      properties: {
        Headline: source.properties.Headline,
        Broken: { id: "state", name: "Workflow", type: "status", status: {} },
      },
    },
    { ...source, properties: { ...source.properties, Other: source.properties.Headline } },
  ])
    assert.equal(parseNotionSchema(input).schema, null);
});

test("semantic proposals cannot bypass type, probability, uniqueness or workflow confirmation constraints", () => {
  const schema = parseNotionSchema(source).schema!;
  const prepared = prepareMapping(schema);
  const distribution = (criteria: Readonly<Record<string, string>>, selected: string, peak = 0.99) => ({
    probabilities: Object.fromEntries(
      Object.keys(criteria).map((id) => [id, id === selected ? peak : (1 - peak) / (Object.keys(criteria).length - 1)]),
    ),
  });
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(prepared.request.questions))
    answers[key] = distribution(
      question.criteria,
      key === "role_owner" ? "own" : key === "role_reviewer" ? "rev" : "none",
    );
  answers.stage_state_draft = distribution(prepared.request.questions.stage_state_draft.criteria, "scoping", 0.79);
  answers.stage_state_review = { probabilities: { review: 1, invented: 0 } };
  const mapping = finishMapping(schema, prepared, { answers });
  assert.equal(mapping.roles.owner.value, "own");
  assert.equal(mapping.roles.reviewer.value, "rev");
  assert.equal(mapping.stages["state:draft"].value, null);
  assert.equal(mapping.stages["state:review"].value, null);
  const confirmation = notionMappingConfirmation(schema, mapping);
  assert.equal(confirmation.confirmationRequired, true);
  assert.deepEqual(
    confirmation.stages.map((s) => s.name),
    ["Scoping", "Ready for review"],
  );
  answers.role_reviewer = distribution(prepared.request.questions.role_reviewer.criteria, "own");
  const collision = finishMapping(schema, prepared, { answers });
  assert.equal(collision.roles.owner.value, null);
  assert.equal(collision.roles.reviewer.value, null);
  const unavailable = finishMapping(schema, prepared, { answers: {} });
  assert.equal(unavailable.roles.title.value, "title");
  assert.equal(unavailable.roles.owner.value, null);
  assert.throws(() => notionMappingConfirmation({ ...schema, id: "other" }, mapping));
  const changed = {
    ...schema,
    properties: schema.properties.map((p) => (p.id === "own" ? { ...p, type: "rich_text" as const } : p)),
  };
  assert.throws(() => finishMapping(changed, prepared, { answers }));
  assert.throws(() => notionMappingConfirmation(changed, mapping));
  assert.equal(
    notionMappingConfirmation({ ...schema, properties: [...schema.properties].reverse() }, mapping).fingerprint,
    confirmation.fingerprint,
  );
});

test("incomplete typed schemas cannot become board configuration", () => {
  for (const partial of [
    { truncated: true },
    { has_more: true },
    { next_cursor: "more" },
    { notices: [{ code: "limited" }] },
  ])
    assert.equal(parseNotionSchema({ ...source, ...partial }).schema, null);
});

test("hosted board and saved-view envelopes preserve actual references and snapshot-scoped schema keys", () => {
  const state = {
    name: "Roadmap",
    url: `collection://${sourceId}`,
    schema: {
      Name: { name: "Name", type: "title" },
      Responsible: { name: "Responsible", type: "person" },
      Workflow: {
        name: "Workflow",
        type: "status",
        groups: {
          in_progress: [
            { name: "Scoping", url: `collectionPropertyOption://${sourceId}/opaque/draft` },
            { name: "Review", url: `collectionPropertyOption://${sourceId}/opaque/review` },
          ],
        },
      },
    },
  };
  const envelope = {
    metadata: { type: "data_source" },
    url: `collection://${sourceId}`,
    text: `<data-source url="{{collection://${sourceId}}}"><data-source-state>${JSON.stringify(state)}</data-source-state></data-source>`,
  };
  const parsed = parseNotionSchema(envelope);
  assert.equal(parsed.schema?.properties.find((p) => p.name === "Responsible")?.type, "people");
  assert.equal(parsed.schema?.properties.find((p) => p.name === "Responsible")?.id, "name:Responsible");
  assert.equal(
    parsed.schema?.properties.find((p) => p.name === "Workflow")?.options?.[0]?.id,
    `collectionPropertyOption://${sourceId}/opaque/draft`,
  );
  const viewState = { name: "By engineer", dataSourceUrl: `{{collection://${sourceId}}}` };
  const view = parseNotionDiscovery({
    metadata: { type: "view" },
    text: `<view url="{{view://${viewId}}}">${JSON.stringify(viewState)}</view>`,
  });
  assert.deepEqual(
    view.items.map((v) => [v.kind, v.name, v.url]),
    [
      ["view", "By engineer", `view://${viewId}`],
      ["data_source", "Data source", `collection://${sourceId}`],
    ],
  );
  assert.equal(parseNotionSchema({ ...envelope, metadata: { type: "page" } }).schema, null);
  const parent = parseNotionDiscovery({
    metadata: { type: "page" },
    text: `<database url="https://app.notion.com/p/${sourceId.replaceAll("-", "")}" inline="false" data-source-url="collection://${sourceId}"></database>`,
  });
  assert.equal(parent.items[0]?.kind, "database");
  assert.equal(parent.items[0]?.id, sourceId.replaceAll("-", ""));
  const renamed = { ...state, schema: { ...state.schema, Responsible: { name: "Other", type: "person" } } };
  assert.equal(
    parseNotionSchema({ ...envelope, text: `<data-source-state>${JSON.stringify(renamed)}</data-source-state>` })
      .schema,
    null,
  );
});
