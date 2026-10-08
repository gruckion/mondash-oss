// Expo finds the Bun workspace root itself, so @mondash/shared resolves from the root node_modules.
const { getDefaultConfig } = require("expo/metro-config");

// Tree shaking for production bundles (web export and the iOS Release build). Without it Metro keeps all of Effect,
// which tripled the web bundle (3.0 MB to 9.3 MB). Expo Go's dev bundle stays on plain Metro.
if (process.env.NODE_ENV === "production") {
  process.env.EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH ??= "1";
  process.env.EXPO_UNSTABLE_TREE_SHAKING ??= "1";
}

const config = getDefaultConfig(__dirname);

// Streamdown loads its code highlighter and Mermaid on demand. Both import Streamdown back, so Metro would move it
// into a shared chunk that the web page loads at start. The conversation screen draws code itself and never renders
// either (components/conversation.tsx), so they resolve to nothing and Streamdown loads with that screen only.
const streamdownExtra = /^\.\/(highlighted-body|mermaid)-[A-Z0-9]+\.js$/;
config.resolver.resolveRequest = (context, moduleName, platform) =>
  streamdownExtra.test(moduleName) && context.originModulePath.includes("/node_modules/streamdown/")
    ? { type: "empty" }
    : context.resolveRequest(context, moduleName, platform);

module.exports = config;
