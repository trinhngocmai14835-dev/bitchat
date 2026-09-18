import { finalizeEvent, SimplePool } from "nostr-tools";
import { base64UrlToBytes } from "./protocol.js";

const PUBLIC_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];
const NOSTR_KIND = 1059;

function endpointFor(baseUrl, route) {
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${basePath}${route}`;
  endpoint.search = "";
  return endpoint;
}

export class RelayClient {
  constructor({ identity, onEnvelope, onStatus }) {
    this.identity = identity;
    this.onEnvelope = onEnvelope;
    this.onStatus = onStatus;
    this.socket = null;
    this.pool = new SimplePool();
    this.subscription = null;
    this.url = "";
    this.conversationId = "";
    this.conversationIds = [];
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.polling = false;
    this.closedByUser = false;
    this.transport = null;
    this.openPromise = null;
  }

  connect(url, conversationId) {
    this.url = typeof url === "string" ? url.trim() : "";
    this.conversationIds = [...new Set(
      (Array.isArray(conversationId) ? conversationId : [conversationId])
        .filter((value) => typeof value === "string" && value.length > 0),
    )];
    this.conversationId = this.conversationIds[0] || "";
    this.closedByUser = false;
    this.clearReconnect();
    this.closeCurrentTransport();
    if (!this.url) {
      this.onStatus("未配置中继");
      return;
    }
    if (this.url === "nostr://public") {
      this.connectNostr();
      return;
    }
    if (/^https?:\/\//i.test(this.url)) {
      this.connectHttpPolling();
      return;
    }
    this.connectWebSocket();
  }

  connectHttpPolling() {
    this.transport = "http";
    this.polling = true;
    this.onStatus("连接中");
    this.pollOnce();
  }

  async pollOnce() {
    if (!this.polling || this.closedByUser) return;
    try {
      const results = await Promise.allSettled(this.conversationIds.map(async (conversationId) => {
        const endpoint = endpointFor(this.url, "/poll");
        endpoint.searchParams.set("conversationId", conversationId);
        // Protect users still running an older service worker that cached GET responses.
        endpoint.searchParams.set("_", String(Date.now()));
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error(`poll ${response.status}`);
        const packet = await response.json();
        if (Array.isArray(packet.envelopes)) {
          for (const envelope of packet.envelopes) this.onEnvelope(envelope);
        }
      }));
      if (results.some((result) => result.status === "fulfilled")) {
        this.onStatus("已连接");
      } else {
        throw new Error("all polls failed");
      }
    } catch {
      if (!this.closedByUser) this.onStatus("中继连接错误，稍后重试");
    } finally {
      if (this.polling && !this.closedByUser) this.pollTimer = setTimeout(() => this.pollOnce(), 3000);
    }
  }

  connectWebSocket() {
    this.transport = "websocket";
    this.onStatus("连接中");
    try {
      const endpoint = new URL(this.url);
      endpoint.searchParams.set("conversationId", this.conversationId);
      const socket = new WebSocket(endpoint.toString());
      this.socket = socket;
      this.openPromise = new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
      });
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.onStatus("已连接");
        socket.send(JSON.stringify({ type: "hello", conversationId: this.conversationId }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const packet = JSON.parse(event.data);
          if (packet.type === "envelope" && packet.envelope) this.onEnvelope(packet.envelope);
          if (packet.type === "sync" && Array.isArray(packet.envelopes)) {
            for (const envelope of packet.envelopes) this.onEnvelope(envelope);
          }
        } catch {
          // Ignore malformed relay frames.
        }
      });
      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.openPromise = null;
        if (!this.closedByUser) {
          this.onStatus("已断开，稍后重连");
          this.scheduleReconnect();
        }
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket) this.onStatus("中继连接错误");
      });
    } catch {
      this.onStatus("中继地址无效");
    }
  }

  connectNostr() {
    this.transport = "nostr";
    this.onStatus("连接公开中继");
    try {
      this.subscription = this.pool.subscribeMany(
        PUBLIC_RELAYS,
        { kinds: [NOSTR_KIND], "#d": [this.conversationId], "#t": ["bitchat-pwa-v1"], limit: 500 },
        {
          onevent: (event) => {
            try {
              const envelope = JSON.parse(event.content);
              if (envelope?.v === 1 && envelope.conversationId === this.conversationId) {
                this.onStatus("已连接");
                this.onEnvelope(envelope);
              }
            } catch {
              // A public relay can contain unrelated or malformed content.
            }
          },
          oneose: () => this.onStatus("已连接"),
          onclose: () => {
            if (!this.closedByUser) {
              this.onStatus("公开中继已断开，稍后重连");
              this.scheduleReconnect();
            }
          },
        },
      );
    } catch {
      this.onStatus("公开中继不可用");
      this.scheduleReconnect();
    }
  }

  async publish(envelope) {
    if (this.transport === "http") {
      const endpoint = endpointFor(this.url, "/publish");
      endpoint.searchParams.set("conversationId", envelope.conversationId || this.conversationId);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("中继发送失败，请稍后重试");
      return;
    }
    if (this.transport === "nostr") {
      if (!this.identity?.nostrSecretKey) throw new Error("本机公开中继密钥不存在，请重新生成本机身份");
      const event = finalizeEvent(
        {
          kind: NOSTR_KIND,
          created_at: Math.floor(envelope.createdAt / 1000),
          tags: [["d", envelope.conversationId], ["t", "bitchat-pwa-v1"]],
          content: JSON.stringify(envelope),
        },
        base64UrlToBytes(this.identity.nostrSecretKey),
      );
      const attempts = this.pool.publish(PUBLIC_RELAYS, event);
      await firstSuccessful(attempts);
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (!this.url) throw new Error("尚未配置中继服务器");
      this.connect(this.url, this.conversationId);
      const openPromise = this.openPromise;
      if (!openPromise) throw new Error("中继地址无效");
      try {
        await Promise.race([
          openPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("中继连接超时，请稍后重试")), 15000)),
        ]);
      } catch {
        throw new Error("中继连接断开，请稍后重试");
      }
    }
    this.socket.send(JSON.stringify({ type: "publish", envelope }));
  }

  close() {
    this.closedByUser = true;
    this.clearReconnect();
    this.closeCurrentTransport();
    this.onStatus("未连接");
  }

  closeCurrentTransport() {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.socket) this.socket.close();
    this.socket = null;
    this.openPromise = null;
    if (this.subscription) this.subscription.close();
    this.subscription = null;
    this.transport = null;
  }

  scheduleReconnect() {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => this.connect(this.url, this.conversationId), 5000);
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function firstSuccessful(promises) {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    let lastError = new Error("所有公开中继都拒绝了消息");
    if (remaining === 0) {
      reject(lastError);
      return;
    }
    for (const promise of promises) {
      promise.then(resolve).catch((error) => {
        lastError = error;
        remaining -= 1;
        if (remaining === 0) reject(lastError);
      });
    }
  });
}
