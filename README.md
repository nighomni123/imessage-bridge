# iMessage Bridge for DeepSeek Harness

A **dependency-free MCP stdio server** that bridges agent harnesses to iMessage via BlueBubbles, enabling human-in-the-loop conversations through your Android device. It speaks plain MCP stdio (newline-delimited JSON-RPC), so it mounts under any MCP client — the examples below use DeepSeek Harness (DSH), where it runs in production daily.

## Architecture

```
DSH Agent (Mac) ──MCP stdio──▶ imessage-bridge ──REST API──▶ BlueBubbles Server (Mac)
                                                                      │
                                                                      ▼
                                                              iMessage Network
                                                                      │
                                                                      ▼
                                              Android (BlueMessage/BlueBubbles app)
```

**Flow:**
1. DSH agent calls `imessage_send` → bridge sends iMessage via BlueBubbles
2. Message appears in your Android iMessage app (BlueMessage/BlueBubbles client)
3. You reply on the **same chat** on Android
4. Bridge's `imessage_receive` polls for new messages and returns your replies
5. DSH agent continues with your response

## What it looks like in action

> 📸 TODO(owner): drop `demo.png` here — screenshot 1–2 exchanges from the real
> self-chat (agent asking for a decision → your one-line reply → agent resuming
> and shipping). This section is the whole README for a viewer who won't run it.

Meanwhile, the actual proof-of-life: every project in this workspace's AGENTS.md
automation loop has been steered and reported through this bridge — the agent
fleet researches and codes in the background and checks in over iMessage,
which is exactly the "orchestrate, don't micromanage" workflow.

## Prerequisites

1. **BlueBubbles server** running on your Mac (the same Mac running DSH)
   - Download: https://bluebubbles.app
   - Configure a server password in Settings → Users/API
2. **Android iMessage client** paired to your BlueBubbles server
   - BlueBubbles app, BlueMessage, or similar
3. **Node.js 18+** (for global `fetch` support)

## Setup

