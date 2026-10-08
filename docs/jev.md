# Jev (TypeSafe System One)

Jev makes structured decisions. It does not write text. Use it to classify and rank dashboard items.

Docs: <https://docs.typesafe.ai/llms.txt>

## Request

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
- Header: `Authorization: Bearer $TYPESAFE_API_KEY`
- Environment (`.env`): `TYPESAFE_API_KEY`, `TYPESAFE_MODEL=jev-latest`

```json
{
  "model": "jev-latest",
  "state": { "item": "Any text or JSON that the questions are about" },
  "questions": {
    "<name>": {
      "type": "choice | score | noul",
      "criteria": "...",
      "instructions": { "goal": "..." }
    }
  }
}
```

- `instructions` is optional.
- You can send many questions in one request. Each answer has the same name as its question.
- A question with `"type": "text"` is not valid. The API returns `Invalid request.`

## Primitives

### Choice: select one option from a set

Request:

```json
{
  "type": "choice",
  "criteria": {
    "now": "Needs action today",
    "soon": "Needs action this week",
    "fyi": "No action needed"
  },
  "instructions": {
    "goal": "Rank how urgently the user must act on this work item."
  }
}
```

Answer:

```json
{
  "type": "choice",
  "choice": "now",
  "confidence": 1.0,
  "probabilities": { "now": 1.0, "soon": 0.0, "fyi": 0.0 }
}
```

### Score: rate against ordered levels

Request (the levels go from lowest to highest):

```json
{ "type": "score", "criteria": ["Trivial", "Useful", "Important", "Critical"] }
```

Answer (`score` is a decimal index into the levels):

```json
{
  "type": "score",
  "score": 1.06,
  "confidence": 0.6,
  "legend": {
    "0": "Trivial",
    "1": "Useful",
    "2": "Important",
    "3": "Critical"
  },
  "probabilities": { "0": 0.17, "1": 0.62, "2": 0.2, "3": 0.01 }
}
```

### Noul: yes or no

Request (`criteria` must be an object; a plain string is not valid):

```json
{
  "type": "noul",
  "criteria": {
    "true": "The user still needs to act on this saved item.",
    "false": "The work is finished or tracked elsewhere."
  }
}
```

Answer (`noul` is the probability of yes):

```json
{ "type": "noul", "noul": 0.19 }
```

## Use in the dashboard

| Primitive | Question                                  | Result                                                                                                  |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Choice    | Urgency: now, soon or FYI                 | The column or group for the item                                                                        |
| Score     | Importance                                | The sort order. A decimal score sorts more precisely than a category.                                   |
| Noul      | Does this saved item still need the user? | Hide the item when the value is low. Example: a saved item that links to a Done Linear ticket got 0.19. |

`confidence` describes how concentrated a Choice/Score distribution is; it is not measured correctness. Use the probabilities of the relevant categories for association decisions.

## Automatic session associations

Reference mentions, titles, branches and recorded PR links nominate candidates; every association requires a Jev verdict of at least 0.7. There are no automatic bypasses or unscored fallbacks. Disabling classification hides automatic associations. Accepted sessions sort by relevance, then activity. A session can genuinely work on several items.

Matching uses the benchmarked two-stage Score classifier. The first pass sends the target, session title, first request (300 characters), last request (240), and latest response (400). Score levels are unrelated, reference only, substantive research/review, and direct execution. The association probability is P(level 2) + P(level 3), never score divided by three or the API confidence field.

At probabilities of 0.1 or less, or 0.9 or more, the first answer is final. Otherwise, a second pass sends the two most relevant user/request and assistant/result exchanges (320 and 600 characters per exchange). Its probability replaces the first answer; the acceptance threshold remains 0.7. A missing transcript or failed/malformed second answer cannot promote an uncertain first answer into a link. Multiple items are judged independently.

An incremental local index streams transcript records and retains natural user/assistant text. Tools, reasoning, provider-injected instructions and mirrored Codex events are excluded. Generated continuation summaries are barriers between exchanges, never user requests. Native Claude metadata joins continuation files; Codex transcript parts share their session ID. The index retries unfinished lines, resets on truncation/rotation, and skips individual records above 4 MiB. Paths and common credential patterns are redacted before snippets are selected.

Jev verdicts expire after six hours and use the native conversation identity, configured model, question version and a hash of both bounded inputs. Newly selected evidence immediately invalidates an old rejection; tool-only changes do not. When the configured model is an alias such as `jev-latest`, its upstream resolution can change within that six-hour TTL. Set a versioned model when a fixed model is required.

The classifier was evaluated on a private, manually labelled sample. Those results are development evidence, not a measured guarantee for new workspaces. The source includes synthetic regression tests for extraction, bounded inputs, candidate selection and cache invalidation. Keep real transcript benchmarks outside the repository.

Cached dashboard associations carry a matching-rule version. Older snapshots preserve their work items but drop their obsolete associations until rebuilt. Claude transcript summaries and the recent-session cache are versioned separately to force reparsing and deduplication.
