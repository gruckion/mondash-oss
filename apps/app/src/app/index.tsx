import { Redirect } from "expo-router";

// Each tab has its own path, so a web refresh or link keeps you on it; the bare address opens Issues.
export default function Index() {
  return <Redirect href="/issues" />;
}
