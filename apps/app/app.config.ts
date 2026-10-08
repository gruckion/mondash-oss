import type { ConfigContext, ExpoConfig } from "expo/config";
const { readFileSync } = require("node:fs") as { readFileSync(path: string, encoding: "utf8"): string };
export default ({ config }: ConfigContext): ExpoConfig => {
  const oss = process.env.MONDASH_APP_VARIANT === "oss";
  const pairing = process.env.MONDASH_IROH_PAIRING_FILE;
  const iroh = pairing ? JSON.parse(readFileSync(pairing, "utf8")) : undefined;
  return {
    ...config,
    name: oss ? "Mondash OSS" : (config.name ?? "Mondash"),
    slug: oss ? "mondash-oss" : (config.slug ?? "mondash"),
    scheme: oss ? "mondash-oss" : config.scheme,
    plugins: [...(config.plugins ?? []), "./plugins/with-iroh.cjs"],
    extra: {
      ...config.extra,
      ...(iroh ? { irohPairing: { ticket: iroh.ticket, token: iroh.token, id: iroh.id } } : {}),
    },
    ios: {
      ...config.ios,
      bundleIdentifier:
        process.env.MONDASH_IOS_BUNDLE_ID ??
        (oss ? `${config.ios?.bundleIdentifier ?? "app.mondash.mobile"}.oss` : config.ios?.bundleIdentifier),
      ...(process.env.MONDASH_APPLE_TEAM_ID ? { appleTeamId: process.env.MONDASH_APPLE_TEAM_ID } : {}),
      buildNumber: process.env.MONDASH_IOS_BUILD_NUMBER ?? config.ios?.buildNumber,
    },
  };
};
