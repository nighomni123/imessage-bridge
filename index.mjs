#!/usr/bin/env node
// imessage-bridge — dependency-free MCP stdio server bridging DSH <-> BlueBubbles.
//
// Why zero deps: MCP stdio is newline-delimited JSON-RPC 2.0; hand-rolling the
// ~4 methods we need beats pulling in a SDK + build step for one relay.
//
// Flow:
//   DSH agent --(MCP stdio)--> this server --(BlueBubbles REST API)--> iMessage
//   Your Android (BlueMessage) <-- iMessage <-- your own Apple ID <-- BlueBubbles
//   You reply on the same chat -> BlueBubbles -> this server buffers it ->
//   DSH agent reads it via imessage_receive.
//
// Config (process.env wins, then ./env file, then defaults):
//   BLUEBUBBLES_URL        base URL of the BlueBubbles server (default http://127.0.0.1:1234)
//   BLUEBUBBLES_API_KEY    BlueBubbles server password (required to send/receive)
//   BLUEBUBBLES_SELF_HANDLE your phone or email, e.g. +15551234567 or you@icloud.com
//   BLUEBUBBLES_DEFAULT_CHAT explicit chat GUID override (rarely needed)

import { readFileSync } from 'node:fs'

// ---- tiny .env loader (no dep) ------------------------------------------------
function loadDotEnv(path) {
  const out = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/)
      if (!m || line.trim().startsWith('#')) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
  } catch {}
  return out
}

const envFile = loadDotEnv(decodeURIComponent(new URL('./.env', import.meta.url).pathname))
const get = (k, d) => process.env[k] ?? envFile[k] ?? d

const BASE = (get('BLUEBUBBLES_URL', 'http://127.0.0.1:1234')).replace(/\/$/, '')
const API_KEY = get('BLUEBUBBLES_API_KEY', '')
const SELF_HANDLE = get('BLUEBUBBLES_SELF_HANDLE', '')
const DEFAULT_CHAT = get('BLUEBUBBLES_DEFAULT_CHAT', SELF_HANDLE ? `iMessage;${SELF_HANDLE}` : '')

