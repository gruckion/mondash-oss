import { createContext, use, useState, type ReactNode } from "react";

const Context = createContext<{ query: string; setQuery: (query: string) => void } | null>(null);

/** Shared by the platform search field and Sessions results; survives tab and keyboard changes. */
export function SessionSearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  return <Context value={{ query, setQuery }}>{children}</Context>;
}

export function useSessionSearch() {
  const state = use(Context);
  if (!state) throw new Error("Session search provider missing");
  return state;
}
