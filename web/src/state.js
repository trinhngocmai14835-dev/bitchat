import { randomId } from "./protocol.js";

export const STORAGE_KEY = "bitchat-pwa-state-v1";
export const IDENTITY_STORAGE_KEY = "bitchat-pwa-identity-v1";
export const PRODUCTION_RELAY_URL = "https://bitchat-private-relay.soft-api-7mskfl.workers.dev";

export function isValidIdentity(identity) {
  return Boolean(identity?.id
    && identity.exchangePrivateJwk
    && identity.exchangePublicJwk
    && identity.signingPrivateJwk
    && identity.signingPublicJwk);
}

export function defaultRelayUrl() {
  if (typeof location === "undefined") return "ws://localhost:8787/ws";
  if (["localhost", "127.0.0.1", "::1"].includes(location.hostname)) return "ws://localhost:8787/ws";
  return PRODUCTION_RELAY_URL;
}

export function createState(identity) {
  return {
    identity,
    contacts: [],
    messagesByConversation: {},
    activeConversationId: null,
    relayUrl: defaultRelayUrl(),
  };
}

export function loadState() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadIdentity() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(IDENTITY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveState(state) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (isValidIdentity(state?.identity)) localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(state.identity));
}

export function createConversation(identity) {
  return {
    conversationId: randomId(),
    generation: randomId(),
    nickname: "待配对联系人",
    peer: null,
    createdAt: Date.now(),
    ownInviteShown: true,
    ownId: identity.id,
  };
}

export function contactFor(state, conversationId) {
  return state.contacts.find((contact) => contact.conversationId === conversationId) || null;
}

export function messagesFor(state, conversationId) {
  return state.messagesByConversation[conversationId] || [];
}

export function addMessage(state, conversationId, message) {
  const messages = state.messagesByConversation[conversationId] || [];
  if (messages.some((item) => item.messageId === message.messageId)) return false;
  messages.push(message);
  messages.sort((left, right) => left.createdAt - right.createdAt);
  state.messagesByConversation[conversationId] = messages.slice(-1000);
  return true;
}

export function mergeInvite(state, invite) {
  let contact = contactFor(state, invite.conversationId);
  if (!contact) {
    contact = {
      conversationId: invite.conversationId,
      generation: invite.generation,
      nickname: invite.peer.nickname || "联系人",
      peer: invite.peer,
      createdAt: Date.now(),
      ownId: state.identity.id,
    };
    state.contacts.push(contact);
  } else {
    if (contact.generation !== invite.generation) {
      throw new Error("这个邀请属于同一会话，但聊天记录代次不同；请使用最新邀请");
    }
    if (invite.peer.id !== state.identity.id) {
      contact.peer = invite.peer;
      contact.nickname = invite.peer.nickname || contact.nickname;
    }
  }
  state.activeConversationId = contact.conversationId;
  return contact;
}

export function applyDelete(state, conversationId, newGeneration, deleteId) {
  const contact = contactFor(state, conversationId);
  if (!contact) return false;
  state.messagesByConversation[conversationId] = [];
  contact.generation = newGeneration;
  contact.lastDeleteId = deleteId;
  return true;
}

export function applyPayload(state, conversationId, envelopeGeneration, payload, messageId, senderId, createdAt) {
  const contact = contactFor(state, conversationId);
  if (!contact || contact.generation !== envelopeGeneration) return { changed: false, ignored: true };
  if (payload?.type === "message" && typeof payload.body === "string") {
    return {
      changed: addMessage(state, conversationId, {
        messageId,
        senderId,
        body: payload.body,
        createdAt,
      }),
      ignored: false,
    };
  }
  if (payload?.type === "conversation.delete" && payload.newGeneration && payload.deleteId) {
    return {
      changed: applyDelete(state, conversationId, payload.newGeneration, payload.deleteId),
      ignored: false,
    };
  }
  return { changed: false, ignored: true };
}
