import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const { generateIdentity, openEnvelope, sealEnvelope } = await import("../src/protocol.js");
const { addMessage, applyDelete, applyPayload } = await import("../src/state.js");

function contactFor(identity, peer, conversationId, generation) {
  return { conversationId, generation, nickname: "测试联系人", peer, ownId: identity.id };
}

test("两端可以用配对密钥加密并验证私聊消息", async () => {
  const alice = await generateIdentity("Alice");
  const bob = await generateIdentity("Bob");
  const conversationId = "conversation-test-1";
  const generation = "generation-test-1";
  const envelope = await sealEnvelope({
    identity: alice,
    peer: { id: bob.id, exchangePublicJwk: bob.exchangePublicJwk, signingPublicJwk: bob.signingPublicJwk },
    conversationId,
    generation,
    payload: { type: "message", body: "你好，Bob" },
  });
  const payload = await openEnvelope({
    identity: bob,
    peer: { id: alice.id, exchangePublicJwk: alice.exchangePublicJwk, signingPublicJwk: alice.signingPublicJwk },
    envelope,
  });
  assert.deepEqual(payload, { type: "message", body: "你好，Bob" });

  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` };
  await assert.rejects(() => openEnvelope({
    identity: bob,
    peer: { id: alice.id, exchangePublicJwk: alice.exchangePublicJwk, signingPublicJwk: alice.signingPublicJwk },
    envelope: tampered,
  }));
});

test("双方收到删除指令后都会清空本地记录并进入新代次", () => {
  const conversationId = "conversation-test-2";
  const oldGeneration = "generation-old";
  const newGeneration = "generation-new";
  const alice = { id: "alice" };
  const bob = { id: "bob" };
  const aliceState = { identity: alice, contacts: [contactFor(alice, bob, conversationId, oldGeneration)], messagesByConversation: {} };
  const bobState = { identity: bob, contacts: [contactFor(bob, alice, conversationId, oldGeneration)], messagesByConversation: {} };
  addMessage(aliceState, conversationId, { messageId: "a1", senderId: "alice", body: "旧消息", createdAt: 1 });
  addMessage(bobState, conversationId, { messageId: "b1", senderId: "bob", body: "旧消息", createdAt: 1 });
  const deletePayload = { type: "conversation.delete", deleteId: "delete-1", newGeneration };
  applyPayload(aliceState, conversationId, oldGeneration, deletePayload, "delete-1", "alice", 2);
  applyPayload(bobState, conversationId, oldGeneration, deletePayload, "delete-1", "alice", 2);
  assert.deepEqual(aliceState.messagesByConversation[conversationId], []);
  assert.deepEqual(bobState.messagesByConversation[conversationId], []);
  assert.equal(aliceState.contacts[0].generation, newGeneration);
  assert.equal(bobState.contacts[0].generation, newGeneration);
  assert.equal(applyDelete(bobState, conversationId, "generation-next", "delete-2"), true);
});
