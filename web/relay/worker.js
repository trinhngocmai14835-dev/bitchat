import { DurableObject } from "cloudflare:workers";

const MAX_ROOM_MESSAGES = 500;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TTL_SECONDS = 10 * 60;

function validConversationId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function validEnvelope(envelope) {
  return envelope && envelope.v === 1
    && validConversationId(envelope.conversationId)
    && typeof envelope.generation === "string"
    && typeof envelope.senderId === "string"
    && typeof envelope.messageId === "string"
    && typeof envelope.createdAt === "number"
    && typeof envelope.iv === "string"
    && typeof envelope.ciphertext === "string"
    && typeof envelope.signature === "string";
}

function validInvite(value) {
  return typeof value === "string" && value.startsWith("bitchat-pwa:v1:") && value.length <= 4096;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: jsonResponse({}).headers });
    if (url.pathname === "/health") return jsonResponse({ ok: true, service: "bitchat-relay" });
    if (["/invite/create", "/invite/resolve"].includes(url.pathname)) {
      const id = env.INVITE_DIRECTORY.idFromName("global");
      return env.INVITE_DIRECTORY.get(id).fetch(request);
    }
    if (!["/ws", "/poll", "/publish"].includes(url.pathname)) return jsonResponse({ error: "BitChat relay: use /poll, /publish, or /invite" }, 404);
    if (url.pathname === "/ws" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "WebSocket upgrade required" }, 426);
    }

    const conversationId = url.searchParams.get("conversationId");
    if (!validConversationId(conversationId)) return jsonResponse({ error: "invalid conversation" }, 400);
    const id = env.CHAT_ROOM.idFromName(conversationId);
    return env.CHAT_ROOM.get(id).fetch(request);
  },
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!validConversationId(conversationId)) return jsonResponse({ error: "invalid conversation" }, 400);

    const url = new URL(request.url);
    if (url.pathname === "/poll" && request.method === "GET") {
      return jsonResponse({ envelopes: await this.messages() });
    }
    if (url.pathname === "/publish" && request.method === "POST") {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_ENVELOPE_BYTES) return jsonResponse({ error: "packet too large" }, 413);
      try {
        const packet = JSON.parse(raw);
        if (!validEnvelope(packet.envelope) || packet.envelope.conversationId !== conversationId) {
          return jsonResponse({ error: "invalid envelope" }, 400);
        }
        await this.storeEnvelope(packet.envelope);
        return jsonResponse({ ok: true, messageId: packet.envelope.messageId });
      } catch {
        return jsonResponse({ error: "invalid json" }, 400);
      }
    }
    if (url.pathname !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "WebSocket upgrade required" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ conversationId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    const raw = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
    if (new TextEncoder().encode(raw).byteLength > MAX_ENVELOPE_BYTES) {
      socket.close(1009, "packet too large");
      return;
    }

    let packet;
    try {
      packet = JSON.parse(raw);
    } catch {
      this.sendError(socket, "invalid json");
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    if (packet.type === "hello") {
      if (packet.conversationId !== attachment.conversationId) {
        socket.close(1008, "invalid conversation");
        return;
      }
      socket.send(JSON.stringify({ type: "sync", envelopes: await this.messages() }));
      return;
    }

    if (packet.type !== "publish") {
      this.sendError(socket, "unknown packet");
      return;
    }
    const envelope = packet.envelope;
    if (!validEnvelope(envelope) || envelope.conversationId !== attachment.conversationId) {
      this.sendError(socket, "invalid envelope");
      return;
    }

    await this.storeEnvelope(envelope, socket);
    socket.send(JSON.stringify({ type: "published", messageId: envelope.messageId }));
  }

  webSocketClose() {}

  webSocketError() {}

  async messages() {
    const stored = await this.ctx.storage.get("messages");
    const cutoff = Date.now() - RETENTION_MS;
    const messages = Array.isArray(stored)
      ? stored.filter((envelope) => typeof envelope.createdAt === "number" && envelope.createdAt >= cutoff).slice(-MAX_ROOM_MESSAGES)
      : [];
    if (Array.isArray(stored) && messages.length !== stored.length) await this.ctx.storage.put("messages", messages);
    return messages;
  }

  async storeEnvelope(envelope, senderSocket = null) {
    const messages = await this.messages();
    if (messages.some((entry) => entry.messageId === envelope.messageId)) return;
    messages.push(envelope);
    await this.ctx.storage.put("messages", messages.slice(-MAX_ROOM_MESSAGES));
    for (const client of this.ctx.getWebSockets()) {
      if (client !== senderSocket && client.readyState === 1) {
        client.send(JSON.stringify({ type: "envelope", envelope }));
      }
    }
  }

  sendError(socket, message) {
    socket.send(JSON.stringify({ type: "error", message }));
  }
}

export class InviteDirectory extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/invite/create" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > 8192) return jsonResponse({ error: "invite too large" }, 413);
      try {
        const packet = JSON.parse(raw);
        if (!validInvite(packet.invite)) return jsonResponse({ error: "invalid invite" }, 400);
        const now = Date.now();
        let code = "";
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
          const existing = await this.ctx.storage.get(`code:${candidate}`);
          if (!existing || existing.expiresAt <= now) {
            code = candidate;
            break;
          }
        }
        if (!code) return jsonResponse({ error: "邀请码繁忙，请稍后重试" }, 503);
        const expiresAt = now + INVITE_TTL_SECONDS * 1000;
        await this.ctx.storage.put(`code:${code}`, { invite: packet.invite, expiresAt }, { expirationTtl: INVITE_TTL_SECONDS });
        return jsonResponse({ code, expiresAt });
      } catch {
        return jsonResponse({ error: "invalid json" }, 400);
      }
    }

    if (url.pathname === "/invite/resolve" && request.method === "GET") {
      const code = url.searchParams.get("code") || "";
      if (!/^\d{6}$/.test(code)) return jsonResponse({ error: "请输入 6 位数字邀请码" }, 400);
      const entry = await this.ctx.storage.get(`code:${code}`);
      if (!entry || entry.expiresAt <= Date.now()) {
        await this.ctx.storage.delete(`code:${code}`);
        return jsonResponse({ error: "数字邀请码无效或已过期" }, 404);
      }
      return jsonResponse({ invite: entry.invite, expiresAt: entry.expiresAt });
    }

    return jsonResponse({ error: "not found" }, 404);
  }
}
