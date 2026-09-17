import "./styles.css";
import {
  encodeInvite,
  createNostrSecretKey,
  generateIdentity,
  openEnvelope,
  parseInvite,
  randomId,
  sealEnvelope,
} from "./protocol.js";
import {
  addMessage,
  applyDelete,
  applyPayload,
  contactFor,
  createConversation,
  createState,
  defaultRelayUrl,
  isValidIdentity,
  loadState,
  loadIdentity,
  mergeInvite,
  messagesFor,
  saveState,
} from "./state.js";
import { RelayClient } from "./relay.js";

(async function bootstrap() {
const app = document.querySelector("#app");
const ui = { modal: null, notice: null, inviteCode: null };
let state = loadState();
const rememberedIdentity = loadIdentity();
let relayStatus = "未连接";
let inviteCodeRequest = 0;

function updateViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
}

updateViewportHeight();
window.addEventListener("resize", updateViewportHeight, { passive: true });
window.addEventListener("orientationchange", updateViewportHeight, { passive: true });
window.visualViewport?.addEventListener("resize", updateViewportHeight, { passive: true });
window.visualViewport?.addEventListener("scroll", updateViewportHeight, { passive: true });

if (!isValidIdentity(state?.identity)) {
  if (isValidIdentity(rememberedIdentity)) {
    state = state ? { ...state, identity: rememberedIdentity } : createState(rememberedIdentity);
  } else {
    const identity = await generateIdentity(`设备-${randomId().slice(0, 4)}`);
    state = createState(identity);
  }
  saveState(state);
}
if (!state.identity.nostrSecretKey) {
  state.identity.nostrSecretKey = createNostrSecretKey();
  saveState(state);
}
if (state.relayUrl === "nostr://public" && defaultRelayUrl() !== "nostr://public") {
  state.relayUrl = defaultRelayUrl();
  saveState(state);
}
navigator.storage?.persist?.().catch(() => {});

const relay = new RelayClient({
  identity: state.identity,
  onStatus: (status) => {
    relayStatus = status;
    const node = document.querySelector("[data-relay-status]");
    if (node) node.textContent = status;
  },
  onEnvelope: async (envelope) => {
    if (!state || envelope.senderId === state.identity.id) return;
    const contact = contactFor(state, envelope.conversationId);
    if (!contact?.peer || envelope.generation !== contact.generation) return;
    try {
      const payload = await openEnvelope({ identity: state.identity, peer: contact.peer, envelope });
      const result = applyPayload(
        state,
        envelope.conversationId,
        envelope.generation,
        payload,
        envelope.messageId,
        envelope.senderId,
        envelope.createdAt,
      );
      if (result.changed) {
        saveState(state);
        render();
      }
    } catch {
      // Invalid, stale, or foreign ciphertext is ignored by design.
    }
  },
});

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function showNotice(message, kind = "info") {
  ui.notice = { message, kind };
  render();
  window.setTimeout(() => {
    if (ui.notice?.message === message) {
      ui.notice = null;
      render();
    }
  }, 3500);
}

function activeContact() {
  return contactFor(state, state.activeConversationId);
}

function inviteFor(contact) {
  return encodeInvite({
    identity: state.identity,
    conversationId: contact.conversationId,
    generation: contact.generation,
  });
}

function inviteCodeFor(contact) {
  if (ui.modal?.type === "invite" && ui.modal.contactId === contact.conversationId && ui.inviteCode !== null) {
    return ui.inviteCode;
  }
  if (contact.inviteCode && contact.inviteCodeExpiresAt > Date.now()) return contact.inviteCode;
  return "";
}

function relayApiBase() {
  try {
    if (!state.relayUrl || state.relayUrl === "nostr://public") return null;
    const url = new URL(state.relayUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (!(["http:", "https:"].includes(url.protocol))) return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

async function inviteApi(path, options = {}) {
  const base = relayApiBase();
  if (!base) throw new Error("当前中继不支持数字邀请码，请检查中继地址");
  const response = await fetch(new URL(path, base), {
    ...options,
    cache: "no-store",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "数字邀请码不可用");
  return data;
}

async function ensureInviteCode(contact) {
  if (!contact) return;
  if (contact.inviteCode && contact.inviteCodeExpiresAt > Date.now()) {
    ui.inviteCode = contact.inviteCode;
    return;
  }
  const requestId = ++inviteCodeRequest;
  ui.inviteCode = "生成中…";
  render();
  try {
    const result = await inviteApi("/invite/create", {
      method: "POST",
      body: JSON.stringify({ invite: inviteFor(contact) }),
    });
    if (requestId !== inviteCodeRequest || !contactFor(state, contact.conversationId)) return;
    contact.inviteCode = result.code;
    contact.inviteCodeExpiresAt = result.expiresAt || Date.now() + 10 * 60 * 1000;
    ui.inviteCode = result.code;
    saveState(state);
    render();
  } catch (error) {
    if (requestId !== inviteCodeRequest) return;
    ui.inviteCode = "";
    render();
    showNotice(error.message || "数字邀请码生成失败，请稍后重试", "error");
  }
}

function render() {
  const contact = activeContact();
  const messages = contact ? messagesFor(state, contact.conversationId) : [];
  const displayName = state.identity.nickname || "未命名设备";
  const notice = ui.notice ? `<div class="notice ${ui.notice.kind}">${escapeHtml(ui.notice.message)}</div>` : "";

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-mark">B</div>
        <div class="brand-copy">
          <div class="eyebrow">BITCHAT PWA</div>
          <h1>${contact ? escapeHtml(contact.nickname) : "私聊"}</h1>
        </div>
        <div class="connection-pill" title="中继只转发加密消息">
          <span class="status-dot ${relayStatus === "已连接" ? "online" : ""}"></span>
          <span data-relay-status>${escapeHtml(relayStatus)}</span>
        </div>
      </header>
      ${notice}
      ${contact ? renderChat(contact, messages) : renderHome(displayName)}
      ${ui.modal ? renderModal() : ""}
    </div>`;

  bindEvents();
}

function renderHome(displayName) {
  const contacts = state.contacts.map((contact) => {
    const count = messagesFor(state, contact.conversationId).length;
    const hasPeer = Boolean(contact.peer);
    return `<button class="contact-card" data-contact="${escapeHtml(contact.conversationId)}">
      <span class="avatar">${escapeHtml((contact.nickname || "联").slice(0, 1))}</span>
      <span class="contact-main"><strong>${escapeHtml(contact.nickname)}</strong><small>${hasPeer ? `${count} 条消息` : "等待对方配对"}</small></span>
      <span class="chevron">›</span>
    </button>`;
  }).join("");

  return `<section class="home-view">
    <div class="hero-card">
      <span class="hero-icon">⌁</span>
      <div><h2>只和指定的人聊天</h2><p>不注册账号。双方互相导入一次邀请，就能通过互联网私聊。</p></div>
    </div>
    <div class="identity-card">
      <div><span class="label">固定本机身份</span><strong>${escapeHtml(displayName)}</strong><small>身份密钥保存在本机，除非主动清除网站数据</small></div>
      <span class="identity-id">${escapeHtml(state.identity.id.slice(0, 8))}</span>
    </div>
    <div class="action-grid">
      <button class="primary-button" data-action="new-invite"><span>＋</span> 新建邀请</button>
      <button class="secondary-button" data-action="import-invite"><span>⌁</span> 导入邀请</button>
    </div>
    ${contacts ? `<div class="section-heading"><h3>联系人</h3><span>${state.contacts.length}</span></div><div class="contact-list">${contacts}</div>` : ""}
    <button class="settings-link" data-action="settings">设置中继和本机名称 <span>›</span></button>
    <p class="privacy-note">端到端加密 · 无账号 · 无蓝牙 · 中继看不到正文</p>
  </section>`;
}

function renderChat(contact, messages) {
  const paired = Boolean(contact.peer);
  const messageMarkup = messages.length ? messages.map((message) => {
    const mine = message.senderId === state.identity.id;
    return `<div class="message-row ${mine ? "mine" : "theirs"}"><div class="message-bubble">${escapeHtml(message.body)}<time>${formatTime(message.createdAt)}</time></div></div>`;
  }).join("") : `<div class="empty-chat"><span>✦</span><strong>这是你们的私密空间</strong><p>${paired ? "消息经过加密后才会离开设备。" : "先让对方也导入你的回传邀请。"}</p></div>`;

  return `<section class="chat-view">
    <div class="chat-actions">
      <button class="icon-button" data-action="back" aria-label="返回">‹</button>
      <div class="chat-peer"><span class="avatar small">${escapeHtml((contact.nickname || "联").slice(0, 1))}</span><div><strong>${escapeHtml(contact.nickname)}</strong><small>${paired ? "已保存配对密钥" : "等待双方完成配对"}</small></div></div>
      <button class="more-button" data-action="chat-menu" aria-label="聊天设置">•••</button>
    </div>
    ${!paired ? `<div class="pairing-banner"><strong>还差一步</strong><span>请把本机回传邀请发给对方，再由对方导入。</span><button data-action="show-invite" data-contact="${escapeHtml(contact.conversationId)}">显示我的邀请</button></div>` : ""}
    <div class="messages" aria-live="polite">${messageMarkup}</div>
    <form class="composer" data-form="send">
      <input name="body" autocomplete="off" maxlength="2000" placeholder="${paired ? "写点什么…" : "完成配对后才能发送"}" ${paired ? "" : "disabled"} />
      <button class="send-button" type="submit" ${paired ? "" : "disabled"} aria-label="发送">↑</button>
    </form>
  </section>`;
}

function renderModal() {
  if (ui.modal.type === "invite") {
    const contact = contactFor(state, ui.modal.contactId);
    if (!contact) return "";
    const inviteCode = inviteCodeFor(contact);
    return `<div class="modal-layer" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true" data-modal="invite">
      <button class="modal-close" data-action="close-modal" aria-label="关闭">×</button>
      <div class="modal-kicker">数字配对</div><h2>把 6 位数字发给对方</h2>
      <p class="modal-description">对方在“导入邀请”中输入这 6 位数字即可加入。对方也需要把自己的数字发回给你。</p>
      <div class="invite-code-card"><span>6 位数字邀请码 · 10 分钟有效</span><strong>${escapeHtml(inviteCode || "生成中…")}</strong></div>
      <div class="modal-actions invite-actions"><button class="primary-button wide" data-action="copy-code" ${inviteCode ? "" : "disabled"}>复制数字邀请码</button></div>
      <p class="micro-note">邀请码只短期有效，不是账号，也不会暴露聊天内容。</p>
    </section></div>`;
  }
  if (ui.modal.type === "import") {
    return `<div class="modal-layer" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true" data-modal="import">
      <button class="modal-close" data-action="close-modal" aria-label="关闭">×</button>
      <div class="modal-kicker">加入私聊</div><h2>导入对方邀请</h2>
      <p class="modal-description">输入对方发来的 6 位数字即可加入。</p>
      <div class="code-import-row"><input id="invite-code-input" class="invite-code-input" type="tel" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" maxlength="6" pattern="[0-9]*" aria-label="6 位数字邀请码" placeholder="输入 6 位数字邀请码" /><button class="primary-button" data-action="resolve-code">加入</button></div>
      <p class="micro-note">邀请码 10 分钟内有效。配对完成后，请把你的数字邀请码发回对方。</p>
    </section></div>`;
  }
  return `<div class="modal-layer" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true" data-modal="settings">
    <button class="modal-close" data-action="close-modal" aria-label="关闭">×</button>
    <div class="modal-kicker">本机设置</div><h2>设置</h2>
    <form data-form="settings"><label>本机名称<input name="nickname" maxlength="32" value="${escapeHtml(state.identity.nickname || "")}" placeholder="例如：我的 iPhone" /></label><label>中继地址<input name="relayUrl" value="${escapeHtml(state.relayUrl || "")}" placeholder="https://你的中继域名 或 wss://你的域名/ws" /></label><p class="micro-note">默认使用项目专用的 HTTPS 中继；也可以改成自己的 HTTPS/WSS 中继。本地开发可用 ws://localhost:8787/ws。</p><button class="primary-button" type="submit">保存设置</button></form>
  </section></div>`;
}

function bindEvents() {
  document.querySelectorAll("[data-contact]").forEach((node) => {
    node.addEventListener("click", () => {
      state.activeConversationId = node.dataset.contact;
      ui.modal = null;
      saveState(state);
      render();
      connectActive();
    });
  });
  document.querySelectorAll("[data-action='close-modal']").forEach((node) => node.addEventListener("click", (event) => {
    if (event.target === node || event.currentTarget === node) closeModal();
  }));
  document.querySelectorAll("[data-action='back']").forEach((node) => node.addEventListener("click", () => {
    state.activeConversationId = null;
    saveState(state);
    relay.close();
    relayStatus = "未连接";
    render();
  }));
  document.querySelectorAll("[data-action='new-invite']").forEach((node) => node.addEventListener("click", newInvite));
  document.querySelectorAll("[data-action='import-invite']").forEach((node) => node.addEventListener("click", () => {
    ui.modal = { type: "import" };
    render();
    const input = document.querySelector("#invite-code-input");
    input?.focus({ preventScroll: true });
  }));
  document.querySelectorAll("[data-action='settings']").forEach((node) => node.addEventListener("click", () => { ui.modal = { type: "settings" }; render(); }));
  document.querySelectorAll("[data-action='show-invite']").forEach((node) => node.addEventListener("click", () => {
    ui.modal = { type: "invite", contactId: node.dataset.contact };
    ui.inviteCode = null;
    render();
    ensureInviteCode(contactFor(state, node.dataset.contact));
  }));
  document.querySelectorAll("[data-action='chat-menu']").forEach((node) => node.addEventListener("click", confirmDeleteBoth));
  document.querySelectorAll("[data-action='copy-code']").forEach((node) => node.addEventListener("click", copyInviteCode));
  document.querySelectorAll("[data-action='resolve-code']").forEach((node) => node.addEventListener("click", importInviteByCode));
  document.querySelectorAll("#invite-code-input").forEach((node) => {
    node.addEventListener("input", () => {
      node.value = node.value.replace(/\D/g, "").slice(0, 6);
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        importInviteByCode();
      }
    });
  });
  document.querySelectorAll("[data-form='send']").forEach((form) => form.addEventListener("submit", sendMessage));
  document.querySelectorAll("[data-form='settings']").forEach((form) => form.addEventListener("submit", saveSettings));
}

function closeModal() {
  ui.modal = null;
  ui.inviteCode = null;
  render();
}

function newInvite() {
  const contact = createConversation(state.identity);
  state.contacts.push(contact);
  state.activeConversationId = contact.conversationId;
  saveState(state);
  ui.modal = { type: "invite", contactId: contact.conversationId };
  ui.inviteCode = null;
  render();
  ensureInviteCode(contact);
}

async function copyInviteCode() {
  const contact = contactFor(state, ui.modal?.contactId);
  const code = contact ? inviteCodeFor(contact) : "";
  if (!code || code === "生成中…") {
    showNotice("数字邀请码还在生成，请稍候", "error");
    return;
  }
  try {
    await copyText(code);
    showNotice("数字邀请码已复制");
  } catch {
    showNotice("复制失败，请记下这 6 位数字", "error");
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for HTTP development servers and older Safari versions.
    }
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("copy unavailable");
}

async function importInviteByCode() {
  const input = document.querySelector("#invite-code-input");
  const code = (input?.value || "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(code)) {
    showNotice("请输入完整的 6 位数字邀请码", "error");
    return;
  }
  try {
    const result = await inviteApi(`/invite/resolve?code=${encodeURIComponent(code)}`);
    completeImport(parseInvite(result.invite));
  } catch (error) {
    showNotice(error.message || "数字邀请码无效或已过期", "error");
  }
}

function completeImport(invite) {
    if (invite.peer.id === state.identity.id) throw new Error("不能导入自己生成的邀请");
    const contact = mergeInvite(state, invite);
    saveState(state);
    closeModal();
    showNotice(`已加入与“${contact.nickname}”的私聊，请把本机邀请回传给对方`);
    connectActive();
}

async function sendMessage(event) {
  event.preventDefault();
  const contact = activeContact();
  const input = event.currentTarget.elements.body;
  const body = input.value.trim();
  if (!body || !contact?.peer) return;
  try {
    const envelope = await sealEnvelope({
      identity: state.identity,
      peer: contact.peer,
      conversationId: contact.conversationId,
      generation: contact.generation,
      payload: { type: "message", body },
    });
    await relay.publish(envelope);
    addMessage(state, contact.conversationId, { messageId: envelope.messageId, senderId: state.identity.id, body, createdAt: envelope.createdAt });
    saveState(state);
    render();
  } catch (error) {
    showNotice(error.message || "发送失败，请检查中继连接", "error");
  }
}

async function confirmDeleteBoth() {
  const contact = activeContact();
  if (!contact?.peer) {
    showNotice("完成配对后才能同步删除双方记录", "error");
    return;
  }
  const confirmed = window.confirm("删除双方聊天记录？\n\n这会清空双方客户端里的本地记录，并开始新的聊天代次。截图、复制内容和系统通知无法删除。此操作不可恢复。");
  if (!confirmed) return;
  try {
    const deleteId = randomId();
    const newGeneration = randomId();
    const envelope = await sealEnvelope({
      identity: state.identity,
      peer: contact.peer,
      conversationId: contact.conversationId,
      generation: contact.generation,
      payload: { type: "conversation.delete", deleteId, newGeneration },
    });
    await relay.publish(envelope);
    applyDelete(state, contact.conversationId, newGeneration, deleteId);
    saveState(state);
    render();
    showNotice("已发送删除指令，双方客户端收到后会清空记录");
  } catch (error) {
    showNotice(error.message || "删除指令发送失败", "error");
  }
}

function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const nickname = form.elements.nickname.value.trim();
  const relayUrl = form.elements.relayUrl.value.trim();
  if (!nickname) {
    showNotice("请填写本机名称", "error");
    return;
  }
  state.identity.nickname = nickname;
  state.relayUrl = relayUrl;
  saveState(state);
  closeModal();
  connectActive();
  showNotice("设置已保存");
}

function connectActive() {
  const contact = activeContact();
  relay.close();
  if (!contact?.peer) {
    relayStatus = contact ? "等待配对" : "未连接";
    const node = document.querySelector("[data-relay-status]");
    if (node) node.textContent = relayStatus;
    return;
  }
  relay.connect(state.relayUrl, contact.conversationId);
}

render();
connectActive();
if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
})();
