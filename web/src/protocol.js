const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" };
const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" };

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function jsonToBase64Url(value) {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

export function base64UrlToJson(value) {
  return JSON.parse(textDecoder.decode(base64UrlToBytes(value)));
}

export function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64Url(bytes);
}

export function createNostrSecretKey() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exportKey(key) {
  return crypto.subtle.exportKey("jwk", key);
}

async function importEcdhPublic(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDH_PARAMS, true, []);
}

async function importEcdhPrivate(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDH_PARAMS, true, ["deriveBits"]);
}

async function importSigningPublic(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDSA_PARAMS, true, ["verify"]);
}

async function importSigningPrivate(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDSA_PARAMS, true, ["sign"]);
}

export async function generateIdentity(nickname = "") {
  const exchange = await crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"]);
  const exchangePublicJwk = await exportKey(exchange.publicKey);
  const signingPublicJwk = await exportKey(signing.publicKey);
  const publicMaterial = stableStringify({ exchangePublicJwk, signingPublicJwk });
  const id = (await sha256Hex(publicMaterial)).slice(0, 24);

  return {
    id,
    nickname: nickname.trim(),
    exchangePrivateJwk: await exportKey(exchange.privateKey),
    exchangePublicJwk,
    signingPrivateJwk: await exportKey(signing.privateKey),
    signingPublicJwk,
    nostrSecretKey: createNostrSecretKey(),
    createdAt: Date.now(),
  };
}

export function publicIdentity(identity) {
  return {
    id: identity.id,
    nickname: identity.nickname || "未命名设备",
    exchangePublicJwk: identity.exchangePublicJwk,
    signingPublicJwk: identity.signingPublicJwk,
  };
}

export function encodeInvite({ identity, conversationId, generation }) {
  const payload = {
    protocol: "bitchat-pwa",
    version: 1,
    conversationId,
    generation,
    peer: publicIdentity(identity),
    createdAt: Date.now(),
  };
  return `bitchat-pwa:v1:${jsonToBase64Url(payload)}`;
}

export function parseInvite(rawText) {
  const value = rawText.trim();
  const prefix = "bitchat-pwa:v1:";
  if (!value.startsWith(prefix)) throw new Error("邀请文本格式不正确");
  const invite = base64UrlToJson(value.slice(prefix.length));
  if (invite.protocol !== "bitchat-pwa" || invite.version !== 1) throw new Error("不支持的邀请版本");
  if (!invite.conversationId || !invite.generation || !invite.peer?.id) throw new Error("邀请缺少必要信息");
  return invite;
}

async function deriveConversationKey({ identity, peer, conversationId, generation }) {
  const privateKey = await importEcdhPrivate(identity.exchangePrivateJwk);
  const publicKey = await importEcdhPublic(peer.exchangePublicJwk);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const salt = textEncoder.encode(`${conversationId}:${generation}`);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: textEncoder.encode("bitchat-pwa-v1") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function envelopeHeader(envelope) {
  return {
    conversationId: envelope.conversationId,
    createdAt: envelope.createdAt,
    generation: envelope.generation,
    messageId: envelope.messageId,
    senderId: envelope.senderId,
    v: envelope.v,
    ...(envelope.sender ? { sender: envelope.sender } : {}),
  };
}

function unsignedEnvelope(envelope) {
  return {
    ...envelopeHeader(envelope),
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
  };
}

export async function sealEnvelope({ identity, peer, conversationId, generation, payload }) {
  const key = await deriveConversationKey({ identity, peer, conversationId, generation });
  const envelope = {
    v: 1,
    conversationId,
    generation,
    senderId: identity.id,
    sender: publicIdentity(identity),
    messageId: randomId(),
    createdAt: Date.now(),
    iv: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12))),
  };
  const additionalData = textEncoder.encode(stableStringify(envelopeHeader(envelope)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), additionalData },
    key,
    textEncoder.encode(JSON.stringify(payload)),
  );
  envelope.ciphertext = bytesToBase64Url(new Uint8Array(ciphertext));
  const signingKey = await importSigningPrivate(identity.signingPrivateJwk);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    textEncoder.encode(stableStringify(unsignedEnvelope(envelope))),
  );
  envelope.signature = bytesToBase64Url(new Uint8Array(signature));
  return envelope;
}

export async function openEnvelope({ identity, peer, envelope }) {
  if (envelope?.v !== 1 || envelope.conversationId == null || envelope.generation == null) {
    throw new Error("无效消息包");
  }
  if (envelope.senderId !== peer.id) throw new Error("消息发送者不是已配对联系人");
  const publicKey = await importSigningPublic(peer.signingPublicJwk);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64UrlToBytes(envelope.signature),
    textEncoder.encode(stableStringify(unsignedEnvelope(envelope))),
  );
  if (!valid) throw new Error("消息签名校验失败");

  const key = await deriveConversationKey({
    identity,
    peer,
    conversationId: envelope.conversationId,
    generation: envelope.generation,
  });
  const header = envelopeHeader(envelope);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), additionalData: textEncoder.encode(stableStringify(header)) },
    key,
    base64UrlToBytes(envelope.ciphertext),
  );
  return JSON.parse(textDecoder.decode(plaintext));
}
