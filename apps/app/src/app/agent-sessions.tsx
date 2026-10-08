import { TooltipButton } from "@/components/tooltip-button";
import { webScrollProps } from "@/lib/web-scroll";
import { Sheet } from "@/components/sheet";
import { Icon } from "@/components/icon";
import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { SessionRow } from "@/components/session-row";
import { StartPrSession, StartReview, StartTicketSession } from "@/components/start-review";
import { useSettings } from "@/lib/provider";
import { useSessionSheet } from "@/lib/session-sheet";
import { useTheme } from "@/lib/theme";

export default function AgentSessionsSheet() {
  const t = useTheme();
  const { group } = useSessionSheet();
  const { refreshSection } = useSettings();
  const active = group ? group.sessions.filter((session) => !session.archived) : [];
  const archived = group ? group.sessions.filter((session) => session.archived) : [];
  return (
    <Sheet>
      <ScrollView
        {...webScrollProps}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 20,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text accessibilityRole="header" style={{ color: t.text, fontSize: 20, fontWeight: "600" }}>
              Agent sessions{group ? ` · ${group.sessions.length}` : ""}
            </Text>
          </View>
          <TooltipButton
            accessibilityRole="button"
            accessibilityLabel="Close agent sessions"
            onPress={() => router.back()}
            style={{
              width: 44,
              height: 44,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Icon name="xmark.circle.fill" color={t.secondary} size={28} />
          </TooltipButton>
        </View>
        {group ? (
          <>
            <Text
              selectable
              numberOfLines={1}
              style={{
                color: t.secondary,
                fontSize: 13,
                lineHeight: 18,
                marginBottom: 8,
              }}
            >
              {group.label} · {group.title}
            </Text>
            {group.ticket && (
              <View style={{ alignSelf: "flex-end", marginBottom: 4 }}>
                <StartTicketSession
                  ticketId={group.ticket.id}
                  url={group.ticket.url}
                  prs={group.ticket.prs}
                  title="New Claude session"
                  onStarted={() => refreshSection("issues")}
                />
              </View>
            )}
            {group.tickets?.map((ticket) => (
              <View key={ticket.id} style={{ alignSelf: "flex-end", marginBottom: 8 }}>
                <StartTicketSession
                  ticketId={ticket.id}
                  url={ticket.url}
                  prs={ticket.prs}
                  title={`New Claude session · ${ticket.id}`}
                  onStarted={() => refreshSection("issues")}
                />
              </View>
            ))}
            {group.pr && (
              <View style={{ alignSelf: "flex-end", marginBottom: 4 }}>
                <StartPrSession url={group.pr} title="New Claude session" onStarted={() => refreshSection("issues")} />
              </View>
            )}
            {group.review && (
              <View style={{ alignSelf: "flex-end", marginBottom: 4 }}>
                <StartReview
                  url={group.review}
                  startNew
                  title="New review"
                  onStarted={() => refreshSection("reviews")}
                />
              </View>
            )}
            {active.map((session, index) => (
              <SessionRow key={`${session.tool}:${session.id}`} session={session} last={index === active.length - 1} />
            ))}
            {archived.length > 0 && (
              <>
                <Text
                  accessibilityRole="header"
                  style={{ color: t.secondary, fontSize: 13, lineHeight: 18, marginTop: 20, marginBottom: 4 }}
                >
                  Archived · {archived.length}
                </Text>
                <View style={{ opacity: 0.6 }}>
                  {archived.map((session, index) => (
                    <SessionRow
                      key={`${session.tool}:${session.id}`}
                      session={session}
                      last={index === archived.length - 1}
                    />
                  ))}
                </View>
              </>
            )}
          </>
        ) : (
          <Text style={{ color: t.secondary, fontSize: 15, marginTop: 16 }}>
            Open agent sessions from an issue, review or scoping item.
          </Text>
        )}
      </ScrollView>
    </Sheet>
  );
}
