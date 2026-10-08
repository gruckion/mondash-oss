# Integrations

This is how the Claude Code agent reads each source now. The dashboard is agentic first, so it must use the same connections.

| Source         | Connection                                                                            | Example tools or commands                                                                                               | Gaps                                        |
| -------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Linear         | Linear MCP server (`mcp__linear__*`)                                                  | `list_issues`, `get_issue`, `list_comments`, `get_notifications`                                                        | None known                                  |
| Slack          | Slack MCP server (`mcp__slack__*`)                                                    | `slack_search_public_and_private`, `slack_read_channel`, `slack_read_thread`                                            | No tool for saved items ("Save for later")  |
| Notion         | Notion MCP server from the sales plugin (`mcp__plugin_sales_notion__*`)               | `notion-search`, `notion-fetch`, `notion-get-comments`                                                                  | None known                                  |
| GitHub         | `gh-axi` CLI, which uses the `gh` login. There is no GitHub MCP server in this setup. | `gh-axi search prs "review-requested:@me"`                                                                              | None known                                  |
| Agent sessions | Local files                                                                           | Claude Code: `~/.claude/projects/*/*.jsonl`. Codex: `~/.codex/sessions`. The session-archaeology skill can search them. | The dashboard must run on the local machine |

## Open questions

- Can the dashboard connect to each MCP server as its own client, with its own OAuth login? Not yet tested.
- Can any Slack API or MCP tool read saved items? The Triage view depends on this. Not yet tested.

See [jev.md](jev.md) for how the dashboard classifies and ranks the items that these sources return.