// ---- BlueBubbles REST client (global fetch, Node 18+) -------------------------
async function bb(method, path, body) {
  const headers = { 'Content-Type': 'application/json' }
  // BlueBubbles uses ?password= query param for auth
  const sep = path.includes('?') ? '&' : '?'
  const authPath = API_KEY ? `${path}${sep}password=${encodeURIComponent(API_KEY)}` : path
  const res = await fetch(`${BASE}${authPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`BlueBubbles ${res.status} on ${path}: ${text}`)
  return json
}

// GUIDs of messages WE sent, so imessage_receive can tell "agent's own send"
// apart from "user's reply" — critical because in a self-chat both are isFromMe.
const sentGuids = new Set()
// GUIDs we already handed back to the agent, so a polling wait doesn't double-send.
const returnedGuids = new Set()
let lastActivity = Date.now()

function guidFor(recipient) {
  return `iMessage;${recipient}`
}

function normalize(m) {
  return {
    guid: m.guid,
    date: m.date ?? m.dateCreated ?? Date.now(),
    text: m.text ?? m.message ?? '',
    isFromMe: !!m.isFromMe,
    handle: m.handle?.id ?? m.handleId ?? null,
    chatGuid: m.chatGuid,
  }
}

async function bbSend(chatGuid, message) {
  // BlueBubbles requires a tempGuid (unique message ID) when using apple-script method
  const tempGuid = crypto.randomUUID()
  const json = await bb('POST', '/api/v1/message/text', { 
    chatGuid, 
    message, 
    method: 'apple-script',
    tempGuid 
  })
  const guid = json?.data?.guid ?? json?.data?.message?.guid
  if (guid) sentGuids.add(guid)
  lastActivity = Date.now()
  return json
}

async function bbReceive(chatGuid, since, limit, waitMs) {
  const deadline = Date.now() + (waitMs || 0)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const json = await bb('GET', `/api/v1/chat/${encodeURIComponent(chatGuid)}/message?limit=${limit}`)
    const candidates = (json?.data ?? [])
      .map(normalize)
      .filter((m) => m.date >= since && !sentGuids.has(m.guid) && !returnedGuids.has(m.guid))
      .sort((a, b) => a.date - b.date)
    if (candidates.length) {
      for (const m of candidates) returnedGuids.add(m.guid)
      lastActivity = Math.max(lastActivity, ...candidates.map((m) => m.date))
      return candidates
    }
    if (Date.now() >= deadline) return []
    await new Promise((r) => setTimeout(r, 3000))
  }
}

// ---- MCP tool surface ---------------------------------------------------------
const TOOLS = [
  {
    name: 'imessage_send',
    description:
      'Send an iMessage through BlueBubbles to a recipient (defaults to your own handle, ' +
      'so the message lands in the BlueMessage chat on your Android). Returns the sent ' +
      'message GUID. After sending, call imessage_receive (optionally with waitMs) to get ' +
      'the human reply from the SAME chat.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text of the iMessage to send.' },
        recipient: {
          type: 'string',
          description:
            'Phone or email to send to. Omit to use BLUEBUBBLES_SELF_HANDLE (message to yourself).',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'imessage_receive',
    description:
      'Read new human replies in an iMessage chat since the last activity. In a self-chat the ' +
      'agent\'s own sent messages are filtered out, so only YOUR replies come back. Pass waitMs ' +
      'to block (poll) until a reply arrives — use this right after imessage_send to wait for the ' +
      'human. Returns an array of { guid, date, text, handle }.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: {
          type: 'number',
          description: 'Max milliseconds to block waiting for a reply (default 0 = return immediately).',
        },
        since: {
          type: 'number',
          description: 'Epoch ms to read from. Omit to use last activity time.',
        },
        chatGuid: { type: 'string', description: 'Chat GUID. Omit to use the default (self) chat.' },
        limit: { type: 'number', description: 'Max messages to scan (default 50).' },
      },
      required: [],
    },
  },
  {
    name: 'imessage_find_chat',
    description:
      'Look up BlueBubbles chat GUIDs for a participant (e.g. your own phone/email). Use this ' +
      'once to confirm the self-chat GUID if the default "iMessage;<handle>" form is wrong.',
    inputSchema: {
      type: 'object',
      properties: { participant: { type: 'string', description: 'Phone or email to search for.' } },
      required: ['participant'],
    },
  },
  {
    name: 'imessage_ping',
    description: 'Health check: verifies the BlueBubbles server is reachable and the API key works.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]

async function callTool(name, args = {}) {
  switch (name) {
    case 'imessage_send': {
      // Use DEFAULT_CHAT if no recipient provided, otherwise construct GUID
      const chatGuid = args.recipient ? guidFor(args.recipient) : DEFAULT_CHAT
      if (!chatGuid) throw new Error('No recipient and no default chat configured.')
      const res = await bbSend(chatGuid, args.message)
      return { sent: true, chatGuid, result: res }
    }
    case 'imessage_receive': {
      const chatGuid = args.chatGuid ?? DEFAULT_CHAT
      if (!chatGuid) throw new Error('No chatGuid and no default chat configured.')
      const since = args.since ?? lastActivity
      const limit = args.limit ?? 50
      const msgs = await bbReceive(chatGuid, since, limit, args.waitMs ?? 0)
      return { count: msgs.length, messages: msgs }
    }
    case 'imessage_find_chat': {
      const res = await bb('POST', '/api/v1/chat/query', { withParticipants: [args.participant], limit: 20 })
      return { chats: res?.data ?? [] }
    }
    case 'imessage_ping': {
      // Use the dedicated ping endpoint (simpler than querying chats)
      const res = await bb('GET', '/api/v1/ping')
      return { ok: true, server: BASE, result: res?.message ?? 'pong', defaultChat: DEFAULT_CHAT }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---- MCP stdio transport (newline-delimited JSON-RPC 2.0) ---------------------
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function log(...a) {
  process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n')
}

async function handleMessage(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'imessage-bridge', version: '1.0.0' },
        },
      }
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments ?? {})
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false },
      }
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null // notifications need no response
    }
    log('unhandled method', method)
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  } catch (err) {
    log('error handling', method, err.message)
    return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } }
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handleMessage(msg).then((res) => {
      if (res) send(res)
    })
  }
})
process.stdin.on('end', () => process.exit(0))

log(`imessage-bridge ready (BASE=${BASE}, defaultChat=${DEFAULT_CHAT || '(none)'})`)
