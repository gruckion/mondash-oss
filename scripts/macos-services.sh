#!/bin/bash
# Manage Mondash's backend (Bun) and Expo Go bundler (Metro) as per-user launch agents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ACTION="${1:-status}"
SERVICE="${2:-backend}"
DOMAIN="gui/$(id -u)"
PREFIX="${MONDASH_SERVICE_PREFIX:-com.mondash}"
[[ "$PREFIX" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid service prefix" >&2; exit 1; }
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$ROOT/.cache/services"

case "$SERVICE" in
  backend|metro) SERVICES=("$SERVICE") ;;
  all) SERVICES=(backend metro) ;;
  *) echo "Service must be backend, metro, or all." >&2; exit 1 ;;
esac

case "$ACTION" in
  install|preview)
    NODE="${MONDASH_NODE:-$(command -v node || true)}"
    BUN="${MONDASH_BUN:-$(command -v bun || true)}"
    test -x "$BUN" || { echo "Install Bun or set MONDASH_BUN to its executable path." >&2; exit 1; }
    command -v python3 >/dev/null || { echo "Install Python 3 to generate launch agents." >&2; exit 1; }
    TAILNET_IP=""
    if [[ " ${SERVICES[*]} " == *" metro "* ]]; then
      test -n "$NODE" || { echo "Metro requires Node.js." >&2; exit 1; }
      TAILNET_IP="${MONDASH_TAILNET_IP:-127.0.0.1}"
    fi
    if [ "$ACTION" = preview ]; then AGENTS="$LOGS/preview"; fi
    mkdir -p "$AGENTS" "$LOGS"
    for NAME in "${SERVICES[@]}"; do
      LABEL="$PREFIX.$NAME"
      if [ "$ACTION" = install ] && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "$LABEL is loaded; stop it before replacing its configuration." >&2
        exit 1
      fi
      python3 - "$ROOT" "$NODE" "$BUN" "$TAILNET_IP" "$NAME" "$AGENTS/$LABEL.plist" "$PREFIX" <<'PY'
import os, pathlib, plistlib, sys
root, node, bun, tailnet_ip, name, target, prefix = sys.argv[1:]
env = {
    "HOME": str(pathlib.Path.home()),
    "PATH": os.pathsep.join([str(pathlib.Path(bun).parent), str(pathlib.Path(node).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
}
if os.environ.get("MONDASH_PROFILE"):
    env["MONDASH_PROFILE"] = str(pathlib.Path(os.environ["MONDASH_PROFILE"]).resolve())
if name == "backend":
    # The repo root, so the server finds .env, .cache and .mcp-auth there.
    cwd = root
    args = [bun, root + "/apps/server/src/main.ts"]
    env["NODE_ENV"] = "production"
else:
    cwd = root + "/apps/app"
    args = [node, root + "/node_modules/expo/bin/cli", "start", "--go", "--lan", "--port", "8081"]
    # No CI=1: with it Metro stops watching files and serves stale cached code after edits.
    env.update({"EXPO_NO_TELEMETRY": "1", "REACT_NATIVE_PACKAGER_HOSTNAME": tailnet_ip})
config = {
    "Label": prefix + "." + name,
    "ProgramArguments": args,
    "WorkingDirectory": cwd,
    "EnvironmentVariables": env,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 30,
    "StandardOutPath": root + "/.cache/services/" + name + ".log",
    "StandardErrorPath": root + "/.cache/services/" + name + ".error.log",
}
with open(target, "wb") as f:
    plistlib.dump(config, f)
os.chmod(target, 0o600)
print("Installed " + target + " (not started)")
PY
    done
    ;;
  start)
    # Check every requested service before starting any of them.
    for NAME in "${SERVICES[@]}"; do
      LABEL="$PREFIX.$NAME"
      if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then continue; fi
      test -f "$AGENTS/$LABEL.plist" || { echo "Run $0 install $NAME first." >&2; exit 1; }
      if [ "$NAME" = backend ]; then
        PORT="$(cd "$ROOT" && "${MONDASH_BUN:-$(command -v bun)}" apps/server/src/doctor.ts port)"
        BACKEND_PORT="$PORT"
        test -f "$ROOT/apps/app/dist/index.html" || { echo "Build the web app with bun run build first." >&2; exit 1; }
      else
        PORT=8081
      fi
      if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "Port $PORT is occupied. Stop the existing $NAME process before starting its managed service." >&2
        exit 1
      fi
    done
    STARTED_SERVICES=()
    for NAME in "${SERVICES[@]}"; do
      LABEL="$PREFIX.$NAME"
      if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "$LABEL is already loaded."
      else
        if ! launchctl bootstrap "$DOMAIN" "$AGENTS/$LABEL.plist"; then
          for STARTED in "${STARTED_SERVICES[@]:-}"; do
            if [ -n "$STARTED" ]; then launchctl bootout "$DOMAIN/$PREFIX.$STARTED" || true; fi
          done
          echo "Start failed; services started in this attempt were rolled back." >&2
          exit 1
        fi
        STARTED_SERVICES+=("$NAME")
        if [ "$NAME" = backend ]; then
          READY=false
          for ((ATTEMPT=0; ATTEMPT<80; ATTEMPT++)); do
            if curl --fail --silent --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null; then READY=true; break; fi
            if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then break; fi
            sleep 0.5
          done
          if [ "$READY" != true ]; then
            for STARTED in "${STARTED_SERVICES[@]}"; do launchctl bootout "$DOMAIN/$PREFIX.$STARTED" || true; done
            echo "Backend did not become healthy; new services were rolled back. Check $LOGS/backend.error.log." >&2
            exit 1
          fi
        fi
        echo "Started $LABEL"
      fi
    done
    ;;
  stop)
    for NAME in "${SERVICES[@]}"; do
      LABEL="$PREFIX.$NAME"
      if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        launchctl bootout "$DOMAIN/$LABEL"
        # bootout can return before launchd removes the job. Wait so an
        # immediately following start cannot mistake it for a running service.
        for ((ATTEMPT=0; ATTEMPT<40; ATTEMPT++)); do
          if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then break; fi
          sleep 0.25
        done
        if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
          echo "Timed out waiting for $LABEL to unload; check its status before restarting." >&2
          exit 1
        fi
        echo "Stopped $LABEL"
      else
        echo "$LABEL is not loaded."
      fi
    done
    ;;
  restart)
    "$0" stop "$SERVICE"
    "$0" start "$SERVICE"
    ;;
  uninstall)
    "$0" stop "$SERVICE"
    for NAME in "${SERVICES[@]}"; do rm -f "$AGENTS/$PREFIX.$NAME.plist"; done
    echo "Launch agents removed; configuration, credentials and saved work retained."
    ;;
  logs)
    for NAME in "${SERVICES[@]}"; do tail -n 80 "$LOGS/$NAME.log" "$LOGS/$NAME.error.log"; done
    ;;
  status)
    for NAME in "${SERVICES[@]}"; do
      LABEL="$PREFIX.$NAME"
      if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        launchctl print "$DOMAIN/$LABEL" | sed -n '/state =/p; /pid =/p; /last exit code =/p'
        echo "$LABEL loaded; logs: $LOGS/$NAME{,.error}.log"
      else
        echo "$LABEL is not loaded."
      fi
    done
    ;;
  *) echo "Usage: $0 {preview|install|start|stop|restart|status|logs|uninstall} [backend|metro|all]" >&2; exit 1 ;;
esac
