import { Schema } from "effect";
import { ActionError } from "./action-error";

// Verified in ChatGPT's published apple-app-site-association. This opens the app,
// not a specific Remote thread; desktop codex:// links are not iPhone links.
export const CHATGPT_APP_URL = "https://chatgpt.com/open-app";
export type CodexRemote = {
  url: typeof CHATGPT_APP_URL;
  handoff: "app";
  remoteStatus: "registered";
  sessionTitle: string;
};
export type CodexRemoteDependencies = {
  find: (id: string) => Promise<{ id: string; tool: string; title: string } | undefined>;
  registered: () => Promise<boolean>;
  running: () => Promise<boolean>;
};

const UUID = Schema.String.check(Schema.isUUID());

/** A recorded registration is deliberately not reported as a live connection. */
export function hasCodexRegistration(value: unknown): boolean {
  return Schema.is(
    Schema.Struct({
      "electron-local-remote-control-installation-id": UUID,
      "electron-local-remote-control-environment-id": Schema.String.check(Schema.isPattern(/^env_[A-Za-z0-9_-]+$/)),
    }),
  )(value);
}

export function createCodexRemoteOpener(deps: CodexRemoteDependencies) {
  return async (id: string): Promise<CodexRemote> => {
    if (!Schema.is(UUID)(id)) throw new ActionError("Invalid Codex session ID.");
    const session = await deps.find(id);
    if (!session || session.id !== id || session.tool !== "codex") {
      throw new ActionError("This Codex session is no longer available on your Mac.");
    }
    if (!(await deps.registered())) {
      throw new ActionError("Set up Remote in the ChatGPT desktop app’s Settings > Connections on your Mac first.");
    }
    if (!(await deps.running())) {
      throw new ActionError("Open the ChatGPT desktop app on your Mac, then try again.");
    }
    return { url: CHATGPT_APP_URL, handoff: "app", remoteStatus: "registered", sessionTitle: session.title };
  };
}
