# OpenClaw Docker (Ubuntu + Chrome)

**Non-headless desktop container** for running OpenClaw on Ubuntu 24.04 with full GUI access and visible browser automation.

This is NOT a headless container - it provides a complete XFCE4 desktop accessible via browser (noVNC) or VNC client.

## Quick Start

### 1. Build Image

```bash
docker build -f Dockerfile.ubuntu-chrome -t openclaw:ubuntu-chrome .
```

### 2. Start Container

```bash
export OPENCLAW_GATEWAY_TOKEN="dev-token-change-me"
docker compose -f docker-compose.ubuntu-chrome.yml up -d
```

### 3. Verify Deployment

```bash
./test-ubuntu-chrome.sh
```

## Features

✅ **Full Ubuntu XFCE4 Desktop** – accessible via browser or VNC
✅ **Gateway Service**: OpenClaw gateway (container: `18789`, host: `18792`)
✅ **File System**: Host `$HOME/.openclaw-ubuntu/workspace/` ↔ Container `/home/node/.openclaw/workspace/`
✅ **CLI Tools**: Full `openclaw` CLI with all tools enabled
✅ **Exec Tool**: System command execution with allowlist security model
✅ **Browser Automation**: Playwright + Firefox for web access
✅ **Browser Tool**: Built-in OpenClaw browser tool for web browsing
✅ **VNC Remote Desktop**: container `5900` → host `5903`, password `openclaw` <!-- pragma: allowlist secret -->
✅ **noVNC Browser Access**: http://localhost:6083 (no VNC client needed)
✅ **Web Browser**: Firefox (configured as default)

## Desktop Access

### Via Browser (Recommended)

Open **http://localhost:6083** in your browser:

- Click "Connect"
- Enter password: `openclaw` <!-- pragma: allowlist secret -->
- You'll see the full Ubuntu XFCE4 desktop

### Via VNC Client

**Option 1: macOS Screen Sharing**

```bash
open vnc://localhost:5903
# Password: openclaw  # pragma: allowlist secret
```

**Option 2: Standalone VNC Client**

Use RealVNC, TightVNC, TigerVNC, etc.:

- Address: `localhost:5903` or `localhost::5903`
- Password: `openclaw` <!-- pragma: allowlist secret -->

**Note**: Port 5903 is native VNC protocol and **cannot** be accessed directly via browser. Use noVNC (port 6083) for browser access.

## File Structure

| File                               | Description                                  |
| ---------------------------------- | -------------------------------------------- |
| `Dockerfile.ubuntu-chrome`         | Docker image definition (with XFCE4 desktop) |
| `docker-compose.ubuntu-chrome.yml` | Docker Compose configuration                 |
| `supervisord.conf`                 | Multi-service management                     |
| `start-services.sh`                | Container startup script                     |
| `GUI_DESKTOP_GUIDE.md`             | GUI desktop usage guide ⭐                   |
| `EXEC_TOOL_SETUP.md`               | Exec tool setup guide ⭐                     |
| `BROWSER_TOOL_ENABLED.md`          | Browser tool configuration ⭐                |
| `UBUNTU_CHROME_SETUP.md`           | Original setup notes                         |
| `test-gui-desktop.sh`              | GUI desktop test script                      |
| `verify-browser-tool.sh`           | Browser tool verification script             |

## Configuration

Container config file: `$HOME/.openclaw-ubuntu/openclaw.json`

```json
{
  "gateway": {
    "bind": "lan",
    "port": 18789,
    "auth": { "token": "dev-token-change-me" }
  },
  "browser": {
    "enabled": true,
    "headless": false,
    "noSandbox": true
  }
}
```

### Headed Chrome (for QR Scanning)

For QR scanning and interactive login flows, the container runs Chrome in headed mode by default:

- `browser.headless = false` – visible browser window
- `browser.noSandbox = true` – required for container environment
- `DISPLAY=:99` – gateway process connects to Xvfb

These settings are wired across three paired files:

| File                               | Role                                       |
| ---------------------------------- | ------------------------------------------ |
| `docker-compose.ubuntu-chrome.yml` | Sets `OPENCLAW_BROWSER_HEADLESS=0` env     |
| `supervisord.conf`                 | Injects `DISPLAY=:99` into gateway process |
| `Dockerfile.ubuntu-chrome`         | Installs Xvfb + supervisor runtime         |

To restart after config changes:

```bash
docker compose -f docker-compose.ubuntu-chrome.yml restart openclaw-ubuntu
```

## Common Commands

```bash
# Check container status
docker compose -f docker-compose.ubuntu-chrome.yml ps

# View logs
docker compose -f docker-compose.ubuntu-chrome.yml logs -f openclaw-ubuntu

# Enter container shell
docker compose -f docker-compose.ubuntu-chrome.yml exec openclaw-ubuntu bash

# Stop container
docker compose -f docker-compose.ubuntu-chrome.yml down
```

## Network Ports (Host)

| Host Port | Container Port | Service                     |
| --------- | -------------- | --------------------------- |
| `18792`   | `18789`        | Gateway WebSocket + HTTP    |
| `18793`   | `18790`        | Bridge service              |
| `5903`    | `5900`         | VNC remote desktop          |
| `6083`    | `6080`         | noVNC browser-based desktop |

## Troubleshooting

### Container Fails to Start

```bash
docker compose -f docker-compose.ubuntu-chrome.yml logs openclaw-ubuntu
```

### Gateway Connection Issues

```bash
docker compose -f docker-compose.ubuntu-chrome.yml exec openclaw-ubuntu \
  curl -s http://127.0.0.1:18789/healthz
```

### Browser Access

To open a web browser in the XFCE4 desktop:

1. **Applications menu → Internet → Web Browser**
2. Or run in terminal: `firefox &`
3. Firefox is configured as the default browser

**Chrome on arm64**: Requires manual setup, see `UBUNTU_CHROME_SETUP.md`.

## Architecture

- **Base Image**: Ubuntu 24.04
- **Node.js**: 22 (NodeSource)
- **OpenClaw**: Latest (npm global install)
- **Browser**: Google Chrome (amd64) / manual setup (arm64)
- **Process Manager**: dumb-init + supervisor

## Next Steps

1. **Access GUI Desktop**: Open http://localhost:6083 (password: `openclaw`)
2. **Use Browser Tool**: Ask OpenClaw to visit websites
3. **Run System Commands**: See [EXEC_TOOL_SETUP.md](EXEC_TOOL_SETUP.md)
4. **Browser Automation**: Use Playwright for advanced automation
5. **Add Messaging Channels**: `openclaw channel add telegram`
6. **Debug Browser Visually**: Run `openclaw browser start` in desktop
7. **File Operations**: Use `$HOME/.openclaw-ubuntu/workspace/`

📖 **Related Docs**:

- [BROWSER_TOOL_ENABLED.md](BROWSER_TOOL_ENABLED.md) – Browser tool setup
- [GUI_DESKTOP_GUIDE.md](GUI_DESKTOP_GUIDE.md) – Desktop usage guide
- [EXEC_TOOL_SETUP.md](EXEC_TOOL_SETUP.md) – Exec tool configuration

## Support

- 📚 Docs: https://docs.openclaw.ai
- 🐛 Issues: https://github.com/openclaw/openclaw/issues
- 💬 Discord: https://discord.gg/openclaw
