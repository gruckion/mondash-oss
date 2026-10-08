import { createContext, use, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

/** The segmented control the focused screen wants in the tab bar's bottom accessory. */
export type Segments = {
  key: string;
  titles: string[];
  counts?: (number | undefined)[];
  descriptions?: (string | undefined)[];
  selected: number;
  onSelect: (index: number) => void;
};

// Two contexts, so the screens that only set the segments do not re-render each time they change.
const SegmentsContext = createContext<{ segments: Segments | null } | null>(null);
const SetSegmentsContext = createContext<Dispatch<SetStateAction<Segments | null>> | null>(null);

export function SegmentsProvider({ children }: { children: ReactNode }) {
  const [segments, setSegments] = useState<Segments | null>(null);
  return (
    <SetSegmentsContext value={setSegments}>
      <SegmentsContext value={{ segments }}>{children}</SegmentsContext>
    </SetSegmentsContext>
  );
}

export function useSegments() {
  const state = use(SegmentsContext);
  if (!state) throw new Error("Segments provider missing");
  return state;
}

export function useSetSegments() {
  const setSegments = use(SetSegmentsContext);
  if (!setSegments) throw new Error("Segments provider missing");
  return setSegments;
}
