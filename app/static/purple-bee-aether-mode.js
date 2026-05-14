(function () {
  "use strict";

  const AETHER_HISTORY_KEY = "pb_aether_history_v2";
  const AETHER_SESSION_KEY = "pb_aether_session_v2";
  const AI_AVATAR = `<svg width="32" height="32" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="pb-av-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#db2777"/></linearGradient><linearGradient id="pb-av-wing" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c4b5fd" stop-opacity=".9"/><stop offset="100%" stop-color="#818cf8" stop-opacity=".6"/></linearGradient></defs><circle cx="40" cy="40" r="38" fill="url(#pb-av-bg)"/><ellipse cx="24" cy="30" rx="14" ry="7" fill="url(#pb-av-wing)" transform="rotate(-25 24 30)"/><ellipse cx="56" cy="30" rx="14" ry="7" fill="url(#pb-av-wing)" transform="rotate(25 56 30)"/><ellipse cx="40" cy="46" rx="14" ry="16" fill="#f5d76e"/><rect x="31" y="39" width="18" height="4" rx="2" fill="#4c1d95" opacity=".55"/><rect x="31" y="47" width="18" height="4" rx="2" fill="#4c1d95" opacity=".55"/><circle cx="35" cy="34" r="2.2" fill="#1a1a2e"/><circle cx="45" cy="34" r="2.2" fill="#1a1a2e"/></svg>`;

  let streaming = false;
  let firstPrompt = true;
  const sessionId = localStorage.getItem(AETHER_SESSION_KEY) || `aether_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(AETHER_SESSION_KEY, sessionId);

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderMarkdown(text) {
    try {
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(text || ""));
      }
    } catch (_) {}
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function scrollBottom() {
    const area = byId("chat-area");
    if (area) area.scrollTop = area.scrollHeight;
  }

  function ensureChatVisible() {
    const home = byId("home");
    const messages = byId("messages");
    if (home) home.style.display = "none";
    if (messages) messages.style.display = "flex";
  }

  function messageRoot() {
    let messages = byId("messages");
    if (messages) return messages;
    const area = byId("chat-area") || document.body;
    messages = document.createElement("div");
    messages.id = "messages";
    area.appendChild(messages);
    return messages;
  }

  function appendMessage(role, content) {
    ensureChatVisible();
    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;

    const avatar = document.createElement("div");
    avatar.className = `avatar ${role}`;
    avatar.innerHTML = role === "ai" ? AI_AVATAR : '<i class="ph ph-user" style="font-size:16px;color:white"></i>';
    if (role === "ai") avatar.style.background = "none";

    const column = document.createElement("div");
    column.className = "message-column";

    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    bubble.innerHTML = role === "ai" ? renderMarkdown(content) : escapeHtml(content).replace(/\n/g, "<br>");
    column.appendChild(bubble);

    if (role === "ai") {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.innerHTML = `<button class="msg-action-btn" type="button" onclick="copyText && copyText(this)"><i class="ph ph-copy"></i> 복사</button><button class="msg-action-btn" type="button" onclick="reportMessage && reportMessage(this)"><i class="ph ph-flag"></i> 신고</button>`;
      column.appendChild(actions);
    }

    wrapper.appendChild(avatar);
    wrapper.appendChild(column);
    messageRoot().appendChild(wrapper);
    scrollBottom();
    return bubble;
  }

  function appendThinking() {
    ensureChatVisible();
    const wrapper = document.createElement("div");
    wrapper.className = "message ai";
    wrapper.dataset.aetherThinking = "true";
    wrapper.innerHTML = `<div class="avatar ai" style="background:none">${AI_AVATAR}</div><div class="message-column"><div class="bubble ai"><div class="thinking-status"><strong>생각 중...</strong> <span data-aether-seconds>1s</span></div><div class="typing-dots"><span></span><span></span><span></span></div><div class="thinking-status" data-aether-first-note style="display:none">첫 응답은 연결을 준비하느라 평소보다 조금 느릴 수 있어요.</div></div></div>`;
    messageRoot().appendChild(wrapper);

    const started = Date.now();
    if (firstPrompt) {
      const note = wrapper.querySelector("[data-aether-first-note]");
      if (note) note.style.display = "block";
    }
    const timer = setInterval(() => {
      const node = wrapper.querySelector("[data-aether-seconds]");
      if (node) node.textContent = `${Math.max(1, Math.floor((Date.now() - started) / 1000))}s`;
    }, 250);
    scrollBottom();
    return { wrapper, timer };
  }

  function getHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(AETHER_HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.slice(-12) : [];
    } catch (_) {
      return [];
    }
  }

  function saveTurn(user, assistant) {
    const history = getHistory();
    history.push({ role: "user", content: user });
    history.push({ role: "assistant", content: assistant });
    localStorage.setItem(AETHER_HISTORY_KEY, JSON.stringify(history.slice(-24)));
  }

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label || "timeout")), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function streamReply(prompt, onChunk) {
    const response = await withTimeout(fetch("/api/pbx_chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: prompt,
        history: getHistory(),
        session_id: sessionId,
        mode: "aether-nexus",
      }),
    }), 30000, "stream-timeout");

    if (!response.ok || !response.body) {
      throw new Error(`chat-${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payloadText = line.slice(5).trim();
        if (!payloadText) continue;
        try {
          const event = JSON.parse(payloadText);
          if (event.chunk) {
            full += event.chunk;
            onChunk(event.chunk, full);
          }
          if (event.done) {
            return String(event.full || full || "").trim();
          }
        } catch (_) {}
      }
    }
    return full.trim();
  }

  async function syncReply(prompt) {
    const response = await withTimeout(fetch("/api/pbx_chat_sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: prompt,
        history: getHistory(),
        session_id: sessionId,
        mode: "aether-nexus",
      }),
    }), 30000, "sync-timeout");
    if (!response.ok) throw new Error(`sync-${response.status}`);
    const payload = await response.json();
    return String(payload.reply || "").trim();
  }

  async function sendAetherMessage(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    }
    if (streaming) return false;

    const field = byId("input-field");
    if (!field) return false;
    const prompt = String(field.value || "").trim();
    if (!prompt) return false;

    streaming = true;
    field.value = "";
    field.style.height = "auto";
    const sendBtn = byId("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    appendMessage("user", prompt);
    const thinking = appendThinking();

    let bubble = null;
    let full = "";
    try {
      try {
        full = await streamReply(prompt, (_chunk, text) => {
          if (!bubble) {
            clearInterval(thinking.timer);
            thinking.wrapper.remove();
            bubble = appendMessage("ai", "");
          }
          bubble.innerHTML = renderMarkdown(text);
          scrollBottom();
        });
      } catch (streamError) {
        console.warn("[Purple Bee][Aether] stream deferred", streamError);
        full = await syncReply(prompt);
      }

      if (!full) full = await syncReply(prompt);
      if (!bubble) {
        clearInterval(thinking.timer);
        thinking.wrapper.remove();
        bubble = appendMessage("ai", "");
      }
      bubble.innerHTML = renderMarkdown(full || "답변을 만들지 못했어요. 같은 뜻으로 한 번만 다시 보내주세요.");
      if (full) saveTurn(prompt, full);
      firstPrompt = false;
    } catch (error) {
      clearInterval(thinking.timer);
      thinking.wrapper.remove();
      appendMessage("ai", `답변 경로에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요. 오류: ${escapeHtml(error.message || "unknown")}`);
    } finally {
      streaming = false;
      if (sendBtn) sendBtn.disabled = false;
      scrollBottom();
    }
    return false;
  }

  function applyAetherModeUi() {
    if (!document.getElementById("pb-aether-mode-style")) {
      const style = document.createElement("style");
      style.id = "pb-aether-mode-style";
      style.textContent = `
        #upgrade-plan-btn,#contributor-card,#ai-assets-btn{display:none!important}
        #model-version-list,#model-version-sep-top,#model-version-sep-bottom,.think-row{display:none!important}
        #top-model-selector{pointer-events:none}
      `;
      document.head.appendChild(style);
    }

    const logoSub = byId("logo-subtitle");
    const engine = byId("engine-label");
    const currentModel = byId("current-model-name");
    const modelSub = byId("model-menu-subtitle");
    const homeSub = byId("home-subtitle");
    if (logoSub) logoSub.textContent = "Aether-Nexus 기반";
    if (engine) engine.textContent = "Aether-Nexus";
    if (currentModel) currentModel.textContent = "Purple Bee 1.0";
    if (modelSub) modelSub.textContent = "준비물 설치 없이 공개 웹사이트에서 바로 대화합니다.";
    if (homeSub) homeSub.textContent = "보고 있는 문제부터 같이 풀어봐도 좋아요.";
  }

  document.addEventListener("click", (event) => {
    if (event.target && event.target.closest && event.target.closest("#send-btn")) {
      sendAetherMessage(event);
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    const field = byId("input-field");
    if (event.target === field && event.key === "Enter" && !event.shiftKey) {
      sendAetherMessage(event);
    }
  }, true);

  document.addEventListener("DOMContentLoaded", applyAetherModeUi);
  if (document.readyState !== "loading") applyAetherModeUi();

  window.sendMessage = sendAetherMessage;
  window.linkAiAssetsFolder = function () {
    alert("현재 Purple Bee는 준비물 설치 없이 바로 대화할 수 있는 Aether-Nexus 모드로 동작합니다.");
  };
  window.openUpgradePage = function (event) {
    if (event) event.preventDefault();
    alert("현재 Purple Bee는 무료 Aether-Nexus 모드로 제공됩니다.");
  };
  window.openContributorHub = function () {
    alert("기여 구독 기능은 Aether-Nexus 전환 단계에서 비활성화되어 있습니다.");
  };
})();
