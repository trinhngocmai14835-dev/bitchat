import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { RelayClient } = await import("../src/relay.js");

test("HTTP 中继会轮询所有联系人并为每次轮询绕过旧缓存", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(new URL(request.url, "http://127.0.0.1").searchParams);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ envelopes: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const statuses = [];
  const relay = new RelayClient({
    identity: {},
    onEnvelope: () => {},
    onStatus: (status) => statuses.push(status),
  });

  relay.connect(`http://127.0.0.1:${port}/relay`, ["conversation-a", "conversation-b"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  relay.close();
  await new Promise((resolve) => server.close(resolve));

  assert.equal(statuses.includes("已连接"), true);
  assert.deepEqual(
    requests.map((params) => params.get("conversationId")).sort(),
    ["conversation-a", "conversation-b"],
  );
  assert.equal(requests.every((params) => /^\d+$/.test(params.get("_") || "")), true);
});
