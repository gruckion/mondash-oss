import { useRef } from "react";
import { Alert, Platform } from "react-native";
import * as Linking from "expo-linking";
import { useMutation } from "@tanstack/react-query";
import { errorMessage, touchWeb } from "./ui";

/**
 * Asks the Mac for a link (a Claude or ChatGPT session), then opens it. Browsers only open tabs during a click, so on
 * a desktop the tab opens first and gets the link when it arrives; a phone browser shows the link ready to tap, so the
 * tap hands off to the app. On the web a failure shows as `error`, since there are no alerts there; `inline` shows it
 * that way on the phone too, for a screen with room to show it. A local Mac action launches through the backend and
 * returns no URL, so it never needs a browser tab.
 */
export function useLaunch(
  title: string,
  fetchUrl: () => Promise<{ url: string } | void>,
  onDone?: () => void,
  onSettled?: () => void,
  inline = false,
  { local = false, immediate = false }: { local?: boolean; immediate?: boolean } = {},
) {
  const web = Platform.OS === "web";
  // A second tap can land before the pending state renders.
  const launching = useRef(false);
  const mutation = useMutation({
    // Takes the tab opened during the click, if any; returns the link a phone browser keeps for the next tap.
    mutationFn: async (tab: Window | null) => {
      const opened = await fetchUrl();
      if (!opened) return;
      const { url } = opened;
      if (tab) tab.location.href = url;
      else if (!web) await Linking.openURL(url);
      else if (immediate) window.location.assign(url);
      return web && !tab && !immediate ? url : undefined;
    },
    onSuccess: () => onDone?.(),
    onError: (failure, tab) => {
      tab?.close();
      if (!web && !inline)
        Alert.alert(title, errorMessage(failure), [
          { text: "Cancel", style: "cancel" },
          { text: "Try again", onPress: () => launch() },
        ]);
    },
    onSettled: () => {
      launching.current = false;
      onSettled?.();
    },
  });
  const ready = mutation.data;
  function launch() {
    if (launching.current) return;
    if (ready) {
      window.location.assign(ready);
      mutation.reset();
      return;
    }
    launching.current = true;
    mutation.mutate(web && !local && !touchWeb() ? window.open("", "_blank") : null);
  }
  return {
    busy: mutation.isPending,
    ready: !!ready,
    error: (web || inline) && mutation.error ? errorMessage(mutation.error) : undefined,
    launch,
  };
}
