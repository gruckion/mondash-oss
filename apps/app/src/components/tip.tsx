import { TooltipButton as Pressable } from "./tooltip-button";
import { useRef, useState, type ReactNode } from "react";
import { Modal, Text, useWindowDimensions, View } from "react-native";
import { useTheme } from "@/lib/theme";

/** Tap an icon to see what it means; tap anywhere to close. An action adds a link line, e.g. to open threads. */
export function Tip({
  lines,
  action,
  children,
}: {
  lines: string[];
  action?: { label: string; onPress: () => void };
  children: ReactNode;
}) {
  const t = useTheme();
  const anchor = useRef<View>(null);
  const [at, setAt] = useState<{
    top: number;
    left?: number;
    right?: number;
  }>();
  const { width } = useWindowDimensions();
  const close = () => setAt(undefined);
  return (
    <>
      <Pressable
        ref={anchor}
        accessibilityRole="button"
        accessibilityLabel={lines.join(". ")}
        hitSlop={8}
        onPress={() =>
          anchor.current?.measureInWindow((x, y, w, h) =>
            setAt(
              // Open towards the middle of the screen so the tip never runs off an edge.
              x + w / 2 < width / 2
                ? { top: y + h + 6, left: Math.max(8, x) }
                : { top: y + h + 6, right: Math.max(8, width - x - w) },
            ),
          )
        }
      >
        {children}
      </Pressable>
      <Modal transparent visible={!!at} animationType="fade" onRequestClose={close}>
        <Pressable tooltip={false} accessibilityLabel="Close" style={{ flex: 1 }} onPress={close}>
          {at && (
            <View
              style={{
                position: "absolute",
                top: at.top,
                left: at.left,
                right: at.right,
                maxWidth: 260,
                backgroundColor: t.dark ? "#2c2c2e" : "#ffffff",
                borderRadius: 10,
                borderCurve: "continuous",
                paddingHorizontal: 12,
                paddingVertical: 8,
                gap: 2,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              }}
            >
              {lines.map((text) => (
                <Text key={text} style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>
                  {text}
                </Text>
              ))}
              {action && (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => {
                    close();
                    action.onPress();
                  }}
                  style={{ minHeight: 32, justifyContent: "center" }}
                >
                  <Text
                    style={{
                      color: "#0a84ff",
                      fontSize: 13,
                      fontWeight: "600",
                    }}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </Pressable>
      </Modal>
    </>
  );
}