### 1. Configure the bridge

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
BLUEBUBBLES_URL=http://127.0.0.1:1234
BLUEBUBBLES_API_KEY=your-bluebubbles-server-password
BLUEBUBBLES_SELF_HANDLE=+15551234567  # or you@icloud.com
```

- **BLUEBUBBLES_API_KEY**: Your BlueBubbles server password (from Settings → Users/API)
- **BLUEBUBBLES_SELF_HANDLE**: Your own phone number or email (the one you'll message yourself from)

### 2. Test the bridge standalone

```bash
node index.mjs
```

You should see: `imessage-bridge ready (BASE=http://127.0.0.1:1234, defaultChat=iMessage;+15551234567)`

The bridge is now listening on stdin for MCP JSON-RPC messages. Press Ctrl+C to stop.

### 3. Register with DeepSeek Harness

Add this entry to your DSH web profile's `cordis.patch.yml` (typically `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: imessage-bridge
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: imessage
    command: /usr/local/bin/node
    args:
      - /path/to/imessage-bridge/index.mjs
    env: {}
    cwd: /path/to/imessage-bridge
    toolCallTimeoutMs: 300000
    failOnStartupError: false
```

**Important:** The bridge reads secrets from its `.env` file (not from DSH config), so `env: {}` is safe.

Restart the DSH web GUI to load the new MCP server.

## Usage

The bridge exposes four tools to the DSH agent:

### `imessage_send`

Send an iMessage to a recipient (defaults to yourself for self-chat).

**Parameters:**
- `message` (required): Text to send
- `recipient` (optional): Phone or email. Omit to use `BLUEBUBBLES_SELF_HANDLE` (message yourself)

**Example:**
```json
{
  "message": "Need your input on this design decision...",
  "recipient": "+15551234567"
}
```

Returns the sent message GUID and confirmation.

### `imessage_receive`

Read new human replies since the last activity. In a self-chat, the agent's own sent messages are filtered out, so only **your replies** come back.

**Parameters:**
- `waitMs` (optional): Max milliseconds to block waiting for a reply (default 0 = return immediately)
- `since` (optional): Epoch ms to read from. Omit to use last activity time
- `chatGuid` (optional): Chat GUID. Omit to use the default (self) chat
- `limit` (optional): Max messages to scan (default 50)

**Example (blocking wait for reply):**
```json
{
  "waitMs": 180000
}
```

Returns an array of messages: `{ guid, date, text, handle, chatGuid }`

**Tip:** Call `imessage_receive` with `waitMs` right after `imessage_send` to wait for the human's reply. The DSH tool call timeout is set to 5 minutes (300000ms), so you can wait up to ~280 seconds.

### `imessage_find_chat`

Look up BlueBubbles chat GUIDs for a participant. Use this once to confirm the self-chat GUID if the default `iMessage;<handle>` form is wrong.

**Parameters:**
- `participant` (required): Phone or email to search for

**Example:**
```json
{
  "participant": "+15551234567"
}
```

Returns matching chats with their GUIDs.

### `imessage_ping`

Health check: verifies the BlueBubbles server is reachable and the API key works.

**Parameters:** None

**Example:**
```json
{}
```

Returns `{ ok: true, server, chatCount, defaultChat }` on success.

## How It Works

### Self-Chat Message Filtering

When you message yourself, both the agent's sent messages and your replies have `isFromMe: true` (since they're all from your Apple ID). The bridge tracks sent message GUIDs in memory and filters them out in `imessage_receive`, so only your **replies** (new GUIDs not in the sent set) are returned.

### Polling with Blocking

`imessage_receive` polls BlueBubbles every 3 seconds when `waitMs > 0`. It returns as soon as it finds new messages or when the timeout expires. This lets the agent wait for your reply without busy-looping.

### Zero Dependencies

The bridge implements the MCP stdio protocol (newline-delimited JSON-RPC 2.0) by hand — no SDK, no build step, no `node_modules`. This keeps it lightweight and avoids dependency conflicts with DSH.

## Troubleshooting

### Bridge won't start in DSH

Check the DSH logs. Common issues:
- **Node path wrong**: Update `command` in `cordis.patch.yml` to your actual Node path (`which node`)
- **Bridge path wrong**: Verify the absolute path to `index.mjs`
- **Permission denied**: Ensure `index.mjs` is executable (`chmod +x index.mjs`)

### `imessage_ping` fails

- **401 Unauthorized**: Wrong `BLUEBUBBLES_API_KEY` in `.env`
- **Connection refused**: BlueBubbles server not running, or wrong `BLUEBUBBLES_URL`
- **404 Not Found**: BlueBubbles API version mismatch (this bridge targets BlueBubbles v1 API)

### `imessage_receive` returns empty

- **No default chat**: Set `BLUEBUBBLES_SELF_HANDLE` in `.env`, or pass `chatGuid` explicitly
- **Messages filtered out**: The bridge only returns messages with GUIDs not in its sent set. If you're testing by sending messages from the same Apple ID, they may be filtered. Use a different chat or restart the bridge.

### Agent times out waiting for reply

The DSH tool call timeout is 5 minutes (300000ms). If you need longer, increase `toolCallTimeoutMs` in `cordis.patch.yml`. Alternatively, have the agent call `imessage_receive` with `waitMs: 0` in a loop (less efficient but avoids timeout).

## Security Notes

- **Secrets in `.env`**: The bridge reads `BLUEBUBBLES_API_KEY` from `.env` (not DSH config). Keep `.env` out of git (it's in `.gitignore`).
- **Local-only**: The bridge assumes BlueBubbles runs on `127.0.0.1`. If you expose BlueBubbles to the network, use HTTPS and strong credentials.
- **Apple ToS**: Relay setups (BlueBubbles, AirMessage) operate in a gray area of Apple's Terms of Service. Use at your own risk.

## Development

The bridge is a single file (`index.mjs`) with no build step. To modify:

1. Edit `index.mjs`
2. Restart the DSH web GUI (or HMR if enabled)

To test the MCP protocol manually:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node index.mjs
```

## License

MIT
