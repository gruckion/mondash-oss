// Consume the one-use invitation before Expo Router captures its initial URL.
if (location.hash.startsWith("#mondash=")) {
  window.__mondashInvitation = location.hash.slice("#mondash=".length);
  history.replaceState(history.state, "", location.pathname + location.search);
}
