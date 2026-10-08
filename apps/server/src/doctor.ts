import { stat } from "node:fs/promises";
import { Effect, Option } from "effect";
import { ServerConfig } from "./config";
import { identityDirectory, profile, profilePath, decodeProfile, defaultProfile } from "./profile";
import { privateUpdate } from "./private-files";
import { hasTokens, origins } from "./lib/mcp";

const probe = (args: string[]) => {
  const executable = Bun.which(args[0]);
  if (!executable) return undefined;
  try {
    return Bun.spawnSync([executable, ...args.slice(1)], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  } catch {
    return undefined;
  }
};
const command = process.argv[2] ?? "doctor";
if (command === "init") {
  await privateUpdate(profilePath(), (previous) => (previous ? decodeProfile(previous) : defaultProfile()));
  console.log(
    "Created a private local profile; existing settings were preserved. Build/start Mondash, then open Settings in your Mac’s browser.",
  );
} else if (command === "port") {
  console.log(
    await Effect.runPromise(Effect.map(ServerConfig, (config) => config.port).pipe(Effect.provide(ServerConfig.layer))),
  );
} else if (command === "doctor") {
  const config = await Effect.runPromise(ServerConfig.pipe(Effect.provide(ServerConfig.layer)));
  let missing = 0;
  const report = (name: string, good: boolean, action: string) => {
    console.log(`${good ? "OK" : "SETUP"} ${name}: ${action}`);
    if (!good) missing++;
  };
  report("Bun", Bun.semver.satisfies(Bun.version, ">=1.4.2"), `running ${Bun.version}; tested runtime is 1.4.2`);
  const node = probe(["node", "--version"]);
  const version = node?.stdout.toString().trim().replace(/^v/, "") ?? "";
  report(
    "Node",
    node?.exitCode === 0 && Bun.semver.satisfies(version, ">=24.14.0"),
    "install Node.js 24.14.0 or newer for Expo builds",
  );
  report(
    "Python",
    probe(["python3", "--version"])?.exitCode === 0,
    "macOS service installation uses python3 for safe plist generation",
  );
  console.log(`Browser: http://localhost:${config.port}; loopback host ${config.host}`);
  console.log(`OAuth callback origins: ${origins(config.publicUrl, undefined, config.port).all.join(", ")}`);
  for (const name of ["github", "linear", "slack", "notion", "sessions"] as const) {
    if (!profile.integrations[name]) {
      console.log(`DISABLED ${name}: saved data is retained`);
      continue;
    }
    if (name === "github") {
      const self = identityDirectory(profile.directory).self;
      const login = probe(["gh", "api", "user", "--jq", ".login"]);
      report(
        "GitHub identity",
        !!self?.github &&
          login?.exitCode === 0 &&
          login.stdout.toString().trim().toLowerCase() === self.github.toLowerCase(),
        "the configured GitHub login must match gh’s signed-in account",
      );
      report(name, probe(["gh", "auth", "status"])?.exitCode === 0, "install GitHub CLI and run gh auth login");
    }
    if (name === "linear") report(name, Option.isSome(config.linearApiKey), "set LINEAR_API_KEY in .env");
    if (name === "slack")
      report(
        name,
        Option.isSome(config.slackClient) && (await hasTokens(name)),
        "use your own approved confidential Slack MCP app and sign in from Settings",
      );
    if (name === "notion")
      report(
        name,
        !!profile.notion.view && (await hasTokens(name)),
        "select the saved view/columns and sign in from Settings",
      );
    if (name === "sessions")
      report(name, process.platform === "darwin", "local Claude/Codex history and session actions require your Mac");
  }
  for (const [name, path] of Object.entries(profile.workspace.directories))
    report(
      `directory ${name}`,
      await stat(path)
        .then((value) => value.isDirectory())
        .catch(() => false),
      "the configured folder must exist on this Mac",
    );
  const sources = ["github", "linear", "slack", "notion"] as const;
  report(
    "Multi-source setup",
    sources.filter((name) => profile.integrations[name]).length >= 2,
    "enable and connect at least two work sources in Settings",
  );
  process.exitCode = missing ? 1 : 0;
} else {
  throw new Error("Use init, doctor or port");
}
