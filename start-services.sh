#!/bin/bash
set -e

echo "Starting OpenClaw with GUI Desktop..."
echo "======================================"

# Set display
export DISPLAY=:99

# Ensure VNC password is set
if [ ! -f /root/.vnc/passwd ]; then
    mkdir -p /root/.vnc
    x11vnc -storepasswd openclaw /root/.vnc/passwd
fi

# Create workspace directory if not exists
mkdir -p /home/node/.openclaw/workspace
chown -R node:node /home/node/.openclaw /workspace

# Ensure XFCE4 panel config exists
mkdir -p /root/.config/xfce4
if [ ! -d /root/.config/xfce4-first-run ]; then
    touch /root/.config/xfce4-first-run
fi

echo "Services (container-internal ports):"
echo "  - OpenClaw Gateway: http://localhost:18789"
echo "  - VNC: localhost:5900 (password: openclaw)"
echo "  - noVNC (Browser): http://localhost:6080"
echo ""
echo "Tip: The desktop panel appears at the top with the Applications menu."
echo ""

# Start supervisord (manages all services)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
