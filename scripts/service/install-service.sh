#!/bin/sh
# 把 Agent 面板装成开机自动在后台运行的服务（不用一直开着终端），和 Windows 的托盘程序对应。
#   macOS：launchd 用户服务（~/Library/LaunchAgents/com.fixcode.agent-panel.plist）
#   Linux：systemd 用户服务（~/.config/systemd/user/agent-panel.service）
#
# 用法：
#   ./install-service.sh            安装并马上启动
#   ./install-service.sh uninstall  停止并移除
#   ./install-service.sh --print    只显示要写入的服务配置，不安装
#
# 服务里用安装时终端的 PATH，这样能找到 claude、codex 这些 CLI；装了新 CLI 或改了 PATH 后重新运行一次即可。
# 运行日志在本目录的 agent-panel.log。
set -e
cd "$(dirname "$0")"
DIR=$(pwd)
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "没有找到 Node.js。Agent 面板需要 Node.js 22 或更新的版本：https://nodejs.org/zh-cn/download" >&2
  exit 1
fi
LABEL=com.fixcode.agent-panel
LOG="$DIR/agent-panel.log"
ACTION=${1:-install}

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  # 退出码不是 0（包括更新后要求重启的 75）时 launchd 重新拉起；正常退出不再启动
  CONF="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$NODE")</string><string>server.mjs</string><string>--prod</string></array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
    <key>AGENT_PANEL_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>"
  case "$ACTION" in
  --print) echo "$CONF" ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已移除 Agent 面板服务"
    ;;
  *)
    mkdir -p "$HOME/Library/LaunchAgents"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    echo "$CONF" >"$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "已安装：登录后自动在后台运行。打开 http://127.0.0.1:8787 使用，日志在 $LOG"
    ;;
  esac
  ;;
Linux)
  UNIT="$HOME/.config/systemd/user/agent-panel.service"
  # 更新后服务以 75 退出要求重启，Restart=always 会重新拉起；systemctl --user stop 时不会
  CONF="[Unit]
Description=Agent 面板
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=\"$NODE\" server.mjs --prod
Environment=\"PATH=$PATH\"
Environment=AGENT_PANEL_SUPERVISED=1
Restart=always
RestartSec=2
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target"
  case "$ACTION" in
  --print) echo "$CONF" ;;
  uninstall)
    systemctl --user disable --now agent-panel.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "已移除 Agent 面板服务"
    ;;
  *)
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "没有找到 systemd，请用 ./start.sh 启动" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$UNIT")"
    echo "$CONF" >"$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now agent-panel.service
    systemctl --user restart agent-panel.service
    echo "已安装：登录后自动在后台运行。打开 http://127.0.0.1:8787 使用，日志在 $LOG"
    echo "想在没登录时也运行：sudo loginctl enable-linger $(id -un)"
    ;;
  esac
  ;;
*)
  echo "只支持 macOS 和 Linux；Windows 请双击 AgentPanel.exe" >&2
  exit 1
  ;;
esac
