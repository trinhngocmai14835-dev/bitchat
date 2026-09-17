import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8787);
const maxRoomMessages = 500;
const maxEnvelopeBytes = 64 * 1024;
const rooms = new Map();

function validConversationId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function validEnvelope(envelope) {
  return envelope && envelope.v === 1
    && validConversationId(envelope.conversationId)
    && typeof envelope.generation === "string"
    && typeof envelope.senderId === "string"
    && typeof envelope.messageId === "string"
    && typeof envelope.ciphertext === "string"
    && typeof envelope.signature === "string";
}

function roomFor(id) {
  if (!rooms.has(id)) rooms.set(id, { clients: new Set(), envelopes: [] });
  return rooms.get(id);
}

function removeSocket(socket, roomId) {
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.clients.delete(socket);
  if (room.clients.size === 0 && room.envelopes.length === 0) rooms.delete(roomId);
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("BitChat relay: use WebSocket /ws");
});

const websocketServer = new WebSocketServer({ server, path: "/ws", maxPayload: maxEnvelopeBytes });

websocketServer.on("connection", (socket) => {
  let roomId = null;
  let publishedInWindow = 0;
  let rateWindowStarted = Date.now();

  socket.on("message", (raw) => {
    if (raw.length > maxEnvelopeBytes) {
      socket.close(1009, "packet too large");
      return;
    }
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "invalid json" }));
      return;
    }

    if (packet.type === "hello") {
      if (!validConversationId(packet.conversationId)) {
        socket.close(1008, "invalid conversation");
        return;
      }
      removeSocket(socket, roomId);
      roomId = packet.conversationId;
      const room = roomFor(roomId);
      room.clients.add(socket);
      socket.send(JSON.stringify({ type: "sync", envelopes: room.envelopes }));
      return;
    }

    if (packet.type === "publish") {
      if (!roomId || !validEnvelope(packet.envelope) || packet.envelope.conversationId !== roomId) {
        socket.send(JSON.stringify({ type: "error", message: "invalid envelope" }));
        return;
      }
      const now = Date.now();
      if (now - rateWindowStarted > 60_000) {
        rateWindowStarted = now;
        publishedInWindow = 0;
      }
      publishedInWindow += 1;
      if (publishedInWindow > 120) {
        socket.close(1008, "rate limit");
        return;
      }

      const room = roomFor(roomId);
      if (room.envelopes.some((entry) => entry.messageId === packet.envelope.messageId)) return;
      room.envelopes.push(packet.envelope);
      while (room.envelopes.length > maxRoomMessages) room.envelopes.shift();
      for (const client of room.clients) {
        if (client !== socket && client.readyState === 1) {
          client.send(JSON.stringify({ type: "envelope", envelope: packet.envelope }));
        }
      }
    }
  });

  socket.on("close", () => removeSocket(socket, roomId));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`BitChat relay listening on ws://localhost:${port}/ws`);
});
