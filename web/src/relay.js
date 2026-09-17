export class RelayClient {
  constructor({ onEnvelope, onStatus }) {
    this.onEnvelope = onEnvelope;
    this.onStatus = onStatus;
    this.socket = null;
    this.url = "";
    this.conversationId = "";
    this.reconnectTimer = null;
    this.closedByUser = false;
  }

  connect(url, conversationId) {
    this.url = url.trim();
    this.conversationId = conversationId;
    this.closedByUser = false;
    this.clearReconnect();
    if (!this.url) {
      this.onStatus("未配置中继");
      return;
    }
    if (this.socket) this.socket.close();
    this.onStatus("连接中");
    try {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener("open", () => {
        this.onStatus("已连接");
        this.socket.send(JSON.stringify({ type: "hello", conversationId: this.conversationId }));
      });
      this.socket.addEventListener("message", (event) => {
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
      this.socket.addEventListener("close", () => {
        this.socket = null;
        if (!this.closedByUser) {
          this.onStatus("已断开，稍后重连");
          this.reconnectTimer = setTimeout(() => this.connect(this.url, this.conversationId), 3000);
        }
      });
      this.socket.addEventListener("error", () => this.onStatus("中继连接错误"));
    } catch {
      this.onStatus("中继地址无效");
    }
  }

  publish(envelope) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("尚未连接中继服务器");
    }
    this.socket.send(JSON.stringify({ type: "publish", envelope }));
  }

  close() {
    this.closedByUser = true;
    this.clearReconnect();
    if (this.socket) this.socket.close();
    this.socket = null;
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
