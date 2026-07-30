#!/usr/bin/env bash
# Install Undertwig Local — background companion for desktop Console / auto path.
# Double-click (macOS .command) or run once. No day-to-day terminal use after that.
set -euo pipefail

ORIGIN="${UNDERTWIG_ORIGIN:-https://www.undertwig.com}"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/undertwig"
BIN="$SHARE/local-console-host.mjs"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_HOST="$(cd "$SCRIPT_DIR/.." && pwd)/local-console-host.mjs"

echo "Installing Undertwig Local…"

mkdir -p "$SHARE"

if [[ -f "$REPO_HOST" ]]; then
  cp "$REPO_HOST" "$BIN"
elif [[ -f "$SCRIPT_DIR/local-console-host.mjs" ]]; then
  cp "$SCRIPT_DIR/local-console-host.mjs" "$BIN"
else
  echo "Downloading companion from $ORIGIN …"
  curl -fsSL "$ORIGIN/local-console-host.mjs" -o "$BIN"
fi
chmod +x "$BIN"

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  for candidate in \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    "$HOME/.nvm/current/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

if ! NODE_BIN="$(resolve_node)"; then
  MSG="Undertwig Local needs Node.js (free). Install it from https://nodejs.org then run this installer again."
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display alert \"Undertwig Local\" message \"$MSG\" as critical" || true
    open "https://nodejs.org" || true
  elif command -v zenity >/dev/null 2>&1; then
    zenity --error --text="$MSG" || true
    xdg-open "https://nodejs.org" >/dev/null 2>&1 || true
  else
    echo "$MSG" >&2
  fi
  exit 1
fi

echo "Using Node at $NODE_BIN"

# --- autostart ---
if [[ "$(uname -s)" == "Darwin" ]]; then
  LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
  PLIST="$LAUNCH_AGENTS/com.undertwig.local.plist"
  mkdir -p "$LAUNCH_AGENTS"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.undertwig.local</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$BIN</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$SHARE/companion.log</string>
  <key>StandardErrorPath</key>
  <string>$SHARE/companion.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  launchctl start com.undertwig.local || true
else
  # Linux / other Unix: systemd user service when available, else XDG autostart
  SYSTEMD_USER="$HOME/.config/systemd/user"
  SERVICE="$SYSTEMD_USER/undertwig-local.service"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    mkdir -p "$SYSTEMD_USER"
    cat >"$SERVICE" <<EOF
[Unit]
Description=Undertwig Local companion
After=default.target

[Service]
Type=simple
ExecStart=$NODE_BIN $BIN serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now undertwig-local.service
  else
    AUTOSTART="$HOME/.config/autostart"
    mkdir -p "$AUTOSTART" "$SHARE"
    cat >"$SHARE/start-companion.sh" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$BIN" serve
EOF
    chmod +x "$SHARE/start-companion.sh"
    cat >"$AUTOSTART/undertwig-local.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Undertwig Local
Comment=Background helper for Undertwig Console and local paths
Exec=$SHARE/start-companion.sh
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
    # Start now for this session
    nohup "$SHARE/start-companion.sh" >"$SHARE/companion.log" 2>&1 &
  fi

  # Custom protocol → start companion / open terminal (optional, used by the website)
  APPS="$HOME/.local/share/applications"
  mkdir -p "$APPS"
  cat >"$APPS/undertwig-local.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Undertwig Local
Exec=$NODE_BIN $BIN handle %u
MimeType=x-scheme-handler/undertwig-local;
NoDisplay=true
Terminal=false
EOF
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default undertwig-local.desktop x-scheme-handler/undertwig-local || true
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS" >/dev/null 2>&1 || true
  fi
fi

# Probe health
sleep 0.6
if curl -fsS "http://127.0.0.1:17834/health" >/dev/null 2>&1; then
  OK_MSG="Undertwig Local is installed and running in the background. You can close this window and return to undertwig.com."
else
  OK_MSG="Undertwig Local was installed. If Console is unavailable, log out and back in once (autostart), or reopen this installer."
fi

if command -v osascript >/dev/null 2>&1; then
  osascript -e "display alert \"Undertwig Local\" message \"$OK_MSG\"" || true
elif command -v zenity >/dev/null 2>&1; then
  zenity --info --text="$OK_MSG" || true
else
  echo "$OK_MSG"
fi
