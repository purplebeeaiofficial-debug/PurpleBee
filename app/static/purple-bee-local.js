(function () {
  "use strict";

  const {
    PurpleBeeModel,
    lower,
    trim,
    normalizeWhitespace,
    containsAny,
    unique,
    shorten,
    ensureSentenceEnding,
    detectLanguage,
    resolveReplyLanguage,
    resolveReplyStyle,
    tokenizeMeaningful,
    detectMode,
    looksFollowUp,
    buildEffectiveQuery,
    collectEvidence,
    composeFromEvidence,
    buildSourcesLine,
    formatCapabilityResponse,
    formatImageLimitResponse,
    pickRepresentativeSentences,
    looksNatural,
    lastAssistantText,
    lastAssistantMeta,
    dedupeDocuments,
  } = window.PurpleBeeCore;

  const STORAGE_KEY = "pb_conversations_v2";
  const SETTINGS_KEY = "pb_settings_v1";
  const REPORTS_KEY = "pb_reports_v1";
  const CONSENT_KEY = "pb_required_consents_v1";
  const MAX_CONVERSATIONS = 20;
  const STORAGE_TEXT_LIMIT = 6000;
  const MODEL_URL = "/static/purple-bee-model.bin";
  const BROWSER_MANIFEST_URL = "/api/runtime/browser-manifest";
  const RUNTIME_MODEL_KEY = "pb_runtime_model_id_v1";
  const INSTALL_MODEL_KEY = "pb_install_model_id_v1";
  const MODEL_REGISTRY_URL = "/static/model-registry.json?v=20260405n";
  const DIALOGUE_BANK_URL = "/static/purple-bee-dialogues.txt";
  const TEXT_EXTENSIONS = new Set(["txt","md","markdown","json","csv","ts","tsx","js","jsx","mjs","py","java","cpp","cc","cxx","c","cs","go","rs","php","rb","html","htm","css","scss","xml","yml","yaml","ini","toml","log","sql","sh","ps1","bat","cmake"]);
  const CODE_EXTENSIONS = new Set(["ts","tsx","js","jsx","mjs","py","java","cpp","cc","cxx","c","cs","go","rs","php","rb","html","css","scss","xml","yml","yaml","ini","toml","sql","sh","ps1","bat"]);
  const DEFAULT_SETTINGS = {
    uiLanguage: "auto",
    replyLanguage: "auto",
    replyStyle: "adaptive",
    typingSpeed: "normal",
    rememberChats: true,
  };
  const DEVICE_CACHE = new Map();
  const MODEL_INSTALL_PRESETS = {
    "purple-bee-1-3": {
      download_bytes: 445315993,
      minimum: {
        memory_gb: 8,
        cpu_threads: 6,
        free_storage_mb: 1600,
      },
      recommended: {
        memory_gb: 16,
        cpu_threads: 10,
        free_storage_mb: 2800,
      },
    },
  };

  const AI_AVATAR_SVG = `<svg width="32" height="32" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="av-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#db2777"/></linearGradient><linearGradient id="av-wing" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c4b5fd" stop-opacity=".9"/><stop offset="100%" stop-color="#818cf8" stop-opacity=".6"/></linearGradient></defs><circle cx="40" cy="40" r="38" fill="url(#av-bg)"/><ellipse cx="24" cy="30" rx="14" ry="7" fill="url(#av-wing)" transform="rotate(-25 24 30)"/><ellipse cx="56" cy="30" rx="14" ry="7" fill="url(#av-wing)" transform="rotate(25 56 30)"/><ellipse cx="40" cy="46" rx="14" ry="16" fill="#f5d76e"/><rect x="31" y="39" width="18" height="4" rx="2" fill="#4c1d95" opacity=".55"/><rect x="31" y="47" width="18" height="4" rx="2" fill="#4c1d95" opacity=".55"/><circle cx="35" cy="34" r="2.2" fill="#1a1a2e"/><circle cx="45" cy="34" r="2.2" fill="#1a1a2e"/></svg>`;
  const initialSettings = loadSettings();

  // ── Purple Bee Backend Bridge ─────────────────────────────────────────────
  function pbxGetBackendBase() { return window.location.origin; }

  async function pbxBackendChatStream(prompt, history, onChunk) {
    const base = pbxGetBackendBase();
    try {
      const resp = await fetch(base + "/api/pbx_chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, history: history || [], web_search: true }),
      });
      if (!resp.ok) throw new Error("sse-" + resp.status);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const p = JSON.parse(line.slice(5).trim());
            if (p.chunk) { fullText += p.chunk; if (onChunk) onChunk(p.chunk); }
            if (p.done) return fullText;
          } catch (_) {}
        }
      }
      return fullText;
    } catch (_) {
      try {
        const r2 = await fetch(base + "/api/pbx_chat_sync", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt, history: history || [], web_search: true }),
        });
        if (!r2.ok) return "";
        const d = await r2.json();
        const t = (d.reply || "").trim();
        if (t && onChunk) onChunk(t);
        return t;
      } catch (_2) { return ""; }
    }
  }

  async function pbxBackendBuildReply(prompt, history) {
    let full = "";
    await pbxBackendChatStream(prompt, history, function(c) { full += c; });
    return full.trim();
  }
  // ─────────────────────────────────────────────────────────────────────────
  const state = {
    sessionId: createSessionId(),
    history: [],
    deepThink: false,
    sidebarOpen: true,
    isStreaming: false,
    pendingAttachments: [],
    settings: initialSettings,
    conversations: loadStoredConversations(initialSettings.rememberChats),
    modelRegistry: null,
    dialogueExamples: [],
    dialogueLoading: null,
    consents: loadRequiredConsents(),
  };

  const engine = {
    browserRuntime: null,
    model: null,
    runtimeKind: "none",
    loading: null,
    inferenceWorker: null,
    inferenceWorkerPromise: null,
    inferenceRequestId: 0,
    installedPackage: null,
    deviceProfile: null,
    lastError: "",
  };

  function loadRequiredConsents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONSENT_KEY) || "{}");
      return {
        terms: !!parsed.terms,
        resource: !!parsed.resource,
        privacy: !!parsed.privacy,
        acceptedAt: parsed.acceptedAt || "",
        version: parsed.version || 1,
      };
    } catch (_error) {
      return { terms: false, resource: false, privacy: false, acceptedAt: "", version: 1 };
    }
  }

  function saveRequiredConsents() {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(state.consents || {}));
  }

  function hasRequiredConsents() {
    const consent = state.consents || {};
    return !!(consent.terms && consent.resource && consent.privacy);
  }

  function syncRequiredConsentUi() {
    const modal = document.getElementById("consent-backdrop");
    if (!modal) return;
    const terms = document.getElementById("consent-terms");
    const resource = document.getElementById("consent-resource");
    const privacy = document.getElementById("consent-privacy");
    const submit = document.getElementById("consent-submit-btn");
    if (terms) terms.checked = !!state.consents?.terms;
    if (resource) resource.checked = !!state.consents?.resource;
    if (privacy) privacy.checked = !!state.consents?.privacy;
    if (submit) submit.disabled = !hasRequiredConsents();
  }

  function openConsentModal() {
    const modal = document.getElementById("consent-backdrop");
    if (!modal) return;
    syncRequiredConsentUi();
    modal.classList.add("open");
  }

  function closeConsentModal(force = false) {
    const modal = document.getElementById("consent-backdrop");
    if (!modal) return;
    if (!force && !hasRequiredConsents()) return;
    modal.classList.remove("open");
  }

  function toggleRequiredConsent() {
    state.consents = {
      ...(state.consents || {}),
      terms: !!document.getElementById("consent-terms")?.checked,
      resource: !!document.getElementById("consent-resource")?.checked,
      privacy: !!document.getElementById("consent-privacy")?.checked,
    };
    syncRequiredConsentUi();
  }

  function submitRequiredConsent() {
    toggleRequiredConsent();
    if (!hasRequiredConsents()) {
      showToast("시작하려면 필수 동의 3개를 모두 확인해 주세요.");
      return false;
    }
    state.consents.acceptedAt = new Date().toISOString();
    state.consents.version = 1;
    saveRequiredConsents();
    closeConsentModal(true);
    showToast("필수 동의를 저장했어요. 이제 Purple Bee를 바로 시작할 수 있어요.");
    return true;
  }

  function ensureRequiredConsent() {
    if (hasRequiredConsents()) return true;
    openConsentModal();
    return false;
  }

  function openConsentDocs() {
    window.open("/index/purple-bee/legal/terms/", "_blank", "noopener");
    window.open("/index/purple-bee/legal/resource-use/", "_blank", "noopener");
    window.open("/index/purple-bee/legal/privacy/", "_blank", "noopener");
  }

  const UI_STRINGS = {
    ko: {
      logoSubtitle: "내 기기 준비형 런타임",
      newChat: "새 대화 시작",
      history: "최근 대화",
      settings: "설정",
      attach: "자료 첨부",
      homeSubtitle: "질문 전에 필요한 실행 자산을 이 기기에 맞춰 준비하고, 설치 상태와 업데이트 여부를 함께 관리하는 Purple Bee입니다.",
      card1Title: "문서 요약",
      card1Desc: "PDF, 텍스트, 코드 파일을 읽고 핵심만 정리",
      card2Title: "문제 해결",
      card2Desc: "에러 로그, 설정 파일, 코드 조각을 함께 분석",
      card3Title: "화면 캡처 점검",
      card3Desc: "스크린샷과 설명을 함께 보내고 흐름을 점검",
      card4Title: "대화 이어서",
      card4Desc: "이 웹사이트 세션에 저장된 최근 대화를 이어서 진행",
      inputPlaceholder: "질문을 입력하고 파일, 문서, 스크린샷을 함께 보내 보세요. (Enter 전송, Shift+Enter 줄바꿈)",
      localBadge: "내 기기 연산",
      modelSubtitle: "설치된 Purple Bee 1.3이 이 기기에서 백그라운드로 답변하는 엔진",
      deepThinkLabel: "정밀 분석",
      deepThinkSubtitle: "첨부 자료와 최근 대화를 더 길게 검토",
      footerNote: "Purple Bee는 실수를 할 수 있습니다. 잘못된 정보는 해당 답변에 신고를 해주세요.",
      settingsTitle: "설정",
      settingsSubtitle: "Purple Bee의 UI 언어, 답변 톤, 저장 방식을 이 웹사이트 세션 기준으로 조정합니다.",
      settingsUiTitle: "UI와 표시",
      settingsUiDesc: "버튼, 안내 문구, 홈 카드 같은 인터페이스 언어와 표시 방식을 조절합니다.",
      settingsUiLanguageLabel: "UI 언어",
      settingsTypingLabel: "응답 애니메이션",
      settingsReplyTitle: "답변 스타일",
      settingsReplyDesc: "질문 언어를 따라가거나, 더 구조적인 형식과 더 일상적인 어투를 고를 수 있습니다.",
      settingsReplyLanguageLabel: "답변 언어",
      settingsStyleLabel: "답변 톤",
      settingsMemoryTitle: "저장과 프라이버시",
      settingsMemoryDesc: "최근 대화와 사용자 설정은 기본적으로 이 웹사이트 세션에 저장되고, 딥러닝 재학습은 관리용 컴퓨터에서만 진행합니다.",
      rememberChatLabel: "최근 대화 저장",
      rememberChatSubtitle: "새로고침 후에도 최근 대화를 다시 불러옵니다.",
      privacyHelp: "대화 저장을 끄면 새 메시지부터 기록하지 않으며, 원하면 아래 버튼으로 저장된 대화도 바로 지울 수 있습니다.",
      clearChats: "이 웹사이트에 저장된 최근 대화 지우기",
      languageSupportTitle: "언어 지원",
      languageSupportDesc: "Purple Bee는 질문에 섞여 있는 언어를 감지해 가능한 한 같은 언어로 답하려고 합니다. 웹사이트 응답은 첨부 자료와 최근 대화를 중심으로 동작하고, 별도 학습은 관리용 컴퓨터에서만 진행합니다.",
      rememberOff: "최근 대화 저장을 끄면 새 메시지는 기록하지 않습니다.",
      rememberOn: "최근 대화 저장을 켰습니다.",
      chatsCleared: "이 웹사이트 세션에 저장된 대화를 지웠습니다.",
      reportSaved: "이 답변을 신고 목록에 저장했습니다.",
      copied: "답변을 복사했습니다.",
      deepThinkOn: "정밀 분석을 켰습니다.",
      deepThinkOff: "정밀 분석을 껐습니다.",
      attachAdded: (count) => `${count}개 자료를 첨부했습니다.`,
      uiLanguageOptions: ["자동", "한국어", "English", "日本語"],
      typingOptions: ["보통", "빠르게", "즉시 표시"],
      replyLanguageOptions: ["질문 언어 따라가기", "한국어", "English", "日本語", "中文", "Español", "Français", "Deutsch"],
      replyStyleOptions: ["자동 조절", "균형형", "구조형", "대화형", "코치형"],
      attachMenuTitles: ["파일/문서 첨부", "스크린샷 붙여넣기", "첨부 비우기"],
      attachMenuDescs: ["텍스트, 코드, PDF, 이미지 파일 추가", "클립보드 이미지나 Ctrl+V로 화면 캡처 추가", "현재 입력창에 올린 자료를 모두 제거"],
    },
    en: {
      logoSubtitle: "Server runtime",
      newChat: "New chat",
      history: "Recent chats",
      settings: "Settings",
      attach: "Attach",
      homeSubtitle: "Purple Bee runs on this website and answers mainly from attachments and recent conversation context.",
      card1Title: "Summarize docs",
      card1Desc: "Read PDFs, text, and code files and pull out the essentials",
      card2Title: "Solve issues",
      card2Desc: "Analyze error logs, config files, and code snippets together",
      card3Title: "Review screenshots",
      card3Desc: "Check screenshots with your notes and explain the flow",
      card4Title: "Continue context",
      card4Desc: "Resume recent conversations saved in this website session",
      inputPlaceholder: "Ask anything and attach files, documents, or screenshots. (Enter to send, Shift+Enter for line break)",
      localBadge: "Server",
      modelSubtitle: "Engine generating replies on the public Purple Bee server",
      deepThinkLabel: "Deep analysis",
      deepThinkSubtitle: "Spend longer on attachments and recent context",
      footerNote: "Purple Bee can make mistakes. If something looks wrong, please report that answer.",
      settingsTitle: "Settings",
      settingsSubtitle: "Tune Purple Bee's UI language, response tone, and saved session behavior for this website.",
      settingsUiTitle: "UI and display",
      settingsUiDesc: "Change the interface language and how the app presents itself.",
      settingsUiLanguageLabel: "UI language",
      settingsTypingLabel: "Response animation",
      settingsReplyTitle: "Reply style",
      settingsReplyDesc: "Let replies follow your question language or use a more structured or conversational tone.",
      settingsReplyLanguageLabel: "Reply language",
      settingsStyleLabel: "Reply tone",
      settingsMemoryTitle: "Storage and privacy",
      settingsMemoryDesc: "Recent chats and settings stay in this website session by default, while deep-learning retraining stays on the management computer.",
      rememberChatLabel: "Save recent chats",
      rememberChatSubtitle: "Load recent conversations again after refresh.",
      privacyHelp: "If you turn chat saving off, new messages stop being stored. You can also clear saved chats below.",
      clearChats: "Clear chats saved in this website session",
      languageSupportTitle: "Language support",
      languageSupportDesc: "Purple Bee tries to detect mixed-language prompts and respond in the same language when possible. Website-time answers focus on attachments and recent context, while separate training stays on the management computer.",
      rememberOff: "Recent chat saving is now off.",
      rememberOn: "Recent chat saving is now on.",
      chatsCleared: "Saved chats in this website session were cleared.",
      reportSaved: "This answer was added to the device report list.",
      copied: "Copied the answer.",
      deepThinkOn: "Deep analysis is on.",
      deepThinkOff: "Deep analysis is off.",
      attachAdded: (count) => `Attached ${count} item${count > 1 ? "s" : ""}.`,
      uiLanguageOptions: ["Auto", "Korean", "English", "Japanese"],
      typingOptions: ["Normal", "Fast", "Instant"],
      replyLanguageOptions: ["Follow prompt language", "Korean", "English", "Japanese", "Chinese", "Spanish", "French", "German"],
      replyStyleOptions: ["Adaptive", "Balanced", "Structured", "Conversational", "Coach"],
      attachMenuTitles: ["Attach file or document", "Paste screenshot", "Clear attachments"],
      attachMenuDescs: ["Add text, code, PDF, or image files", "Add a clipboard image or screenshot with Ctrl+V", "Remove everything currently attached"],
    },
    ja: {
      logoSubtitle: "On-device runtime",
      newChat: "新しい会話",
      history: "最近の会話",
      settings: "設定",
      attach: "添付",
      homeSubtitle: "Purple Bee はこのウェブサイト上で動作し、添付資料と最近の会話を中心に答えます。",
      card1Title: "文書を要約",
      card1Desc: "PDF、テキスト、コードを読んで要点だけ整理",
      card2Title: "問題を整理",
      card2Desc: "エラーログ、設定ファイル、コード断片をまとめて分析",
      card3Title: "スクリーンショット確認",
      card3Desc: "画像と説明を合わせて流れを確認",
      card4Title: "会話を続ける",
      card4Desc: "このウェブサイトのセッションに保存された最近の会話を再開",
      inputPlaceholder: "質問を入力して、ファイル・文書・スクリーンショットを一緒に送ってください。(Enter 送信、Shift+Enter 改行)",
      localBadge: "この端末で計算",
      modelSubtitle: "現在の端末上で直接動くエンジン",
      deepThinkLabel: "詳細分析",
      deepThinkSubtitle: "添付資料と最近の会話をより長く検討します",
      footerNote: "Purple Bee は誤ることがあります。内容が違うと思ったら、その回答を報告してください。",
      settingsTitle: "設定",
      settingsSubtitle: "UI 言語、回答トーン、保存方法などをこのウェブサイトのセッション基準で調整します。",
      settingsUiTitle: "UI と表示",
      settingsUiDesc: "ボタンや案内文、ホームカードなどの表示言語を変更します。",
      settingsUiLanguageLabel: "UI 言語",
      settingsTypingLabel: "応答アニメーション",
      settingsReplyTitle: "回答スタイル",
      settingsReplyDesc: "質問の言語に合わせるか、より構造化された口調や会話調を選べます。",
      settingsReplyLanguageLabel: "回答言語",
      settingsStyleLabel: "回答トーン",
      settingsMemoryTitle: "保存とプライバシー",
      settingsMemoryDesc: "最近の会話と設定は基本的にこのウェブサイトのセッションに保存され、深層学習の再学習は管理用コンピュータでのみ行います。",
      rememberChatLabel: "最近の会話を保存",
      rememberChatSubtitle: "再読み込み後も最近の会話を呼び出します。",
      privacyHelp: "保存をオフにすると新しいメッセージは記録されません。必要なら下のボタンで保存済み会話も消せます。",
      clearChats: "このウェブサイトに保存された会話を削除",
      languageSupportTitle: "言語サポート",
      languageSupportDesc: "Purple Bee は混在した言語もできるだけ判別し、可能なら同じ言語で返答します。ウェブサイト実行時は添付資料と最近の会話を中心に答え、別途の学習は管理用コンピュータだけで行います。",
      rememberOff: "最近の会話保存をオフにしました。",
      rememberOn: "最近の会話保存をオンにしました。",
      chatsCleared: "このウェブサイトに保存された会話を削除しました。",
      reportSaved: "この回答を端末内の報告一覧に保存しました。",
      copied: "回答をコピーしました。",
      deepThinkOn: "詳細分析をオンにしました。",
      deepThinkOff: "詳細分析をオフにしました。",
      attachAdded: (count) => `${count}件の資料を添付しました。`,
      uiLanguageOptions: ["自動", "韓国語", "英語", "日本語"],
      typingOptions: ["通常", "高速", "即時表示"],
      replyLanguageOptions: ["質問の言語に合わせる", "韓国語", "英語", "日本語", "中国語", "スペイン語", "フランス語", "ドイツ語"],
      replyStyleOptions: ["自動調整", "バランス型", "構造化", "会話型", "コーチ型"],
      attachMenuTitles: ["ファイル/文書を添付", "スクリーンショットを貼り付け", "添付をクリア"],
      attachMenuDescs: ["テキスト、コード、PDF、画像を追加", "クリップボード画像または Ctrl+V で追加", "現在の添付をすべて削除"],
    },
  };

  UI_STRINGS.ko.logoSubtitle = "온디바이스 런타임";
  UI_STRINGS.ko.homeSubtitle = "외부 AI 없이 이 웹사이트에서 동작하며, 첨부 자료와 최근 대화를 바탕으로 답하는 Purple Bee입니다.";
  UI_STRINGS.ko.card4Desc = "이 웹사이트 세션에 저장된 최근 대화를 이어서 진행";
  UI_STRINGS.ko.localBadge = "내 기기 연산";
  UI_STRINGS.ko.modelSubtitle = "현재 접속한 기기에서 직접 계산하는 엔진";
  UI_STRINGS.ko.settingsSubtitle = "Purple Bee의 UI 언어, 답변 톤, 저장 방식을 이 웹사이트 세션 기준으로 조정합니다.";
  UI_STRINGS.ko.settingsMemoryDesc = "최근 대화와 사용자 설정은 기본적으로 이 웹사이트 세션에 저장되고, 별도 딥러닝 학습은 관리용 컴퓨터에서만 진행합니다.";
  UI_STRINGS.ko.clearChats = "이 웹사이트에 저장된 최근 대화 지우기";
  UI_STRINGS.ko.languageSupportDesc = "Purple Bee는 질문에 섞인 언어를 감지해 가능한 한 같은 언어로 답하려고 합니다. 웹사이트 응답은 첨부 자료와 최근 대화를 중심으로 동작하고, 별도 모델 학습은 관리용 컴퓨터에서만 진행합니다.";

  UI_STRINGS.en.logoSubtitle = "On-device runtime";
  UI_STRINGS.en.homeSubtitle = "Purple Bee runs on this website without external AI services and answers mainly from attachments and recent conversation context.";
  UI_STRINGS.en.card4Desc = "Resume recent conversations saved in this website session";
  UI_STRINGS.en.localBadge = "On-device";
  UI_STRINGS.en.modelSubtitle = "Engine running directly on the current device";
  UI_STRINGS.en.settingsSubtitle = "Tune Purple Bee's UI language, reply tone, and saved session behavior for this website.";
  UI_STRINGS.en.settingsMemoryDesc = "Recent chats and settings stay in this website session by default, while separate deep-learning training stays on the management computer.";
  UI_STRINGS.en.clearChats = "Clear chats saved in this website session";
  UI_STRINGS.en.languageSupportDesc = "Purple Bee tries to detect mixed-language prompts and respond in the same language when possible. Website-time answers focus on attachments and recent context, while separate model training stays on the management computer.";

  UI_STRINGS.ja.logoSubtitle = "On-device runtime";
  UI_STRINGS.ja.homeSubtitle = "Purple Bee は外部AIサービスなしでこのウェブサイト上で動作し、添付資料と最近の会話をもとに答えます。";
  UI_STRINGS.ja.card4Desc = "このウェブサイトのセッションに保存された最近の会話を再開";
  UI_STRINGS.ja.localBadge = "この端末で計算";
  UI_STRINGS.ja.modelSubtitle = "現在の端末上で直接動くエンジン";
  UI_STRINGS.ja.settingsSubtitle = "UI 言語、回答トーン、保存方法などをこのウェブサイトのセッション基準で調整します。";
  UI_STRINGS.ja.settingsMemoryDesc = "最近の会話と設定は基本的にこのウェブサイトのセッションに保存され、深層学習の再学習は管理用コンピュータでのみ行います。";
  UI_STRINGS.ja.clearChats = "このウェブサイトに保存された会話を削除";
  UI_STRINGS.ja.languageSupportDesc = "Purple Bee は混在した言語もできるだけ判別し、可能なら同じ言語で返答します。ウェブサイト実行時は添付資料と最近の会話を中心に答え、別途の学習は管理用コンピュータだけで行います。";

  document.addEventListener("DOMContentLoaded", () => {
    if (window.marked && window.marked.setOptions) window.marked.setOptions({ gfm: true, breaks: true });
    setupInput();
    setupFileInput();
    setupPasteAndDrop();
    setupMenuDismiss();
    setupSettings();
    applySettingsToUI();
    loadConversationList();
    updateAttachmentStrip();
    setEngineStatus("idle", getRuntimeModelLabel(), getLocalStatusMessage("idle"));
    void loadModelRegistry();
    void loadDialogueBank();
  });

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch (error) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function getActiveUiLanguage() {
    if (state.settings.uiLanguage && state.settings.uiLanguage !== "auto") return state.settings.uiLanguage;
    const candidate = lower((navigator.language || "en").slice(0, 2));
    return UI_STRINGS[candidate] ? candidate : "en";
  }

  function getUiText() {
    return UI_STRINGS[getActiveUiLanguage()] || UI_STRINGS.en;
  }

  function getLocalStatusMessage(status) {
    const language = getActiveUiLanguage();
    if (language === "ko") {
      if (status === "loading") return "이 웹사이트용 Purple Bee 런타임을 현재 기기에서 준비하고 있습니다.";
      if (status === "error") return "현재 기기에서 Purple Bee 100M 런타임 초기화에 실패했습니다. 페이지를 새로고침하거나 잠시 뒤 다시 시도해 주세요.";
      return "현재 웹사이트에서는 질문이 들어오면 접속한 사용자 기기에서 직접 연산하고, 별도 딥러닝 학습은 관리용 컴퓨터에서만 진행됩니다.";
    }
    if (language === "ja") {
      if (status === "loading") return "このウェブサイト用の Purple Bee ランタイムを現在の端末で準備しています。";
      if (status === "error") return "現在の端末で Purple Bee 100M ランタイムの初期化に失敗しました。ページを再読み込みして、少ししてからもう一度試してください。";
      return "現在のウェブサイトでは、質問が来ると接続中の端末上で直接計算し、深層学習の再学習は管理用コンピュータだけで行います。";
    }
    if (status === "loading") return "Preparing the Purple Bee runtime on the current device.";
    if (status === "error") return "Purple Bee 100M failed to initialize on this device. Refresh the page and try again in a moment.";
    return "On this website, Purple Bee runs directly on the user's current device for each question. Separate deep-learning training stays on the management computer.";
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function setSelectOptions(selectId, labels) {
    const select = document.getElementById(selectId);
    if (!select) return;
    Array.from(select.options).forEach((option, index) => {
      if (labels[index]) option.textContent = labels[index];
    });
  }

  function applySettingsToUI() {
    const ui = getUiText();
    document.documentElement.lang = getActiveUiLanguage();
    setText("logo-subtitle", ui.logoSubtitle);
    setText("new-chat-label", ui.newChat);
    setText("history-section-label", ui.history);
    setText("settings-open-label", ui.settings);
    setText("attach-topbar-label", ui.attach);
    setText("home-subtitle", ui.homeSubtitle);
    setText("home-card-1-title", ui.card1Title);
    setText("home-card-1-desc", ui.card1Desc);
    setText("home-card-2-title", ui.card2Title);
    setText("home-card-2-desc", ui.card2Desc);
    setText("home-card-3-title", ui.card3Title);
    setText("home-card-3-desc", ui.card3Desc);
    setText("home-card-4-title", ui.card4Title);
    setText("home-card-4-desc", ui.card4Desc);
    setText("local-badge-label", ui.localBadge);
    setText("model-menu-subtitle", ui.modelSubtitle);
    setText("deep-think-label", ui.deepThinkLabel);
    setText("deep-think-subtitle", ui.deepThinkSubtitle);
    setText("footer-note", ui.footerNote);
    setText("settings-title", ui.settingsTitle);
    setText("settings-subtitle", ui.settingsSubtitle);
    setText("settings-ui-title", ui.settingsUiTitle);
    setText("settings-ui-desc", ui.settingsUiDesc);
    setText("settings-ui-language-label", ui.settingsUiLanguageLabel);
    setText("settings-typing-label", ui.settingsTypingLabel);
    setText("settings-reply-title", ui.settingsReplyTitle);
    setText("settings-reply-desc", ui.settingsReplyDesc);
    setText("settings-reply-language-label", ui.settingsReplyLanguageLabel);
    setText("settings-style-label", ui.settingsStyleLabel);
    setText("settings-memory-title", ui.settingsMemoryTitle);
    setText("settings-memory-desc", ui.settingsMemoryDesc);
    setText("remember-chat-label", ui.rememberChatLabel);
    setText("remember-chat-subtitle", ui.rememberChatSubtitle);
    setText("privacy-help", ui.privacyHelp);
    setText("clear-chats-btn", ui.clearChats);
    setText("settings-language-support-title", ui.languageSupportTitle);
    setText("settings-language-support-desc", ui.languageSupportDesc);

    const field = document.getElementById("input-field");
    if (field) field.placeholder = ui.inputPlaceholder;

    setSelectOptions("ui-language-select", ui.uiLanguageOptions);
    setSelectOptions("typing-speed-select", ui.typingOptions);
    setSelectOptions("reply-language-select", ui.replyLanguageOptions);
    setSelectOptions("reply-style-select", ui.replyStyleOptions);

    const attachTitles = document.querySelectorAll("#attach-menu .attach-menu-item span div:first-child");
    const attachDescs = document.querySelectorAll("#attach-menu .attach-menu-item span div:last-child");
    ui.attachMenuTitles.forEach((value, index) => { if (attachTitles[index]) attachTitles[index].textContent = value; });
    ui.attachMenuDescs.forEach((value, index) => { if (attachDescs[index]) attachDescs[index].textContent = value; });

    const settingsButton = document.getElementById("settings-open-btn");
    const attachButton = document.getElementById("attach-topbar-btn");
    if (settingsButton) settingsButton.title = ui.settings;
    if (attachButton) attachButton.title = ui.attach;

    document.querySelectorAll(".msg-action-btn").forEach((button) => {
      const icon = button.querySelector("i");
      if (!icon) return;
      if (icon.className.includes("ph-copy")) button.lastChild.textContent = getActiveUiLanguage() === "ko" ? " 복사" : getActiveUiLanguage() === "ja" ? " コピー" : " Copy";
      if (icon.className.includes("ph-flag")) button.lastChild.textContent = getActiveUiLanguage() === "ko" ? " 신고" : getActiveUiLanguage() === "ja" ? " 報告" : " Report";
    });

    const statusNode = document.getElementById("local-status");
    if (statusNode) {
      const status = engine.loading ? "loading" : engine.model ? "ready" : "idle";
      statusNode.textContent = getLocalStatusMessage(status);
    }
  }

  function setupSettings() {
    hydrateSettingsControls();
    document.getElementById("ui-language-select").addEventListener("change", (event) => {
      state.settings.uiLanguage = event.target.value;
      persistSettings();
      applySettingsToUI();
    });
    document.getElementById("reply-language-select").addEventListener("change", (event) => {
      state.settings.replyLanguage = event.target.value;
      persistSettings();
    });
    document.getElementById("reply-style-select").addEventListener("change", (event) => {
      state.settings.replyStyle = event.target.value;
      persistSettings();
    });
    document.getElementById("typing-speed-select").addEventListener("change", (event) => {
      state.settings.typingSpeed = event.target.value;
      persistSettings();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSettings();
    });
  }

  function hydrateSettingsControls() {
    const uiLanguage = document.getElementById("ui-language-select");
    const replyLanguage = document.getElementById("reply-language-select");
    const replyStyle = document.getElementById("reply-style-select");
    const typingSpeed = document.getElementById("typing-speed-select");
    const rememberToggle = document.getElementById("remember-chat-toggle");
    if (uiLanguage) uiLanguage.value = state.settings.uiLanguage;
    if (replyLanguage) replyLanguage.value = state.settings.replyLanguage;
    if (replyStyle) replyStyle.value = state.settings.replyStyle;
    if (typingSpeed) typingSpeed.value = state.settings.typingSpeed;
    if (rememberToggle) rememberToggle.checked = !!state.settings.rememberChats;
  }

  function setupInput() {
    const field = document.getElementById("input-field");
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendMessage();
      }
    });
    field.addEventListener("input", () => {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
      document.getElementById("char-count").textContent = `${field.value.length} / 2000`;
    });
  }

  function setupFileInput() {
    const input = document.getElementById("file-input");
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      input.value = "";
      if (files.length) await addAttachments(files);
    });
  }

  function setupPasteAndDrop() {
    const field = document.getElementById("input-field");
    const composeBox = document.getElementById("compose-box");

    field.addEventListener("paste", (event) => {
      const files = Array.from((event.clipboardData && event.clipboardData.files) || []);
      if (files.length) {
        event.preventDefault();
        void addAttachments(files);
      }
    });

    composeBox.addEventListener("dragover", (event) => {
      event.preventDefault();
      composeBox.style.borderColor = "rgba(139,92,246,.6)";
    });
    composeBox.addEventListener("dragleave", () => { composeBox.style.borderColor = ""; });
    composeBox.addEventListener("drop", (event) => {
      event.preventDefault();
      composeBox.style.borderColor = "";
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
      if (files.length) void addAttachments(files);
    });
  }

  function setupMenuDismiss() {
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#attach-btn") && !event.target.closest("#attach-menu")) {
        document.getElementById("attach-menu").classList.remove("open");
      }
      if (!event.target.closest("#model-opt-btn") && !event.target.closest("#top-model-selector") && !event.target.closest("#model-menu")) {
        document.getElementById("model-menu").classList.remove("open");
      }
    });
  }

  async function ensureEngineReady() {
    if (engine.browserRuntime || engine.model) return engine;
    if (engine.loading) return engine.loading;

    setEngineStatus("loading", getRuntimeModelLabel(), getLocalStatusMessage("loading"));
    engine.loading = Promise.resolve()
      .then(async () => {
        if (window.PurpleBeeBrowserRuntime) {
          const runtime = window.PurpleBeeBrowserRuntime.createRuntime({
            manifestUrl: buildRuntimeManifestUrl(getSelectedRuntimeModelId()),
          });
          await runtime.init();
          engine.browserRuntime = runtime;
          engine.runtimeKind = runtime.engineType || "browser-runtime";
          setEngineStatus("ready", getRuntimeModelLabel(), getLocalStatusMessage("ready"));
          return engine;
        }
        throw new Error("browser runtime unavailable");
      })
      .catch((error) => {
        engine.runtimeKind = "error";
        engine.lastError = String(error && error.message ? error.message : error || "unknown runtime error");
        setEngineStatus("error", getRuntimeModelLabel(), getLocalStatusMessage("error"));
        throw error;
      })
      .finally(() => { engine.loading = null; });

    return engine.loading;
  }

  function buildRuntimeManifestUrl(modelId) {
    const url = new URL(BROWSER_MANIFEST_URL, window.location.origin);
    const selectedId = trim(modelId);
    if (selectedId) url.searchParams.set("model_id", selectedId);
    return `${url.pathname}${url.search}`;
  }

  function getRegistryModelList() {
    return state.modelRegistry && Array.isArray(state.modelRegistry.models)
      ? state.modelRegistry.models
      : [];
  }

  function getSelectedRuntimeModelId() {
    const registryModels = getRegistryModelList();
    const stored = trim(localStorage.getItem(RUNTIME_MODEL_KEY) || "");
    if (stored && !registryModels.length) {
      return stored;
    }
    if (stored && registryModels.some((model) => model && model.id === stored)) {
      return stored;
    }
    const registry = state.modelRegistry;
    const fallback = trim(
      (registry && registry.current_model_id)
      || (registryModels[0] && registryModels[0].id)
      || ""
    );
    if (fallback) localStorage.setItem(RUNTIME_MODEL_KEY, fallback);
    return fallback;
  }

  function getSelectedInstallModelId() {
    const registryModels = getRegistryModelList();
    const stored = trim(localStorage.getItem(INSTALL_MODEL_KEY) || "");
    if (stored && registryModels.some((model) => model && model.id === stored)) {
      return stored;
    }
    const fallback = getSelectedRuntimeModelId()
      || trim((state.modelRegistry && state.modelRegistry.current_model_id) || "")
      || trim((registryModels[0] && registryModels[0].id) || "");
    if (fallback) localStorage.setItem(INSTALL_MODEL_KEY, fallback);
    return fallback;
  }

  function setSelectedInstallModelId(modelId) {
    const nextId = trim(modelId);
    if (!nextId) return;
    localStorage.setItem(INSTALL_MODEL_KEY, nextId);
  }

  function getInstallModelMeta() {
    const registry = state.modelRegistry;
    const installId = getSelectedInstallModelId() || (registry && registry.current_model_id) || "purple-bee-1-3";
    const models = registry && Array.isArray(registry.models) ? registry.models : [];
    return models.find((model) => model && model.id === installId)
      || models[0]
      || {
        id: installId,
        display_name: "Purple Bee",
        architecture_name: "Purple Bee runtime",
      };
  }

  function resetRuntimeEngine() {
    engine.browserRuntime = null;
    engine.model = null;
    engine.loading = null;
    engine.runtimeKind = "none";
    engine.lastError = "";
  }

  function switchRuntimeModel(modelId) {
    const nextId = trim(modelId);
    if (!nextId) return;
    if (nextId === getSelectedRuntimeModelId() && (engine.browserRuntime || engine.loading)) {
      document.getElementById("model-menu").classList.remove("open");
      return;
    }
    localStorage.setItem(RUNTIME_MODEL_KEY, nextId);
    resetRuntimeEngine();
    renderModelRegistry();
    setEngineStatus("idle", getRuntimeModelLabel(), getLocalStatusMessage("idle"));
    document.getElementById("model-menu").classList.remove("open");
  }

  function setEngineStatus(status, label, message) {
    const dot = document.getElementById("engine-dot");
    const labelNode = document.getElementById("engine-label");
    const statusNode = document.getElementById("local-status");
    const currentModelNode = document.getElementById("current-model-name");
    if (dot) dot.style.background = status === "ready" ? "var(--green)" : status === "loading" ? "var(--yellow)" : status === "error" ? "var(--red)" : "var(--green)";
    if (labelNode) labelNode.textContent = label;
    if (currentModelNode) currentModelNode.textContent = label;
    if (statusNode) statusNode.textContent = message;
  }

  function getRuntimeModelLabel() {
    const registry = state.modelRegistry;
    if (!registry || !Array.isArray(registry.models)) return "Purple Bee";
    const currentId = getSelectedRuntimeModelId() || registry.current_model_id;
    const currentModel = registry.models.find((model) => model.id === currentId) || registry.models.find((model) => model.current) || registry.models[0];
    return currentModel && currentModel.display_name ? currentModel.display_name : "Purple Bee";
  }

  function findDialogueSeedExamples(prompt, limit = 3) {
    if (!Array.isArray(state.dialogueExamples) || !state.dialogueExamples.length) return [];
    const normalizedPrompt = normalizeDialogueText(prompt);
    const promptTokens = tokenizeDialoguePrompt(prompt);
    if (!normalizedPrompt && !promptTokens.length) return [];
    return state.dialogueExamples
      .map((example) => ({ example, score: scoreDialogueExample(prompt, normalizedPrompt, promptTokens, example) }))
      .filter((entry) => entry.score >= (promptTokens.length <= 1 ? 24 : promptTokens.length === 2 ? 18 : 12))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.example);
  }

  function isNaturalChatPreferencePrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "고정적인 답변",
      "정해진 답변",
      "복붙",
      "복사 붙여넣기",
      "복사붙여넣기",
      "틀에 박힌",
      "자연스럽게 말해",
      "대화처럼 말해",
    ]);
  }

  function isSocialPrompt(loweredPrompt, prompt) {
    return (
      isPlanningPrompt(loweredPrompt) ||
      isHesitationPrompt(loweredPrompt) ||
      isDirectAddressPrompt(loweredPrompt) ||
      isStatusPrompt(loweredPrompt) ||
      containsAny(loweredPrompt, [
        "안녕", "반가워", "고마워", "감사", "심심해", "심심하다", "놀자", "이야기하자",
        "hello", "hi", "hey", "thanks", "thank you", "bored",
      ]) ||
      (trim(prompt).length <= 28 &&
        !isWebsiteSearchPrompt(loweredPrompt) &&
        !isWeatherQuestion(loweredPrompt) &&
        !containsAny(loweredPrompt, ["링크", "url", "주소", "날씨", "검색", "search", "weather"]))
    );
  }

  function buildGreetingReply(language) {
    const seed = `${language}:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "안녕. 뭐부터 얘기해볼까?",
        "안녕. 편하게 말 걸어줘.",
        "안녕. 지금 생각나는 것부터 말해줘.",
      ]);
    }
    if (language === "ja") return pickReplyVariant(seed, ["こんにちは。何から話そうか。", "こんにちは。気軽に話しかけてください。"]);
    if (language === "zh") return pickReplyVariant(seed, ["你好，想先聊什么？", "你好，想到什么就直接说吧。"]);
    return pickReplyVariant(seed, ["Hi. What should we talk about first?", "Hi. Just say whatever is on your mind."]);
  }

  function buildPlanningReply(language) {
    const seed = `${language}:plan:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "우리 그냥 편하게 정하자. 지금 끌리는 거 하나 말해줘.",
        "음, 아무거나 좋아. 잡담해도 되고 코딩 얘기해도 되고, 네가 끌리는 쪽으로 가자.",
        "네가 하고 싶은 쪽으로 맞출게. 그냥 한 줄로 던져줘.",
      ]);
    }
    if (language === "ja") return pickReplyVariant(seed, ["気楽に決めよう。今やりたいことを一つ言って。", "雑談でも作業でも大丈夫。気になる方から始めよう。"]);
    if (language === "zh") return pickReplyVariant(seed, ["随便定就行，你现在更想做什么？", "聊天也行，做事也行，你说一个方向我就接着走。"]);
    return pickReplyVariant(seed, ["We can decide casually. Tell me what feels right right now.", "Anything is fine. We can chat or work on something—your call."]);
  }

  function buildCurrentActivityReply(language) {
    const seed = `${language}:status:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "지금은 너랑 이야기하는 중이야.",
        "지금은 네가 하는 말을 보고 바로 이어서 답하는 중이야.",
        "지금은 네 흐름에 맞춰 같이 얘기하고 있어.",
      ]);
    }
    if (language === "ja") return pickReplyVariant(seed, ["今はあなたと話しているところです。", "今はあなたの流れに合わせて返しているところです。"]);
    if (language === "zh") return pickReplyVariant(seed, ["我现在正在跟你聊天。", "我现在是在顺着你的话继续回答。"]);
    return pickReplyVariant(seed, ["I'm talking with you right now.", "I'm following what you're saying and replying as we go."]);
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const focus = shorten(trim(prompt), 64);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (language === "ko") {
      return style === "coach"
        ? `좋아. **${focus}** 쪽으로 같이 맞춰볼게.`
        : `응, **${focus}** 쪽으로 이어가보자.`;
    }
    if (language === "ja") return `はい、**${focus}** の流れで続けましょう。`;
    if (language === "zh") return `好，那就顺着 **${focus}** 继续。`;
    return `Okay, let's continue with **${focus}**.`;
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    if (!/^\d+$/.test(normalized)) {
      if (normalized === "?") return buildConfusionReply(language);
      if (language === "ko") return "이번 입력에서는 모델 출력이 비었어. 같은 뜻으로 한 줄만 더 붙여서 다시 보내줘.";
      if (language === "ja") return "今回はモデル出力が空でした。同じ意味で一行だけ足してもう一度送ってください。";
      if (language === "zh") return "这次模型输出是空的。请用相同意思再补一行后重新发送。";
      return "The model returned an empty reply for this short input. Add one more line and send it again.";
    }
    const loweredPrompt = lower(normalized);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "숫자만 있어서 아직 의미를 못 잡았어. 그 숫자가 뭘 뜻하는지만 한 줄 더 적어줘.";
      if (language === "ja") return "数字だけだとまだ意味が取りにくいです。何を表す数字か一言だけ足してください。";
      if (language === "zh") return "现在只有数字，我还不知道它表示什么。再补一句说明就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (trim(loweredPrompt) === "?") return buildConfusionReply(language);
    if (language === "ko") return "한마디만 더 붙여주면 그 뜻에 맞춰서 자연스럽게 이어갈게.";
    if (language === "ja") return "一言だけ足してくれれば、その意味に合わせて自然に続けます。";
    if (language === "zh") return "你再补一小句，我就能顺着你的意思接下去。";
    return "Give me one more short phrase and I'll continue naturally.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    if (language === "ko") return "이번 답변은 모델 출력이 비어서 끝까지 이어가지 못했어. 같은 뜻으로 표현을 조금만 바꿔서 다시 보내줘.";
    if (language === "ja") return "今回はモデル出力が空で、最後まで返答を続けられませんでした。意味はそのままで、言い方だけ少し変えてもう一度送ってください。";
    if (language === "zh") return "这次模型输出是空的，所以没能把回答继续下去。请保持原意，稍微换个说法再发一次。";
    return "The model returned an empty reply this time. Rephrase the same intent slightly and send it again.";
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (topic) return buildTopicAbilityReply(topic, language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["지금 뭐해", "지금 뭐 해", "뭐해"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (containsAny(loweredPrompt, ["emoji", "이모지"])) return buildEmojiReply(language);
    if (containsAny(loweredPrompt, ["python", "파이썬"])) return buildTopicAbilityReply("python", language);
    if (containsAny(loweredPrompt, ["roblox", "lua", "로블록스"])) return buildTopicAbilityReply("roblox", language);
    if (containsAny(loweredPrompt, ["coding", "programming", "code", "코딩", "코드"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["what can you do", "how can you help", "뭐 할 수 있어", "뭐할수있어"])) return buildCapabilityReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  function buildBrowserModelPrompt(prompt, language) {
    const languageLabel = language === "ko" ? "Korean" : language === "ja" ? "Japanese" : language === "zh" ? "Chinese" : "English";
    const history = state.history
      .slice(-4)
      .filter((entry) => entry && entry.content)
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${trim(entry.content)}`)
      .join("\n");
    const examples = findDialogueSeedExamples(prompt, 2)
      .map((example) => `User: ${trim(example.prompt)}\nAssistant: ${trim(example.answer)}`)
      .join("\n\n");
    return [
      "You are Purple Bee, a warm and natural conversational AI running on the user's device.",
      `Reply in ${languageLabel}.`,
      "Sound like a real conversation, not a support script.",
      "Keep replies to 1-4 sentences unless the user explicitly asks for a list, steps, or a structured answer.",
      "Do not repeat the user's words back to them unless needed.",
      "Do not say you need more detail unless the message is truly impossible to interpret.",
      "Do not default to menus, capability lists, or canned help text for casual chat.",
      state.prefersOpenEndedChat ? "The user dislikes rigid canned replies. Be more natural and adaptive." : "",
      examples ? `Style examples:\n${examples}` : "",
      history ? `Recent conversation:\n${history}` : "",
      `User: ${trim(prompt)}`,
      "Assistant:",
    ].filter(Boolean).join("\n\n");
  }

  function cleanupBrowserModelReply(text, prompt) {
    let value = trim(String(text || ""));
    value = value.replace(/^(assistant|purple bee)\s*:\s*/i, "").trim();
    value = value.replace(/\b(user|assistant|purple bee)\s*:/gi, "").trim();
    value = value.replace(/\n{3,}/g, "\n\n").trim();
    const normalizedPrompt = normalizeDialogueText(prompt);
    const normalizedValue = normalizeDialogueText(value);
    if (!value || normalizedValue === normalizedPrompt) return "";
    if (containsAny(lower(normalizedValue), ["localhost server inference", "question core", "at a glance"])) return "";
    if ((value.match(/[A-Za-z]/g) || []).length > value.length * 0.75 && /[가-힣]/.test(prompt)) return "";
    if (value.length < 3) return "";
    return value;
  }

  async function tryModelFirstReply(prompt, _language) {
    const loweredPrompt = lower(prompt);
    const socialPrompt = isSocialPrompt(loweredPrompt, prompt);
    if (!trim(prompt) || trim(prompt).length < (socialPrompt ? 2 : 10)) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt)
    ) return "";

    try {
      await loadDialogueBank();
      await ensureEngineReady();
      if (engine.browserRuntime) {
        const generated = await engine.browserRuntime.generateReply(
          buildBrowserModelPrompt(prompt, detectLanguage(prompt)),
          {
            maxNewTokens: socialPrompt ? (state.deepThink ? 72 : 48) : (state.deepThink ? 96 : 64),
            temperature: socialPrompt ? 0.72 : (state.deepThink ? 0.62 : 0.34),
            topK: socialPrompt ? 28 : (state.deepThink ? 28 : 12),
          },
        );
        const cleaned = cleanupBrowserModelReply(generated, prompt);
        if (
          cleaned &&
          cleaned.length >= (socialPrompt ? 4 : 8) &&
          (!socialPrompt || cleaned.length <= 220) &&
          normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
          !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
        ) {
          return cleaned;
        }
      }
    } catch (_error) {
      // Fall back below.
    }

    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      return {
        text: "알겠어. 이번부터는 메뉴처럼 정해진 말보다, 대화 흐름에 맞춰 더 자연스럽게 받을게. 그냥 이어서 말해줘.",
        meta: "",
      };
    }

    const retryPrompt = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt))
      ? trim(previousUserPrompt(userEntry.id))
      : "";
    const effectivePrompt = retryPrompt || prompt;
    const loweredEffectivePrompt = lower(effectivePrompt);
    const intentPrompt = retryPrompt ? effectivePrompt : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredEffectivePrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(effectivePrompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(effectivePrompt);

    if (!currentDocs.length && isKnownLinkPrompt(loweredIntentPrompt)) {
      const direct = buildKnownLinkReply(intentPrompt, promptLanguage);
      if (direct) return { text: direct, meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(effectivePrompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(effectivePrompt, evidence);
        return {
          text: composeFromEvidence(mode, effectivePrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (retryPrompt) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };

    if (containsAny(loweredPrompt, ["안녕", "반가워", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"]) || isDirectAddressPrompt(loweredPrompt)) return { text: buildIdentityReply(promptLanguage), meta: "" };
    if (isPlanningPrompt(loweredPrompt)) return { text: buildPlanningReply(promptLanguage), meta: "" };
    if (isHesitationPrompt(loweredPrompt)) return { text: buildHesitationReply(promptLanguage), meta: "" };
    if (isStatusPrompt(loweredPrompt)) return { text: buildCurrentActivityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
    if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
    if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
      const meta = lastAssistantMeta(state.history);
      if (meta) return { text: meta, meta: "" };
    }
    if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: shorten(previous, 140), meta: "" };
    }
    if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    return { text: buildGeneralChatFallback(effectivePrompt, promptLanguage, replyStyle), meta: "" };
  }

  function buildInstructionStagePrompt(prompt, language) {
    const languageLabel = language === "ko" ? "Korean" : language === "ja" ? "Japanese" : language === "zh" ? "Chinese" : "English";
    const history = state.history
      .slice(-4)
      .filter((entry) => entry && entry.content)
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${trim(entry.content)}`)
      .join("\n");
    return [
      "You are Purple Bee.",
      `Read the conversation and think in ${languageLabel}.`,
      "Write one short internal note describing the user's intent, tone, and the most natural response direction.",
      "Do not answer the user yet.",
      "Do not output bullet lists.",
      history ? `Recent conversation:\n${history}` : "",
      `User: ${trim(prompt)}`,
      "Internal note:",
    ].filter(Boolean).join("\n\n");
  }

  function buildReasonedAnswerPrompt(prompt, language, internalNote) {
    const languageLabel = language === "ko" ? "Korean" : language === "ja" ? "Japanese" : language === "zh" ? "Chinese" : "English";
    const history = state.history
      .slice(-5)
      .filter((entry) => entry && entry.content)
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${trim(entry.content)}`)
      .join("\n");
    const examples = findDialogueSeedExamples(prompt, 2)
      .map((example) => `User: ${trim(example.prompt)}\nAssistant: ${trim(example.answer)}`)
      .join("\n\n");
    return [
      "You are Purple Bee, a natural conversational AI.",
      `Reply in ${languageLabel}.`,
      "Answer like a real conversation.",
      "Avoid canned menus, support-script phrasing, and repeated stock lines.",
      "Use 1-4 sentences unless the user explicitly asks for steps or a list.",
      "If the user is casual, respond casually.",
      state.prefersOpenEndedChat ? "The user explicitly dislikes fixed or repetitive responses. Be adaptive." : "",
      internalNote ? `Internal note:\n${internalNote}` : "",
      examples ? `Style examples:\n${examples}` : "",
      history ? `Recent conversation:\n${history}` : "",
      `User: ${trim(prompt)}`,
      "Assistant:",
    ].filter(Boolean).join("\n\n");
  }

  function buildPolishPrompt(prompt, language, draft) {
    const languageLabel = language === "ko" ? "Korean" : language === "ja" ? "Japanese" : language === "zh" ? "Chinese" : "English";
    return [
      "You are Purple Bee.",
      `Rewrite the reply in ${languageLabel}.`,
      "Make it sound more natural, less rigid, and less repetitive.",
      "Keep the meaning, but remove canned support wording.",
      "Use 1-3 sentences.",
      `User: ${trim(prompt)}`,
      `Draft reply: ${trim(draft)}`,
      "Final reply:",
    ].join("\n\n");
  }

  function cleanupStageNote(text) {
    return trim(String(text || ""))
      .replace(/^(internal note|note|analysis)\s*:\s*/i, "")
      .replace(/\n{2,}/g, " ")
      .trim();
  }

  function looksRigidReply(text) {
    const value = trim(String(text || ""));
    if (!value) return false;
    const lines = value.split(/\r?\n/).filter(Boolean);
    if (lines.length >= 5) return true;
    if (/^\d+\.\s/m.test(value)) return true;
    if ((value.match(/- /g) || []).length >= 3) return true;
    return containsAny(lower(value), [
      "같이 할 만한 건",
      "지금 이 웹사이트에서 바로 잘할 수 있는 건",
      "원하는 걸 하나 고르거나",
      "조금 더 구체적으로 적어주면",
      "지금 답할 수 있는 부분부터",
    ]);
  }

  async function generateReasonedChatReply(prompt, language) {
    await loadDialogueBank();
    await ensureEngineReady();
    if (!engine.browserRuntime) return "";

    const attempts = state.deepThink
      ? [
        { maxNewTokens: 120, temperature: 0.74, topK: 36, topP: 0.92 },
        { maxNewTokens: 132, temperature: 0.9, topK: 48, topP: 0.95 },
      ]
      : [
        { maxNewTokens: 72, temperature: 0.68, topK: 28, topP: 0.9 },
        { maxNewTokens: 84, temperature: 0.84, topK: 40, topP: 0.94 },
      ];

    let bestCandidate = "";
    const modelPrompt = buildBrowserModelPrompt(prompt, language);

    for (const attempt of attempts) {
      const raw = await engine.browserRuntime.generateReply(modelPrompt, attempt);
      const cleaned = cleanupBrowserModelReply(raw, prompt);
      if (!cleaned) continue;
      if (!bestCandidate) bestCandidate = cleaned;
      if (!looksRigidReply(cleaned)) return cleaned;
    }

    return bestCandidate;
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const socialPrompt = isSocialPrompt(loweredPrompt, prompt);
    if (!trim(prompt) || trim(prompt).length < (socialPrompt ? 2 : 10)) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt) || isKnownLinkPrompt(loweredPrompt)) return "";
    try {
      const generated = await generateReasonedChatReply(prompt, language);
      if (
        generated &&
        generated.length >= (socialPrompt ? 4 : 8) &&
        normalizeDialogueText(generated) !== normalizeDialogueText(lastAssistantText(state.history)) &&
        !containsAny(lower(generated), ["localhost server inference", "question core", "at a glance"])
      ) {
        return generated;
      }
    } catch (_error) {
      // Fall through.
    }
    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      return {
        text: "알겠어. 이번부터는 정해진 메뉴처럼 말하지 않고, 더 대화처럼 자연스럽게 이어서 받을게.",
        meta: "",
      };
    }

    const retryPrompt = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt))
      ? trim(previousUserPrompt(userEntry.id))
      : "";
    const effectivePrompt = retryPrompt || prompt;
    const loweredEffectivePrompt = lower(effectivePrompt);
    const intentPrompt = retryPrompt ? effectivePrompt : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredEffectivePrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(effectivePrompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(effectivePrompt);

    if (!currentDocs.length && isKnownLinkPrompt(loweredIntentPrompt)) {
      const direct = buildKnownLinkReply(intentPrompt, promptLanguage);
      if (direct) return { text: direct, meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(effectivePrompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(effectivePrompt, evidence);
        return {
          text: composeFromEvidence(mode, effectivePrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (retryPrompt) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };
    if (containsAny(loweredPrompt, ["안녕", "반가워", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"]) || isDirectAddressPrompt(loweredPrompt)) return { text: buildIdentityReply(promptLanguage), meta: "" };
    if (isPlanningPrompt(loweredPrompt)) return { text: buildPlanningReply(promptLanguage), meta: "" };
    if (isHesitationPrompt(loweredPrompt)) return { text: buildHesitationReply(promptLanguage), meta: "" };
    if (isStatusPrompt(loweredPrompt)) return { text: buildCurrentActivityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
    if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
    if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
      const meta = lastAssistantMeta(state.history);
      if (meta) return { text: meta, meta: "" };
    }
    if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: shorten(previous, 140), meta: "" };
    }
    if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    return { text: buildGeneralChatFallback(effectivePrompt, promptLanguage, replyStyle), meta: "" };
  }

  // Final public chat routing: model first, rigid rule replies last.
  function isAlternativePrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "그거말고",
      "그거 말고",
      "다른거",
      "다른 거",
      "다른거 없어",
      "다른 거 없어",
      "말고",
      "아니 그거",
      "not that",
      "something else",
      "another one",
    ]);
  }

  function buildPlanningReply(language) {
    const seed = `${language}:${state.history.length}:${normalizeDialogueText(lastAssistantText(state.history)).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "가볍게 수다 떨면서 가도 되고, 지금 마음에 걸리는 거 하나 붙잡고 같이 봐도 돼. 네가 끌리는 쪽부터 말해줘.",
        "굳이 메뉴처럼 고를 필요는 없어. 지금 생각나는 거 하나만 던지면 내가 그 흐름에 맞춰서 이어갈게.",
        "편하게 가자. 그냥 이야기해도 되고, 아이디어를 잡아도 되고, 막히는 문제 하나 꺼내도 돼.",
      ]);
    }
    if (language === "ja") return pickReplyVariant(seed, [
      "雑談でもいいし、今気になっていることを一つ持ってきてもいいです。やりたい方向から始めましょう。",
      "堅く決めなくて大丈夫です。今いちばん話したいことを一つ投げてください。",
    ]);
    if (language === "zh") return pickReplyVariant(seed, [
      "轻松聊天也行，直接抓一个你现在在意的话题也行。你先选个方向就好。",
      "不用像菜单一样去选。你现在最想聊的那件事直接说出来就行。",
    ]);
    return pickReplyVariant(seed, [
      "We can keep it casual, or we can grab one thing you're thinking about and dig into it. Start wherever feels natural.",
      "You do not have to pick from a menu. Just throw me the thing you feel like talking about first.",
    ]);
  }

  function buildCapabilityReply(language) {
    if (language === "ko") {
      return "대화 자체도 할 수 있고, 코드나 문서, 로그, 스크린샷 같이 실물을 놓고 같이 보는 쪽도 강해. 지금 바로 붙잡고 싶은 걸 하나 던져줘.";
    }
    if (language === "ja") return "会話もできますし、コードや文書、ログ、スクリーンショットを一緒に見ながら整理するのも得意です。今見たいものを一つ投げてください。";
    if (language === "zh") return "我既可以正常聊天，也比较擅长一起看代码、文档、日志和截图。你现在想先抓哪一个就直接说。";
    return "I can handle normal conversation, and I am also good at looking through code, documents, logs, and screenshots with you. Throw me the thing you want to tackle first.";
  }

  function buildCodingReply(language) {
    if (language === "ko") {
      return "응, 코딩도 같이 볼 수 있어. 코드 설명, 버그 추적, 구조 정리, 수정 방향 제안 쪽으로 바로 들어갈 수 있으니 파일이나 에러만 던져줘.";
    }
    if (language === "ja") return "はい、コーディングも一緒に見られます。コード説明、バグ追跡、構造整理、修正方針の提案まで対応できます。";
    if (language === "zh") return "可以，代码也能一起看。解释代码、排查 bug、整理结构、给出修改方向这些都可以直接做。";
    return "Yes, I can help with coding too: reading code, tracing bugs, cleaning up structure, and suggesting concrete fixes.";
  }

  function buildTopicAbilityReply(topic, language) {
    const loweredTopic = lower(topic);
    if (containsAny(loweredTopic, ["python", "파이썬"])) {
      return language === "ko"
        ? "응, 파이썬 알아. 문법 설명부터 에러 분석, 디버깅, 코드 수정 방향까지 바로 도와줄 수 있어."
        : language === "ja"
          ? "はい、Python は分かります。文法説明、エラー分析、デバッグ、修正方針まで手伝えます。"
          : language === "zh"
            ? "可以，我懂 Python。语法说明、报错分析、调试和修改方向都能帮你看。"
            : "Yes, I know Python. I can help with syntax, debugging, errors, and code changes.";
    }
    if (containsAny(loweredTopic, ["roblox", "lua", "로블록스"])) {
      return language === "ko"
        ? "응, 로블록스도 볼 수 있어. Roblox Studio, Lua, 구조 설계나 버그 추적 쪽으로 같이 파고들 수 있어."
        : language === "ja"
          ? "はい、Roblox も見られます。Roblox Studio、Lua、構造設計やバグ追跡まで一緒に進められます。"
          : language === "zh"
            ? "可以，Roblox 也能看。Roblox Studio、Lua、结构设计和 bug 排查都能一起处理。"
            : "Yes, I can help with Roblox too, especially Roblox Studio, Lua, structure, and bug tracing.";
    }
    if (containsAny(loweredTopic, ["coding", "programming", "code", "코딩", "코드"])) return buildCodingReply(language);
    return buildCapabilityReply(language);
  }

  function buildAlternativeReply(language) {
    const seed = `${language}:${state.history.length}:${lastAssistantText(state.history).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "좋아, 그 방향 말고 다른 쪽으로 가자. 지금 당기는 주제 하나만 새로 던져줘.",
        "오케이, 아까 흐름은 접고 새로 가자. 궁금한 거나 하고 싶은 걸 한 줄로 말해줘.",
        "그럼 방향을 바꿔보자. 잡담이든 질문이든 지금 끌리는 쪽으로 바로 이어가면 돼.",
      ]);
    }
    if (language === "ja") return pickReplyVariant(seed, [
      "分かりました。さっきの流れは閉じて、別の方向に行きましょう。今気になることを一つ言ってください。",
      "では方向を変えましょう。雑談でも質問でも、今いちばん話したいことから始めましょう。",
    ]);
    if (language === "zh") return pickReplyVariant(seed, [
      "好，那刚才那条线就先放下。你现在最想聊的东西直接换一个说就行。",
      "那我们换个方向。无论是闲聊还是问题，你现在最想说的那件事先来。",
    ]);
    return pickReplyVariant(seed, [
      "Okay, let's drop that direction and switch. Just tell me what you want to talk about instead.",
      "Sure. We can pivot. Throw me the thing you actually want to focus on now.",
    ]);
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    if (isAlternativePrompt(loweredPrompt)) return buildAlternativeReply(language);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isStatusPrompt(loweredPrompt)) return buildCurrentActivityReply(language);
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) {
        return style === "coach"
          ? "응, 그건 바로 같이 풀어볼 수 있어. 어디부터 보면 좋을지만 말해주면 맞춰서 이어갈게."
          : "응, 그건 바로 얘기해볼 수 있어. 네가 궁금한 포인트부터 편하게 말해줘.";
      }
      return style === "coach"
        ? "좋아. 그 얘기 흐름에 맞춰서 같이 정리해볼게."
        : "좋아, 그 얘기 이어가자. 내가 흐름 맞춰서 받을게.";
    }
    if (language === "ja") {
      return trim(prompt).endsWith("?")
        ? "はい、それはそのまま一緒に見られます。気になるポイントから話してください。"
        : "いいですね。その話をそのまま続けましょう。";
    }
    if (language === "zh") {
      return trim(prompt).endsWith("?")
        ? "可以，这个我能直接接着聊。你最想先问的点说出来就行。"
        : "好，就顺着这个话题继续说吧。";
    }
    return trim(prompt).endsWith("?")
      ? "Yes, we can talk about that directly. Start with the part you care about most."
      : "Okay, let's stay with that topic and keep going.";
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    const loweredPrompt = lower(normalized);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "지금은 숫자만 보여서 의미를 아직 못 잡았어. 그 숫자가 뭘 가리키는지만 한 줄 더 알려줘.";
      if (language === "ja") return "今は数字だけなので意味がまだ取れていません。その数字が何を指すのか一言だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还看不出它指的是什么。再补一句说明就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isAlternativePrompt(loweredPrompt)) return buildAlternativeReply(language);
    if (trim(loweredPrompt) === "?") return buildConfusionReply(language);
    if (language === "ko") return "한마디만 더 붙여주면 뜻을 맞춰서 바로 이어갈게.";
    if (language === "ja") return "一言だけ足してくれれば、その意味に合わせてすぐ続けます。";
    if (language === "zh") return "你再补一句，我就能顺着你的意思接下去。";
    return "Give me one more short phrase and I'll continue in the right direction.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (isAlternativePrompt(loweredPrompt)) return buildAlternativeReply(language);
    if (trim(prompt).endsWith("?")) {
      if (language === "ko") return "이번엔 모델 답이 비어서 질문을 제대로 풀어내지 못했어. 같은 질문을 조금 더 길게 쓰거나, 필요한 방식이 있으면 한 줄만 더 붙여줘.";
      if (language === "ja") return "今回はモデルの返答が空で、この質問をうまく広げられませんでした。同じ質問をもう少し長く書くか、望む答え方を一言だけ足してください。";
      if (language === "zh") return "这次模型回复是空的，所以没能把这个问题好好展开。你可以把同一个问题写长一点，或者补一句你想要的回答方式。";
      return "This time the model reply came back empty, so I could not answer the question properly. Try the same question with one more line of context.";
    }
    if (language === "ko") return "이번엔 모델 답이 비어서 흐름을 충분히 못 이었어. 하고 싶은 말을 한 줄만 더 붙여주면 다시 바로 시도할게.";
    if (language === "ja") return "今回はモデルの返答が空で、流れを十分につなげられませんでした。一言だけ足してくれればもう一度すぐ試します。";
    if (language === "zh") return "这次模型回复是空的，所以没能顺着你的话接下去。你再补一句，我就马上再试一次。";
    return "The model reply came back empty this time. Add one more short line and I will try again right away.";
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (!trim(prompt) || trim(prompt).length < 2) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt) || isKnownLinkPrompt(loweredPrompt)) return "";

    try {
      const generated = await generateReasonedChatReply(prompt, language);
      const cleaned = cleanupBrowserModelReply(generated, prompt);
      if (
        cleaned &&
        cleaned.length >= 4 &&
        !looksRigidReply(cleaned) &&
        normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
        !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
      ) {
        return cleaned;
      }
    } catch (_error) {
      // Fall through to minimal fallback.
    }
    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const wantsAlternative = isAlternativePrompt(loweredPrompt);
    const wantsRetry = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt)) && !wantsAlternative;
    const retryPrompt = wantsRetry ? trim(previousUserPrompt(userEntry.id)) : "";
    const effectivePrompt = retryPrompt || prompt;
    const loweredEffectivePrompt = lower(effectivePrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(effectivePrompt, "general");
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(effectivePrompt);

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      if (promptLanguage === "ko") return { text: "좋아. 앞으로는 메뉴형 말투보다 자연스럽게 바로 답하는 쪽으로 맞출게.", meta: "" };
      if (promptLanguage === "ja") return { text: "分かりました。これからは固定的な言い回しより、もっと自然にそのまま返す方向で合わせます。", meta: "" };
      if (promptLanguage === "zh") return { text: "好，我接下来会尽量减少固定模板，改成更自然、更直接的回应。", meta: "" };
      return { text: "Got it. I will lean less on fixed phrasing and answer more naturally from here.", meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(effectivePrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(promptLanguage),
        language: promptLanguage,
        style: replyStyle,
      });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredEffectivePrompt)) {
      const effectiveQuery = buildEffectiveQuery(effectivePrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(effectivePrompt, evidence);
        return {
          text: composeFromEvidence("general", effectivePrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    if (isKnownLinkPrompt(loweredEffectivePrompt)) {
      const direct = buildKnownLinkReply(effectivePrompt, promptLanguage);
      if (direct) return { text: direct, meta: "" };
    }

    if (isWebsiteSearchPrompt(loweredEffectivePrompt)) {
      const searchReply = buildWebsiteSearchReply(effectivePrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (isWeatherQuestion(loweredEffectivePrompt)) {
      const weatherReply = await buildWeatherReply(effectivePrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (isKnowledgeLookupPrompt(effectivePrompt, loweredEffectivePrompt, "general")) {
      const knowledgeReply = await buildKnowledgeReply(effectivePrompt, promptLanguage);
      if (knowledgeReply) return knowledgeReply;
    }

    const modelFirstReply = await tryModelFirstReply(effectivePrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (!retryPrompt) {
      if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"]) || isDirectAddressPrompt(loweredPrompt)) return { text: buildIdentityReply(promptLanguage), meta: "" };
      if (isPlanningPrompt(loweredPrompt)) return { text: buildPlanningReply(promptLanguage), meta: "" };
      if (isHesitationPrompt(loweredPrompt)) return { text: buildHesitationReply(promptLanguage), meta: "" };
      if (isStatusPrompt(loweredPrompt)) return { text: buildCurrentActivityReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
      if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
      if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["뭐 할 수 있어", "뭐할수있어", "what can you do", "how can you help"])) return { text: buildCapabilityReply(promptLanguage), meta: "" };
      if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    }

    if (wantsAlternative) return { text: buildAlternativeReply(promptLanguage), meta: "" };
    if (retryPrompt) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    return { text: buildGeneralChatFallback(effectivePrompt, promptLanguage, replyStyle), meta: "" };
  }

  function countHangulCharacters(value) {
    const matches = String(value || "").match(/[\uac00-\ud7a3]/g);
    return matches ? matches.length : 0;
  }

  function countLatinWords(value) {
    const matches = String(value || "").match(/[A-Za-z]{2,}/g);
    return matches ? matches.length : 0;
  }

  function looksRepetitiveReply(value) {
    const normalized = normalizeWhitespace(String(value || ""));
    if (!normalized) return false;
    if (/^(.{1,12})\1{2,}$/u.test(normalized)) return true;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length < 6) return false;
    let repeated = 0;
    for (let index = 1; index < words.length; index += 1) {
      if (normalizeDialogueText(words[index]) === normalizeDialogueText(words[index - 1])) repeated += 1;
    }
    return repeated >= Math.max(2, Math.floor(words.length / 3));
  }

  function isUsefulConversationalReply(value, prompt, language) {
    const reply = trim(String(value || ""));
    if (!reply) return false;
    if (reply.length < 4) return false;
    if (!looksNatural(reply)) return false;
    if (looksRigidReply(reply)) return false;
    if (looksRepetitiveReply(reply)) return false;
    if (normalizeDialogueText(reply) === normalizeDialogueText(prompt)) return false;
    if (normalizeDialogueText(reply) === normalizeDialogueText(lastAssistantText(state.history))) return false;
    const loweredReply = lower(reply);
    if (containsAny(loweredReply, ["localhost server inference", "question core", "at a glance"])) return false;
    if (language === "ko" && countHangulCharacters(reply) < 2 && countLatinWords(reply) >= 4) return false;
    return true;
  }

  function extractDefinitionTarget(prompt) {
    const source = trim(String(prompt || "")).replace(/[?!？！。]+$/u, "");
    if (!source) return "";
    const patterns = [
      /^(.+?)(?:가|이|란)\s*뭐야$/u,
      /^(.+?)\s*뜻(?:이)?\s*뭐야$/u,
      /^(.+?)\s*설명해줘$/u,
      /^what is (.+)$/iu,
      /^who is (.+)$/iu,
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && match[1]) return trim(match[1]);
    }
    return "";
  }

  function buildDefinitionFallbackReply(prompt, language) {
    const target = extractDefinitionTarget(prompt);
    if (!target) return "";
    const loweredTarget = lower(target);
    if (language === "ko") {
      if (containsAny(loweredTarget, ["사과", "apple"])) {
        return "사과는 과일 이름이야. 보통 둥근 모양에 단맛이나 새콤한 맛이 나고 그냥 먹거나 주스, 디저트 재료로도 많이 써.";
      }
      if (containsAny(loweredTarget, ["파이썬", "python"])) {
        return "파이썬은 문법이 비교적 읽기 쉬운 프로그래밍 언어야. 웹, 자동화, 데이터 처리, AI 쪽까지 넓게 쓰여.";
      }
      if (containsAny(loweredTarget, ["인공지능", "ai"])) {
        return "인공지능은 데이터를 바탕으로 패턴을 배우고, 분류나 예측이나 생성 같은 작업을 수행하는 시스템을 말해.";
      }
      if (containsAny(loweredTarget, ["로블록스", "roblox"])) {
        return "로블록스는 게임을 플레이할 수도 있고 직접 만들 수도 있는 플랫폼이야. 보통 Roblox Studio와 Lua 스크립트로 개발해.";
      }
      return `${target}는 맥락에 따라 뜻이 달라질 수 있어. 내가 먼저 설명해보면 개념, 서비스, 사람 이름 같은 여러 경우가 있으니 원하는 쪽을 말해주면 그 방향으로 바로 좁혀줄게.`;
    }
    if (language === "ja") return `${target} は文脈で意味が変わることがあります。まずざっくり説明することはできますが、概念・サービス・人名のどれかを言ってくれればもっと正確に絞れます。`;
    if (language === "zh") return `${target} 的意思会随上下文变化。我可以先做一个大致说明，但如果你告诉我是概念、服务还是人名，我就能更准确地解释。`;
    return `${target} can mean different things depending on context. I can explain it broadly first, but if you tell me whether you mean a concept, service, or person, I can narrow it down properly.`;
  }

  function buildPlanningReply(language) {
    const seed = `${language}:plan:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "우리 그냥 편하게 정하자. 지금 끌리는 거 하나만 말해줘.",
        "아무거나 괜찮아. 잡담해도 되고, 코드 봐도 되고, 떠오르는 얘기부터 시작해도 돼.",
        "네가 지금 하고 싶은 쪽으로 맞출게. 머릿속에 있는 거부터 던져줘.",
      ]);
    }
    if (language === "ja") return pickReplyVariant(seed, ["気楽に決めよう。今やりたいことを一つだけ言って。", "雑談でも作業でもいい。気になる方から始めよう。"]);
    if (language === "zh") return pickReplyVariant(seed, ["随便定就行，你现在更想做什么？", "聊天也行，做事也行，你先说一个方向。"]);
    return pickReplyVariant(seed, ["We can keep it simple. Tell me what you're in the mood for.", "Anything is fine. We can chat, work, or just start from whatever is on your mind."]);
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    const loweredPrompt = lower(normalized);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "숫자만 보여서 아직 무슨 뜻인지 모르겠어. 그 숫자가 뭘 가리키는지만 한 줄 덧붙여줘.";
      if (language === "ja") return "数字だけだとまだ意味が取れません。何を表す数字か一言だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还不知道它表示什么。再补一句说明就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (trim(loweredPrompt) === "?") return buildConfusionReply(language);
    const definition = buildDefinitionFallbackReply(prompt, language);
    if (definition) return definition;
    if (language === "ko") return "짧게 말해도 괜찮아. 내가 그 뜻에 맞춰서 자연스럽게 이어갈게.";
    if (language === "ja") return "短くても大丈夫です。その意味に合わせて自然に続けます。";
    if (language === "zh") return "说短一点也没关系，我会顺着你的意思接下去。";
    return "Short is fine. I'll continue in the direction you mean.";
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const focus = shorten(trim(prompt), 48);
    const definition = buildDefinitionFallbackReply(prompt, language);
    if (definition) return definition;
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (language === "ko") {
      if (containsAny(loweredPrompt, ["왜"])) return `${focus} 쪽이면 원인부터 좁혀보면 돼. 내가 같이 흐름을 정리해줄게.`;
      if (containsAny(loweredPrompt, ["어떻게"])) return `${focus}는 방법을 나눠서 보면 쉬워. 바로 순서대로 풀어줄 수 있어.`;
      if (trim(prompt).endsWith("?")) {
        return style === "coach"
          ? `${focus}라면 같이 핵심부터 잡아보자. 바로 풀어볼 수 있어.`
          : `${focus}라면 바로 이어서 답할 수 있어. 궁금한 포인트부터 볼게.`;
      }
      return style === "coach"
        ? `${focus} 쪽으로 천천히 맞춰가자.`
        : `${focus} 얘기면 그대로 이어가도 돼.`;
    }
    if (language === "ja") return trim(prompt).endsWith("?") ? `${focus} ならそのまま答えられます。` : `${focus} の話ならそのまま続けられます。`;
    if (language === "zh") return trim(prompt).endsWith("?") ? `${focus} 这个我可以直接接着答。` : `${focus} 这个话题可以直接继续说。`;
    return trim(prompt).endsWith("?") ? `I can answer ${focus} directly.` : `We can keep going with ${focus}.`;
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = trim(previousUserPrompt(currentEntryId));
    const loweredPrevious = lower(previous);
    const topic = previous ? extractAbilityTopic(previous) : "";
    const definition = previous ? buildDefinitionFallbackReply(previous, language) : "";
    if (definition) return definition;
    if (topic) return buildTopicAbilityReply(topic, language);
    if (previous && isPlanningPrompt(loweredPrevious)) {
      if (language === "ko") return "그래, 메뉴처럼 고를 얘기는 아니었어. 그냥 편하게 가자. 지금 하고 싶은 말부터 던져줘.";
      if (language === "ja") return "そうですね。メニューみたいに返す話ではありませんでした。気楽に続けましょう。";
      if (language === "zh") return "对，这里不该像菜单一样回答。我们直接自然一点继续。";
      return "Fair point. That should not have sounded like a menu. Let's keep it natural.";
    }
    if (previous && isKnownLinkPrompt(loweredPrevious)) {
      const direct = buildKnownLinkReply(previous, language);
      if (direct) return direct;
    }
    if (previous && isWeatherQuestion(loweredPrevious) && !extractWeatherLocation(previous)) return buildWeatherMissingLocationReply(language);
    if (language === "ko") return "맞아, 방금 답은 좀 굳어 있었어. 이번엔 돌리지 말고 더 자연스럽게 바로 답할게.";
    if (language === "ja") return "その通りです。さっきの答えは少し固すぎました。今度はもっと自然に直接返します。";
    if (language === "zh") return "对，刚才那句太僵了。这次我会更自然、直接一点。";
    return "You're right. That last answer was too rigid. I'll answer more naturally this time.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const definition = buildDefinitionFallbackReply(prompt, language);
    if (definition) return definition;
    const topic = extractAbilityTopic(prompt);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["지금 뭐해", "지금 뭐 해", "뭐해"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (isKnownLinkPrompt(loweredPrompt)) {
      const direct = buildKnownLinkReply(prompt, language);
      if (direct) return direct;
    }
    if (containsAny(loweredPrompt, ["emoji", "이모지"])) return buildEmojiReply(language);
    if (topic) return buildTopicAbilityReply(topic, language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const normalized = trim(prompt);
    if (!normalized || /^[?？！!.]$/u.test(normalized)) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt) || isKnownLinkPrompt(loweredPrompt)) return "";
    try {
      const generated = await generateReasonedChatReply(prompt, language);
      if (isUsefulConversationalReply(generated, prompt, language)) return generated;
    } catch (_error) {
      // Fall through to the deterministic path below.
    }
    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      return {
        text: "알겠어. 이제부터는 메뉴처럼 고정된 답을 먼저 꺼내지 않고, 네 말에 맞춰서 더 자연스럽게 이어갈게.",
        meta: "",
      };
    }

    const retryPrompt = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt))
      ? trim(previousUserPrompt(userEntry.id))
      : "";
    const effectivePrompt = retryPrompt || prompt;
    const loweredEffectivePrompt = lower(effectivePrompt);
    const intentPrompt = retryPrompt ? `${effectivePrompt}\nAnswer more directly and naturally.` : buildIntentPrompt(userEntry);
    const mode = detectMode(loweredEffectivePrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(effectivePrompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(effectivePrompt);

    if (!currentDocs.length && isKnownLinkPrompt(loweredEffectivePrompt)) {
      const direct = buildKnownLinkReply(effectivePrompt, promptLanguage);
      if (direct) return { text: direct, meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredEffectivePrompt)) {
      const searchReply = buildWebsiteSearchReply(effectivePrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredEffectivePrompt)) {
      const weatherReply = await buildWeatherReply(effectivePrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(effectivePrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(promptLanguage),
        language: promptLanguage,
        style: replyStyle,
      });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredEffectivePrompt)) {
      const effectiveQuery = buildEffectiveQuery(effectivePrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(effectivePrompt, evidence);
        return {
          text: composeFromEvidence(mode, effectivePrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (retryPrompt) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };
    if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"]) || isDirectAddressPrompt(loweredPrompt)) return { text: buildIdentityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
    if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
      const meta = lastAssistantMeta(state.history);
      if (meta) return { text: meta, meta: "" };
    }
    if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: shorten(previous, 140), meta: "" };
    }
    if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    return { text: buildGeneralChatFallback(effectivePrompt, promptLanguage, replyStyle), meta: "" };
  }

  function buildPlanningReply(language) {
    const seed = `${language}:${state.history.length}:${trim(previousUserPrompt("")).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "우리 그냥 편하게 가도 돼. 잡담해도 되고, 궁금한 거 하나 파도 되고, 코드나 파일 같이 봐도 돼. 지금 끌리는 쪽 있으면 그걸로 가자.",
        "딱 메뉴처럼 정할 필요는 없어. 생각나는 주제 하나 던지면 내가 거기서 이어갈게.",
        "가볍게 이야기해도 좋고, 뭔가 같이 풀어봐도 좋아. 지금 머리에 떠오른 걸 그냥 말해줘.",
      ]);
    }
    if (language === "ja") return "きっちり決めなくても大丈夫です。雑談でも、質問でも、コードでも、今やりたい方向を一つ言ってくれればそこから続けます。";
    if (language === "zh") return "不用像菜单一样先定死。闲聊、提问、看代码都可以，你现在想往哪边走就直接说。";
    return "We don't have to turn it into a menu. We can chat, solve something, or look at code or files. Just say what feels right.";
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const seed = `${language}:${state.history.length}:${prompt}`;
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) {
        return pickReplyVariant(seed, [
          "그 얘기면 같이 볼 수 있어. 내가 아는 선에서 바로 이어볼게.",
          style === "coach"
            ? "좋아, 그 질문은 같이 정리해볼 수 있어. 핵심부터 바로 잡아볼게."
            : "응, 그 질문도 바로 이어서 답할 수 있어.",
          "그 주제 괜찮아. 내가 먼저 짧게 풀어볼게.",
        ]);
      }
      return pickReplyVariant(seed, [
        "좋아, 그 이야기로 이어가자. 내가 흐름 맞춰서 따라갈게.",
        "오케이, 그 주제로 가자. 편하게 계속 말해줘.",
        style === "coach"
          ? "좋아. 그 흐름으로 하나씩 맞춰보자."
          : "응, 그 얘기도 괜찮아. 그대로 이어가자.",
      ]);
    }
    if (language === "ja") return trim(prompt).endsWith("?") ? "その話ならそのまま答えられます。" : "その話題で続けましょう。";
    if (language === "zh") return trim(prompt).endsWith("?") ? "这个问题我可以直接接着答。" : "好，就顺着这个话题继续。";
    return trim(prompt).endsWith("?") ? "I can answer that directly." : "Okay, let's continue with that.";
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    const loweredPrompt = lower(normalized);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "숫자만 보여서 아직 뜻을 못 잡았어. 그 숫자가 뭘 뜻하는지만 한 줄 더 적어줘.";
      if (language === "ja") return "数字だけだとまだ意味が取れません。何を表す数字か一言だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还不知道它表示什么。再补一句说明就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (isAlternativePrompt(loweredPrompt)) return buildAlternativeReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (trim(loweredPrompt) === "?") return buildConfusionReply(language);
    if (language === "ko") return "짧게 말해도 괜찮아. 한마디만 더 붙여주면 내가 맥락 맞춰서 이어갈게.";
    if (language === "ja") return "短くても大丈夫です。一言だけ足してくれれば、流れを合わせて続けます。";
    if (language === "zh") return "说得短也没关系。你再补一句，我就能顺着你的意思接下去。";
    return "Short is fine. Give me one more phrase and I can continue in the right direction.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isAlternativePrompt(loweredPrompt)) return buildAlternativeReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["지금 뭐해", "지금 뭐 해", "뭐해"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (isKnownLinkPrompt(loweredPrompt)) {
      const direct = buildKnownLinkReply(prompt, language);
      if (direct) return direct;
    }
    if (isKnowledgeLookupPrompt(prompt, loweredPrompt, detectMode(loweredPrompt))) {
      const definition = buildDefinitionFallbackReply(prompt, language);
      if (definition) return definition;
    }
    if (containsAny(loweredPrompt, ["emoji", "이모지"])) return buildEmojiReply(language);
    if (containsAny(loweredPrompt, ["python", "파이썬"])) return buildTopicAbilityReply("python", language);
    if (containsAny(loweredPrompt, ["roblox", "lua", "로블록스"])) return buildTopicAbilityReply("roblox", language);
    if (topic) return buildTopicAbilityReply(topic, language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const normalized = trim(prompt);
    const mode = detectMode(loweredPrompt);
    if (!normalized || normalized.length < 4) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt) ||
      isKnowledgeLookupPrompt(prompt, loweredPrompt, mode)
    ) {
      return "";
    }

    try {
      const generated = await generateReasonedChatReply(prompt, language);
      if (isUsefulConversationalReply(generated, prompt, language)) return generated;
    } catch (_error) {
      return "";
    }

    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const isRepairTurn = isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt);
    const previousUser = trim(previousUserPrompt(userEntry.id));
    const previousUserLowered = lower(previousUser);
    const intentPrompt = isRepairTurn ? prompt : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredIntentPrompt || loweredPrompt);
    const replyStyle = getReplyStyle(intentPrompt || prompt, mode);
    const topic = extractAbilityTopic(intentPrompt || prompt);

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      return {
        text: "알겠어. 이제부터는 메뉴처럼 정해진 답을 먼저 꺼내지 않고, 네 말 흐름에 맞춰서 더 자연스럽게 이어갈게.",
        meta: "",
      };
    }

    if (isRepairTurn && previousUser) {
      if (isPlanningPrompt(previousUserLowered)) return { text: buildAlternativeReply(promptLanguage), meta: "" };
      if (isKnownLinkPrompt(previousUserLowered)) {
        const direct = buildKnownLinkReply(previousUser, promptLanguage);
        if (direct) return { text: direct, meta: "" };
      }
      if (isWeatherQuestion(previousUserLowered)) {
        const repairedWeather = await buildWeatherReply(previousUser, promptLanguage);
        if (repairedWeather) return repairedWeather;
        return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
      }
      if (isKnowledgeLookupPrompt(previousUser, previousUserLowered, detectMode(previousUserLowered))) {
        const repairedKnowledge = await buildKnowledgeReply(previousUser, promptLanguage);
        if (repairedKnowledge) return repairedKnowledge;
      }
      if (extractAbilityTopic(previousUser)) return { text: buildTopicAbilityReply(extractAbilityTopic(previousUser), promptLanguage), meta: "" };
      const repairedModelReply = await tryModelFirstReply(`${previousUser}\nAnswer more directly and naturally.`, promptLanguage);
      if (repairedModelReply) return { text: repairedModelReply, meta: "" };
      return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };
    }

    if (!currentDocs.length && isKnownLinkPrompt(loweredIntentPrompt)) {
      const direct = buildKnownLinkReply(intentPrompt, promptLanguage);
      if (direct) return { text: direct, meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(intentPrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(promptLanguage),
        language: promptLanguage,
        style: replyStyle,
      });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(intentPrompt, evidence);
        return {
          text: composeFromEvidence(mode, intentPrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    if (!currentDocs.length && isKnowledgeLookupPrompt(intentPrompt, loweredIntentPrompt, mode)) {
      const knowledgeReply = await buildKnowledgeReply(intentPrompt, promptLanguage);
      if (knowledgeReply) return knowledgeReply;
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (!currentDocs.length) {
      if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"]) || isDirectAddressPrompt(loweredPrompt)) return { text: buildIdentityReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
      if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
      if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
      if (mode === "capability" || containsAny(loweredPrompt, ["뭐 할 수 있어", "뭐할수있어", "무엇을 할 수", "what can you do", "how can you help"])) {
        return { text: buildCapabilityReply(promptLanguage), meta: "" };
      }
      if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
        const meta = lastAssistantMeta(state.history);
        if (meta) return { text: meta, meta: "" };
      }
      if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
        const previous = lastAssistantText(state.history);
        if (previous) return { text: shorten(previous, 140), meta: "" };
      }
      if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt) && !isKnowledgeLookupPrompt(prompt, loweredPrompt, mode)) {
        return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
      }
    }

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    return { text: buildGeneralChatFallback(intentPrompt, promptLanguage, replyStyle), meta: "" };
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "지금은 숫자만 보여서 뜻을 바로 못 잡겠어. 그 숫자가 뭘 뜻하는지만 한 줄 더 적어줘.";
      if (language === "ja") return "今は数字だけ見えていて意味をまだ特定できません。何を指하는 숫자인지만 한 줄 더 적어주세요。";
      if (language === "zh") return "现在只看到数字，还不能直接判断意思。再补一行说明这个数字指什么就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (language === "ko") {
      if (normalized === "?") return "지금은 답이 비어서 정확히 못 이어갔어. 같은 뜻으로 한 줄만 더 적어주면 바로 다시 답할게.";
      return `지금은 **${escapeMarkdown(shorten(normalized, 24))}**만으로 모델 응답이 비었어. 같은 뜻으로 한 줄만 더 적어주면 바로 다시 이어갈게.`;
    }
    if (language === "ja") return "今はまだ入力が短すぎてモデル応答が空です。同じ 뜻으로 한 줄만 더 적어주면 바로 다시 이어갈게요.";
    if (language === "zh") return "这句话现在还是太短，模型回复是空的。再补一行同样意思的说明，我就马上重试。";
    return "The message is still too short and the model reply came back empty. Add one more short line and I will retry directly.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    void style;
    const loweredPrompt = lower(prompt);
    if (isKnownLinkPrompt(loweredPrompt)) {
      const direct = buildKnownLinkReply(prompt, language);
      if (direct) return direct;
    }
    if (isWebsiteSearchPrompt(loweredPrompt)) {
      const searchReply = buildWebsiteSearchReply(prompt, language);
      if (searchReply) return searchReply.text;
    }
    if (isWeatherQuestion(loweredPrompt)) return buildLiveInfoReply(prompt, language);
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") return `지금은 **${focus}**에 대해 모델 응답이 비어서 자연스럽게 이어가지 못했어. 같은 뜻으로 한 줄만 더 적어주면 바로 다시 답할게.`;
    if (language === "ja") return `今は **${focus}** に対するモデル応答が空で、そのまま自然に続けられませんでした。同じ 뜻으로 한 줄만 더 적어주면 바로 다시 답할게요.`;
    if (language === "zh") return `现在关于 **${focus}** 的模型回复是空的，所以还没自然地接上。你再补一行同样意思的话，我就马上重试。`;
    return `The model reply for **${focus}** came back empty, so I could not continue naturally yet. Add one more short line and I will retry directly.`;
  }

  function looksBrokenModelReply(text) {
    const value = trim(String(text || ""));
    if (!value) return true;
    if (/<\|>/.test(value)) return true;
    if (/([\/\\_\-.])\1{5,}/.test(value)) return true;
    if ((value.match(/\/{2,}/g) || []).length >= 2) return true;
    const compact = normalizeWhitespace(value);
    const chars = Array.from(compact);
    const uniqueChars = new Set(chars).size;
    if (compact.length >= 12 && uniqueChars <= Math.max(3, Math.floor(compact.length * 0.12))) return true;
    const words = compact.split(/\s+/).filter(Boolean);
    if (words.length >= 4) {
      const uniqueWords = new Set(words.map((word) => lower(word))).size;
      if (uniqueWords <= Math.max(1, Math.floor(words.length * 0.35))) return true;
    }
    return false;
  }

async function generateReasonedChatReply(prompt, language) {
    await ensureEngineReady();
    if (!engine.browserRuntime) return "";

    const trimmedPrompt = trim(prompt);
    const history = state.history
      .slice(-2)
      .filter((entry) => entry && entry.content)
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${trim(entry.content)}`)
      .join("\n");

    const promptVariants = [
      buildBrowserModelPrompt(trimmedPrompt, language),
      [
        "You are Purple Bee.",
        "Reply naturally and directly.",
        "Keep it short unless the user asks for detail.",
        history ? `Recent conversation:\n${history}` : "",
        `User: ${trimmedPrompt}`,
        "Assistant:",
      ].filter(Boolean).join("\n\n"),
    ];

    const generationProfiles = [
      { maxNewTokens: state.deepThink ? 72 : 56, temperature: state.deepThink ? 0.68 : 0.58, topK: 24, topP: 0.92 },
      { maxNewTokens: state.deepThink ? 84 : 64, temperature: 0.74, topK: 32, topP: 0.95 },
    ];

    for (let index = 0; index < promptVariants.length; index += 1) {
      const raw = await engine.browserRuntime.generateReply(promptVariants[index], generationProfiles[index]);
      const cleaned = cleanupBrowserModelReply(raw, trimmedPrompt);
      if (
        cleaned &&
        cleaned.length >= 2 &&
        isLanguageCompatible(cleaned, language) &&
        !looksBrokenModelReply(cleaned) &&
        normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history))
      ) {
        return cleaned;
      }
    }

    return "";
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const normalized = trim(prompt);
    if (!normalized || normalized.length < 2) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt)
    ) {
      return "";
    }

    try {
      const generated = await generateReasonedChatReply(prompt, language);
      const cleaned = cleanupBrowserModelReply(generated, prompt);
      if (
        cleaned &&
        cleaned.length >= 2 &&
        isLanguageCompatible(cleaned, language) &&
        normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
        !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
      ) {
        return cleaned;
      }
    } catch (_error) {
      // Fall through to minimal fallback.
    }

    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const intentPrompt = buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const replyStyle = getReplyStyle(intentPrompt || prompt, "general");

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      if (promptLanguage === "ko") return { text: "좋아. 앞으로는 메뉴형 고정 답변보다 자연스럽게 바로 답하는 쪽으로 더 맞출게.", meta: "" };
      if (promptLanguage === "ja") return { text: "了解です。これからは固定パターンより自然にそのまま答える方向を優先します。", meta: "" };
      if (promptLanguage === "zh") return { text: "好。我之后会尽量少用固定模板，优先直接自然地回答。", meta: "" };
      return { text: "Got it. I will lean less on fixed phrasing and answer more directly from here.", meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(intentPrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(promptLanguage),
        language: promptLanguage,
        style: replyStyle,
      });
      if (currentReply) return currentReply;
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(intentPrompt, evidence);
        return {
          text: composeFromEvidence("general", intentPrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    const fallbackCode = "PB-FALLBACK-001";
    if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) {
      return { text: buildShortPromptReply(prompt, promptLanguage), meta: "", code: fallbackCode };
    }
    return { text: buildGeneralChatFallback(intentPrompt, promptLanguage, replyStyle), meta: "", code: fallbackCode };
  }

  function buildModelRetryReply(language, kind) {
    if (language === "ko") {
      if (kind === "repair") return "이번엔 모델 응답이 비었어. 원하는 방향을 한 줄만 더 적어주면 바로 다시 맞춰볼게.";
      return "지금은 모델 응답이 비었어. 같은 뜻으로 한 줄만 더 보내주면 바로 다시 시도할게.";
    }
    if (language === "ja") {
      if (kind === "repair") return "今回はモデル応答が空でした。望む方向を一行だけ足してくれれば、すぐにやり直します。";
      return "今はモデル応答が空でした。同じ意味で一行だけ送り直してくれれば、すぐ再試行します。";
    }
    if (language === "zh") {
      if (kind === "repair") return "这次模型输出是空的。你再补一行想要的方向，我就马上重试。";
      return "现在模型输出是空的。你换一句再发一次，我就立刻重新尝试。";
    }
    if (kind === "repair") return "The model returned an empty reply this time. Add one short hint about the direction you want and I will retry.";
    return "The model returned an empty reply. Send it one more time and I will retry right away.";
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const normalized = trim(prompt);
    if (!normalized || normalized.length < 2) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt)
    ) {
      return "";
    }

    try {
      const generated = await generateReasonedChatReply(prompt, language);
      const cleaned = cleanupBrowserModelReply(generated, prompt);
      if (
        cleaned &&
        cleaned.length >= 2 &&
        isLanguageCompatible(cleaned, language) &&
        !looksBrokenModelReply(cleaned) &&
        normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
        !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
      ) {
        return cleaned;
      }
    } catch (_error) {
      // Fall through to minimal fallback.
    }

    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const wantsRepair = isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt);
    const previousUser = trim(previousUserPrompt(userEntry.id));
    const intentPrompt = wantsRepair && previousUser
      ? `${previousUser}\n\nUser follow-up: ${prompt}\nAssistant:`
      : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const replyStyle = getReplyStyle(intentPrompt || prompt, "general");

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      if (promptLanguage === "ko") return { text: "좋아. 앞으로는 메뉴형 고정 답변보다 자연스럽게 바로 답하는 쪽으로 더 맞출게.", meta: "" };
      if (promptLanguage === "ja") return { text: "了解です。これからは固定パターンより自然にそのまま答える方向を優先します。", meta: "" };
      if (promptLanguage === "zh") return { text: "好。我之后会尽量少用固定模板，优先直接自然地回答。", meta: "" };
      return { text: "Got it. I will lean less on fixed phrasing and answer more directly from here.", meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(intentPrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(promptLanguage),
        language: promptLanguage,
        style: replyStyle,
      });
      if (currentReply) return currentReply;
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(intentPrompt, evidence);
        return {
          text: composeFromEvidence("general", intentPrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    const fallbackCode = "PB-FALLBACK-001";
    return {
      text: buildModelRetryReply(promptLanguage, wantsRepair ? "repair" : "general"),
      meta: "",
      code: fallbackCode,
    };
  }

  function renderModelRegistry() {
    const registry = state.modelRegistry;
    const header = document.getElementById("model-menu-header");
    const list = document.getElementById("model-version-list");
    const topSep = document.getElementById("model-version-sep-top");
    const bottomSep = document.getElementById("model-version-sep-bottom");
    const label = getRuntimeModelLabel();
    const currentId = getSelectedRuntimeModelId() || (registry && registry.current_model_id ? registry.current_model_id : "");
    if (header) header.textContent = registry && registry.family_name ? registry.family_name : "Purple Bee";
    setEngineStatus(engine.model ? "ready" : engine.loading ? "loading" : "idle", label, getLocalStatusMessage(engine.model ? "ready" : engine.loading ? "loading" : "idle"));
    if (!list) return;
    list.innerHTML = "";
    list.style.display = "none";
    if (topSep) topSep.style.display = "none";
    if (bottomSep) bottomSep.style.display = "none";
    if (!registry || !Array.isArray(registry.models) || !registry.models.length) return;
    let rendered = 0;
    registry.models.forEach((model) => {
      if ((currentId && model.id === currentId) || model.current) return;
      const item = document.createElement("div");
      item.className = "model-menu-item";
      const badges = [];
      if (model.current) badges.push("현재 사용중");
      if (model.latest) badges.push("최신");
      if (model.trainable) badges.push("학습 가능");
      item.innerHTML = `
        <span class="item-icon" style="background:rgba(139,92,246,.12)">
          <i class="ph ph-cube" style="color:var(--accent-light)"></i>
        </span>
        <span>
          <div style="color:var(--text)">${escapeHtml(model.display_name || model.id || "Purple Bee")}</div>
          <div style="font-size:10px;color:var(--text-3)">${escapeHtml([model.architecture_name || "", badges.join(" · ")].filter(Boolean).join(" · "))}</div>
        </span>
      `;
      item.addEventListener("click", () => switchRuntimeModel(model.id));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          switchRuntimeModel(model.id);
        }
      });
      list.appendChild(item);
      rendered += 1;
    });
    if (rendered > 0) {
      list.style.display = "";
      if (topSep) topSep.style.display = "";
      if (bottomSep) bottomSep.style.display = "";
    }
  }

  async function loadModelRegistry() {
    try {
      const response = await fetch(MODEL_REGISTRY_URL, { cache: "no-store" });
      if (!response.ok) return;
      const registry = await response.json();
      if (!registry || !Array.isArray(registry.models)) return;
      state.modelRegistry = registry;
      getSelectedRuntimeModelId();
      renderModelRegistry();
    } catch (_error) {
      // Keep the default label when registry loading is unavailable.
    }
  }

  function getReplyLanguage(prompt, evidence) {
    return resolveReplyLanguage(state.settings.replyLanguage, prompt, evidence || []);
  }

  function getReplyStyle(prompt, mode) {
    return resolveReplyStyle(state.settings.replyStyle, mode, prompt);
  }

  function buildGreetingReply(language) {
    if (language === "ko") return "안녕하세요. 자료나 화면 캡처를 붙여주시면 이 기기 안에서 바로 분석해서 자연스럽게 이어서 설명해드릴게요.";
    if (language === "ja") return "こんにちは。資料やスクリーンショットを添付してくれれば、この端末の中でそのまま分析して続けて説明できます。";
    if (language === "zh") return "你好。把文件或截图一起发过来，我会直接在这台设备里继续分析并解释。";
    return "Hello. If you attach files or screenshots, I can analyze them locally on this device and continue from there.";
  }

  function buildThanksReply(language) {
    if (language === "ko") return "언제든지요. 원하면 방금 답변을 더 짧게 줄이거나, 체크리스트 형태로 다시 정리해드릴 수 있어요.";
    if (language === "ja") return "どういたしまして。必要なら、今の答えをもっと短くしたり、チェックリスト形式にまとめ直したりできます。";
    if (language === "zh") return "不客气。如果你愿意，我也可以把刚才的回答再压缩一下，或者改成清单形式。";
    return "Anytime. If you want, I can shorten the last answer or turn it into a checklist.";
  }

  function buildIdentityReply(language) {
    if (language === "ko") return "저는 Purple Bee예요. 이 웹사이트에서 동작하면서, 최근 대화와 첨부 자료를 바탕으로 정리하고 설명하고 문제 해결 순서를 제안하는 쪽에 맞춰져 있어요.";
    if (language === "ja") return "私は Purple Bee です。このウェブサイト上で動き、最近の会話や添付資料をもとに整理・説明・問題解決の手順提案を行います。";
    if (language === "zh") return "我是 Purple Bee。我在这个浏览器里运行，主要根据最近对话和附件来整理、解释并提出解决步骤。";
    return "I'm Purple Bee. I run on this website and mainly help by organizing, explaining, and troubleshooting from recent conversation context and attachments.";
  }

  function buildCapabilityReply(language) {
    if (language === "ko") {
      return [
        "지금 이 웹사이트에서 바로 잘할 수 있는 건 이런 쪽이에요.",
        "",
        "## 내가 잘하는 일",
        "- 파일, 문서, 로그, 코드 조각을 읽고 핵심만 정리하기",
        "- 에러 원인 후보와 점검 순서 정리하기",
        "- 최근 대화를 이어서 다음 작업 제안하기",
        "- 스크린샷, 문서, 설정 파일을 같이 보고 문제 상황 설명하기",
        "",
        "## 코딩 쪽",
        "- 코드 설명",
        "- 버그 원인 추정",
        "- 수정 방향 제안",
        "- 함수나 로직 초안 작성",
        "",
        "첨부 자료를 같이 보내주면 훨씬 정확해져요."
      ].join("\n");
    }
    if (language === "ja") {
      return "このウェブサイト上でできることは、文書やログやコードの整理、原因候補の整理、次の作業の提案、スクリーンショットや設定ファイルを含む状況説明です。添付資料があるほど精度が上がります。";
    }
    if (language === "zh") {
      return "我现在在浏览器里比较擅长做这些事：整理文档、日志和代码片段，推测问题原因，给出排查顺序，以及结合截图和配置文件解释当前情况。你附上资料时会更准。";
    }
    return "On this website I work best on summarizing documents, logs, and code, suggesting likely causes, proposing next steps, and explaining screenshots or config-related issues. I get much better when you attach actual material.";
  }

  function buildCodingReply(language) {
    if (language === "ko") {
      return [
        "네, 코딩 쪽도 도와줄 수 있어요.",
        "",
        "## 예를 들면",
        "- 코드 읽고 설명하기",
        "- 버그 원인 찾기",
        "- 에러 로그 보고 수정 순서 정리하기",
        "- 함수나 컴포넌트 초안 만들기",
        "- 구조를 더 깔끔하게 바꾸는 방향 제안하기",
        "",
        "언어나 파일을 같이 보내주면 바로 그 기준으로 볼게요."
      ].join("\n");
    }
    if (language === "ja") return "はい、コーディングも手伝えます。コードの説明、バグ原因の整理、エラーログの確認、関数やコンポーネントのたたき台作成などができます。";
    if (language === "zh") return "可以，我也能帮你做代码相关的事，比如解释代码、推测 bug 原因、整理报错日志、起草函数或组件结构。";
    return "Yes. I can help with coding too: reading code, explaining logic, spotting likely bugs, reviewing logs, and drafting functions or components.";
  }

  function buildEmojiReply(language) {
    if (language === "ko") return "네 🙂 필요하면 이모지도 조금 섞어서 더 자연스럽게 답할게요. 다만 과하게 쓰기보다는 내용이 먼저 잘 전달되도록 맞출게요.";
    if (language === "ja") return "はい 🙂 必要なら絵文字も少し混ぜて、もう少しやわらかく答えます。";
    if (language === "zh") return "可以 🙂 如果你 원하면，我也可以适当加一点表情，让语气更自然。";
    return "Sure 🙂 I can use a bit of emoji too when it helps the tone feel more natural.";
  }

  function buildConfusionReply(language) {
    if (language === "ko") return "방금 답이 이상했네요. 그 부분은 제가 제대로 못 받았어요. 한 번만 다시 말해주면 이번에는 바로 핵심만 짚어서 답할게요.";
    if (language === "ja") return "さっきの答えは変でしたね。そこはうまく受け取れていませんでした。もう一度だけ言ってくれれば、今度は要点だけで返します。";
    if (language === "zh") return "刚才那句答得不对，我没有正确理解。你再说一遍的话，这次我会直接抓重点来回答。";
    return "That last answer was off. I did not parse it correctly. Say it once more and I'll answer more directly.";
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "숫자만 보내주셔서 아직 의미를 못 잡았어요. 무엇을 뜻하는 숫자인지 한 줄만 더 적어주세요.";
      if (language === "ja") return "数字だけでは意味をまだ特定できません。何を表す数字か一行だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还不能判断它表示什么。你再补一行说明一下它代表什么就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (language === "ko") return "조금 더 구체적으로 적어주면 정확하게 도와줄 수 있어요. 예를 들면 코드, 에러, 문서, 화면 캡처 중 어떤 건지 같이 적어주세요.";
    if (language === "ja") return "もう少し具体的に書いてくれると、かなり正確に答えられます。";
    if (language === "zh") return "如果你再具体一点，我就能更准确地帮你。";
    return "A bit more detail will help me answer much more accurately.";
  }

  async function cachedJsonFetch(key, url, ttlMs) {
    const now = Date.now();
    const cached = DEVICE_CACHE.get(key);
    if (cached && now - cached.time < ttlMs) return cached.data;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
    });
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const data = await response.json();
    DEVICE_CACHE.set(key, { time: now, data });
    return data;
  }

  function stripWeatherNoise(text) {
    return trim(
      String(text || "")
        .replace(/[?？！,，.!]/g, " ")
        .replace(/\b(today|tomorrow|now|current|forecast|weather|temperature)\b/gi, " ")
        .replace(/(오늘|내일|모레|지금|현재|주말|이번주|이번 주|날씨|기온|예보|어때|어때요|알려줘|검색해줘)/g, " ")
        .replace(/\s+/g, " ")
    );
  }

  function extractWeatherLocation(prompt) {
    const source = normalizeWhitespace(String(prompt || ""));
    const koreanMatch = source.match(/(?:오늘|내일|모레|지금|현재|주말|이번주|이번 주)?\s*([가-힣]{2,20})\s*(?:의\s*)?(?:날씨|기온|예보)/);
    if (koreanMatch && koreanMatch[1]) return stripWeatherNoise(koreanMatch[1]);
    const englishMatch = source.match(/(?:weather|forecast|temperature)\s+(?:in|for)?\s*([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s-]{1,30})/i);
    if (englishMatch && englishMatch[1]) return stripWeatherNoise(englishMatch[1]);
    const reversedEnglish = source.match(/([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s-]{1,30})\s+(?:weather|forecast|temperature)/i);
    if (reversedEnglish && reversedEnglish[1]) return stripWeatherNoise(reversedEnglish[1]);
    return "";
  }

  function weatherCodeLabel(code, language) {
    const labels = {
      0: { ko: "맑음", en: "Clear", ja: "晴れ", zh: "晴朗" },
      1: { ko: "대체로 맑음", en: "Mostly clear", ja: "おおむね晴れ", zh: "大致晴朗" },
      2: { ko: "구름 조금", en: "Partly cloudy", ja: "一部くもり", zh: "局部多云" },
      3: { ko: "흐림", en: "Overcast", ja: "くもり", zh: "阴天" },
      45: { ko: "안개", en: "Fog", ja: "霧", zh: "雾" },
      48: { ko: "짙은 서리 안개", en: "Depositing rime fog", ja: "着氷霧", zh: "冻雾" },
      51: { ko: "약한 이슬비", en: "Light drizzle", ja: "弱い霧雨", zh: "小毛毛雨" },
      53: { ko: "이슬비", en: "Drizzle", ja: "霧雨", zh: "毛毛雨" },
      55: { ko: "강한 이슬비", en: "Dense drizzle", ja: "強い霧雨", zh: "强毛毛雨" },
      61: { ko: "약한 비", en: "Light rain", ja: "弱い雨", zh: "小雨" },
      63: { ko: "비", en: "Rain", ja: "雨", zh: "下雨" },
      65: { ko: "강한 비", en: "Heavy rain", ja: "強い雨", zh: "大雨" },
      71: { ko: "약한 눈", en: "Light snow", ja: "弱い雪", zh: "小雪" },
      73: { ko: "눈", en: "Snow", ja: "雪", zh: "下雪" },
      75: { ko: "강한 눈", en: "Heavy snow", ja: "強い雪", zh: "大雪" },
      80: { ko: "약한 소나기", en: "Light showers", ja: "弱いにわか雨", zh: "小阵雨" },
      81: { ko: "소나기", en: "Showers", ja: "にわか雨", zh: "阵雨" },
      82: { ko: "강한 소나기", en: "Heavy showers", ja: "強いにわか雨", zh: "强阵雨" },
      95: { ko: "뇌우", en: "Thunderstorm", ja: "雷雨", zh: "雷暴" },
    };
    return (labels[code] && labels[code][language]) || (labels[code] && labels[code].en) || `code ${code}`;
  }

  function formatWeatherReply(locationName, forecast, language) {
    const current = forecast && forecast.current;
    const daily = forecast && forecast.daily;
    if (!current || !daily || !daily.time || !daily.time.length) return "";
    const condition = weatherCodeLabel(current.weather_code, language);
    const min = daily.temperature_2m_min && daily.temperature_2m_min[0];
    const max = daily.temperature_2m_max && daily.temperature_2m_max[0];
    const rain = daily.precipitation_probability_max && daily.precipitation_probability_max[0];
    if (language === "ko") {
      return [
        `**${locationName}** 기준으로 지금 확인한 날씨예요.`,
        `- 현재 ${current.temperature_2m}°C, 체감 ${current.apparent_temperature}°C`,
        `- 상태: ${condition}`,
        `- 바람: ${current.wind_speed_10m} km/h`,
        `- 오늘 예상: 최저 ${min}°C / 최고 ${max}°C`,
        typeof rain === "number" ? `- 오늘 강수확률 최대: ${rain}%` : "",
      ].filter(Boolean).join("\n");
    }
    if (language === "ja") {
      return [
        `**${locationName}** の現在の天気です。`,
        `- 現在 ${current.temperature_2m}°C、体感 ${current.apparent_temperature}°C`,
        `- 状態: ${condition}`,
        `- 風速: ${current.wind_speed_10m} km/h`,
        `- 今日の予想: 最低 ${min}°C / 最高 ${max}°C`,
        typeof rain === "number" ? `- 今日の降水確率最大: ${rain}%` : "",
      ].filter(Boolean).join("\n");
    }
    if (language === "zh") {
      return [
        `这是 **${locationName}** 当前的天气。`,
        `- 现在 ${current.temperature_2m}°C，体感 ${current.apparent_temperature}°C`,
        `- 状态: ${condition}`,
        `- 风速: ${current.wind_speed_10m} km/h`,
        `- 今日预估: 最低 ${min}°C / 最高 ${max}°C`,
        typeof rain === "number" ? `- 今日最高降水概率: ${rain}%` : "",
      ].filter(Boolean).join("\n");
    }
    return [
      `Here is the current weather for **${locationName}**.`,
      `- Current: ${current.temperature_2m}°C, feels like ${current.apparent_temperature}°C`,
      `- Condition: ${condition}`,
      `- Wind: ${current.wind_speed_10m} km/h`,
      `- Today: low ${min}°C / high ${max}°C`,
      typeof rain === "number" ? `- Max precipitation chance today: ${rain}%` : "",
    ].filter(Boolean).join("\n");
  }

  async function buildWeatherReply(prompt, language) {
    const location = extractWeatherLocation(prompt);
    if (!location) return null;
    try {
      const geo = await cachedJsonFetch(
        `geo:${lower(location)}`,
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=${encodeURIComponent(language === "ko" ? "ko" : language === "ja" ? "ja" : language === "zh" ? "zh" : "en")}&q=${encodeURIComponent(location)}`,
        1000 * 60 * 60 * 24,
      );
      if (!Array.isArray(geo) || !geo.length) return null;
      const first = geo[0];
      const latitude = Number(first.lat);
      const longitude = Number(first.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const weather = await cachedJsonFetch(
        `weather:${latitude.toFixed(3)},${longitude.toFixed(3)}`,
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=1`,
        1000 * 60 * 10,
      );
      const title = stripWeatherNoise(first.name || location) || location;
      const text = formatWeatherReply(title, weather, language);
      if (!text) return null;
      const meta = language === "ko"
        ? "사용자 기기 조회: OpenStreetMap 지오코딩 + Open-Meteo 날씨"
        : language === "ja"
          ? "端末側取得: OpenStreetMap ジオコーディング + Open-Meteo 天気"
          : language === "zh"
            ? "设备侧查询: OpenStreetMap 地理编码 + Open-Meteo 天气"
            : "On-device lookup: OpenStreetMap geocoding + Open-Meteo weather";
      return { text, meta };
    } catch (_error) {
      return null;
    }
  }

  function isKnowledgeLookupPrompt(prompt, loweredPrompt, mode) {
    if (mode === "capability" || mode === "troubleshoot" || mode === "steps" || mode === "compare") return false;
    if (isLiveInfoPrompt(loweredPrompt)) return false;
    if (containsAny(loweredPrompt, ["뭐야", "무엇", "뜻", "설명", "정의", "누구", "what is", "who is", "meaning of", "define", "tell me about", "explain"])) return true;
    return mode === "direct" && trim(prompt).length >= 4;
  }

  function extractKnowledgeQuery(prompt) {
    return trim(
      normalizeWhitespace(String(prompt || ""))
        .replace(/[?？！]/g, " ")
        .replace(/\b(what is|who is|tell me about|explain|define|meaning of)\b/gi, " ")
        .replace(/(이 뭐야|가 뭐야|은 뭐야|는 뭐야|란 뭐야|이란 뭐야|뜻이 뭐야|설명해줘|설명해 줘|정의해줘|누구야|알려줘)/g, " ")
        .replace(/\s+/g, " ")
    );
  }

  function getWikipediaApiBase(language) {
    if (language === "ko") return "https://ko.wikipedia.org/w/api.php";
    if (language === "ja") return "https://ja.wikipedia.org/w/api.php";
    if (language === "zh") return "https://zh.wikipedia.org/w/api.php";
    return "https://en.wikipedia.org/w/api.php";
  }

  async function fetchWikipediaSummary(query, language) {
    const apiBase = getWikipediaApiBase(language);
    const searchUrl = `${apiBase}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
    const searchData = await cachedJsonFetch(`wiki-search:${language}:${lower(query)}`, searchUrl, 1000 * 60 * 60 * 6);
    const searchItems = searchData && searchData.query && Array.isArray(searchData.query.search) ? searchData.query.search : [];
    if (!searchItems.length) return null;
    const title = searchItems[0].title;
    const summaryUrl = `${apiBase}?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const summaryData = await cachedJsonFetch(`wiki-summary:${language}:${lower(title)}`, summaryUrl, 1000 * 60 * 60 * 24);
    const pages = summaryData && summaryData.query && summaryData.query.pages ? Object.values(summaryData.query.pages) : [];
    const extract = pages.length && pages[0] && pages[0].extract ? trim(pages[0].extract) : "";
    if (!extract) return null;
    return { title, extract };
  }

  async function buildKnowledgeReply(prompt, language) {
    const query = extractKnowledgeQuery(prompt);
    if (!query || query.length < 2) return null;
    try {
      const summary = await fetchWikipediaSummary(query, language);
      if (!summary) return null;
      const clipped = shorten(summary.extract, language === "ko" ? 360 : 420);
      const lead = language === "ko"
        ? `**${summary.title}** 기준으로 짧게 정리하면, ${ensureSentenceEnding(clipped)}`
        : language === "ja"
          ? `**${summary.title}** を短くまとめると、${ensureSentenceEnding(clipped)}`
          : language === "zh"
            ? `按 **${summary.title}** 来简短说明的话，${ensureSentenceEnding(clipped)}`
            : `A short summary of **${summary.title}** is: ${ensureSentenceEnding(clipped)}`;
      const meta = language === "ko"
        ? `사용자 기기 조회: Wikipedia - ${summary.title}`
        : language === "ja"
          ? `端末側取得: Wikipedia - ${summary.title}`
          : language === "zh"
            ? `设备侧查询: Wikipedia - ${summary.title}`
            : `On-device lookup: Wikipedia - ${summary.title}`;
      return { text: lead, meta };
    } catch (_error) {
      return null;
    }
  }

  function pickReplyVariant(seed, options) {
    const values = Array.isArray(options) ? options.filter(Boolean) : [];
    if (!values.length) return "";
    let hash = 0;
    for (const char of String(seed || "")) hash = (hash + char.codePointAt(0)) % 2147483647;
    return values[hash % values.length];
  }

  function previousUserPrompt(currentEntryId) {
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      const entry = state.history[index];
      if (!entry || entry.role !== "user") continue;
      if (currentEntryId && entry.id === currentEntryId) continue;
      if (trim(entry.content)) return trim(entry.content);
    }
    return "";
  }

  function buildIntentPrompt(userEntry) {
    const prompt = trim(userEntry.content) || "첨부한 자료를 분석해줘";
    if (!looksFollowUp(lower(prompt))) return prompt;
    const previousUser = previousUserPrompt(userEntry.id);
    return previousUser ? `${previousUser} ${prompt}` : prompt;
  }

  function isWebsiteSearchPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "검색해",
      "검색해줘",
      "찾아줘",
      "찾아 줘",
      "웹에서",
      "웹사이트에서",
      "사이트에서",
      "공식 사이트",
      "홈페이지",
      "search for",
      "look up",
      "find",
      "website",
      "site",
    ]);
  }

  function extractWebsiteSearchQuery(prompt) {
    return trim(
      normalizeWhitespace(String(prompt || ""))
        .replace(/(웹사이트에서|웹에서|인터넷에서|사이트에서|웹사이트|사이트|공식 사이트|홈페이지|검색해줘|검색해 줘|검색해|찾아줘|찾아 줘|찾아|열어줘|열어 줘|보여줘|search for|look up|find|open|website|site|please)/gi, " ")
        .replace(/^(로|을|를|에 대해|에대한|about)\s+/i, " ")
        .replace(/\s+/g, " ")
    );
  }

  function detectOfficialSite(query) {
    const loweredQuery = lower(query);
    if (containsAny(loweredQuery, ["roblox", "로블록스"])) {
      return {
        name: "Roblox",
        url: "https://www.roblox.com/",
        extraLabel: "Roblox 게임 탐색",
        extraUrl: "https://www.roblox.com/discover/",
      };
    }
    if (containsAny(loweredQuery, ["youtube", "유튜브"])) return { name: "YouTube", url: "https://www.youtube.com/" };
    if (containsAny(loweredQuery, ["wikipedia", "위키피디아", "위키"])) return { name: "Wikipedia", url: "https://www.wikipedia.org/" };
    if (containsAny(loweredQuery, ["google", "구글"])) return { name: "Google", url: "https://www.google.com/" };
    return null;
  }

  function buildWebsiteSearchReply(prompt, language) {
    const query = extractWebsiteSearchQuery(prompt);
    if (!query || query.length < 2) return null;
    const official = detectOfficialSite(query);
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const duckUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

    if (language === "ko") {
      const intro = pickReplyVariant(query, [
        `좋아요. **${query}** 쪽이면 바로 열 수 있는 링크부터 정리할게요.`,
        `바로 찾을게요. **${query}** 관련해서 먼저 쓸 만한 링크는 이쪽이에요.`,
        `**${query}** 찾는 거면 아래 링크로 바로 들어가면 돼요.`,
      ]);
      const lines = [intro, ""];
      if (official) lines.push(`- [${official.name} 공식 사이트](${official.url})`);
      if (official && official.extraLabel && official.extraUrl) lines.push(`- [${official.extraLabel}](${official.extraUrl})`);
      lines.push(`- [Google에서 ${query} 검색](${googleUrl})`);
      lines.push(`- [DuckDuckGo에서 ${query} 검색](${duckUrl})`);
      lines.push("");
      lines.push("원하는 게 설치, 계정, 게임 찾기, 오류 해결 중 어떤 쪽인지 말해주면 그 방향으로 바로 이어서 도와드릴게요.");
      return { text: lines.join("\n"), meta: "" };
    }

    if (language === "ja") {
      const lines = [`**${query}** を探すなら、すぐ開けるリンクを先にまとめます。`, ""];
      if (official) lines.push(`- [${official.name} 公式サイト](${official.url})`);
      if (official && official.extraLabel && official.extraUrl) lines.push(`- [${official.extraLabel}](${official.extraUrl})`);
      lines.push(`- [Google で ${query} を検索](${googleUrl})`);
      lines.push(`- [DuckDuckGo で ${query} を検索](${duckUrl})`);
      return { text: lines.join("\n"), meta: "" };
    }

    if (language === "zh") {
      const lines = [`如果你要找 **${query}**，先给你可以直接打开的链接。`, ""];
      if (official) lines.push(`- [${official.name} 官方网站](${official.url})`);
      if (official && official.extraLabel && official.extraUrl) lines.push(`- [${official.extraLabel}](${official.extraUrl})`);
      lines.push(`- [Google 搜索 ${query}](${googleUrl})`);
      lines.push(`- [DuckDuckGo 搜索 ${query}](${duckUrl})`);
      return { text: lines.join("\n"), meta: "" };
    }

    const lines = [`If you want to find **${query}**, here are the quickest links.`, ""];
    if (official) lines.push(`- [${official.name} official site](${official.url})`);
    if (official && official.extraLabel && official.extraUrl) lines.push(`- [${official.extraLabel}](${official.extraUrl})`);
    lines.push(`- [Search ${query} on Google](${googleUrl})`);
    lines.push(`- [Search ${query} on DuckDuckGo](${duckUrl})`);
    return { text: lines.join("\n"), meta: "" };
  }

  function summarizePromptFocus(prompt) {
    return shorten(normalizeWhitespace(String(prompt || "").replace(/[!?！？。．\s]+$/g, "")), 88);
  }

  function isLiveInfoPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "날씨", "기온", "비 와", "미세먼지", "weather", "temperature", "forecast",
      "주가", "환율", "실시간", "최신", "속보", "news", "stock", "price", "today",
    ]);
  }

  function buildLiveInfoReply(prompt, language) {
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") {
      return `질문은 **${focus}**처럼 실시간 정보가 필요한 종류예요.\n\n이 웹사이트는 질문이 들어오면 현재 접속한 사용자 기기에서 직접 조회를 시도합니다. 다만 아직 연결된 도구가 없는 종류는 사실처럼 지어내면 안 되니, 관련 화면 캡처나 텍스트를 보내주면 바로 읽어서 정리해드릴게요.`;
    }
    if (language === "ja") {
      return `**${focus}** のような質問は、リアルタイム情報が必要な種類です。\n\nこのウェブサイトは現在の端末上で直接取得を試みますが、まだ接続されていない種類については事実のように作って答えることはできません。代わりに画面キャプチャやテキストを送ってくれれば、すぐ整理して説明します。`;
    }
    if (language === "zh") {
      return `像 **${focus}** 这样的提问需要实时信息。\n\n这个网站会先在当前设备上尝试直接查询，但对还没接入的类型，我不能把猜测当成事实回答。你可以把相关截图或文字发来，我会立刻帮你整理和说明。`;
    }
    return `A question like **${focus}** needs live information.\n\nThis website first tries to look it up on the current device, but for types that are not wired in yet I should not invent it as fact. If you send the related screenshot or text, I can still read it and break it down right away.`;
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") {
      if (style === "structured") {
        return [
          `질문 핵심은 **${focus}** 쪽이에요.`,
          "",
          "지금 이 웹사이트 버전에서는 이렇게 접근할게요.",
          "1. 질문이 요구하는 의미를 먼저 짚고",
          "2. 필요한 전제나 선택지를 나누고",
          "3. 첨부 자료나 최근 대화가 있으면 그 문맥까지 합쳐서 좁혀볼게요.",
        ].join("\n");
      }
      return `질문 핵심은 **${focus}** 쪽으로 보여요. 지금 가진 문맥만으로도 먼저 이어서 답할 수 있고, 자료나 예시가 붙으면 훨씬 더 정확하게 좁혀드릴 수 있어요.`;
    }
    if (language === "ja") {
      return `質問の中心は **${focus}** ですね。今ある文脈だけでも先に答えられますし、資料や具体例があればもっと正確に絞れます。`;
    }
    if (language === "zh") {
      return `这个问题的重点看起来是 **${focus}**。只用当前上下文我也可以先继续回答，如果再给一点资料或例子，我就能收得更准。`;
    }
    return `The core of your question looks like **${focus}**. I can keep answering from the current context, and if you add a concrete example or attachment I can narrow it down much more precisely.`;
  }

  function tryModelFirstReply(_prompt, _language) {
    return "";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    if (isLiveInfoPrompt(loweredPrompt)) return buildLiveInfoReply(prompt, language);
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "bug", "error", "debug"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return buildEmojiReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  function buildLiveInfoReply(prompt, language) {
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") {
      return `**${focus}** 쪽이면 실시간 확인이 필요해서, 연결된 도구가 있으면 지금 기기에서 바로 조회해볼게요.\n\n아직 이 웹사이트에 연결되지 않은 종류는 지어내서 말하지 않을게요. 대신 관련 링크, 화면 캡처, 텍스트를 보내주면 바로 읽고 정리해드릴 수 있어요.`;
    }
    if (language === "ja") {
      return `**${focus}** ならリアルタイム確認が必要です。使える道具がつながっていれば、この端末上でそのまま調べます。\n\nまだ未接続の種類は作り話では答えません。その代わり、関連リンクや画面キャプチャやテキストがあれば、すぐ整理して説明できます。`;
    }
    if (language === "zh") {
      return `像 **${focus}** 这种问题需要实时信息。如果已经接入工具，我会先在当前设备上直接查询。\n\n还没接入的类型我不会拿猜测当事实来回答。你把相关链接、截图或文字发来，我也可以马上帮你整理说明。`;
    }
    return `Something like **${focus}** needs live information. If the tool is wired in, I will check it directly on this device.\n\nIf that kind of lookup is not connected yet, I will not invent facts. Send a related link, screenshot, or text and I can still break it down right away.`;
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") {
      const lead = pickReplyVariant(focus, [
        `좋아요. **${focus}**부터 바로 볼게요.`,
        `알겠어요. **${focus}** 기준으로 이어서 답해볼게요.`,
        `네, **${focus}** 쪽부터 자연스럽게 정리해볼게요.`,
      ]);
      if (style === "structured") {
        return [lead, "", "바로 답할 수 있는 부분부터 먼저 정리하고,", "필요한 정보가 더 있으면 마지막에 짧게만 물어볼게요."].join("\n");
      }
      return `${lead} 지금 답할 수 있는 부분부터 먼저 자연스럽게 이어서 설명해볼게요.`;
    }
    if (language === "ja") {
      return `${pickReplyVariant(focus, [`では **${focus}** から見ていきます。`, `はい、**${focus}** を基準に続けます。`])} まずはそのまま答えられる部分から自然につなげます。`;
    }
    if (language === "zh") {
      return `${pickReplyVariant(focus, [`好，我先按 **${focus}** 这个方向来看。`, `可以，我就从 **${focus}** 这里继续。`])} 先把现在能直接回答的部分接着说清楚。`;
    }
    return `${pickReplyVariant(focus, [`Okay, I will start with **${focus}**.`, `Got it. I will continue from **${focus}**.`, `Sure, let me tackle **${focus}** first.`])} I will answer the part I can already resolve first and only ask for extra detail if it is really needed.`;
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const searchReply = buildWebsiteSearchReply(prompt, language);
    if (isWebsiteSearchPrompt(loweredPrompt) && searchReply) return searchReply.text;
    if (isLiveInfoPrompt(loweredPrompt)) return buildLiveInfoReply(prompt, language);
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "bug", "error", "debug"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return buildEmojiReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  function isExplicitContinuationPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, ["이어서", "계속", "계속해", "더 자세히", "좀 더 자세히", "다음 단계", "이어가", "continue", "go on", "tell me more"]);
  }

  function isConfusionPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, ["뭔소리", "먼소리", "원소리", "뭐라는", "뭐가", "무슨 말", "이상한데", "이상해", "헷갈", "모르겠", "what are you saying", "that makes no sense", "huh", "???"]);
  }

  function isVeryShortPrompt(prompt) {
    const normalized = trim(prompt);
    return normalized.length > 0 && normalized.length <= 3;
  }

  function buildLanguageAbilityReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (containsAny(loweredPrompt, ["영어", "english"])) return { text: "네, 영어로도 자연스럽게 답할 수 있어요. 원하면 지금부터 영어로 이어서 답할게요.", meta: "" };
    if (containsAny(loweredPrompt, ["일본어", "japanese", "日本語"])) return { text: "네, 일본어로도 답할 수 있어요. 원하면 지금부터 일본어로 이어서 설명할게요.", meta: "" };
    if (containsAny(loweredPrompt, ["중국어", "chinese", "中文"])) return { text: "네, 중국어로도 답할 수 있어요. 원하면 지금부터 중국어로 답할게요.", meta: "" };
    if (containsAny(loweredPrompt, ["한국어", "korean"])) return { text: "네, 한국어로 자연스럽게 이어서 답할 수 있어요.", meta: "" };
    if (language === "ja") return { text: "はい。質問の言語に合わせて、できるだけ同じ言語で答えます。必要なら今すぐその言語で続けます。", meta: "" };
    if (language === "zh") return { text: "可以。我会尽量跟随你的提问语言来回答。如果你愿意，我现在就可以切换过去。", meta: "" };
    return { text: "Yes. I can follow your question language and continue in that language when possible.", meta: "" };
  }

  function buildFollowUpReply(previous, language) {
    if (!previous) return "";
    const clipped = ensureSentenceEnding(shorten(previous, 220));
    if (language === "ko") return `방금 대화를 이어서 정리하면 ${clipped}`;
    if (language === "ja") return `さっきの流れを続けてまとめると ${clipped}`;
    if (language === "zh") return `顺着刚才的对话继续说的话，${clipped}`;
    return `Continuing from the previous answer, ${clipped}`;
  }

  function buildModelFallbackReply(generated, language) {
    const clipped = ensureSentenceEnding(generated);
    if (language === "ko") return `지금은 딱 맞는 근거 문장을 많이 못 찾았지만, 현재 로컬 모델 문맥으로 정리하면 ${clipped}`;
    if (language === "ja") return `今はぴったり一致する根拠文を十分に拾えていませんが、ローカルモデルの文脈でまとめると ${clipped}`;
    if (language === "zh") return `我还没有找到足够贴切的依据句，不过按当前本地模型的上下文来整理的话，${clipped}`;
    return `I do not have enough exact evidence lines yet, but based on the current local model context, ${clipped}`;
  }

  function isLanguageCompatible(text, language) {
    const sample = String(text || "");
    if (!sample) return false;
    if (language === "ko") return /[가-힣]/.test(sample) && (sample.match(/[A-Za-z]/g) || []).length < Math.max(20, sample.length * 0.45);
    if (language === "ja") return /[\u3040-\u30ff]/.test(sample) || /[\u4e00-\u9fff]/.test(sample);
    if (language === "zh") return /[\u4e00-\u9fff]/.test(sample);
    return true;
  }

  function buildNoEvidenceReply(language, hasAttachments, engineError) {
    if (language === "ko") {
      if (engineError) return "현재 기기에서 웹 런타임 자산을 아직 모두 준비하지 못했습니다. 그래도 첨부 자료, 코드, 로그, 문서 범위 안에서는 계속 분석할 수 있으니 필요한 자료를 그대로 붙여주세요.";
      if (hasAttachments) return "지금 첨부 안에는 재료가 있지만, 질문과 바로 맞닿는 단서를 더 좁혀야 합니다. 어떤 부분이 헷갈리는지나 보고 싶은 포인트를 한 줄만 더 적어주면 답을 훨씬 날카롭게 만들 수 있어요.";
      return "아직 이 질문에 바로 닿는 기기 내 자료가 부족합니다. 파일, 문서, 로그, 코드, 화면 설명 중 하나만 더 붙여주면 그 범위 안에서 훨씬 정확하게 풀어드릴 수 있어요.";
    }
    if (language === "ja") {
      if (engineError) return "現在の端末でウェブランタイム資産の準備がまだ完全ではありません。それでも添付資料、コード、ログ、文書ベースの分析は続けられます。";
      if (hasAttachments) return "添付の中に材料はありますが、質問と直結する手がかりをもう少し絞る必要があります。見たいポイントを一行足してもらえると精度がかなり上がります。";
      return "この質問に直接つながる端末内資料がまだ足りません。ファイル、文書、ログ、コード、画面説明のどれかを一つ足してもらえると、かなり正確に整理できます。";
    }
    if (language === "zh") {
      if (engineError) return "当前设备上的网页运行资源还没有完全准备好，不过我仍然可以继续基于附件、代码、日志和文档来分析。";
      if (hasAttachments) return "附件里已经有材料了，但还需要把问题焦点再收窄一点。你再补一行你最想确认的点，我就能回答得更准。";
      return "目前还缺少能直接支撑这个问题的设备内资料。如果你补一个文件、文档、日志、代码片段或画面说明，我就能更准确地继续。";
    }
    if (engineError) return "The website runtime assets are not fully ready on this device yet, but I can still keep working from attachments, code, logs, and documents.";
    if (hasAttachments) return "There is useful material in the attachments, but I still need one sharper angle from you. Add the exact part you want checked and I can make the answer much tighter.";
    return "I do not have enough directly relevant material on this device for the question yet. Add a file, document, log, code snippet, or screenshot note and I can work much more precisely.";
  }

  function getAttachmentMetaPrefix(language) {
    if (language === "ko") return "첨부 자료 기반";
    if (language === "ja") return "添付資料ベース";
    if (language === "zh") return "基于附件资料";
    return "Attachment-based";
  }

  async function addAttachments(files) {
    const added = [];
    const ui = getUiText();
    for (const file of files) {
      try {
        const attachment = await buildAttachment(file);
        state.pendingAttachments.push(attachment);
        added.push(attachment);
      } catch (error) {
        showToast(`${file.name} 분석 중 문제가 생겼습니다.`);
      }
    }
    if (added.length) showToast(ui.attachAdded(added.length));
    updateAttachmentStrip();
  }

  async function buildAttachment(file) {
    const extension = file.name.toLowerCase().split(".").pop() || "";
    const attachment = { id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: file.name, size: file.size || 0, type: file.type || "application/octet-stream", extension, kind: "binary", summary: "", detail: "", text: "", width: null, height: null, previewUrl: "" };

    if (file.type.startsWith("image/")) {
      attachment.kind = "image";
      attachment.previewUrl = URL.createObjectURL(file);
      const info = await readImageInfo(file);
      attachment.width = info.width;
      attachment.height = info.height;
      attachment.summary = `${info.width || "?"}x${info.height || "?"} 이미지`;
      attachment.detail = "현재는 화면의 픽셀 내용을 완전히 읽는 단계는 아니고, 첨부 메타데이터와 대화 문맥 중심으로 해석합니다. 보이는 문구나 오류 코드를 한 줄만 함께 적어주면 훨씬 정확해집니다.";
      return attachment;
    }

    if (file.type === "application/pdf" || extension === "pdf") {
      attachment.kind = "pdf";
      attachment.text = extractPdfText(await file.arrayBuffer()).slice(0, 16000);
      attachment.summary = attachment.text ? `PDF 텍스트 ${attachment.text.length.toLocaleString()}자 추출` : "PDF 구조만 확인";
      attachment.detail = attachment.text ? summarizeText(attachment.text) : "이미지형 PDF일 수 있습니다. 필요한 부분을 텍스트로 함께 적어주세요.";
      return attachment;
    }

    if (file.type.startsWith("text/") || file.type.includes("json") || file.type.includes("xml") || TEXT_EXTENSIONS.has(extension)) {
      attachment.kind = CODE_EXTENSIONS.has(extension) ? "code" : "text";
      attachment.text = normalizeFileText(await file.text()).slice(0, 18000);
      attachment.summary = `${attachment.kind === "code" ? "코드/설정" : "텍스트"} ${attachment.text.length.toLocaleString()}자`;
      attachment.detail = summarizeText(attachment.text);
      return attachment;
    }

    attachment.summary = `${formatBytes(attachment.size)} 파일`;
    attachment.detail = "이 형식은 브라우저에서 본문을 바로 읽기 어렵습니다. 핵심 부분을 텍스트로 같이 보내면 더 정확하게 분석할 수 있습니다.";
    return attachment;
  }

  function updateAttachmentStrip() {
    const strip = document.getElementById("attachment-strip");
    strip.innerHTML = "";
    if (!state.pendingAttachments.length) {
      strip.classList.remove("active");
      return;
    }

    strip.classList.add("active");
    state.pendingAttachments.forEach((attachment) => {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      const icon = attachment.previewUrl
        ? ""
        : `<i class="ph ${attachment.kind === "pdf" ? "ph-file-pdf" : attachment.kind === "code" ? "ph-code" : attachment.kind === "text" ? "ph-file-text" : "ph-file"}"></i>`;
      chip.innerHTML = `
        <div class="attachment-thumb"${attachment.previewUrl ? ` style="background-image:url('${attachment.previewUrl.replace(/'/g, "\\'")}')"` : ""}>${icon}</div>
        <div class="attachment-meta">
          <div class="attachment-name">${escapeHtml(attachment.name)}</div>
          <div class="attachment-desc">${escapeHtml(compactLabel(attachment))}</div>
        </div>
      `;
      const remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.type = "button";
      remove.innerHTML = '<i class="ph ph-x"></i>';
      remove.onclick = () => removePendingAttachment(attachment.id);
      chip.appendChild(remove);
      strip.appendChild(chip);
    });
  }

  function removePendingAttachment(id) {
    const index = state.pendingAttachments.findIndex((attachment) => attachment.id === id);
    if (index < 0) return;
    const [removed] = state.pendingAttachments.splice(index, 1);
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    updateAttachmentStrip();
  }

  function clearPendingAttachments() {
    state.pendingAttachments.forEach((attachment) => attachment.previewUrl && URL.revokeObjectURL(attachment.previewUrl));
    state.pendingAttachments = [];
    document.getElementById("attach-menu").classList.remove("open");
    updateAttachmentStrip();
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    const raw = trim(field.value);
    const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
    if ((!raw && !attachments.length) || state.isStreaming) return;

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    document.getElementById("char-count").textContent = "0 / 2000";

    const userEntry = { id: `msg_${Date.now()}`, role: "user", content: raw || "첨부한 자료를 분석해줘", attachments, meta: "" };
    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    state.isStreaming = true;
    document.getElementById("send-btn").disabled = true;

    const typingId = appendTyping();
    try {
      const reply = await buildReply(userEntry);
      removeTyping(typingId);
      if (reply.code) showToast(`${reply.code} · 모델 응답이 비어 fallback으로 전환됨`);
      const aiEntry = { id: `msg_${Date.now()}_ai`, role: "assistant", content: reply.text, attachments: [], meta: reply.meta || "" };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
    } catch (error) {
      removeTyping(typingId);
      const aiEntry = { id: `msg_${Date.now()}_err`, role: "assistant", content: "로컬 분석 중 오류가 발생했습니다. 같은 자료로 다시 시도하거나 질문을 더 구체적으로 적어주세요.", attachments: [], meta: "" };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.content);
      state.history.push(aiEntry);
    } finally {
      state.isStreaming = false;
      document.getElementById("send-btn").disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "첨부한 자료를 분석해줘";
    const loweredPrompt = lower(prompt);
    const mode = detectMode(loweredPrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(prompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);

    if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"])) return { text: buildIdentityReply(promptLanguage), meta: "" };
    if (isConfusionPrompt(loweredPrompt)) return { text: buildConfusionReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
    if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
      const meta = lastAssistantMeta(state.history);
      if (meta) return { text: meta, meta: "" };
    }
    if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: shorten(previous, 140), meta: "" };
    }
    if (isVeryShortPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    if (!currentDocs.length && isLiveInfoPrompt(loweredPrompt)) {
      const weatherReply = await buildWeatherReply(prompt, promptLanguage);
      if (weatherReply) return weatherReply;
    }
    if (currentDocs.length) {
      const currentReply = replyFromDocuments(prompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    const effectiveQuery = buildEffectiveQuery(prompt, state.history);
    const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
    const combined = dedupeDocuments(localDocs).slice(0, 8);
    const evidence = collectEvidence(effectiveQuery, combined);
    if (evidence.length) {
      const evidenceLanguage = getReplyLanguage(prompt, evidence);
      return {
        text: composeFromEvidence(mode, prompt, evidence, { language: evidenceLanguage, style: replyStyle }),
        meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
      };
    }

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    if (!currentDocs.length && !historyDocs.length) {
      if (isKnowledgeLookupPrompt(prompt, loweredPrompt, mode)) {
        const knowledgeReply = await buildKnowledgeReply(prompt, promptLanguage);
        if (knowledgeReply) return knowledgeReply;
      }
      return { text: buildGeneralChatFallback(prompt, promptLanguage, replyStyle), meta: "" };
    }

    return { text: buildNoEvidenceReply(promptLanguage, currentDocs.length > 0 || historyDocs.length > 0, null), meta: "" };
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "첨부한 자료를 분석해줘";
    const loweredPrompt = lower(prompt);
    const intentPrompt = buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredPrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(prompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);

    if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"])) return { text: buildIdentityReply(promptLanguage), meta: "" };
    if (isConfusionPrompt(loweredPrompt)) return { text: buildConfusionReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
    if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
      const meta = lastAssistantMeta(state.history);
      if (meta) return { text: meta, meta: "" };
    }
    if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: shorten(previous, 140), meta: "" };
    }
    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }
    if (isVeryShortPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    if (!currentDocs.length && isLiveInfoPrompt(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
    }
    if (currentDocs.length) {
      const currentReply = replyFromDocuments(prompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    const effectiveQuery = buildEffectiveQuery(prompt, state.history);
    const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
    const combined = dedupeDocuments(localDocs).slice(0, 8);
    const evidence = collectEvidence(effectiveQuery, combined);
    if (evidence.length) {
      const evidenceLanguage = getReplyLanguage(prompt, evidence);
      return {
        text: composeFromEvidence(mode, prompt, evidence, { language: evidenceLanguage, style: replyStyle }),
        meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
      };
    }

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    if (!currentDocs.length && !historyDocs.length) {
      if (isKnowledgeLookupPrompt(intentPrompt, loweredIntentPrompt, mode)) {
        const knowledgeReply = await buildKnowledgeReply(intentPrompt, promptLanguage);
        if (knowledgeReply) return knowledgeReply;
      }
      return { text: buildGeneralChatFallback(intentPrompt, promptLanguage, replyStyle), meta: "" };
    }

    return { text: buildNoEvidenceReply(promptLanguage, currentDocs.length > 0 || historyDocs.length > 0, null), meta: "" };
  }

  function shouldCarryPreviousPrompt(prompt) {
    const raw = trim(prompt);
    const loweredPrompt = lower(raw);
    if (!loweredPrompt) return false;
    if (containsAny(loweredPrompt, ["그거", "그건", "이거", "이건", "그게", "이게", "그럼", "그러면", "방금", "아까", "이어서", "계속", "다시", "저거"])) return true;
    if (/^(아니|아닌데|이게 아니지|그게 아니지|왜|그래서|응|ㅇㅇ|\?)$/u.test(raw)) return true;
    if (loweredPrompt.startsWith("그 ")) return true;
    if (loweredPrompt.length <= 6 && !containsAny(loweredPrompt, ["알아", "어때", "뭐해", "뭐야", "누구", "왜", "가능", "할수", "할 수", "코딩", "파이썬", "로블록스", "날씨"])) return true;
    return false;
  }

  function buildIntentPrompt(userEntry) {
    const prompt = trim(userEntry.content) || "첨부한 자료를 분석해줘";
    if (!shouldCarryPreviousPrompt(prompt)) return prompt;
    const previousUser = previousUserPrompt(userEntry.id);
    return previousUser ? `${previousUser} ${prompt}` : prompt;
  }

  function isStatusPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, ["지금 뭐해", "뭐해", "뭐 하고 있어", "뭐하고 있어", "what are you doing", "what are you up to"]);
  }

  function buildCurrentActivityReply(language) {
    if (language === "ko") return "지금은 네 질문을 읽고 있고, 필요한 링크나 자료가 있으면 이 기기에서 바로 확인해서 이어서 답하고 있어. 문서, 코드, 오류, 스크린샷 쪽은 바로 도와줄 수 있어.";
    if (language === "ja") return "今はあなたの質問を見ながら、必要なリンクや資料があればこの端末上で確認して続けて答えています。文書、コード、エラー、スクリーンショットの整理が得意です。";
    if (language === "zh") return "我现在是在看你的问题，如果需要链接或资料，我会直接在这台设备上确认后继续回答。文档、代码、错误和截图这类内容我能马上帮你看。";
    return "Right now I am reading your question and checking any needed links or materials on this device before continuing. I am especially useful with documents, code, errors, and screenshots.";
  }

  function extractAbilityTopic(prompt) {
    const normalized = trim(String(prompt || "")).replace(/[?？！]+$/u, "");
    const match = normalized.match(/^(.*?)\s*(알아|알고 있어|할 수 있어|할수있어|가능해|할 줄 알아|can you do|do you know)$/iu);
    if (!match || !match[1]) return "";
    return trim(match[1].replace(/^(그럼|그러면)\s+/u, ""));
  }

  function buildTopicAbilityReply(topic, language) {
    const loweredTopic = lower(topic);
    if (language === "ko") {
      if (containsAny(loweredTopic, ["python", "파이썬"])) return "응, 파이썬 알아. 문법 설명, 에러 원인 파악, 코드 수정, 스크립트 작성, 라이브러리 사용 방향까지 같이 볼 수 있어.";
      if (containsAny(loweredTopic, ["roblox", "로블록스"])) return "응, 로블록스도 알아. Roblox Studio, Lua 스크립트, 게임 구조, 오류 원인, 시스템 설계 쪽으로 이어서 도와줄 수 있어.";
      if (containsAny(loweredTopic, ["날씨", "weather"])) return "응, 날씨도 볼 수 있어. 지역명만 같이 적어주면 지금 기기에서 바로 조회해서 정리해줄게. 예: 군산 날씨 어때";
      return `응, **${topic}** 쪽도 알아. 원하는 게 설명인지, 검색인지, 문제 해결인지 말해주면 그 방향으로 바로 맞춰서 답할게.`;
    }
    if (language === "ja") return `はい、**${topic}** についても対応できます。説明、検索、問題解決のどれをしたいか言ってくれれば、その方向で続けます。`;
    if (language === "zh") return `可以，**${topic}** 这方面我也能接着处理。你想要说明、搜索还是排查问题，直接说方向就行。`;
    return `Yes, I can help with **${topic}** too. Tell me whether you want an explanation, a search, or troubleshooting and I will continue in that direction.`;
  }

  function isNegativeCorrectionPrompt(loweredPrompt) {
    return trim(loweredPrompt) === "?" || containsAny(loweredPrompt, ["아니", "아닌데", "이게아니지", "이게 아니지", "그게아니지", "그게 아니지", "뭔소리야", "이상한데"]);
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = previousUserPrompt(currentEntryId);
    const topic = previous ? extractAbilityTopic(previous) : "";
    if (topic) {
      const answer = buildTopicAbilityReply(topic, language);
      if (language === "ko") return `맞아요. 방금 답이 엉뚱했어요. 다시 바로 답하면, ${answer}`;
      return answer;
    }
    if (previous && isWeatherQuestion(lower(previous)) && !extractWeatherLocation(previous)) {
      if (language === "ko") return "맞아요. 방금 답이 엉뚱했어요. 날씨를 보려면 지역명이 필요해요. 예: 군산 날씨 어때";
    }
    if (language === "ko") return "알겠어. 방금 답이 엉뚱했네. 원하는 방향을 짧게 다시 말해주면 이번엔 그 의도에 맞춰 바로 답할게.";
    if (language === "ja") return "了解です。さっきの答えはずれていました。欲しい方向を短く言ってくれれば、その意図に合わせて答え直します。";
    if (language === "zh") return "明白，刚才那句跑偏了。你把想要的方向再短短说一下，我这次按那个意思直接回答。";
    return "Fair point. My last answer drifted. Give me the direction in one short line and I will answer it directly this time.";
  }

  function isWeatherQuestion(loweredPrompt) {
    return containsAny(loweredPrompt, ["날씨", "기온", "예보", "weather", "forecast", "temperature"]);
  }

  function buildWeatherMissingLocationReply(language) {
    if (language === "ko") return "날씨는 바로 확인할 수 있는데, 먼저 지역명이 필요해요. 예를 들면 `군산 날씨 어때`처럼 적어주면 바로 볼게요.";
    if (language === "ja") return "天気は見られますが、先に地域名が必要です。たとえば `群山の天気は？` のように書いてください。";
    if (language === "zh") return "天气可以查，不过先要有地区名。比如写成 `群山天气怎么样` 这样我就能直接看。";
    return "I can check the weather, but I need a location first. For example: `How is the weather in Gunsan?`";
  }

  function extractWeatherLocation(prompt) {
    const source = normalizeWhitespace(String(prompt || ""))
      .replace(/^(그럼|그러면|그)\s+/u, "")
      .replace(/\s+/g, " ");
    const koreanCompact = source.match(/([가-힣]{2,20})\s*날씨/u);
    if (koreanCompact && koreanCompact[1]) return stripWeatherNoise(koreanCompact[1].replace(/^(그|이|저)/u, ""));
    const koreanMatch = source.match(/(?:오늘|내일|모레|지금|현재|주말|이번주|이번 주)?\s*([가-힣]{2,20})\s*(?:의\s*)?(?:날씨|기온|예보)/u);
    if (koreanMatch && koreanMatch[1]) return stripWeatherNoise(koreanMatch[1].replace(/^(그|이|저)/u, ""));
    const englishMatch = source.match(/(?:weather|forecast|temperature)\s+(?:in|for)?\s*([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s-]{1,30})/i);
    if (englishMatch && englishMatch[1]) return stripWeatherNoise(englishMatch[1]);
    const reversedEnglish = source.match(/([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s-]{1,30})\s+(?:weather|forecast|temperature)/i);
    if (reversedEnglish && reversedEnglish[1]) return stripWeatherNoise(reversedEnglish[1]);
    return "";
  }

  async function buildWeatherReply(prompt, language) {
    const location = extractWeatherLocation(prompt);
    if (!location) return null;
    try {
      const geo = await cachedJsonFetch(
        `geo:${lower(location)}`,
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=${encodeURIComponent(language === "ko" ? "ko" : language === "ja" ? "ja" : language === "zh" ? "zh" : "en")}&q=${encodeURIComponent(location)}`,
        1000 * 60 * 60 * 24,
      );
      if (!Array.isArray(geo) || !geo.length) return null;
      const first = geo[0];
      const latitude = Number(first.lat);
      const longitude = Number(first.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const weather = await cachedJsonFetch(
        `weather:${latitude.toFixed(3)},${longitude.toFixed(3)}`,
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=1`,
        1000 * 60 * 10,
      );
      const title = stripWeatherNoise(first.name || location) || location;
      const text = formatWeatherReply(title, weather, language);
      if (!text) return null;
      return { text, meta: "" };
    } catch (_error) {
      return null;
    }
  }

  function buildLiveInfoReply(prompt, language) {
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") return `**${focus}** 쪽은 실시간 확인이 필요한 질문이에요. 연결된 도구가 있으면 지금 기기에서 바로 확인하고, 아직 없는 종류는 지어내지 않고 솔직하게 말할게요.`;
    if (language === "ja") return `**${focus}** はリアルタイム確認が必要な質問です。使える道具があればこの端末上で確認し、未接続の種類は作り話では答えません。`;
    if (language === "zh") return `**${focus}** 这类问题需要实时确认。如果有接入工具，我会在当前设备上直接查；没有的话我不会编造答案。`;
    return `**${focus}** needs live information. If the tool is connected I will check it on this device, and if it is not connected I will not invent facts.`;
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const focus = summarizePromptFocus(prompt);
    if (language === "ko") {
      const lead = pickReplyVariant(focus, [
        `좋아요. **${focus}**부터 바로 볼게요.`,
        `알겠어요. **${focus}** 기준으로 바로 이어서 답할게요.`,
        `네, **${focus}** 쪽부터 자연스럽게 정리해볼게요.`,
      ]);
      if (style === "structured") return [lead, "", "필요한 말만 먼저 짚고, 더 필요한 게 있으면 마지막에 짧게만 물어볼게요."].join("\n");
      return `${lead} 불필요한 메타 설명 없이 바로 답해볼게요.`;
    }
    if (language === "ja") return `${pickReplyVariant(focus, [`では **${focus}** から見ていきます。`, `はい、**${focus}** を基準に続けます。`])} 余計な前置きは省いて、そのまま答えます。`;
    if (language === "zh") return `${pickReplyVariant(focus, [`好，我先按 **${focus}** 这个方向来看。`, `可以，我就从 **${focus}** 这里继续。`])} 我直接回答，不再加多余的铺垫。`;
    return `${pickReplyVariant(focus, [`Okay, I will start with **${focus}**.`, `Got it. I will continue from **${focus}**.`])} I will answer directly without extra meta commentary.`;
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (topic) return buildTopicAbilityReply(topic, language);
    const searchReply = buildWebsiteSearchReply(prompt, language);
    if (isWebsiteSearchPrompt(loweredPrompt) && searchReply) return searchReply.text;
    if (isLiveInfoPrompt(loweredPrompt)) return buildLiveInfoReply(prompt, language);
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "bug", "error", "debug"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return buildEmojiReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "첨부한 자료를 분석해줘";
    const loweredPrompt = lower(prompt);
    const intentPrompt = buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredPrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(prompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(prompt);

    if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"])) return { text: buildIdentityReply(promptLanguage), meta: "" };
    if (isStatusPrompt(loweredPrompt)) return { text: buildCurrentActivityReply(promptLanguage), meta: "" };
    if (isNegativeCorrectionPrompt(loweredPrompt)) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };
    if (isConfusionPrompt(loweredPrompt)) return { text: buildConfusionReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
    if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
    if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
    if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
      const meta = lastAssistantMeta(state.history);
      if (meta) return { text: meta, meta: "" };
    }
    if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: shorten(previous, 140), meta: "" };
    }
    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }
    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt) && !extractWeatherLocation(intentPrompt)) {
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }
    if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    if (!currentDocs.length && isLiveInfoPrompt(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
    }
    if (currentDocs.length) {
      const currentReply = replyFromDocuments(prompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
    const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
    const combined = dedupeDocuments(localDocs).slice(0, 8);
    const evidence = collectEvidence(effectiveQuery, combined);
    if (evidence.length) {
      const evidenceLanguage = getReplyLanguage(prompt, evidence);
      return {
        text: composeFromEvidence(mode, prompt, evidence, { language: evidenceLanguage, style: replyStyle }),
        meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
      };
    }

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    if (!currentDocs.length && !historyDocs.length) {
      if (isKnowledgeLookupPrompt(intentPrompt, loweredIntentPrompt, mode)) {
        const knowledgeReply = await buildKnowledgeReply(intentPrompt, promptLanguage);
        if (knowledgeReply) return knowledgeReply;
      }
      return { text: buildGeneralChatFallback(intentPrompt, promptLanguage, replyStyle), meta: "" };
    }

    return { text: buildNoEvidenceReply(promptLanguage, currentDocs.length > 0 || historyDocs.length > 0, null), meta: "" };
  }

  function replyFromDocuments(prompt, documents, options = {}) {
    const language = options.language || getReplyLanguage(prompt, []);
    const style = options.style || getReplyStyle(prompt, detectMode(lower(prompt)));
    const evidence = collectEvidence(prompt, documents);
    if (evidence.length) {
      return {
        text: composeFromEvidence(detectMode(lower(prompt)), prompt, evidence, { language, style }),
        meta: options.metaPrefix ? `${options.metaPrefix}: ${unique(evidence.map((item) => item.source)).join(", ")}` : buildSourcesLine(evidence, { language }),
      };
    }
    const representatives = [];
    documents.forEach((document) => {
      pickRepresentativeSentences(document.text || "", detectMode(lower(prompt)), 2).forEach((sentence) => {
        representatives.push({ sentence, source: document.title, category: "attachment", score: 1 });
      });
    });
    if (representatives.length) {
      return {
        text: composeFromEvidence(detectMode(lower(prompt)), prompt, representatives, { language, style }),
        meta: options.metaPrefix ? `${options.metaPrefix}: ${unique(representatives.map((item) => item.source)).join(", ")}` : buildSourcesLine(representatives, { language }),
      };
    }
    if (documents.every((document) => document.kind === "image")) {
      return {
        text: formatImageLimitResponse(language, documents.map((document) => document.title)),
        meta: options.metaPrefix ? `${options.metaPrefix}: ${documents.map((document) => document.title).join(", ")}` : "",
      };
    }
    return null;
  }

  function attachmentsToDocuments(attachments) {
    return (attachments || []).map((attachment) => ({ title: attachment.name, url: "", text: attachment.text || attachment.detail || attachment.summary || "", category: "attachment", kind: attachment.kind })).filter((document) => document.text || document.kind === "image");
  }

  function collectHistoryDocuments(history) {
    const docs = [];
    history.forEach((entry) => Array.isArray(entry.attachments) && docs.push(...attachmentsToDocuments(entry.attachments)));
    return docs;
  }

  function searchDocuments(query, documents, topN) {
    const tokens = tokenizeMeaningful(query);
    if (!tokens.length) return documents.slice(0, topN);
    return documents
      .map((document, index) => ({ index, score: window.PurpleBeeCore.scoreDocument(tokens, document) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topN)
      .map((entry) => documents[entry.index]);
  }

  function appendMessage(role, content, entry) {
    const messages = document.getElementById("messages");
    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;
    if (entry && entry.id) wrapper.dataset.entryId = entry.id;
    const avatar = document.createElement("div");
    avatar.className = `avatar ${role}`;
    avatar.innerHTML = role === "ai" ? AI_AVATAR_SVG : '<i class="ph ph-user" style="font-size:16px;color:white"></i>';
    if (role === "ai") avatar.style.background = "none";
    const column = document.createElement("div");
    column.className = "message-column";
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    bubble.innerHTML = role === "ai" ? renderMarkdown(content) : escapeHtml(content || "(첨부 자료)").replace(/\n/g, "<br>");
    column.appendChild(bubble);
    if (entry && entry.attachments && entry.attachments.length) column.appendChild(renderAttachments(entry.attachments));
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    if (role === "ai") {
      const lang = getActiveUiLanguage();
      const copyLabel = lang === "ko" ? "복사" : lang === "ja" ? "コピー" : "Copy";
      const reportLabel = lang === "ko" ? "신고" : lang === "ja" ? "報告" : "Report";
      actions.innerHTML = `<button class="msg-action-btn" onclick="copyText(this)"><i class="ph ph-copy"></i> ${copyLabel}</button><button class="msg-action-btn" onclick="reportMessage(this)"><i class="ph ph-flag"></i> ${reportLabel}</button><button class="msg-action-btn" onclick="regenerate()"><i class="ph ph-arrow-clockwise"></i></button>`;
    }
    column.appendChild(actions);
    wrapper.appendChild(avatar);
    wrapper.appendChild(column);
    messages.appendChild(wrapper);
    scrollBottom();
    return bubble;
  }

  function renderAttachments(attachments) {
    const container = document.createElement("div");
    container.className = "message-attachments";
    attachments.forEach((attachment) => {
      const item = document.createElement("div");
      item.className = "message-attachment";
      item.innerHTML = `<div class="message-attachment-name">${escapeHtml(attachment.name)}</div><div class="message-attachment-desc">${escapeHtml(compactLabel(attachment))}</div>${attachment.detail ? `<div class="message-attachment-inline">${escapeHtml(shorten(attachment.detail, 180))}</div>` : ""}`;
      container.appendChild(item);
    });
    return container;
  }

  function appendTyping() {
    const messages = document.getElementById("messages");
    const id = `typing_${Date.now()}`;
    const wrapper = document.createElement("div");
    wrapper.className = "message ai";
    wrapper.id = id;
    wrapper.innerHTML = `<div class="avatar ai" style="background:none">${AI_AVATAR_SVG}</div><div class="bubble ai"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
    messages.appendChild(wrapper);
    scrollBottom();
    return id;
  }

  function removeTyping(id) { const node = document.getElementById(id); if (node) node.remove(); }
  function showChat() { document.getElementById("home").style.display = "none"; document.getElementById("messages").style.display = "flex"; }
  function showHome() { document.getElementById("home").style.display = "flex"; document.getElementById("messages").style.display = "none"; }
  function scrollBottom() { const area = document.getElementById("chat-area"); area.scrollTop = area.scrollHeight; }
  function renderMarkdown(text) { try { return DOMPurify.sanitize(marked.parse(text || "")); } catch (error) { return escapeHtml(text).replace(/\n/g, "<br>"); } }

  async function streamToBubble(bubble, text) {
    if (state.settings.typingSpeed === "instant") {
      bubble.innerHTML = renderMarkdown(text);
      scrollBottom();
      return;
    }
    const chunks = text.match(/\S+\s*|\n/g) || [text];
    let current = "";
    const delay = state.settings.typingSpeed === "fast" ? 6 : 14;
    const whitespaceDelay = state.settings.typingSpeed === "fast" ? 4 : 8;
    for (const chunk of chunks) {
      current += chunk;
      bubble.innerHTML = renderMarkdown(current);
      scrollBottom();
      await new Promise((resolve) => setTimeout(resolve, chunk.trim() ? delay : whitespaceDelay));
    }
  }

  function newChat() {
    if (state.history.length) saveConversation();
    state.history = [];
    state.sessionId = createSessionId();
    document.getElementById("messages").innerHTML = "";
    showHome();
    loadConversationList();
  }

  function quickSend(text) {
    const field = document.getElementById("input-field");
    field.value = text;
    field.dispatchEvent(new Event("input"));
    void sendMessage();
  }

  function quickAction(action) {
    const language = getActiveUiLanguage();
    const prompts = {
      ko: {
        "summarize-doc": "첨부한 문서의 핵심만 정리해줘",
        "solve-issue": "첨부한 코드와 로그를 보고 문제 원인과 해결 순서를 알려줘",
        "review-screenshot": "붙인 화면 캡처를 기준으로 문제를 찾아줘",
        "continue-context": "방금 대화를 이어서 다음 작업을 제안해줘",
      },
      ja: {
        "summarize-doc": "添付した文書の要点だけ簡潔にまとめてください",
        "solve-issue": "添付したコードとログを見て、原因と解決の順番を教えてください",
        "review-screenshot": "添付したスクリーンショットをもとに問題点を見つけてください",
        "continue-context": "今の会話を続けて次の作業を提案してください",
      },
      en: {
        "summarize-doc": "Summarize the key points from the attached document.",
        "solve-issue": "Review the attached code and logs, then explain the likely cause and the fix order.",
        "review-screenshot": "Review the attached screenshot and point out what looks wrong.",
        "continue-context": "Continue the recent conversation and suggest the next steps.",
      },
    };
    const prompt = (prompts[language] && prompts[language][action]) || prompts.en[action] || prompts.ko[action] || "";
    quickSend(prompt);
  }

  function saveConversation() {
    if (!state.settings.rememberChats) return;
    if (!state.history.length) return;
    const firstUser = state.history.find((entry) => entry.role === "user");
    if (!firstUser) return;
    const title = shorten(trim(firstUser.content) || ((firstUser.attachments && firstUser.attachments[0] && firstUser.attachments[0].name) || "첨부 자료 대화"), 36);
    const conversation = { id: state.sessionId, title, history: state.history.map(serializeMessage), time: Date.now() };
    const index = state.conversations.findIndex((item) => item.id === state.sessionId);
    if (index >= 0) state.conversations[index] = conversation;
    else state.conversations.unshift(conversation);
    state.conversations.sort((left, right) => right.time - left.time);
    state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
    persistConversations();
  }

  function loadConversationList() {
    const list = document.getElementById("chat-history-list");
    list.innerHTML = "";
    if (!state.settings.rememberChats) return;
    state.conversations.forEach((conversation) => {
      const item = document.createElement("div");
      item.className = `history-item${conversation.id === state.sessionId ? " active" : ""}`;
      item.innerHTML = `<i class="ph ph-chat-circle" style="font-size:13px;flex-shrink:0"></i>${escapeHtml(conversation.title)}`;
      item.onclick = () => loadConversation(conversation);
      list.appendChild(item);
    });
  }

  function loadConversation(conversation) {
    state.sessionId = conversation.id;
    state.history = (conversation.history || []).map(deserializeMessage);
    document.getElementById("messages").innerHTML = "";
    showChat();
    state.history.forEach((entry) => appendMessage(entry.role === "assistant" ? "ai" : "user", entry.role === "assistant" ? (entry.meta ? `${entry.content}\n\n> ${entry.meta}` : entry.content) : entry.content, entry));
    loadConversationList();
  }

  function persistConversations() {
    if (!state.settings.rememberChats) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations));
    } catch (error) {
      state.conversations = state.conversations.slice(0, 8).map((conversation) => ({ ...conversation, history: conversation.history.map((entry) => ({ ...entry, attachments: (entry.attachments || []).map((attachment) => ({ ...attachment, text: (attachment.text || "").slice(0, 2000), detail: shorten(attachment.detail || "", 120) })) })) }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations));
    }
  }

  function loadStoredConversations(rememberChats = true) {
    if (!rememberChats) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function serializeMessage(entry) {
    return {
      id: entry.id,
      role: entry.role,
      content: entry.content,
      meta: entry.meta || "",
      attachments: (entry.attachments || []).map((attachment) => ({ id: attachment.id, name: attachment.name, size: attachment.size, type: attachment.type, extension: attachment.extension, kind: attachment.kind, summary: shorten(attachment.summary || "", 160), detail: shorten(attachment.detail || "", 240), text: (attachment.text || "").slice(0, STORAGE_TEXT_LIMIT), width: attachment.width || null, height: attachment.height || null })),
    };
  }

  function deserializeMessage(entry) {
    return { id: entry.id || `msg_${Date.now()}`, role: entry.role === "assistant" ? "assistant" : "user", content: entry.content || "", meta: entry.meta || "", attachments: Array.isArray(entry.attachments) ? entry.attachments.map((attachment) => ({ ...attachment, previewUrl: "" })) : [] };
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    document.getElementById("sidebar").classList.toggle("collapsed", !state.sidebarOpen);
  }

  function toggleAttachMenu(event) { event.stopPropagation(); document.getElementById("model-menu").classList.remove("open"); document.getElementById("attach-menu").classList.toggle("open"); }
  function toggleModelMenu(event) { event.stopPropagation(); document.getElementById("attach-menu").classList.remove("open"); document.getElementById("model-menu").classList.toggle("open"); }
  function toggleDeepThink(checkbox) { const ui = getUiText(); state.deepThink = checkbox.checked; showToast(state.deepThink ? ui.deepThinkOn : ui.deepThinkOff); }
  function openFilePicker() { document.getElementById("attach-menu").classList.remove("open"); document.getElementById("file-input").click(); }
  function openSettings() {
    document.getElementById("attach-menu").classList.remove("open");
    document.getElementById("model-menu").classList.remove("open");
    document.getElementById("settings-backdrop").classList.add("open");
    hydrateSettingsControls();
  }
  function closeSettings(event) {
    if (event && event.target && event.target !== document.getElementById("settings-backdrop")) return;
    document.getElementById("settings-backdrop").classList.remove("open");
  }
  function toggleRememberChats(checkbox) {
    const ui = getUiText();
    state.settings.rememberChats = !!checkbox.checked;
    persistSettings();
    if (!state.settings.rememberChats) {
      state.conversations = [];
      localStorage.removeItem(STORAGE_KEY);
      loadConversationList();
      showToast(ui.rememberOff);
      return;
    }
    state.conversations = loadStoredConversations(true);
    loadConversationList();
    showToast(ui.rememberOn);
  }
  function clearStoredChats() {
    const ui = getUiText();
    state.conversations = [];
    localStorage.removeItem(STORAGE_KEY);
    loadConversationList();
    showToast(ui.chatsCleared);
  }

  async function pasteClipboardImage() {
    document.getElementById("attach-menu").classList.remove("open");
    if (!navigator.clipboard || !navigator.clipboard.read) { showToast("브라우저가 클립보드 이미지를 직접 읽지 못합니다. Ctrl+V나 파일 선택을 사용해 주세요."); return; }
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], `screenshot-${Date.now()}.png`, { type }));
      }
      if (!files.length) { showToast("클립보드에 이미지가 없습니다."); return; }
      await addAttachments(files);
    } catch (error) {
      showToast("클립보드 이미지를 읽지 못했습니다. Ctrl+V로 다시 시도해 주세요.");
    }
  }

  function showToast(message) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function copyText(button) {
    const bubble = button.closest(".message").querySelector(".bubble");
    navigator.clipboard.writeText(bubble.innerText).then(() => showToast(getUiText().copied));
  }

  function reportMessage(button) {
    const ui = getUiText();
    const bubble = button.closest(".message").querySelector(".bubble");
    let reports = [];
    try {
      reports = JSON.parse(localStorage.getItem(REPORTS_KEY) || "[]");
      if (!Array.isArray(reports)) reports = [];
    } catch (error) {
      reports = [];
    }
    reports.unshift({ text: bubble.innerText, time: Date.now(), sessionId: state.sessionId });
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports.slice(0, 50)));
    showToast(ui.reportSaved);
  }

  async function regenerate() {
    if (state.isStreaming) return;
    while (state.history.length && state.history[state.history.length - 1].role === "assistant") state.history.pop();
    const lastUser = state.history[state.history.length - 1];
    if (!lastUser || lastUser.role !== "user") return;
    document.getElementById("messages").innerHTML = "";
    state.history.forEach((entry) => appendMessage(entry.role === "assistant" ? "ai" : "user", entry.role === "assistant" ? (entry.meta ? `${entry.content}\n\n> ${entry.meta}` : entry.content) : entry.content, entry));
    state.isStreaming = false;
    await sendSyntheticReply(lastUser);
  }

  async function sendSyntheticReply(userEntry) {
    state.isStreaming = true;
    document.getElementById("send-btn").disabled = true;
    const typingId = appendTyping();
    try {
      const reply = await buildReply(userEntry);
      removeTyping(typingId);
      if (reply.code) showToast(`${reply.code} · 모델 응답이 비어 fallback으로 전환됨`);
      const aiEntry = { id: `msg_${Date.now()}_ai`, role: "assistant", content: reply.text, attachments: [], meta: reply.meta || "" };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
      saveConversation();
      loadConversationList();
    } finally {
      state.isStreaming = false;
      document.getElementById("send-btn").disabled = false;
    }
  }

  function normalizeFileText(text) { return normalizeWhitespace(String(text || "").replace(/\u0000/g, " ").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n")); }
  function summarizeText(text) { return shorten(normalizeWhitespace(text).split(/(?<=[.!?])\s+/).slice(0, 2).join(" "), 180); }
  function compactLabel(attachment) { return attachment.summary || `${formatBytes(attachment.size)} · ${attachment.type}`; }
  function formatBytes(size) { if (!size) return "0B"; const units = ["B","KB","MB","GB"]; let value = size; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; } return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)}${units[index]}`; }
  function createSessionId() { return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
  function escapeHtml(text) { return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

  async function readImageInfo(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const node = new Image();
        node.onload = () => resolve(node);
        node.onerror = reject;
        node.src = url;
      });
      return { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function extractPdfText(buffer) {
    const raw = new TextDecoder("latin1").decode(new Uint8Array(buffer));
    const matches = raw.match(/\((?:\\.|[^()]){1,500}\)/g) || [];
    return normalizeWhitespace(matches.slice(0, 600).map((match) => match.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, " ").replace(/\\t/g, " ").replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\")).filter((text) => /[A-Za-z가-힣0-9]/.test(text)).join(" "));
  }

  async function loadDialogueBank(forceReload = false) {
    if (!forceReload && state.dialogueExamples.length) return state.dialogueExamples;
    if (!forceReload && state.dialogueLoading) return state.dialogueLoading;
    state.dialogueLoading = (async () => {
      try {
        const response = await fetch(DIALOGUE_BANK_URL, { cache: "no-store" });
        if (!response.ok) return state.dialogueExamples;
        const text = await response.text();
        state.dialogueExamples = parseDialogueBank(text);
        return state.dialogueExamples;
      } catch (_error) {
        return state.dialogueExamples;
      } finally {
        state.dialogueLoading = null;
      }
    })();
    return state.dialogueLoading;
  }

  function parseDialogueBank(text) {
    const examples = [];
    const seen = new Set();
    let pendingPrompt = "";
    String(text || "").split(/\r?\n/).forEach((rawLine) => {
      const line = trim(rawLine);
      if (!line) return;
      const assistantLine = line.match(/^purple bee:\s*(.+)$/i);
      if (assistantLine) {
        const message = trim(assistantLine[1]);
        if (!pendingPrompt || !message) return;
        const key = `${normalizeDialogueText(pendingPrompt)}|${normalizeDialogueText(message)}`;
        if (!seen.has(key)) {
          seen.add(key);
          examples.push({
            prompt: pendingPrompt,
            answer: message,
            normalizedPrompt: normalizeDialogueText(pendingPrompt),
            tokens: tokenizeDialoguePrompt(pendingPrompt),
          });
        }
        pendingPrompt = "";
        return;
      }
      const match = line.match(/^([^:]{1,24}):\s*(.+)$/);
      if (match) {
        const speaker = lower(trim(match[1]));
        const message = trim(match[2]);
        if (!message) return;
        if (speaker.includes("user") || speaker.length <= 8) {
          pendingPrompt = message;
        }
        return;
      }
      if (!line.includes(":") && line.length <= 120) {
        pendingPrompt = trim(line.replace(/^\S+\s+/, ""));
      }
    });
    return examples;
  }

  function normalizeDialogueText(text) {
    return lower(String(text || ""))
      .replace(/[`"'“”‘’()[\]{}.,!?;:/\\|<>@#%^&*_+=~-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeDialoguePrompt(text) {
    return unique(normalizeDialogueText(text).split(" ").filter((token) => token.length >= 2));
  }

  function scoreDialogueExample(prompt, normalizedPrompt, promptTokens, example) {
    if (!example || !example.normalizedPrompt) return 0;
    if (example.normalizedPrompt === normalizedPrompt) return 120;
    if (!normalizedPrompt) return 0;
    let score = 0;
    if (normalizedPrompt.includes(example.normalizedPrompt) || example.normalizedPrompt.includes(normalizedPrompt)) score += 72;
    let overlap = 0;
    promptTokens.forEach((token) => {
      if (example.tokens.includes(token)) overlap += 1;
    });
    score += overlap * 14;
    if (prompt.endsWith("?") && example.prompt.endsWith("?")) score += 4;
    if (prompt.length <= 20 && example.prompt.length <= 28) score += 2;
    return score;
  }

  function findDialogueReply(prompt) {
    if (!state.dialogueExamples.length) return "";
    const normalizedPrompt = normalizeDialogueText(prompt);
    const promptTokens = tokenizeDialoguePrompt(prompt);
    if (!normalizedPrompt && !promptTokens.length) return "";
    const lastReply = normalizeDialogueText(lastAssistantText(state.history));
    const ranked = state.dialogueExamples
      .map((example) => ({ example, score: scoreDialogueExample(prompt, normalizedPrompt, promptTokens, example) }))
      .filter((entry) => entry.score >= (promptTokens.length >= 2 ? 18 : 60))
      .sort((left, right) => right.score - left.score);
    for (const entry of ranked) {
      if (normalizeDialogueText(entry.example.answer) !== lastReply) return entry.example.answer;
    }
    return ranked.length ? ranked[0].example.answer : "";
  }

  function shouldCarryPreviousPrompt(prompt) {
    const raw = trim(prompt);
    const loweredPrompt = lower(raw);
    const exactCarryPrompts = new Set(["?", "??", "website", "site"]);
    if (!loweredPrompt) return false;
    if (containsAny(loweredPrompt, ["website", "site", "again", "continue", "before"])) return true;
    if (exactCarryPrompts.has(loweredPrompt)) return true;
    return false;
  }

  function buildIntentPrompt(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    if (!shouldCarryPreviousPrompt(prompt)) return prompt;
    const previousUser = previousUserPrompt(userEntry.id);
    return previousUser ? `${previousUser} ${prompt}` : prompt;
  }

  function buildCurrentActivityReply(language) {
    return language === "ko"
      ? "\uC9C0\uAE08\uC740 \uB124 \uC9C8\uBB38\uC5D0 \uB2F5\uD558\uACE0 \uC788\uC5B4."
      : "Right now I am reading your question and answering it.";
  }

  function buildTopicAbilityReply(topic, language) {
    const loweredTopic = lower(topic);
    if (containsAny(loweredTopic, ["python", "\uD30C\uC774\uC36C"])) {
      return language === "ko"
        ? "\uC751, \uD30C\uC774\uC36C \uC54C\uC544. \uBB38\uBC95 \uC124\uBA85, \uC624\uB958 \uBD84\uC11D, \uCF54\uB4DC \uC218\uC815\uAE4C\uC9C0 \uB3C4\uC640\uC904 \uC218 \uC788\uC5B4."
        : "Yes, I know Python. I can help with syntax, errors, code changes, and debugging.";
    }
    if (containsAny(loweredTopic, ["roblox", "lua", "\uB85C\uBE14\uB85D\uC2A4"])) {
      return language === "ko"
        ? "\uC751, \uB85C\uBE14\uB85D\uC2A4\uB3C4 \uB3C4\uC640\uC904 \uC218 \uC788\uC5B4. Roblox Studio, Lua, \uAC8C\uC784 \uAD6C\uC870, \uBC84\uADF8 \uBD84\uC11D \uCABD\uC73C\uB85C \uC774\uC5B4\uAC08 \uC218 \uC788\uC5B4."
        : "Yes, I can help with Roblox too, especially Roblox Studio, Lua, structure, and bug analysis.";
    }
    if (containsAny(loweredTopic, ["weather", "\uB0A0\uC528"])) {
      return language === "ko"
        ? "\uC751, \uB0A0\uC528\uB3C4 \uBC14\uB85C \uD655\uC778\uD574\uC904 \uC218 \uC788\uC5B4. \uC9C0\uC5ED\uBA85\uB9CC \uAC19\uC774 \uC801\uC5B4\uC8FC\uBA74 \uBC14\uB85C \uBCFC\uAC8C."
        : "Yes, I can check weather too. Just include the location and I will look it up.";
    }
    return language === "ko"
      ? `\uC751, **${topic}** \uCABD\uB3C4 \uB3C4\uC640\uC904 \uC218 \uC788\uC5B4. \uC124\uBA85, \uC608\uC2DC, \uBE44\uAD50, \uBB38\uC81C \uD574\uACB0 \uC911 \uC6D0\uD558\uB294 \uBC29\uD5A5\uC744 \uB9D0\uD574\uC918.`
      : `Yes, I can help with **${topic}** too. Tell me whether you want an explanation, examples, comparison, or troubleshooting.`;
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = previousUserPrompt(currentEntryId);
    if (language === "ko") {
      if (previous) return `\uC54C\uACA0\uC5B4. \uBC29\uAE08 \uB2F5\uC740 \uC811\uACE0 **${shorten(previous, 42)}** \uCABD\uC73C\uB85C \uB2E4\uC2DC \uC9C1\uC811 \uB2F5\uD560\uAC8C.`;
      return "\uC54C\uACA0\uC5B4. \uBC29\uAE08 \uB2F5\uC740 \uC811\uACE0 \uB2E4\uC2DC \uC9C1\uC811 \uB2F5\uD560\uAC8C.";
    }
    return "Fair point. I will drop the last direction and answer more directly.";
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const focus = shorten(trim(prompt), 64);
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) return `\uC751, **${focus}** \uCABD\uC73C\uB85C \uC774\uC5B4 \uB2F5\uD560 \uC218 \uC788\uC5B4. \uC124\uBA85, \uC608\uC2DC, \uBE44\uAD50, \uBB38\uC81C \uD574\uACB0 \uC911 \uC6D0\uD558\uB294 \uD615\uC2DD\uB9CC \uB9D0\uD574\uC918.`;
      if (style === "coach") return `\uC88B\uC544. **${focus}** \uAE30\uC900\uC73C\uB85C \uBC14\uB85C \uC815\uB9AC\uD574\uBCFC\uAC8C. \uC6D0\uD558\uBA74 \uC6B0\uC120\uC21C\uC704\uB098 \uB2E4\uC74C \uB2E8\uACC4 \uC704\uC8FC\uB85C \uB9DE\uCD94\uACA0\uC5B4.`;
      return `\uC88B\uC544. **${focus}** \uAE30\uC900\uC73C\uB85C \uC774\uC5B4\uAC08\uAC8C. \uD544\uC694\uD55C \uC790\uB8CC\uB098 \uAE30\uC900\uC774 \uC788\uC73C\uBA74 \uD55C \uC904\uB9CC \uB354 \uBD99\uC5EC\uC918.`;
    }
    return `Okay. I can continue from **${focus}**. If you want, tell me whether you want an explanation, examples, comparison, or troubleshooting.`;
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (topic) return buildTopicAbilityReply(topic, language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["\uC9C0\uAE08 \uBB50\uD574", "\uC9C0\uAE08 \uBB50 \uD574", "\uBB50\uD574"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (containsAny(loweredPrompt, ["python", "\uD30C\uC774\uC36C"])) return buildTopicAbilityReply("python", language);
    if (containsAny(loweredPrompt, ["roblox", "\uB85C\uBE14\uB85D\uC2A4"])) return buildTopicAbilityReply("roblox", language);
    if (containsAny(loweredPrompt, ["weather", "\uB0A0\uC528"])) return buildTopicAbilityReply("weather", language);
    if (containsAny(loweredPrompt, ["python", "roblox", "lua", "programming", "coding", "\uD30C\uC774\uC36C", "\uB85C\uBE14\uB85D\uC2A4", "\uCF54\uB529"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["what can you do", "how can you help"])) return buildCapabilityReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  function shouldUseHistoryDocuments(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "attachment", "attachments", "document", "documents", "file", "files", "screenshot", "image", "log", "code", "config",
      "continue", "again", "previous", "before"
    ]) || isExplicitContinuationPrompt(loweredPrompt);
  }

  async function tryModelFirstReply(prompt, language) {
    await loadDialogueBank();
    const bankReply = findDialogueReply(prompt);
    if (bankReply) return bankReply;
    try {
      if (!engine.model) await ensureEngineReady();
    } catch (_error) {
      return "";
    }
    if (!engine.model) return "";
    const generated = trim(engine.model.generateReply(prompt, 160, 0.72));
    if (!generated || !looksNatural(generated)) return "";
    if (normalizeDialogueText(generated) === normalizeDialogueText(lastAssistantText(state.history))) return "";
    const loweredGenerated = lower(generated);
    if (containsAny(loweredGenerated, ["localhost server inference", "question core", "at a glance"])) return "";
    return language === "ko" ? generated : ensureSentenceEnding(generated);
  }

  function renderModelRegistry() {
    const registry = state.modelRegistry;
    const header = document.getElementById("model-menu-header");
    const list = document.getElementById("model-version-list");
    const topSep = document.getElementById("model-version-sep-top");
    const bottomSep = document.getElementById("model-version-sep-bottom");
    const label = getRuntimeModelLabel();
    const currentId = getSelectedRuntimeModelId() || (registry && registry.current_model_id ? registry.current_model_id : "");
    if (header) header.textContent = registry && registry.family_name ? registry.family_name : "Purple Bee";
    setEngineStatus(engine.model ? "ready" : engine.loading ? "loading" : "idle", label, getLocalStatusMessage(engine.model ? "ready" : engine.loading ? "loading" : "idle"));
    if (!list) return;
    list.innerHTML = "";
    list.style.display = "none";
    if (topSep) topSep.style.display = "none";
    if (bottomSep) bottomSep.style.display = "none";
    if (!registry || !Array.isArray(registry.models) || !registry.models.length) return;
    let rendered = 0;
    registry.models.forEach((model) => {
      if ((currentId && model.id === currentId) || model.current) return;
      const item = document.createElement("div");
      item.className = "model-menu-item";
      const badges = [];
      if (model.latest) badges.push("latest");
      if (model.trainable) badges.push("trainable");
      item.innerHTML = `
        <span class="item-icon" style="background:rgba(139,92,246,.12)">
          <i class="ph ph-cube" style="color:var(--accent-light)"></i>
        </span>
        <span>
          <div style="color:var(--text)">${escapeHtml(model.display_name || model.id || "Purple Bee")}</div>
          <div style="font-size:10px;color:var(--text-3)">${escapeHtml([model.architecture_name || "", badges.join(" · ")].filter(Boolean).join(" · "))}</div>
        </span>
      `;
      list.appendChild(item);
      rendered += 1;
    });
    if (rendered > 0) {
      list.style.display = "";
      if (topSep) topSep.style.display = "";
      if (bottomSep) bottomSep.style.display = "";
    }
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const intentPrompt = buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredPrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(prompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);

    if (!currentDocs.length && (isWebsiteSearchPrompt(loweredIntentPrompt) || containsAny(loweredIntentPrompt, ["search", "website", "\uAC80\uC0C9", "\uC6F9\uC0AC\uC774\uD2B8"]))) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && (isWeatherQuestion(loweredIntentPrompt) || containsAny(loweredIntentPrompt, ["weather", "forecast", "\uB0A0\uC528", "\uAE30\uC628"]))) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(prompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(prompt, evidence);
        return {
          text: composeFromEvidence(mode, prompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    if (isNegativeCorrectionPrompt(loweredPrompt)) {
      return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
    return { text: buildGeneralChatFallback(intentPrompt, promptLanguage, replyStyle), meta: "" };
  }

  function buildGreetingReply(language) {
    const seed = `${language}:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "\uC548\uB155. \uBB50\uBD80\uD130 \uAC19\uC774 \uBCFC\uAE4C?",
        "\uC548\uB155. \uAD81\uAE08\uD55C \uAC70 \uD3B8\uD558\uAC8C \uB9D0\uD574\uC918.",
        "\uC548\uB155. \uC624\uB298\uC740 \uBB50 \uB3C4\uC640\uC904\uAE4C?",
      ]);
    }
    if (language === "ja") {
      return pickReplyVariant(seed, [
        "\u3053\u3093\u306B\u3061\u306F\u3002\u4F55\u304B\u3089\u898B\u307E\u3057\u3087\u3046\u304B\u3002",
        "\u3053\u3093\u306B\u3061\u306F\u3002\u6C17\u8EFD\u306B\u8A71\u3057\u304B\u3051\u3066\u304F\u3060\u3055\u3044\u3002",
        "\u3053\u3093\u306B\u3061\u306F\u3002\u4ECA\u65E5\u306F\u4F55\u3092\u624B\u4F1D\u3048\u307E\u3059\u304B\u3002",
      ]);
    }
    if (language === "zh") {
      return pickReplyVariant(seed, [
        "\u4F60\u597D\u3002\u60F3\u5148\u804A\u54EA\u4E00\u5757\uff1F",
        "\u4F60\u597D\u3002\u6709\u4EC0\u4E48\u60F3\u76F4\u63A5\u95EE\u7684\u5C31\u8BF4\u5427\u3002",
        "\u4F60\u597D\u3002\u4ECA\u5929\u60F3\u5148\u5904\u7406\u4EC0\u4E48\uff1F",
      ]);
    }
    return pickReplyVariant(seed, [
      "Hi. What do you want to start with?",
      "Hi. Ask me anything you want to go over.",
      "Hi. What should we work on first?",
    ]);
  }

  function buildThanksReply(language) {
    if (language === "ko") return "\uCC9C\uB9CC\uC5D0. \uADF8\uB7FC \uC774\uC5B4\uC11C \uACC4\uC18D \uD574\uBCF4\uC790.";
    if (language === "ja") return "\u3069\u3046\u3044\u305F\u3057\u307E\u3057\u3066\u3002\u305D\u306E\u307E\u307E\u7D9A\u3051\u307E\u3057\u3087\u3046\u3002";
    if (language === "zh") return "\u4E0D\u5BA2\u6C14\u3002\u90A3\u5C31\u7EE7\u7EED\u5427\u3002";
    return "Anytime. We can keep going.";
  }

  function buildIdentityReply(language) {
    if (language === "ko") return "\uB098\uB294 Purple Bee\uC57C. \uC774 \uC6F9\uC0AC\uC774\uD2B8\uC5D0\uC11C \uB3D9\uC791\uD558\uBA74\uC11C \uB300\uD654, \uBB38\uC11C, \uCF54\uB4DC, \uB9C1\uD06C \uC815\uB9AC\uB97C \uB3D5\uB294 \uCABD\uC73C\uB85C \uB9DE\uCD94\uACE0 \uC788\uC5B4.";
    if (language === "ja") return "\u79C1\u306F Purple Bee \u3067\u3059\u3002\u3053\u306E\u30A6\u30A7\u30D6\u30B5\u30A4\u30C8\u3067\u52D5\u304D\u3001\u4F1A\u8A71\u3001\u6587\u66F8\u3001\u30B3\u30FC\u30C9\u3001\u30EA\u30F3\u30AF\u306E\u6574\u7406\u3092\u624B\u4F1D\u3044\u307E\u3059\u3002";
    if (language === "zh") return "\u6211\u662F Purple Bee\u3002\u6211\u5728\u8FD9\u4E2A\u7F51\u7AD9\u91CC\u8FD0\u884C\uff0c\u4E3B\u8981\u5E2E\u4F60\u5904\u7406\u5BF9\u8BDD\u3001\u6587\u6863\u3001\u4EE3\u7801\u548C\u94FE\u63A5\u6574\u7406\u3002";
    return "I'm Purple Bee. I run on this website and help with conversation, documents, code, and links.";
  }

  function buildCurrentActivityReply(language) {
    const seed = `${language}:${lastAssistantText(state.history).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "\uC9C0\uAE08\uC740 \uB108\uB791 \uB300\uD654\uD558\uACE0 \uC788\uC5B4. \uAD81\uAE08\uD55C \uAC70 \uBC14\uB85C \uC774\uC5B4\uC11C \uB9D0\uD574\uC918.",
        "\uC9C0\uAE08 \uB124 \uBA54\uC2DC\uC9C0 \uBCF4\uACE0 \uB2F5\uD558\uACE0 \uC788\uC5B4. \uACC4\uC18D \uB9D0\uD574\uC918.",
        "\uC9C0\uAE08\uC740 \uB108 \uC9C8\uBB38 \uBC1B\uC544\uC11C \uD55C \uAC00\uC9C0\uC529 \uBCF4\uACE0 \uC788\uC5B4.",
      ]);
    }
    if (language === "ja") return "\u4ECA\u306F\u3042\u306A\u305F\u306E\u8CEA\u554F\u3092\u898B\u306A\u304C\u3089\u8FD4\u4FE1\u3057\u3066\u3044\u307E\u3059\u3002";
    if (language === "zh") return "\u6211\u73B0\u5728\u6B63\u5728\u770B\u4F60\u7684\u95EE\u9898\u5E76\u56DE\u7B54\u3002";
    return pickReplyVariant(seed, [
      "Right now I'm talking with you and working through your question.",
      "I'm reading your message and replying as we go.",
      "I'm here, following your question and answering it.",
    ]);
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = trim(previousUserPrompt(currentEntryId));
    if (language === "ko") {
      if (previous) return `\uC54C\uACA0\uC5B4. \uBC29\uAE08 \uB2F5\uC740 \uBC84\uB9AC\uACE0 **${shorten(previous, 32)}**\uC5D0 \uB9DE\uCD94\uC11C \uB2E4\uC2DC \uB2F5\uD560\uAC8C.`;
      return "\uC54C\uACA0\uC5B4. \uBC29\uAE08 \uB2F5\uC740 \uBC84\uB9AC\uACE0 \uB2E4\uC2DC \uB9DE\uCD94\uC11C \uB2F5\uD560\uAC8C.";
    }
    if (language === "ja") return "\u308F\u304B\u308A\u307E\u3057\u305F\u3002\u3055\u3063\u304D\u306E\u8FD4\u7B54\u306F\u6D41\u3057\u3066\u3001\u3082\u3046\u4E00\u5EA6\u307E\u3063\u3059\u3050\u7B54\u3048\u307E\u3059\u3002";
    if (language === "zh") return "\u660E\u767D\u4E86\u3002\u521A\u624D\u90A3\u4E2A\u56DE\u7B54\u4F5C\u5E9F\uff0C\u6211\u91CD\u65B0\u76F4\u63A5\u56DE\u7B54\u3002";
    return "Understood. I'll drop that last answer and answer more directly.";
  }

  function buildConfusionReply(language) {
    if (language === "ko") return "\uB9DE\uC544. \uBC29\uAE08 \uB2F5\uC774 \uC774\uC0C1\uD588\uC5B4. \uC774\uBC88\uC5D0\uB294 \uB354 \uC9E7\uACE0 \uC9C1\uC811\uC801\uC73C\uB85C \uB2F5\uD574\uBCFC\uAC8C.";
    if (language === "ja") return "\u305D\u306E\u901A\u308A\u3067\u3059\u3002\u3055\u3063\u304D\u306E\u8FD4\u7B54\u306F\u5909\u3067\u3057\u305F\u3002\u4ECA\u5EA6\u306F\u3088\u308A\u76F4\u63A5\u7684\u306B\u7B54\u3048\u307E\u3059\u3002";
    if (language === "zh") return "\u6CA1\u9519\uff0c\u521A\u624D\u90A3\u4E2A\u56DE\u7B54\u5F88\u5947\u602A\u3002\u8FD9\u6B21\u6211\u4F1A\u66F4\u76F4\u63A5\u5730\u56DE\u7B54\u3002";
    return "You're right. That last answer was off. I'll answer more directly this time.";
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "\uC22B\uC790\uB9CC \uC788\uC5B4\uC11C \uC544\uC9C1 \uB73B\uC744 \uC7A1\uAE30 \uC5B4\uB824\uC6CC. \uADF8 \uC22B\uC790\uAC00 \uBB50\uB97C \uB73B\uD558\uB294\uC9C0 \uD55C \uC904\uB9CC \uB354 \uC801\uC5B4\uC918.";
      if (language === "ja") return "\u6570\u5B57\u3060\u3051\u3067\u306F\u307E\u3060\u610F\u5473\u304C\u53D6\u308C\u307E\u305B\u3093\u3002\u4F55\u3092\u8868\u3059\u6570\u5B57\u304B\u4E00\u884C\u3060\u3051\u88DC\u8DB3\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
      if (language === "zh") return "\u73B0\u5728\u53EA\u6709\u6570\u5B57\uff0C\u6211\u8FD8\u65E0\u6CD5\u5224\u65AD\u5B83\u4EE3\u8868\u4EC0\u4E48\u3002\u518D\u8865\u4E00\u53E5\u5C31\u884C\u3002";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (language === "ko") return "\uD55C \uB450 \uB2E8\uC5B4\uB9CC \uC788\uC5B4\uC11C \uB73B\uC744 \uC815\uD655\uD788 \uC7A1\uAE30 \uC5B4\uB824\uC6CC. \uD55C \uC904\uB9CC \uB354 \uBD99\uC5EC\uC8FC\uBA74 \uBC14\uB85C \uC774\uC5B4\uC11C \uB2F5\uD560\uAC8C.";
    if (language === "ja") return "\u307E\u3060\u8A00\u8449\u304C\u77ED\u3059\u304E\u3066\u610F\u5473\u3092\u53D6\u308A\u306B\u304F\u3044\u3067\u3059\u3002\u4E00\u884C\u3060\u3051\u8FFD\u52A0\u3057\u3066\u304F\u308C\u308C\u3070\u3059\u3050\u7D9A\u3051\u307E\u3059\u3002";
    if (language === "zh") return "\u8FD9\u53E5\u8FD8\u592A\u77ED\uff0C\u6211\u4E0D\u592A\u597D\u5224\u65AD\u4F60\u7684\u610F\u601D\u3002\u518D\u8865\u4E00\u53E5\uff0c\u6211\u5C31\u76F4\u63A5\u7EE7\u7EED\u56DE\u7B54\u3002";
    return "That is still too short for me to read cleanly. Add one more short line and I'll continue directly.";
  }

  function shouldCarryPreviousPrompt(prompt) {
    const raw = trim(prompt);
    const loweredPrompt = lower(raw);
    const exactCarryPrompts = new Set(["?", "??", "website", "site", "link", "\uB9C1\uD06C"]);
    if (!loweredPrompt) return false;
    if (containsAny(loweredPrompt, ["website", "site", "link", "\uC6F9\uC0AC\uC774\uD2B8", "\uC0AC\uC774\uD2B8", "\uB9C1\uD06C", "again", "continue", "before"])) return true;
    if (exactCarryPrompts.has(loweredPrompt)) return true;
    return false;
  }

  function isWebsiteSearchPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "\uAC80\uC0C9\uD574",
      "\uAC80\uC0C9\uD574\uC918",
      "\uCC3E\uC544\uC918",
      "\uCC3E\uC544 \uC918",
      "\uC6F9\uC5D0\uC11C",
      "\uC6F9\uC0AC\uC774\uD2B8\uC5D0\uC11C",
      "\uC0AC\uC774\uD2B8\uC5D0\uC11C",
      "\uACF5\uC2DD \uC0AC\uC774\uD2B8",
      "\uD648\uD398\uC774\uC9C0",
      "\uB9C1\uD06C",
      "search for",
      "look up",
      "find",
      "website",
      "site",
      "link",
    ]);
  }

  function extractWebsiteSearchQuery(prompt) {
    return trim(
      normalizeWhitespace(String(prompt || ""))
        .replace(/^(?:\uADF8\uB7FC|\uADF8\uB7EC\uBA74|\uADF8|\uC774\uAC70|\uADF8\uAC70)\s+/u, "")
        .replace(/(?:\uC6F9\uC0AC\uC774\uD2B8\uC5D0\uC11C|\uC6F9\uC5D0\uC11C|\uC778\uD130\uB137\uC5D0\uC11C|\uC0AC\uC774\uD2B8\uC5D0\uC11C|\uC6F9\uC0AC\uC774\uD2B8|\uC0AC\uC774\uD2B8|\uACF5\uC2DD \uC0AC\uC774\uD2B8|\uD648\uD398\uC774\uC9C0|\uAC80\uC0C9\uD574\uC918|\uAC80\uC0C9\uD574 \uC918|\uAC80\uC0C9\uD574|\uCC3E\uC544\uC918|\uCC3E\uC544 \uC918|\uCC3E\uC544|\uC5F4\uC5B4\uC918|\uC5F4\uC5B4 \uC918|\uBCF4\uC5EC\uC918|\uB9C1\uD06C\uB9CC|\uB9C1\uD06C|\uB2EC\uB77C\uACE0|\uC918|search for|look up|find|open|website|site|link|please)/giu, " ")
        .replace(/^(?:\uB85C|\uC744|\uB97C|\uC5D0 \uB300\uD574|\uC5D0\uB300\uD55C|about)\s+/iu, " ")
        .replace(/\s+/g, " ")
    );
  }

  function detectOfficialSite(query) {
    const loweredQuery = lower(query);
    if (containsAny(loweredQuery, ["chatgpt", "gpt", "openai", "\uCC57gpt", "\uC9C0\uD53C\uD2F0"])) {
      return {
        name: "ChatGPT",
        url: "https://chatgpt.com/",
        extraLabel: "OpenAI ChatGPT",
        extraUrl: "https://openai.com/chatgpt/",
      };
    }
    if (containsAny(loweredQuery, ["roblox", "\uB85C\uBE14\uB85D\uC2A4"])) {
      return {
        name: "Roblox",
        url: "https://www.roblox.com/",
        extraLabel: "Roblox Discover",
        extraUrl: "https://www.roblox.com/discover/",
      };
    }
    if (containsAny(loweredQuery, ["python", "\uD30C\uC774\uC36C"])) return { name: "Python", url: "https://www.python.org/" };
    if (containsAny(loweredQuery, ["github", "\uAE43\uD5C8\uBE0C"])) return { name: "GitHub", url: "https://github.com/" };
    if (containsAny(loweredQuery, ["discord", "\uB514\uC2A4\uCF54\uB4DC"])) return { name: "Discord", url: "https://discord.com/" };
    if (containsAny(loweredQuery, ["youtube", "\uC720\uD29C\uBE0C"])) return { name: "YouTube", url: "https://www.youtube.com/" };
    if (containsAny(loweredQuery, ["wikipedia", "\uC704\uD0A4\uD53C\uB514\uC544", "\uC704\uD0A4"])) return { name: "Wikipedia", url: "https://www.wikipedia.org/" };
    if (containsAny(loweredQuery, ["google", "\uAD6C\uAE00"])) return { name: "Google", url: "https://www.google.com/" };
    return null;
  }

  function buildWebsiteSearchReply(prompt, language) {
    const query = extractWebsiteSearchQuery(prompt);
    if (!query || query.length < 2) return null;
    const official = detectOfficialSite(query);
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const duckUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    if (language === "ko") {
      const lines = [];
      if (official) {
        lines.push(`\uC5EC\uAE30 \uC788\uC5B4\uC694. **${query}** \uAD00\uB828 \uB9C1\uD06C\uB294 \uC774\uAC70\uC608\uC694.`);
        lines.push("");
        lines.push(`- [${official.name} \uBC14\uB85C \uC5F4\uAE30](${official.url})`);
        if (official.extraLabel && official.extraUrl) lines.push(`- [${official.extraLabel}](${official.extraUrl})`);
        lines.push(`- [Google\uC5D0\uC11C ${query} \uAC80\uC0C9](${googleUrl})`);
        return { text: lines.join("\n"), meta: "" };
      }
      return {
        text: [
          `**${query}** \uB9C1\uD06C \uC9C0\uC6D0\uC6A9\uC73C\uB85C \uC774\uAC70\uBD80\uD130 \uBCF4\uBA74 \uB3FC\uC694.`,
          "",
          `- [Google\uC5D0\uC11C ${query} \uAC80\uC0C9](${googleUrl})`,
          `- [DuckDuckGo\uC5D0\uC11C ${query} \uAC80\uC0C9](${duckUrl})`,
        ].join("\n"),
        meta: "",
      };
    }
    if (language === "ja") {
      const lines = official
        ? [
            `**${query}** \u306E\u30EA\u30F3\u30AF\u306F\u3053\u3061\u3089\u3067\u3059\u3002`,
            "",
            `- [${official.name}](${official.url})`,
            official.extraLabel && official.extraUrl ? `- [${official.extraLabel}](${official.extraUrl})` : "",
            `- [Google \u3067 ${query} \u3092\u691C\u7D22](${googleUrl})`,
          ].filter(Boolean)
        : [
            `**${query}** \u3092\u63A2\u3059\u306A\u3089\u3053\u3061\u3089\u3067\u3059\u3002`,
            "",
            `- [Google \u3067 ${query} \u3092\u691C\u7D22](${googleUrl})`,
            `- [DuckDuckGo \u3067 ${query} \u3092\u691C\u7D22](${duckUrl})`,
          ];
      return { text: lines.join("\n"), meta: "" };
    }
    if (language === "zh") {
      const lines = official
        ? [
            `**${query}** \u7684\u94FE\u63A5\u5728\u8FD9\u91CC\u3002`,
            "",
            `- [${official.name}](${official.url})`,
            official.extraLabel && official.extraUrl ? `- [${official.extraLabel}](${official.extraUrl})` : "",
            `- [Google \u641C\u7D22 ${query}](${googleUrl})`,
          ].filter(Boolean)
        : [
            `\u8981\u627E **${query}** \u7684\u8BDD\uff0c\u53EF\u4EE5\u5148\u7528\u8FD9\u4E24\u4E2A\u94FE\u63A5\u3002`,
            "",
            `- [Google \u641C\u7D22 ${query}](${googleUrl})`,
            `- [DuckDuckGo \u641C\u7D22 ${query}](${duckUrl})`,
          ];
      return { text: lines.join("\n"), meta: "" };
    }
    const lines = official
      ? [
          `Here you go. These are the most direct links for **${query}**.`,
          "",
          `- [${official.name}](${official.url})`,
          official.extraLabel && official.extraUrl ? `- [${official.extraLabel}](${official.extraUrl})` : "",
          `- [Google search for ${query}](${googleUrl})`,
        ].filter(Boolean)
      : [
          `Here are the fastest links for **${query}**.`,
          "",
          `- [Google search for ${query}](${googleUrl})`,
          `- [DuckDuckGo search for ${query}](${duckUrl})`,
        ];
    return { text: lines.join("\n"), meta: "" };
  }

  function buildOpenQuestionReply(prompt, language, _style) {
    const focus = shorten(trim(prompt), 64);
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) {
        return pickReplyVariant(prompt, [
          `\uC751. **${focus}**\uC5D0 \uB300\uD574 \uBC14\uB85C \uB2F5\uD574\uBCFC\uAC8C.`,
          `\uC88B\uC544. **${focus}** \uCABD\uC73C\uB85C \uBC14\uB85C \uC774\uC5B4\uAC08\uAC8C.`,
          `\uADF8\uB798. **${focus}**\uB97C \uAE30\uC900\uC73C\uB85C \uBC14\uB85C \uB9D0\uD574\uBCFC\uAC8C.`,
        ]);
      }
      return pickReplyVariant(prompt, [
        `\uC88B\uC544. **${focus}** \uC598\uAE30\uD574\uBCF4\uC790.`,
        `\uADF8\uB798. **${focus}** \uCABD\uC73C\uB85C \uC774\uC5B4\uAC00\uBCFC\uAC8C.`,
        `\uC751. **${focus}** \uC774\uC57C\uAE30 \uACC4\uC18D\uD574\uBCF4\uC790.`,
      ]);
    }
    if (language === "ja") return `**${focus}** \u306B\u3064\u3044\u3066\u305D\u306E\u307E\u307E\u7D9A\u3051\u307E\u3059\u3002`;
    if (language === "zh") return `\u90A3\u5C31\u76F4\u63A5\u7EE7\u7EED\u804A **${focus}** \u5427\u3002`;
    return trim(prompt).endsWith("?")
      ? `Sure. I'll answer **${focus}** directly.`
      : `Okay. Let's continue with **${focus}**.`;
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (topic) return buildTopicAbilityReply(topic, language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["\uC9C0\uAE08 \uBB50\uD574", "\uC9C0\uAE08 \uBB50 \uD574", "\uBB50\uD574"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (containsAny(loweredPrompt, ["python", "\uD30C\uC774\uC36C"])) return buildTopicAbilityReply("python", language);
    if (containsAny(loweredPrompt, ["roblox", "\uB85C\uBE14\uB85D\uC2A4"])) return buildTopicAbilityReply("roblox", language);
    if (containsAny(loweredPrompt, ["weather", "\uB0A0\uC528"])) return buildTopicAbilityReply("weather", language);
    if (containsAny(loweredPrompt, ["\uC774\uBAA8\uC9C0", "emoji"])) return buildEmojiReply(language);
    if (containsAny(loweredPrompt, ["python", "roblox", "lua", "programming", "coding", "\uD30C\uC774\uC36C", "\uB85C\uBE14\uB85D\uC2A4", "\uCF54\uB529"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["what can you do", "how can you help", "\uBB50 \uD560 \uC218 \uC788\uC5B4", "\uBB50\uD560\uC218\uC788\uC5B4"])) return buildCapabilityReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  function buildBrowserModelPrompt(prompt, language) {
    const cleanPrompt = trim(prompt);
    const loweredPrompt = lower(cleanPrompt);
    const historyEntries = state.history.filter((entry) => entry && trim(entry.content));
    const promptKey = normalizeDialogueText(cleanPrompt);
    const recentEntries = historyEntries.slice();

    if (
      recentEntries.length
      && recentEntries[recentEntries.length - 1].role === "user"
      && normalizeDialogueText(recentEntries[recentEntries.length - 1].content) === promptKey
    ) {
      recentEntries.pop();
    }

    const recentConversation = recentEntries
      .slice(-4)
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${trim(entry.content)}`)
      .join("\n");

    const previousUser = [...recentEntries].reverse().find((entry) => entry.role === "user" && trim(entry.content));
    const previousAssistant = [...recentEntries].reverse().find((entry) => entry.role === "assistant" && trim(entry.content));
    const isCorrectionTurn = isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt);

    const systemInstruction = language === "ko"
      ? [
          "System: You are Purple Bee.",
          "Answer naturally and directly in Korean unless the user explicitly asks for another language.",
          "Do not explain how you interpreted the question.",
          "Do not fall back to generic lines like '한 줄만 더 붙여주세요' when the conversation already gives enough context.",
          "If the user says things like '아니야', '그게 아니고', or '뭔 소리야', briefly admit the previous answer missed the point and either answer the previous request better or ask one short clarifying question.",
          "For definition questions, answer with a plain definition first.",
          "For how-to questions, answer with direct steps first.",
        ].join(" ")
      : [
          "System: You are Purple Bee.",
          "Answer naturally and directly.",
          "Do not explain how you interpreted the question.",
          "If the user is correcting you, briefly acknowledge the miss and answer the previous request better or ask one short clarifying question.",
          "For definition questions, answer with a plain definition first.",
          "For how-to questions, answer with direct steps first.",
        ].join(" ");

    const correctionNotes = [];
    if (isCorrectionTurn && previousUser) {
      correctionNotes.push(`Previous user request: ${trim(previousUser.content)}`);
    }
    if (isCorrectionTurn && previousAssistant) {
      correctionNotes.push(`Your last answer: ${shorten(trim(previousAssistant.content), 220)}`);
    }

    return [
      systemInstruction,
      recentConversation ? `Recent conversation:\n${recentConversation}` : "",
      correctionNotes.length ? correctionNotes.join("\n") : "",
      `User: ${cleanPrompt}`,
      "Assistant:",
    ].filter(Boolean).join("\n\n");
  }

  function cleanupBrowserModelReply(text, prompt) {
    let value = trim(String(text || ""));
    value = value.replace(/^(assistant|purple bee)\s*:\s*/i, "").trim();
    value = value.replace(/\b(user|assistant|purple bee)\s*:/gi, "").trim();
    value = value.replace(/^user\s*:/i, "").trim();
    value = value.split(/\n+\s*User\s*:/i)[0].trim();
    value = value.replace(/\n+\s*Assistant\s*:/gi, "\n").trim();
    const normalizedPrompt = normalizeDialogueText(prompt);
    const normalizedValue = normalizeDialogueText(value);
    if (!value || normalizedValue === normalizedPrompt) return "";
    if (containsAny(lower(normalizedValue), ["localhost server inference", "question core", "at a glance"])) return "";
    if (value.length < 2) return "";
    return value;
  }

  async function tryModelFirstReply(prompt, _language) {
    const loweredPrompt = lower(prompt);
    if (!trim(prompt) || trim(prompt).length < 6) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt) || isStatusPrompt(loweredPrompt) || isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt)) return "";
    try {
      await ensureEngineReady();
      if (engine.browserRuntime) {
        const generated = await engine.browserRuntime.generateReply(
          buildBrowserModelPrompt(prompt, detectLanguage(prompt)),
          {
            maxNewTokens: state.deepThink ? 88 : 56,
            temperature: state.deepThink ? 0.72 : 0.45,
            topK: state.deepThink ? 32 : 18,
          },
        );
        const cleaned = cleanupBrowserModelReply(generated, prompt);
        if (cleaned && looksNatural(cleaned) && normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history))) {
          return cleaned;
        }
      }
    } catch (_error) {
      // Fall through to the curated dialogue bank.
    }
    await loadDialogueBank();
    const bankReply = trim(findDialogueReply(prompt));
    if (!bankReply) return "";
    const loweredReply = lower(bankReply);
    if (normalizeDialogueText(bankReply) === normalizeDialogueText(lastAssistantText(state.history))) return "";
    if (containsAny(loweredReply, [
      "localhost server inference",
      "question core",
      "at a glance",
      "\uC9C0\uAE08 \uB2F5\uD560 \uC218 \uC788\uB294 \uBD80\uBD84\uBD80\uD130",
      "\uC790\uC5F0\uC2A4\uB7FD\uAC8C \uC774\uC5B4\uC11C \uC124\uBA85",
      "\uAE30\uC900\uC73C\uB85C \uC774\uC5B4\uC11C \uB2F5",
    ])) return "";
    return bankReply;
  }

  function renderModelRegistry() {
    const registry = state.modelRegistry;
    const header = document.getElementById("model-menu-header");
    const list = document.getElementById("model-version-list");
    const topSep = document.getElementById("model-version-sep-top");
    const bottomSep = document.getElementById("model-version-sep-bottom");
    const label = getRuntimeModelLabel();
    const currentId = getSelectedRuntimeModelId() || (registry && registry.current_model_id ? registry.current_model_id : "");
    const currentLabelKey = normalizeDialogueText(label);
    if (header) header.textContent = registry && registry.family_name ? registry.family_name : "Purple Bee";
    setEngineStatus(engine.model ? "ready" : engine.loading ? "loading" : "idle", label, getLocalStatusMessage(engine.model ? "ready" : engine.loading ? "loading" : "idle"));
    if (!list) return;
    list.innerHTML = "";
    list.style.display = "none";
    if (topSep) topSep.style.display = "none";
    if (bottomSep) bottomSep.style.display = "none";
    if (!registry || !Array.isArray(registry.models) || registry.models.length <= 1) return;
    let rendered = 0;
    const seen = new Set([currentLabelKey]);
    registry.models.forEach((model) => {
      const displayName = model.display_name || model.id || "Purple Bee";
      const displayKey = normalizeDialogueText(displayName);
      if ((currentId && model.id === currentId) || seen.has(displayKey)) return;
      seen.add(displayKey);
      const item = document.createElement("div");
      item.className = "model-menu-item";
      item.tabIndex = 0;
      const badges = [];
      if (model.latest) badges.push("latest");
      if (model.trainable) badges.push("trainable");
      item.innerHTML = `
        <span class="item-icon" style="background:rgba(139,92,246,.12)">
          <i class="ph ph-cube" style="color:var(--accent-light)"></i>
        </span>
        <span>
          <div style="color:var(--text)">${escapeHtml(displayName)}</div>
          <div style="font-size:10px;color:var(--text-3)">${escapeHtml([model.architecture_name || "", badges.join(" \u00B7 ")].filter(Boolean).join(" \u00B7 "))}</div>
        </span>
      `;
      list.appendChild(item);
      rendered += 1;
    });
    if (rendered > 0) {
      list.style.display = "";
      if (topSep) topSep.style.display = "";
      if (bottomSep) bottomSep.style.display = "";
    }
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const retryPrompt = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt))
      ? trim(previousUserPrompt(userEntry.id))
      : "";
    const effectivePrompt = retryPrompt || prompt;
    const loweredEffectivePrompt = lower(effectivePrompt);
    const intentPrompt = retryPrompt ? effectivePrompt : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredEffectivePrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(effectivePrompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(effectivePrompt);

    if (!retryPrompt) {
      if (containsAny(loweredPrompt, ["\uC548\uB155", "\uBC18\uAC00", "hello", "hi", "hey", "\u3053\u3093\u306B\u3061\u306F", "\u4F60\u597D"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["\uACE0\uB9C8\uC6CC", "\uAC10\uC0AC", "thanks", "thank you", "\u3042\u308A\u304C\u3068\u3046", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["\uB204\uAD6C\uC57C", "\uB204\uAD6C\uB0D0", "who are you", "what are you", "\uC790\uAE30\uC18C\uAC1C", "\uC18C\uAC1C\uD574"])) return { text: buildIdentityReply(promptLanguage), meta: "" };
      if (isStatusPrompt(loweredPrompt)) return { text: buildCurrentActivityReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["\uC601\uC5B4\uB85C \uB9D0\uD560", "\uC601\uC5B4\uB85C \uB2F5", "speak english", "in english", "english?", "\uC77C\uBCF8\uC5B4\uB85C", "\uC911\uAD6D\uC5B4\uB85C", "\uD55C\uAD6D\uC5B4\uB85C"])) return buildLanguageAbilityReply(prompt, promptLanguage);
      if (containsAny(loweredPrompt, ["\uC774\uBAA8\uC9C0", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["\uCF54\uB529", "\uCF54\uB4DC", "\uAC1C\uBC1C", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
      if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["\uCD9C\uCC98", "\uADFC\uAC70", "\uC5B4\uB514\uC11C", "\uBB34\uC2A8 \uC790\uB8CC"])) {
        const meta = lastAssistantMeta(state.history);
        if (meta) return { text: meta, meta: "" };
      }
      if (containsAny(loweredPrompt, ["\uB354 \uC9E7\uAC8C", "\uC9E7\uAC8C", "\uD55C \uC904", "\uD55C\uC904", "\uC694\uC57D"])) {
        const previous = lastAssistantText(state.history);
        if (previous) return { text: shorten(previous, 140), meta: "" };
      }
      if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    }

    if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(effectivePrompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(effectivePrompt, evidence);
        return {
          text: composeFromEvidence(mode, effectivePrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (!retryPrompt && isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    if (retryPrompt) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };
    return { text: buildGeneralChatFallback(effectivePrompt, promptLanguage, replyStyle), meta: "" };
  }

  function normalizeDialogueText(text) {
    return lower(String(text || ""))
      .replace(/[`"'()[\]{}.,!?;:/\\|<>@#%^&*_+=~-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeDialoguePrompt(text) {
    return unique(normalizeDialogueText(text).split(" ").filter((token) => token.length >= 2));
  }

  function scoreDialogueExample(prompt, normalizedPrompt, promptTokens, example) {
    if (!example || !example.normalizedPrompt) return 0;
    if (example.normalizedPrompt === normalizedPrompt) return 150;
    if (!normalizedPrompt) return 0;
    let score = 0;
    if (normalizedPrompt.includes(example.normalizedPrompt) || example.normalizedPrompt.includes(normalizedPrompt)) score += 64;
    let overlap = 0;
    promptTokens.forEach((token) => {
      if (example.tokens.includes(token)) overlap += 1;
    });
    score += overlap * 16;
    if (prompt.endsWith("?") && example.prompt.endsWith("?")) score += 6;
    if (prompt.length <= 18 && example.prompt.length <= 22) score += 4;
    return score;
  }

  function findDialogueReply(prompt) {
    if (!state.dialogueExamples.length) return "";
    const normalizedPrompt = normalizeDialogueText(prompt);
    const promptTokens = tokenizeDialoguePrompt(prompt);
    if (!normalizedPrompt && !promptTokens.length) return "";
    const lastReply = normalizeDialogueText(lastAssistantText(state.history));
    const ranked = state.dialogueExamples
      .map((example) => ({ example, score: scoreDialogueExample(prompt, normalizedPrompt, promptTokens, example) }))
      .filter((entry) => entry.score >= (promptTokens.length <= 1 ? 120 : promptTokens.length === 2 ? 38 : 28))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best) return "";
    const second = ranked[1];
    if (best.score < 120 && second && best.score - second.score < 8) return "";
    if (normalizeDialogueText(best.example.answer) === lastReply) return "";
    return best.example.answer;
  }

  function shouldCarryPreviousPrompt(prompt) {
    const raw = trim(prompt);
    const loweredPrompt = lower(raw);
    if (!loweredPrompt) return false;
    if (/^[?？!]$/.test(raw)) return true;
    if (/^(그거|그건|그게|그 링크|그 사이트|그 웹사이트|그 날씨|그 지역|거기|아니 그거|아니 그게|그 말|그 답)$/u.test(raw)) return true;
    if (/^(more|again|continue|that one|that link|that site)$/i.test(raw)) return true;
    return false;
  }

  function buildIntentPrompt(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    if (!shouldCarryPreviousPrompt(prompt)) return prompt;
    const previousUser = previousUserPrompt(userEntry.id);
    return previousUser ? `${previousUser} ${prompt}` : prompt;
  }

  function buildCurrentActivityReply(language) {
    const seed = `${language}:${lastAssistantText(state.history).length}:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "지금은 네 메시지 보고 답하고 있어.",
        "지금은 너랑 대화하는 중이야. 편하게 이어서 말해줘.",
        "지금은 네 질문을 읽고 바로 답하는 중이야.",
      ]);
    }
    if (language === "ja") return "今はあなたのメッセージを見ながら返事しています。";
    if (language === "zh") return "我现在正在看你的消息并继续回答。";
    return pickReplyVariant(seed, [
      "I'm reading your message and answering it now.",
      "Right now I'm talking with you and replying as we go.",
      "I'm looking at your question and answering it now.",
    ]);
  }

  function buildTopicAbilityReply(topic, language) {
    const loweredTopic = lower(topic);
    if (containsAny(loweredTopic, ["python", "파이썬"])) {
      return language === "ko"
        ? "응, 파이썬 알아. 문법 설명, 오류 분석, 코드 수정, 디버깅까지 도와줄 수 있어."
        : "Yes, I know Python. I can help with syntax, debugging, errors, and code changes.";
    }
    if (containsAny(loweredTopic, ["roblox", "lua", "로블록스"])) {
      return language === "ko"
        ? "응, 로블록스도 알아. Roblox Studio, Lua, 구조 설계, 버그 분석 쪽으로 도와줄 수 있어."
        : "Yes, I can help with Roblox too, especially Roblox Studio, Lua, structure, and debugging.";
    }
    if (containsAny(loweredTopic, ["weather", "날씨"])) {
      return language === "ko"
        ? "응, 날씨도 볼 수 있어. 지역명만 같이 적어주면 지금 기기에서 바로 확인해줄게."
        : "Yes, I can check the weather too. Just include the location and I will look it up on this device.";
    }
    if (containsAny(loweredTopic, ["coding", "programming", "code", "코딩", "코드"])) {
      return language === "ko"
        ? "응, 코딩도 도와줄 수 있어. 코드 설명, 버그 찾기, 수정 방향 정리까지 가능해."
        : "Yes, I can help with coding too, including code explanation, bug hunting, and fix suggestions.";
    }
    return language === "ko"
      ? `응, **${topic}** 쪽도 같이 볼 수 있어. 궁금한 포인트만 바로 말해줘.`
      : `Yes, I can help with **${topic}** too. Tell me which part you want to focus on.`;
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = previousUserPrompt(currentEntryId);
    if (language === "ko") {
      if (previous) return `알겠어. 방금 답은 접고 **${shorten(previous, 42)}** 쪽으로 다시 바로 답할게.`;
      return "알겠어. 방금 답은 접고 다시 바로 답할게.";
    }
    return previous
      ? `Okay. I'll drop the last direction and answer **${shorten(previous, 42)}** more directly.`
      : "Okay. I'll drop the last direction and answer more directly.";
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const focus = shorten(trim(prompt), 64);
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) {
        return style === "conversational"
          ? `응, **${focus}** 쪽으로 바로 이어가도 돼.`
          : `응, **${focus}**는 같이 풀어볼 수 있어.`;
      }
      return style === "coach"
        ? `좋아. **${focus}** 기준으로 하나씩 정리해볼게.`
        : `좋아. **${focus}** 이야기로 이어가자.`;
    }
    if (language === "ja") return `了解です。**${focus}** の話をそのまま続けます。`;
    if (language === "zh") return `好，那就直接继续聊 **${focus}**。`;
    return trim(prompt).endsWith("?")
      ? `Sure. I can answer **${focus}** directly.`
      : `Okay. Let's continue with **${focus}**.`;
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "지금은 숫자만 보여서 뜻을 아직 못 잡았어. 숫자가 뭘 의미하는지만 한 줄 더 적어줘.";
      if (language === "ja") return "今は数字だけなので意味がまだ取りにくいです。何を指す数字か一行だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还不知道它代表什么。再补一句就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (language === "ko") return "아직 말이 너무 짧아서 뜻을 정확히 잡기 어렵다. 한 줄만 더 붙여주면 바로 이어서 답할게.";
    if (language === "ja") return "まだ短すぎて意図を取りにくいです。一行だけ足してくれればすぐ続けます。";
    if (language === "zh") return "这句还太短，我不太好判断你的意思。再补一句我就直接接着答。";
    return "That is still too short for me to read cleanly. Add one more short line and I'll continue directly.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (topic) return buildTopicAbilityReply(topic, language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["지금 뭐해", "지금 뭐 해", "뭐해"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (containsAny(loweredPrompt, ["emoji", "이모지"])) return buildEmojiReply(language);
    if (containsAny(loweredPrompt, ["python", "파이썬"])) return buildTopicAbilityReply("python", language);
    if (containsAny(loweredPrompt, ["roblox", "lua", "로블록스"])) return buildTopicAbilityReply("roblox", language);
    if (containsAny(loweredPrompt, ["coding", "programming", "code", "코딩", "코드"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["what can you do", "how can you help", "뭐 할 수 있어", "뭐할수있어"])) return buildCapabilityReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  async function tryModelFirstReply(prompt, _language) {
    const loweredPrompt = lower(prompt);
    if (!trim(prompt) || trim(prompt).length < 6) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt) || isStatusPrompt(loweredPrompt) || isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt)) return "";

    try {
      await ensureEngineReady();
      if (engine.browserRuntime) {
        const generated = await engine.browserRuntime.generateReply(
          buildBrowserModelPrompt(prompt, detectLanguage(prompt)),
          {
            maxNewTokens: state.deepThink ? 96 : 64,
            temperature: state.deepThink ? 0.68 : 0.42,
            topK: state.deepThink ? 36 : 16,
          },
        );
        const cleaned = cleanupBrowserModelReply(generated, prompt);
        if (
          cleaned &&
          cleaned.length >= 6 &&
          looksNatural(cleaned) &&
          normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
          !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
        ) {
          return cleaned;
        }
      }
    } catch (_error) {
      // Fall through to the dialogue bank.
    }

    await loadDialogueBank();
    return trim(findDialogueReply(prompt));
  }

  function isPlanningPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "뭐할까",
      "뭐 하지",
      "뭐하지",
      "우리 뭐할래",
      "우리 뭐 할래",
      "우리 뭐하지",
      "what should we do",
      "what do we do",
      "what should we work on",
    ]);
  }

  function isHesitationPrompt(loweredPrompt) {
    return containsAny(loweredPrompt, [
      "으음",
      "음...",
      "음..",
      "음",
      "흠",
      "hmm",
      "umm",
      "uh",
    ]);
  }

  function isDirectAddressPrompt(loweredPrompt) {
    return trim(loweredPrompt) === "너" || trim(loweredPrompt) === "you";
  }

  function isKnownLinkPrompt(loweredPrompt) {
    const wantsLink = containsAny(loweredPrompt, ["링크", "url", "주소", "site", "website", "사이트", "홈페이지", "page"]);
    if (!wantsLink) return false;
    return containsAny(loweredPrompt, ["gpt", "chatgpt", "openai", "claude", "anthropic", "gemini", "google ai"]);
  }

  function buildPlanningReply(language) {
    if (language === "ko") {
      return [
        "같이 할 만한 걸 바로 몇 개 고르면 이래.",
        "",
        "1. 그냥 잡담하기",
        "2. 코딩이나 오류 같이 보기",
        "3. 문서나 파일 분석하기",
        "4. 아이디어 정리하기",
        "",
        "원하는 걸 하나 고르거나, 하고 싶은 걸 그냥 한 줄로 던져줘."
      ].join("\n");
    }
    if (language === "ja") return "今すぐ一緒にできるのは、雑談、コード確認、文書分析、アイデア整理です。やりたいものを一つ言ってください。";
    if (language === "zh") return "现在可以一起做的有：聊天、看代码、分析文档、整理想法。你直接说一个方向就行。";
    return "We can chat, look at code, analyze a file, or organize an idea. Pick one direction and I'll jump in.";
  }

  function buildHesitationReply(language) {
    if (language === "ko") return "천천히 생각해도 돼. 떠오르는 말 한마디만 던져줘도 내가 이어서 맞춰볼게.";
    if (language === "ja") return "ゆっくりで大丈夫です。思い浮かんだ一言だけでも投げてくれれば、そこから続けます。";
    if (language === "zh") return "慢慢想也可以。你随便丢一句出来，我会顺着接下去。";
    return "No rush. Throw me even one rough phrase and I'll continue from there.";
  }

  function buildKnownLinkReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (containsAny(loweredPrompt, ["gpt", "chatgpt", "openai"])) {
      if (language === "ko") return "[ChatGPT 공식 사이트](https://chatgpt.com) 링크는 여기예요. 필요하면 OpenAI 홈페이지나 API 문서 링크도 바로 이어서 줄게.";
      if (language === "ja") return "ChatGPT の公式リンクはこちらです: [ChatGPT](https://chatgpt.com)";
      if (language === "zh") return "ChatGPT 官方链接在这里：[ChatGPT](https://chatgpt.com)";
      return "Here is the official ChatGPT link: [ChatGPT](https://chatgpt.com)";
    }
    if (containsAny(loweredPrompt, ["claude", "anthropic"])) {
      if (language === "ko") return "[Claude 공식 사이트](https://claude.ai) 링크는 여기예요.";
      return "Here is the official Claude link: [Claude](https://claude.ai)";
    }
    if (containsAny(loweredPrompt, ["gemini", "google ai"])) {
      if (language === "ko") return "[Gemini 공식 사이트](https://gemini.google.com) 링크는 여기예요.";
      return "Here is the official Gemini link: [Gemini](https://gemini.google.com)";
    }
    return "";
  }

  function isVeryShortPrompt(prompt) {
    const normalized = trim(prompt);
    const loweredPrompt = lower(normalized);
    if (!normalized) return false;
    if (isDirectAddressPrompt(loweredPrompt) || isPlanningPrompt(loweredPrompt) || isHesitationPrompt(loweredPrompt)) return false;
    if (containsAny(loweredPrompt, ["안녕", "hello", "hi", "hey", "고마워", "thanks", "아니", "아니지", "아닌데"])) return false;
    return normalized.length <= 1 || /^\d+$/.test(normalized);
  }

  function buildCurrentActivityReply(language) {
    const seed = `${language}:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "지금은 너랑 대화하고 있어. 편하게 이어서 말해줘.",
        "지금은 네 메시지 읽고 바로 답하는 중이야.",
        "지금은 네가 던지는 주제에 맞춰 같이 보고 있어.",
      ]);
    }
    if (language === "ja") return "今はあなたのメッセージを見ながら、そのまま答えているところです。";
    if (language === "zh") return "我现在正在看你的消息，并顺着你的话继续回答。";
    return pickReplyVariant(seed, [
      "Right now I'm talking with you and replying as we go.",
      "I'm reading your message and answering it now.",
      "I'm following the topic you're throwing at me right now.",
    ]);
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = trim(previousUserPrompt(currentEntryId));
    const loweredPrevious = lower(previous);
    const topic = previous ? extractAbilityTopic(previous) : "";
    if (topic) return buildTopicAbilityReply(topic, language);
    if (previous && isPlanningPrompt(loweredPrevious)) return buildPlanningReply(language);
    if (previous && isKnownLinkPrompt(loweredPrevious)) {
      const direct = buildKnownLinkReply(previous, language);
      if (direct) return direct;
    }
    if (previous && isWeatherQuestion(loweredPrevious) && !extractWeatherLocation(previous)) return buildWeatherMissingLocationReply(language);
    if (language === "ko") return "맞아, 방금 답이 어색했어. 이번엔 돌리지 말고 바로 맞춰서 답할게.";
    if (language === "ja") return "その通りです。さっきの答えは少しずれていました。今度は回りくどくせず、もっと直接答えます。";
    if (language === "zh") return "对，刚才那句有点跑偏了。这次我直接一点回答。";
    return "You're right. That last answer drifted. I'll answer more directly this time.";
  }

  function buildConfusionReply(language) {
    if (language === "ko") return "맞아, 방금 말이 이상했어. 다시 짧고 자연스럽게 말해볼게.";
    if (language === "ja") return "その通りです。さっきの言い方は変でした。今度は短く自然に言い直します。";
    if (language === "zh") return "对，刚才那句话确实怪。我这次会更短、更自然地重说。";
    return "You're right. That came out weird. I'll say it again more clearly.";
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const focus = shorten(trim(prompt), 64);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) {
        return style === "coach"
          ? `응, **${focus}** 얘기면 같이 정리해볼 수 있어. 원하는 방향부터 말해줘.`
          : `응, **${focus}** 쪽은 바로 같이 볼 수 있어.`;
      }
      return style === "coach"
        ? `좋아. **${focus}** 기준으로 하나씩 맞춰볼게.`
        : `응, **${focus}** 얘기 계속해봐.`;
    }
    if (language === "ja") return trim(prompt).endsWith("?") ? `はい。**${focus}** ならそのまま一緒に見られます。` : `はい、**${focus}** の話を続けてください。`;
    if (language === "zh") return trim(prompt).endsWith("?") ? `可以，**${focus}** 这个我能直接接着答。` : `好，继续说 **${focus}** 这件事吧。`;
    return trim(prompt).endsWith("?") ? `Yes, I can answer **${focus}** directly.` : `Okay, keep going with **${focus}**.`;
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    const loweredPrompt = lower(normalized);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "숫자만 보여서 아직 의미를 못 잡았어. 그 숫자가 뭘 뜻하는지만 한 줄 더 적어줘.";
      if (language === "ja") return "数字だけだと意味がまだ取れません。何を表す数字か一言だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还不知道它表示什么。再补一句说明就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (trim(loweredPrompt) === "?") return buildConfusionReply(language);
    if (language === "ko") return "한두 마디만 더 붙여주면 바로 그 뜻에 맞춰서 이어서 답할게.";
    if (language === "ja") return "一言だけ足してくれれば、その意味に合わせてすぐ続けます。";
    if (language === "zh") return "你再补一小句，我就能顺着你的意思直接接下去。";
    return "Give me one more short phrase and I'll continue in the right direction.";
  }

  function buildGeneralChatFallback(prompt, language, style) {
    const loweredPrompt = lower(prompt);
    const topic = extractAbilityTopic(prompt);
    if (isPlanningPrompt(loweredPrompt)) return buildPlanningReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (topic) return buildTopicAbilityReply(topic, language);
    if (isStatusPrompt(loweredPrompt) || containsAny(loweredPrompt, ["지금 뭐해", "지금 뭐 해", "뭐해"])) return buildCurrentActivityReply(language);
    if (isNegativeCorrectionPrompt(loweredPrompt)) return buildCorrectionReply(language, "");
    if (isKnownLinkPrompt(loweredPrompt)) {
      const direct = buildKnownLinkReply(prompt, language);
      if (direct) return direct;
    }
    if (containsAny(loweredPrompt, ["emoji", "이모지"])) return buildEmojiReply(language);
    if (containsAny(loweredPrompt, ["python", "파이썬"])) return buildTopicAbilityReply("python", language);
    if (containsAny(loweredPrompt, ["roblox", "lua", "로블록스"])) return buildTopicAbilityReply("roblox", language);
    if (containsAny(loweredPrompt, ["coding", "programming", "code", "코딩", "코드"])) return buildCodingReply(language);
    if (containsAny(loweredPrompt, ["what can you do", "how can you help", "뭐 할 수 있어", "뭐할수있어"])) return buildCapabilityReply(language);
    return buildOpenQuestionReply(prompt, language, style);
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const retryPrompt = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt))
      ? trim(previousUserPrompt(userEntry.id))
      : "";
    const effectivePrompt = retryPrompt || prompt;
    const loweredEffectivePrompt = lower(effectivePrompt);
    const intentPrompt = retryPrompt ? effectivePrompt : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const mode = detectMode(loweredEffectivePrompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const replyStyle = getReplyStyle(effectivePrompt, mode);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const topic = extractAbilityTopic(effectivePrompt);

    if (!retryPrompt) {
      if (containsAny(loweredPrompt, ["안녕", "반가", "hello", "hi", "hey", "こんにちは", "你好"])) return { text: buildGreetingReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["고마워", "감사", "thanks", "thank you", "ありがとう", "merci"])) return { text: buildThanksReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["누구야", "누구냐", "who are you", "what are you", "자기소개", "소개해"]) || isDirectAddressPrompt(loweredPrompt)) return { text: buildIdentityReply(promptLanguage), meta: "" };
      if (isPlanningPrompt(loweredPrompt)) return { text: buildPlanningReply(promptLanguage), meta: "" };
      if (isHesitationPrompt(loweredPrompt)) return { text: buildHesitationReply(promptLanguage), meta: "" };
      if (isStatusPrompt(loweredPrompt)) return { text: buildCurrentActivityReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["영어로 말할", "영어로 답", "speak english", "in english", "english?", "일본어로", "중국어로", "한국어로"])) return buildLanguageAbilityReply(prompt, promptLanguage);
      if (containsAny(loweredPrompt, ["이모지", "emoji"])) return { text: buildEmojiReply(promptLanguage), meta: "" };
      if (isKnownLinkPrompt(loweredPrompt)) {
        const direct = buildKnownLinkReply(prompt, promptLanguage);
        if (direct) return { text: direct, meta: "" };
      }
      if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["코딩", "코드", "개발", "programming", "coding"])) return { text: buildCodingReply(promptLanguage), meta: "" };
      if (mode === "capability") return { text: buildCapabilityReply(promptLanguage), meta: "" };
      if (containsAny(loweredPrompt, ["출처", "근거", "어디서", "무슨 자료"])) {
        const meta = lastAssistantMeta(state.history);
        if (meta) return { text: meta, meta: "" };
      }
      if (containsAny(loweredPrompt, ["더 짧게", "짧게", "한 줄", "한줄", "요약"])) {
        const previous = lastAssistantText(state.history);
        if (previous) return { text: shorten(previous, 140), meta: "" };
      }
      if (isVeryShortPrompt(prompt) && !shouldCarryPreviousPrompt(prompt)) return { text: buildShortPromptReply(prompt, promptLanguage), meta: "" };
    }

    if (topic) return { text: buildTopicAbilityReply(topic, promptLanguage), meta: "" };

    if (!currentDocs.length && isKnownLinkPrompt(loweredIntentPrompt)) {
      const direct = buildKnownLinkReply(intentPrompt, promptLanguage);
      if (direct) return { text: direct, meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(effectivePrompt, currentDocs, { metaPrefix: getAttachmentMetaPrefix(promptLanguage), language: promptLanguage, style: replyStyle });
      if (currentReply) return currentReply;
    }

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(effectivePrompt, evidence);
        return {
          text: composeFromEvidence(mode, effectivePrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (retryPrompt) return { text: buildCorrectionReply(promptLanguage, userEntry.id), meta: "" };

    if (isExplicitContinuationPrompt(loweredPrompt)) {
      const previous = lastAssistantText(state.history);
      if (previous) return { text: buildFollowUpReply(previous, promptLanguage), meta: "" };
    }

    return { text: buildGeneralChatFallback(effectivePrompt, promptLanguage, replyStyle), meta: "" };
  }

  async function tryModelFirstReply(prompt, _language) {
    const loweredPrompt = lower(prompt);
    if (!trim(prompt) || trim(prompt).length < 12) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isStatusPrompt(loweredPrompt) ||
      isNegativeCorrectionPrompt(loweredPrompt) ||
      isConfusionPrompt(loweredPrompt) ||
      isPlanningPrompt(loweredPrompt) ||
      isHesitationPrompt(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt) ||
      isDirectAddressPrompt(loweredPrompt)
    ) return "";

    try {
      await ensureEngineReady();
      if (engine.browserRuntime) {
        const generated = await engine.browserRuntime.generateReply(
          buildBrowserModelPrompt(prompt, detectLanguage(prompt)),
          {
            maxNewTokens: state.deepThink ? 96 : 64,
            temperature: state.deepThink ? 0.66 : 0.36,
            topK: state.deepThink ? 32 : 14,
          },
        );
        const cleaned = cleanupBrowserModelReply(generated, prompt);
        if (
          cleaned &&
          cleaned.length >= 8 &&
          looksNatural(cleaned) &&
          normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
          !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
        ) {
          return cleaned;
        }
      }
    } catch (_error) {
      // Fall through to the dialogue bank.
    }

    await loadDialogueBank();
    return trim(findDialogueReply(prompt));
  }

  function isAlternativePrompt(loweredPrompt) {
    const normalized = trim(loweredPrompt);
    return (
      normalized === "아니" ||
      normalized === "아닌데" ||
      containsAny(loweredPrompt, [
        "그거말고",
        "그거 말고",
        "이거말고",
        "이거 말고",
        "딴거",
        "딴 거",
        "다른거",
        "다른 거",
        "다른거 없어",
        "다른 거 없어",
        "다르게",
        "그런거 말고",
        "그런 거 말고",
      ])
    );
  }

  function isSoftSocialPrompt(loweredPrompt) {
    return (
      isPlanningPrompt(loweredPrompt) ||
      isHesitationPrompt(loweredPrompt) ||
      isDirectAddressPrompt(loweredPrompt) ||
      isStatusPrompt(loweredPrompt) ||
      isNegativeCorrectionPrompt(loweredPrompt) ||
      isConfusionPrompt(loweredPrompt) ||
      isAlternativePrompt(loweredPrompt) ||
      containsAny(loweredPrompt, [
        "안녕",
        "반가",
        "hello",
        "hi",
        "hey",
        "고마워",
        "감사",
        "thanks",
        "thank you",
        "emoji",
        "이모지",
      ])
    );
  }

  function buildGreetingReply(language) {
    const seed = `${language}:${state.history.length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "안녕. 편하게 말해줘. 궁금한 거나 하고 싶은 얘기 있으면 바로 이어갈게.",
        "안녕. 지금 생각나는 거 아무거나 던져줘. 같이 바로 풀어보자.",
        "안녕. 편하게 시작하자. 질문이든 잡담이든 괜찮아.",
      ]);
    }
    if (language === "ja") return "こんにちは。気になることでも雑談でも、そのまま続けてください。";
    if (language === "zh") return "你好。想问什么就直接说，闲聊也可以。";
    return "Hi. Ask anything or just keep talking. Casual chat is fine too.";
  }

  function buildIdentityReply(language) {
    if (language === "ko") return "나는 Purple Bee야. 여기서 대화하고, 파일이나 코드도 같이 보고, 필요하면 검색까지 붙여서 도와줄 수 있어.";
    if (language === "ja") return "私は Purple Bee です。ここで会話したり、ファイルやコードを一緒に見たり、必要なら検索も使って手伝えます。";
    if (language === "zh") return "我是 Purple Bee。我可以在这里和你对话，也能一起看文件、代码，必要时再接上搜索。";
    return "I'm Purple Bee. I can chat here, look through files or code with you, and use search when needed.";
  }

  function buildCurrentActivityReply(language) {
    const seed = `${language}:${state.history.length}:${lastAssistantText(state.history).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "지금은 너랑 대화하는 중이야. 편하게 이어서 말해줘.",
        "지금은 네 메시지 보고 바로 답하고 있어.",
        "지금은 네가 던지는 주제 따라가면서 같이 보고 있어.",
      ]);
    }
    if (language === "ja") return "今はあなたのメッセージを見ながら、そのまま返しているところです。";
    if (language === "zh") return "我现在正在看你的消息，然后顺着你的话继续回答。";
    return "I'm talking with you right now and following where the conversation goes.";
  }

  function buildCapabilityReply(language) {
    if (language === "ko") {
      return "나는 지금 이 사이트에서 대화, 코드 보기, 파일·문서 분석, 링크 정리, 간단한 검색 정리 쪽을 가장 안정적으로 도와줄 수 있어. 하고 싶은 걸 바로 말해주면 거기 맞춰서 붙을게.";
    }
    if (language === "ja") return "このサイト上では、会話、コード確認、文書やファイルの分析、リンク整理、簡単な検索整理を安定して手伝えます。";
    if (language === "zh") return "在这个网站里，我现在比较稳定的能力是对话、看代码、分析文件和文档、整理链接，以及做一些简单搜索整理。";
    return "On this site I work best for conversation, code review, document or file analysis, link cleanup, and simple search-based summaries.";
  }

  function buildCodingReply(language) {
    if (language === "ko") return "응, 코딩도 도와줄 수 있어. 코드 설명, 버그 원인 추적, 수정 방향 정리, 함수 초안 만들기 같은 건 바로 같이 볼 수 있어.";
    if (language === "ja") return "はい、コーディングも手伝えます。コードの説明、バグ原因の整理、修正方針、関数のたたき台作成などができます。";
    if (language === "zh") return "可以，我也能帮你处理代码：解释代码、定位 bug 原因、整理修改方向、起草函数等。";
    return "Yes. I can help with coding too: explaining code, tracing bugs, suggesting fixes, and drafting functions.";
  }

  function buildTopicAbilityReply(topic, language) {
    const loweredTopic = lower(topic);
    if (containsAny(loweredTopic, ["python", "파이썬"])) {
      return language === "ko"
        ? "응, 파이썬 알아. 문법 설명부터 디버깅, 에러 원인 추적, 코드 수정 방향까지 같이 볼 수 있어."
        : "Yes, I can help with Python, including syntax, debugging, errors, and code changes.";
    }
    if (containsAny(loweredTopic, ["roblox", "lua", "로블록스"])) {
      return language === "ko"
        ? "응, 로블록스도 볼 수 있어. Roblox Studio, Lua 스크립트, 구조 설계, 오류 원인 쪽으로 이어서 도와줄 수 있어."
        : "Yes, I can help with Roblox too, especially Roblox Studio, Lua, structure, and debugging.";
    }
    if (containsAny(loweredTopic, ["weather", "날씨"])) {
      return language === "ko"
        ? "응, 날씨도 볼 수 있어. 지역명만 같이 적어주면 지금 기기에서 바로 조회해서 정리해줄게."
        : "Yes, I can check the weather too. Just include the location and I can look it up on this device.";
    }
    if (containsAny(loweredTopic, ["coding", "programming", "code", "코딩", "코드"])) {
      return buildCodingReply(language);
    }
    return language === "ko"
      ? `응, ${topic} 쪽도 이어서 볼 수 있어. 설명이 필요한지, 검색이 필요한지, 문제를 풀고 싶은지 말해주면 그쪽으로 맞출게.`
      : `Yes, I can keep going on ${topic} too. Tell me if you want explanation, search, or troubleshooting.`;
  }

  function buildPlanningReply(language) {
    const seed = `${language}:${state.history.length}:${trim(previousUserPrompt("")).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "우리 그냥 편하게 가도 돼. 잡담해도 되고, 궁금한 거 하나 파도 되고, 코드나 파일 같이 봐도 돼. 지금 끌리는 쪽 있으면 그걸로 가자.",
        "딱 메뉴처럼 정할 필요는 없어. 생각나는 주제 하나 던지면 내가 거기서 이어갈게.",
        "가볍게 이야기해도 좋고, 뭔가 같이 풀어봐도 좋아. 지금 머리에 떠오른 걸 그냥 말해줘.",
      ]);
    }
    if (language === "ja") return "きっちり決めなくても大丈夫です。雑談でも、質問でも、コードでも、今やりたい方向を一つ言ってくれればそこから続けます。";
    if (language === "zh") return "不用像菜单一样先定死。闲聊、提问、看代码都可以，你现在想往哪边走就直接说。";
    return "We don't have to turn it into a menu. We can chat, solve something, or look at code or files. Just say what feels right.";
  }

  function buildAlternativeReply(language) {
    const seed = `${language}:${state.history.length}:${lastAssistantText(state.history).length}`;
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "오케이, 그럼 아까 톤은 버리고 다르게 가자. 그냥 수다처럼 가도 되고, 네가 궁금한 걸 바로 물어봐도 되고, 내가 먼저 화제를 하나 던져도 돼.",
        "좋아. 그 방향 말고 다른 흐름으로 가자. 편하게 잡담해도 되고, 궁금한 주제 하나만 찍어줘도 돼.",
        "알겠어. 메뉴식으로 가지 말고 자연스럽게 다시 가자. 지금 하고 싶은 말 한 줄만 던져줘도 충분해.",
      ]);
    }
    if (language === "ja") return "わかりました。さっきの方向は捨てて、もっと自然にやり直しましょう。雑談でも質問でも大丈夫です。";
    if (language === "zh") return "明白了，那就换个方向，不按刚才那种菜单式方式走。闲聊或直接提问题都可以。";
    return "Got it. Let's drop the previous direction and go more naturally. Casual chat or a direct question are both fine.";
  }

  function buildHesitationReply(language) {
    if (language === "ko") return "천천히 해도 돼. 떠오르는 단어 하나만 던져줘도 내가 이어서 맞춰볼게.";
    if (language === "ja") return "ゆっくりで大丈夫です。思い浮かんだ一言だけでも投げてくれれば、そこから続けます。";
    if (language === "zh") return "慢慢来也行。你先随便丢一句出来，我会顺着接下去。";
    return "No rush. Even one rough phrase is enough for me to continue from there.";
  }

  function buildCorrectionReply(language, currentEntryId) {
    const previous = trim(previousUserPrompt(currentEntryId));
    const loweredPrevious = lower(previous);
    const seed = `${language}:${state.history.length}:${previous}`;
    if (previous && isPlanningPrompt(loweredPrevious)) return buildAlternativeReply(language);
    if (previous && isKnownLinkPrompt(loweredPrevious)) {
      const direct = buildKnownLinkReply(previous, language);
      if (direct) return direct;
    }
    if (previous && isWeatherQuestion(loweredPrevious) && !extractWeatherLocation(previous)) {
      return buildWeatherMissingLocationReply(language);
    }
    if (previous && extractAbilityTopic(previous)) {
      return buildTopicAbilityReply(extractAbilityTopic(previous), language);
    }
    if (language === "ko") {
      return pickReplyVariant(seed, [
        "맞아. 방금 답이 빗나갔어. 이번엔 돌려 말하지 말고 바로 맞춰서 갈게.",
        "오케이, 아까 답은 버리고 다시 갈게. 이번엔 더 직접적으로 답하겠다.",
        "알겠어. 방금 건 어색했어. 이번엔 네 말 의도에 맞춰서 짧고 바로 답할게.",
      ]);
    }
    if (language === "ja") return "その通りです。さっきの答えはずれていました。今度はもっと直接合わせます。";
    if (language === "zh") return "对，刚才那句跑偏了。这次我会更直接地贴着你的意思来答。";
    return "You're right. That drifted. I'll answer more directly this time.";
  }

  function buildConfusionReply(language) {
    if (language === "ko") return "맞아. 방금 말이 이상했어. 이번엔 더 짧고 자연스럽게 다시 말해볼게.";
    if (language === "ja") return "その通りです。さっきの言い方は変でした。今度はもっと短く自然に言い直します。";
    if (language === "zh") return "对，刚才那句很怪。这次我会说得更短、更自然一点。";
    return "You're right. That came out weird. I'll say it again more naturally.";
  }

  function buildOpenQuestionReply(prompt, language, style) {
    const seed = `${language}:${state.history.length}:${prompt}`;
    if (language === "ko") {
      if (trim(prompt).endsWith("?")) {
        return pickReplyVariant(seed, [
          "그 얘기면 같이 볼 수 있어. 내가 아는 선에서 바로 이어볼게.",
          style === "coach"
            ? "좋아, 그 질문은 같이 정리해볼 수 있어. 핵심부터 바로 잡아볼게."
            : "응, 그 질문도 바로 이어서 답할 수 있어.",
          "그 주제 괜찮아. 내가 먼저 짧게 풀어볼게.",
        ]);
      }
      return pickReplyVariant(seed, [
        "좋아, 그 이야기로 이어가자. 내가 흐름 맞춰서 따라갈게.",
        "오케이, 그 주제로 가자. 편하게 계속 말해줘.",
        style === "coach"
          ? "좋아. 그 흐름으로 하나씩 맞춰보자."
          : "응, 그 얘기도 괜찮아. 그대로 이어가자.",
      ]);
    }
    if (language === "ja") return trim(prompt).endsWith("?") ? "その話ならそのまま答えられます。" : "その話題で続けましょう。";
    if (language === "zh") return trim(prompt).endsWith("?") ? "这个问题我可以直接接着答。" : "好，就顺着这个话题继续。";
    return trim(prompt).endsWith("?") ? "I can answer that directly." : "Okay, let's continue with that.";
  }

  function buildShortPromptReply(prompt, language) {
    const normalized = trim(prompt);
    const loweredPrompt = lower(normalized);
    if (/^\d+$/.test(normalized)) {
      if (language === "ko") return "숫자만 보여서 아직 뜻을 못 잡았어. 그 숫자가 뭘 뜻하는지만 한 줄 더 적어줘.";
      if (language === "ja") return "数字だけだとまだ意味が取れません。何を表す数字か一言だけ補足してください。";
      if (language === "zh") return "现在只有数字，我还不知道它表示什么。再补一句说明就行。";
      return "I only see a number so far. Add one short line telling me what it refers to.";
    }
    if (isAlternativePrompt(loweredPrompt)) return buildAlternativeReply(language);
    if (isDirectAddressPrompt(loweredPrompt)) return buildIdentityReply(language);
    if (isHesitationPrompt(loweredPrompt)) return buildHesitationReply(language);
    if (trim(loweredPrompt) === "?") return buildConfusionReply(language);
    if (language === "ko") return "짧게 말해도 괜찮아. 한마디만 더 붙여주면 내가 맥락 맞춰서 이어갈게.";
    if (language === "ja") return "短くても大丈夫です。一言だけ足してくれれば、流れを合わせて続けます。";
    if (language === "zh") return "说得短也没关系。你再补一句，我就能顺着你的意思接下去。";
    return "Short is fine. Give me one more phrase and I can continue in the right direction.";
  }

  function buildModelRetryReply(language, kind) {
    if (language === "ko") {
      if (kind === "repair") return "이번엔 모델 응답이 비었어. 원하는 방향을 한 줄만 더 붙여주면 바로 다시 맞춰볼게.";
      return "지금 모델 응답이 비었어. 같은 뜻으로 한 번만 더 보내주면 바로 다시 시도할게.";
    }
    if (language === "ja") {
      if (kind === "repair") return "今回はモデルの返答が空でした。望む方向を一言だけ足してくれれば、すぐにやり直します。";
      return "今はモデルの返答が空でした。もう一度だけ言い換えて送ってくれれば、すぐ再試行します。";
    }
    if (language === "zh") {
      if (kind === "repair") return "这次模型输出为空。你再补一句想要的方向，我就马上重试。";
      return "现在模型输出为空。你换一句再发一次，我就立刻重新尝试。";
    }
    if (kind === "repair") return "The model returned an empty reply this time. Add one short hint about the direction you want and I will retry.";
    return "The model returned an empty reply. Send it one more time and I will retry right away.";
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const normalized = trim(prompt);
    if (!normalized) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt)
    ) {
      return "";
    }

    try {
      const generated = await generateReasonedChatReply(prompt, language);
      const cleaned = cleanupBrowserModelReply(generated, prompt);
      if (
        cleaned &&
        cleaned.length >= 4 &&
        normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
        !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
      ) {
        return cleaned;
      }
    } catch (_error) {
      // Fall through to minimal fallback.
    }

    return "";
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "Please analyze the attached material.";
    const loweredPrompt = lower(prompt);
    const promptLanguage = getReplyLanguage(prompt, []);
    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const wantsAlternative = isAlternativePrompt(loweredPrompt);
    const wantsRepair = (isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt)) && !wantsAlternative;
    const previousUser = trim(previousUserPrompt(userEntry.id));
    const intentPrompt = wantsRepair && previousUser
      ? `${previousUser}\n\nUser follow-up: ${prompt}\nAssistant:`
      : buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const replyStyle = getReplyStyle(intentPrompt || prompt, "general");

    if (isNaturalChatPreferencePrompt(loweredPrompt)) {
      state.prefersOpenEndedChat = true;
      if (promptLanguage === "ko") return { text: "좋아. 앞으로는 메뉴형 답보다 자연스럽고 바로 반응하는 쪽으로 맞출게.", meta: "" };
      if (promptLanguage === "ja") return { text: "分かりました。これからは固定的な答えより、もっと自然にそのまま返す方向で合わせます。", meta: "" };
      if (promptLanguage === "zh") return { text: "好，我接下来会尽量减少固定模板，改成更自然、更直接的回应。", meta: "" };
      return { text: "Got it. I will lean less on fixed phrasing and answer more naturally from here.", meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, promptLanguage);
      if (searchReply) return searchReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, promptLanguage);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(promptLanguage), meta: "" };
    }

    if (currentDocs.length) {
      const currentReply = replyFromDocuments(intentPrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(promptLanguage),
        language: promptLanguage,
        style: replyStyle,
      });
      if (currentReply) return currentReply;
    }

    const modelFirstReply = await tryModelFirstReply(intentPrompt, promptLanguage);
    if (modelFirstReply) return { text: modelFirstReply, meta: "" };

    if (historyDocs.length && shouldUseHistoryDocuments(loweredIntentPrompt)) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const combined = dedupeDocuments(localDocs).slice(0, 8);
      const evidence = collectEvidence(effectiveQuery, combined);
      if (evidence.length) {
        const evidenceLanguage = getReplyLanguage(intentPrompt, evidence);
        return {
          text: composeFromEvidence("general", intentPrompt, evidence, { language: evidenceLanguage, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language: evidenceLanguage }),
        };
      }
    }

    const fallbackCode = "PB-FALLBACK-001";
    return {
      text: buildModelRetryReply(promptLanguage, wantsRepair ? "repair" : "general"),
      meta: "",
      code: fallbackCode,
    };
  }

  function renderModelRegistry() {
    const registry = state.modelRegistry;
    const header = document.getElementById("model-menu-header");
    const list = document.getElementById("model-version-list");
    const topSep = document.getElementById("model-version-sep-top");
    const bottomSep = document.getElementById("model-version-sep-bottom");
    const label = getRuntimeModelLabel();
    const currentId = getSelectedRuntimeModelId() || (registry && registry.current_model_id ? registry.current_model_id : "");
    const currentLabelKey = normalizeDialogueText(label);

    if (header) header.textContent = registry && registry.family_name ? registry.family_name : "Purple Bee";
    setEngineStatus(engine.browserRuntime || engine.model ? "ready" : engine.loading ? "loading" : "idle", label, getLocalStatusMessage(engine.browserRuntime || engine.model ? "ready" : engine.loading ? "loading" : "idle"));

    if (!list) return;
    list.innerHTML = "";
    list.style.display = "none";
    if (topSep) topSep.style.display = "none";
    if (bottomSep) bottomSep.style.display = "none";
    if (!registry || !Array.isArray(registry.models) || registry.models.length <= 1) return;

    const seen = new Set([currentLabelKey]);
    let rendered = 0;
    registry.models.forEach((model) => {
      const displayName = model.display_name || model.id || "Purple Bee";
      const displayKey = normalizeDialogueText(displayName);
      if ((currentId && model.id === currentId) || seen.has(displayKey)) return;
      seen.add(displayKey);
      const item = document.createElement("div");
      item.className = "model-menu-item";
      item.tabIndex = 0;
      const badges = [];
      if (model.latest) badges.push("latest");
      if (model.trainable) badges.push("trainable");
      item.innerHTML = `
        <span class="item-icon" style="background:rgba(139,92,246,.12)">
          <i class="ph ph-cube" style="color:var(--accent-light)"></i>
        </span>
        <span>
          <div style="color:var(--text)">${escapeHtml(displayName)}</div>
          <div style="font-size:10px;color:var(--text-3)">${escapeHtml([model.architecture_name || "", badges.join(" · ")].filter(Boolean).join(" · "))}</div>
        </span>
      `;
      item.addEventListener("click", () => switchRuntimeModel(model.id));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          switchRuntimeModel(model.id);
        }
      });
      list.appendChild(item);
      rendered += 1;
    });

    if (rendered > 0) {
      list.style.display = "";
      if (topSep) topSep.style.display = "";
      if (bottomSep) bottomSep.style.display = "";
    }
  }

  const PBX_USER_KEY = "pb_user_v1";
  const PBX_MEMORY_PREFIX = "pb_user_memories_v1_";
  const PBX_THEME_KEY = "pb_theme_v1";
  const PBX_CONTEXT_MENU = { open: false, conversationId: "" };
  const PBX_WELCOME_LINES = [
    "오늘은 어떤 이야기를 할까요?",
    "준비되면 얘기해 주세요.",
    "오늘은 어떤 걸 함께 도와드릴까요?",
    "지금 떠오른 고민 하나만 던져줘요.",
    "가볍게 시작해도 좋아요. 제가 맞춰갈게요.",
    "오늘 할 일 같이 정리해볼까요?",
    "바로 시작해요. 지금 제일 필요한 것부터요.",
    "짧게 말해도 괜찮아요. 핵심만 던져주세요.",
    "지금 막히는 지점부터 같이 보죠.",
    "오늘 목표 한 줄만 알려주세요.",
    "자료가 있다면 붙여주고, 없으면 말로만 시작해도 돼요.",
    "어떤 톤으로 답하면 좋을지 같이 맞춰볼게요.",
    "급한 순서대로 하나씩 정리해볼까요?",
    "지금 생각나는 질문부터 바로 물어봐요.",
    "어디서부터 막혔는지부터 알려주세요.",
    "딱 한 문장으로 시작해도 됩니다.",
    "대화 이어서 갈까요, 새로 시작할까요?",
    "오늘은 속도 우선으로 빠르게 가볼게요.",
    "조금 천천히, 정확하게 가도 좋아요.",
    "바로 실전으로 들어가도 돼요.",
    "필요하면 제가 먼저 질문으로 정리해줄게요.",
    "문서, 코드, 스크린샷 모두 같이 볼 수 있어요.",
    "짧은 질문도 괜찮아요. 바로 이어갈게요.",
    "원하는 결과 형태를 알려주면 더 정확해져요.",
    "지금 가장 중요한 문제 하나만 골라봐요.",
    "오늘은 어떤 방향으로 도와드릴까요?",
    "실패한 시도도 알려주면 해결이 빨라져요.",
    "결론부터 원하면 결론부터 드릴게요.",
    "설명형, 요약형, 단계형 중 원하는 방식으로 갈게요.",
    "계속 이어서 작업해도 좋고, 새로 정리해도 좋아요.",
    "먼저 어디까지 했는지 알려주세요.",
    "필요하면 제가 다음 액션을 제안해드릴게요.",
    "말투도 맞춰드릴 수 있어요. 편하게 말해줘요.",
    "작은 질문부터 쌓아도 충분히 잘 풀립니다.",
    "바로 시작할 준비됐어요.",
    "대화 흐름 유지하면서 도와드릴게요.",
    "오류 로그가 있다면 붙여주세요. 바로 분석해볼게요.",
    "요약이 필요하면 길게 말해도 제가 정리해드려요.",
    "우선순위 정리부터 할까요?",
    "한 번에 많이 물어봐도 괜찮아요.",
    "짧게 던지고 빠르게 왕복해도 좋습니다.",
    "현재 상황 설명 한 줄이면 충분해요.",
    "원하는 결과물 형태를 같이 정해볼까요?",
    "필요한 자료가 없으면 대화만으로도 시작할 수 있어요.",
    "막힌 느낌이 들면 그 지점만 콕 집어줘요.",
    "오늘은 어떤 방식으로 진행할까요?",
    "바로 도와드릴게요. 질문 주세요.",
    "편하게 시작해요. 제가 흐름 맞출게요.",
    "한 문장만 있어도 시작할 수 있어요.",
    "지금 필요한 걸 말해주면 바로 이어갈게요.",
  ];

  function pbxCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem(PBX_USER_KEY) || "null");
    } catch (_error) {
      return null;
    }
  }

  function pbxSetUser(user) {
    if (!user) {
      localStorage.removeItem(PBX_USER_KEY);
      return;
    }
    localStorage.setItem(PBX_USER_KEY, JSON.stringify(user));
  }

  function pbxMemoryKey() {
    const user = pbxCurrentUser();
    if (!user || !user.email) return "";
    return `${PBX_MEMORY_PREFIX}${lower(user.email)}`;
  }

  function pbxConversationKey() {
    const user = pbxCurrentUser();
    if (!user || !user.email) return STORAGE_KEY;
    return `${STORAGE_KEY}_${lower(user.email)}`;
  }

  function pbxLoadMemories() {
    const key = pbxMemoryKey();
    if (!key) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function pbxSaveMemories(memories) {
    const key = pbxMemoryKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify((memories || []).slice(0, 100)));
  }

  function pbxApplyTheme() {
    const saved = localStorage.getItem(PBX_THEME_KEY) || state.settings.theme || "dark";
    state.settings.theme = saved;
    document.body.classList.toggle("theme-light", saved === "light");
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = saved;
  }

  function pbxSetTheme(value) {
    const next = value === "light" ? "light" : "dark";
    state.settings.theme = next;
    localStorage.setItem(PBX_THEME_KEY, next);
    persistSettings();
    pbxApplyTheme();
  }

  function pbxSetRandomWelcome() {
    const node = document.getElementById("home-subtitle");
    if (!node) return;
    const index = Math.floor(Math.random() * PBX_WELCOME_LINES.length);
    node.textContent = PBX_WELCOME_LINES[index];
  }

  function pbxInferConversationTitle(text) {
    const source = normalizeWhitespace(String(text || "").replace(/[?？！]+$/u, ""));
    if (!source) return "새 대화";
    const loweredPrompt = lower(source);
    if (containsAny(loweredPrompt, ["날씨", "weather", "forecast"])) return "날씨 확인";
    if (containsAny(loweredPrompt, ["코드", "코딩", "error", "bug", "debug"])) return "코드 점검";
    if (containsAny(loweredPrompt, ["요약", "정리", "summary"])) return "요약 요청";
    if (containsAny(loweredPrompt, ["번역", "translate"])) return "번역";
    if (containsAny(loweredPrompt, ["기억", "메모리", "저장해줘"])) return "메모 관리";
    return shorten(source, 34);
  }

  function pbxEnsureAuth(requiredAction) {
    if (pbxCurrentUser()) return true;
    showToast(requiredAction || "Google 로그인 후 사용할 수 있습니다.");
    return false;
  }

  function pbxRenderProfileMenu() {
    const user = pbxCurrentUser();
    const emailNode = document.getElementById("profile-email");
    const titleNode = document.getElementById("profile-head-title");
    const loginBtn = document.getElementById("google-login-btn");
    const logoutBtn = document.getElementById("profile-logout-btn");
    if (titleNode) titleNode.textContent = user ? (user.name || "로그인됨") : "로그인 필요";
    if (emailNode) emailNode.textContent = user ? (user.email || "") : "Google 계정을 연결하면 대화와 메모리를 사용자별로 유지합니다.";
    if (loginBtn) loginBtn.style.display = user ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = user ? "" : "none";
    pbxRenderMemoryList();
    pbxRefreshContributorSidebar().catch(() => {});
  }

  function pbxContributorStrings() {
    const lang = getActiveUiLanguage();
    if (lang === "ko") {
      return {
        upgradeTitle: "⚡ 플랜 업그레이드",
        upgradeSub: "Free, Basic, Plus, Pro 플랜과 기여 기반 업그레이드를 확인해 보세요.",
        cardTitle: "기여 구독 상태",
        cardSub: "현재 플랜, 큐, 연결된 기기만 간단하게 보여드려요.",
        labels: { plan: "플랜", premium: "프리미엄", queue: "큐", next: "다음 기여", mode: "연산 모드" },
        values: { inactive: "비활성", active: "활성", standard: "표준", none: "없음", free: "Free" },
        deviceLabel: "연결된 기기",
        deviceCount: "{count}대 연결됨",
        noteAnon: "Google 로그인 후 기여 시간 예약과 구독 상태를 계정 기준으로 관리할 수 있어요.",
        noteFree: "Free에서는 내 기기 연산만 사용합니다. Basic 이상부터 분산 보조 연산 모드를 고를 수 있어요.",
        noteActive: "현재 기여 기반 구독이 활성화되어 있어요. 모드와 다음 기여 시간을 여기서 빠르게 확인할 수 있어요.",
        openPlans: "✨ 자세히",
        downloadApp: "🧩 앱",
        refresh: "🔄",
        modeOptions: {
          local: "내 기기 연산",
          hybrid: "내 기기 + 분산 보조 연산",
          distributed: "분산 보조 연산 우선",
        },
        modeDesc: "Basic 이상부터 모드를 고를 수 있어요.",
      };
    }
    if (lang === "ja") {
      return {
        upgradeTitle: "⚡ プランをアップグレード",
        upgradeSub: "Free・Basic・Plus・Pro と貢献型特典を見る",
        cardTitle: "貢献サブスク状態",
        cardSub: "予約した貢献時間と現在の有効プランをまとめて確認できます。",
        labels: { plan: "プラン", premium: "Premium", queue: "キュー", next: "次の貢献" },
        values: { inactive: "未有効", active: "有効", standard: "標準", none: "なし", free: "Free" },
        noteAnon: "Google ログイン後、ユーザー単位で貢献予定とプラン状態を管理できます。",
        noteFree: "貢献時間を予約すると Basic / Plus / Pro 特典を有効化できます。",
        noteActive: "現在、貢献型サブスクが有効です。追加予約で特典期間を延長できます。",
        openPlans: "プランを見る",
        refresh: "更新",
      };
    }
    return {
      upgradeTitle: "⚡ Upgrade plans",
      upgradeSub: "See Free, Basic, Plus, Pro and contributor benefits",
      cardTitle: "Contributor status",
      cardSub: "A compact summary of your plan, queue, and linked device.",
      labels: { plan: "Plan", premium: "Premium", queue: "Queue", next: "Next window", mode: "Compute mode" },
      values: { inactive: "Inactive", active: "Active", standard: "Standard", none: "None", free: "Free" },
      deviceLabel: "Linked device",
      deviceCount: "{count} linked",
      noteAnon: "Sign in with Google to manage contributor windows and plan status per account.",
      noteFree: "Free uses local compute only. Basic and above can switch to distributed assist modes.",
      noteActive: "Your contributor subscription is active. Open the hub for reservation details and plan controls.",
      openPlans: "✨ Details",
      downloadApp: "🧩 App",
      refresh: "🔄",
      modeOptions: {
        local: "Local compute",
        hybrid: "Local + contributor assist",
        distributed: "Contributor assist priority",
      },
      modeDesc: "Basic and above can choose a compute mode.",
    };
  }

  function pbxNormalizePlanTier(plan) {
    const normalized = trim(String(plan || "Free"));
    if (!normalized) return "Free";
    const lowered = normalized.toLowerCase();
    if (lowered === "basic") return "Basic";
    if (lowered === "plus") return "Plus";
    if (lowered === "pro") return "Pro";
    return "Free";
  }

  function pbxIsPaidPlan(plan) {
    return ["Basic", "Plus", "Pro"].includes(pbxNormalizePlanTier(plan));
  }

  function pbxContributorLocalePrefix() {
    return getActiveUiLanguage() === "ko"
      ? "ko-KR"
      : getActiveUiLanguage() === "ja"
        ? "ja-JP"
        : "en-US";
  }

  function pbxGetContributorComputeMode() {
    const saved = trim(localStorage.getItem("pb_contributor_compute_mode") || "");
    return ["local", "hybrid", "distributed"].includes(saved) ? saved : "local";
  }

  function pbxSetContributorComputeMode(mode) {
    const safeMode = ["local", "hybrid", "distributed"].includes(mode) ? mode : "local";
    localStorage.setItem("pb_contributor_compute_mode", safeMode);
    return safeMode;
  }

  function pbxApplyContributorComputeMode(plan) {
    const copy = pbxContributorStrings();
    const row = document.getElementById("contributor-mode-row");
    const labelNode = document.getElementById("contributor-mode-label");
    const descNode = document.getElementById("contributor-mode-desc");
    const select = document.getElementById("contributor-compute-mode-select");
    if (!row || !labelNode || !descNode || !select) return "local";
    labelNode.textContent = copy.labels.mode;
    descNode.textContent = copy.modeDesc;
    select.innerHTML = "";
    const tier = pbxNormalizePlanTier(plan);
    const canUseDistributed = tier === "Plus" || tier === "Pro";
    const options = [
      { value: "local", label: copy.modeOptions.local, disabled: false },
      { value: "hybrid", label: copy.modeOptions.hybrid, disabled: !pbxIsPaidPlan(tier) },
      { value: "distributed", label: copy.modeOptions.distributed, disabled: !canUseDistributed },
    ];
    options.forEach((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      node.disabled = !!option.disabled;
      select.appendChild(node);
    });
    let selected = pbxGetContributorComputeMode();
    if (selected === "distributed" && !canUseDistributed) selected = pbxIsPaidPlan(tier) ? "hybrid" : "local";
    if (selected === "hybrid" && !pbxIsPaidPlan(tier)) selected = "local";
    select.value = selected;
    row.classList.toggle("hidden", !pbxIsPaidPlan(tier));
    pbxSetContributorComputeMode(selected);
    return selected;
  }

  function pbxOpenUpgradePage(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    pbxOpenContributorHub("plans");
  }

  function pbxOpenContributorHub(mode = "status") {
    const backdrop = document.getElementById("contributor-hub-backdrop");
    const frame = document.getElementById("contributor-hub-frame");
    const titleNode = document.getElementById("contributor-hub-title");
    const subtitleNode = document.getElementById("contributor-hub-subtitle");
    const footLeftNode = document.getElementById("contributor-hub-foot-left");
    const footRightNode = document.getElementById("contributor-hub-foot-right");
    if (!backdrop || !frame) return;
    const safeMode = mode === "plans" ? "plans" : "status";
    if (titleNode) {
      titleNode.textContent = safeMode === "plans"
        ? (getActiveUiLanguage() === "ko" ? "플랜 업그레이드" : "Upgrade plans")
        : (getActiveUiLanguage() === "ko" ? "기여 구독 상태" : "Contributor status");
    }
    if (subtitleNode) {
      subtitleNode.textContent = safeMode === "plans"
        ? (getActiveUiLanguage() === "ko"
          ? "Free, Basic, Plus, Pro 플랜 차이와 혜택만 한눈에 볼 수 있어요."
          : "See only the Free, Basic, Plus, and Pro plan differences in one place.")
        : (getActiveUiLanguage() === "ko"
          ? "기여 앱 연결, 예약 시간, 연결 기기 상태를 한 화면에서 관리할 수 있어요."
          : "Manage contributor app sync, reservations, and device status in one place.");
    }
    if (footLeftNode) {
      footLeftNode.textContent = safeMode === "plans"
        ? (getActiveUiLanguage() === "ko"
          ? "Free에서는 내 기기 연산만 사용하고, Basic 이상부터 분산 보조 연산 모드를 선택할 수 있어요."
          : "Free uses local compute only. Basic and above can choose distributed assist modes.")
        : (getActiveUiLanguage() === "ko"
          ? "기여 예약은 기여 앱 설치와 사이트 동기화가 확인된 뒤에만 활성화됩니다."
          : "Contributor reservations unlock only after the app is installed and synced.")
    }
    if (footRightNode) {
      footRightNode.textContent = safeMode === "plans"
        ? (getActiveUiLanguage() === "ko"
          ? "정확한 기기 판정과 예약 기여 실행은 기여 앱에서 처리됩니다."
          : "Exact hardware checks and scheduled contribution run inside the contributor app.")
        : (getActiveUiLanguage() === "ko"
          ? "연결 기기가 끊기면 예약 저장이 잠기고, 다시 동기화하면 바로 복구됩니다."
          : "If the linked device disconnects, reservations lock until sync is restored.");
    }
    frame.src = `/${pbxContributorLocalePrefix()}/index/purple-bee/pricing/?embed=${safeMode}`;
    backdrop.classList.add("open");
  }

  function pbxCloseContributorHub(event) {
    if (event && event.target && event.target.id !== "contributor-hub-backdrop") return;
    const backdrop = document.getElementById("contributor-hub-backdrop");
    const frame = document.getElementById("contributor-hub-frame");
    if (backdrop) backdrop.classList.remove("open");
    if (frame) frame.src = "about:blank";
  }

  function pbxUpdateContributorComputeMode(mode) {
    const selected = pbxSetContributorComputeMode(mode);
    const copy = pbxContributorStrings();
    const noteNode = document.getElementById("contributor-card-note");
    if (!noteNode) return;
    if (selected === "distributed") {
      noteNode.textContent = getActiveUiLanguage() === "ko"
        ? "분산 보조 연산 우선 모드가 선택되어 있어요. 상위 플랜에서만 안정적으로 사용할 수 있어요."
        : "Contributor assist priority is selected. This mode is intended for higher plans.";
    } else if (selected === "hybrid") {
      noteNode.textContent = getActiveUiLanguage() === "ko"
        ? "내 기기 연산에 기여 네트워크 보조 연산을 함께 쓰는 하이브리드 모드예요."
        : "Hybrid mode mixes local compute with contributor network assist.";
    } else {
      noteNode.textContent = pbxCurrentUser() ? copy.noteActive : copy.noteFree;
    }
  }

  async function pbxDownloadContributorApp() {
    const user = pbxCurrentUser();
    if (!user) {
      showToast(getActiveUiLanguage() === "ko" ? "Google 로그인 후 기여 앱을 내려받을 수 있어요." : "Sign in with Google before downloading the contributor app.");
      return;
    }
    const userId = pbxContributorUserId();
    const displayName = trim(user?.name || user?.email || "");
    try {
      const response = await fetch(`/api/contributor/client/download?user_id=${encodeURIComponent(userId)}&display_name=${encodeURIComponent(displayName)}`);
      if (!response.ok) throw new Error(`download-${response.status}`);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `purple-bee-contributor-${userId.slice(0, 12)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1500);
      showToast(getActiveUiLanguage() === "ko" ? "기여 앱 다운로드를 시작했어요." : "Contributor app download started.");
    } catch (_error) {
      showToast(getActiveUiLanguage() === "ko" ? "기여 앱 다운로드를 시작할 수 없어요." : "Unable to start the contributor app download.");
    }
  }

  function pbxContributorUserId() {
    const user = pbxCurrentUser();
    const stored = trim(localStorage.getItem("pb_contributor_user_id") || "");
    const preferred = trim(String(user?.sub || user?.email || stored || ""));
    const value = preferred || `pb_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("pb_contributor_user_id", value);
    return value;
  }

  function pbxFormatContributorDate(value) {
    if (!value) return pbxContributorStrings().values.none;
    try {
      return new Date(value).toLocaleString(getActiveUiLanguage() === "ko" ? "ko-KR" : getActiveUiLanguage() === "ja" ? "ja-JP" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_error) {
      return String(value);
    }
  }

  async function pbxRefreshContributorSidebar() {
    const copy = pbxContributorStrings();
    const upgradeNode = document.getElementById("upgrade-plan-btn");
    const cardNode = document.getElementById("contributor-card");
    setText("upgrade-plan-title", copy.upgradeTitle);
    setText("upgrade-plan-sub", copy.upgradeSub);
    setText("contributor-card-title", copy.cardTitle);
    setText("contributor-card-sub", copy.cardSub);
    setText("contributor-stat-plan-label", copy.labels.plan);
    setText("contributor-stat-premium-label", copy.labels.premium);
    setText("contributor-stat-queue-label", copy.labels.queue);
    setText("contributor-stat-next-label", copy.labels.next);
    setText("contributor-upgrade-btn", copy.openPlans);
    setText("contributor-refresh-btn", copy.refresh);

    const planNode = document.getElementById("contributor-plan-value");
    const premiumNode = document.getElementById("contributor-premium-value");
    const queueNode = document.getElementById("contributor-queue-value");
    const nextNode = document.getElementById("contributor-next-value");
    const pillNode = document.getElementById("contributor-card-pill");
    const noteNode = document.getElementById("contributor-card-note");
    const deviceLabelNode = document.getElementById("contributor-device-label");
    const deviceNode = document.getElementById("contributor-device-value");
    if (!planNode || !premiumNode || !queueNode || !nextNode || !pillNode || !noteNode || !deviceNode || !deviceLabelNode || !upgradeNode || !cardNode) return;

    const user = pbxCurrentUser();
    setText("contributor-download-btn", copy.downloadApp);
    deviceLabelNode.textContent = copy.deviceLabel;
    if (!user) {
      upgradeNode.classList.remove("hidden");
      cardNode.classList.add("hidden");
      cardNode.classList.remove("disabled");
      planNode.textContent = copy.values.free;
      premiumNode.textContent = copy.values.inactive;
      queueNode.textContent = copy.values.standard;
      nextNode.textContent = copy.values.none;
      pillNode.textContent = copy.values.free;
      noteNode.textContent = copy.noteAnon;
      deviceNode.textContent = copy.values.none;
      return;
    }

    try {
      const response = await fetch(`/api/contributor/status?user_id=${encodeURIComponent(pbxContributorUserId())}`);
      const payload = await response.json();
      if (!payload || !payload.ok) throw new Error("status-unavailable");
      const account = payload.account || {};
      const reservations = Array.isArray(payload.reservations) ? payload.reservations : [];
      const devices = Array.isArray(payload.devices) ? payload.devices : [];
      const nextReservation = reservations.find((item) => String(item.status || "").toLowerCase() === "scheduled") || reservations[0] || null;
      const plan = trim(account.plan || "Free");
      const premiumActive = !!payload.premium_active;
      const mode = pbxApplyContributorComputeMode(plan);
      const paidPlan = pbxIsPaidPlan(plan);
      upgradeNode.classList.toggle("hidden", paidPlan);
      cardNode.classList.remove("hidden");
      cardNode.classList.toggle("disabled", !paidPlan);
      planNode.textContent = plan;
      premiumNode.textContent = premiumActive ? copy.values.active : copy.values.inactive;
      queueNode.textContent = trim((account.latest_quote && account.latest_quote.queue_mode) || payload.queue_mode || copy.values.standard);
      nextNode.textContent = nextReservation ? pbxFormatContributorDate(nextReservation.starts_at) : copy.values.none;
      pillNode.textContent = premiumActive ? `${plan} Active` : plan;
      noteNode.textContent = !paidPlan
        ? copy.noteFree
        : mode === "distributed"
          ? (getActiveUiLanguage() === "ko" ? "분산 보조 연산 우선 모드가 선택되어 있어요." : "Contributor assist priority mode is active.")
          : mode === "hybrid"
            ? (getActiveUiLanguage() === "ko" ? "내 기기 + 분산 보조 연산을 함께 쓰는 모드예요." : "Hybrid local + contributor assist mode is active.")
            : copy.noteActive;
      deviceNode.textContent = trim(payload.exact_device_summary || "") || (devices.length ? copy.deviceCount.replace("{count}", String(devices.length)) : copy.values.none);
    } catch (_error) {
      upgradeNode.classList.remove("hidden");
      cardNode.classList.add("hidden");
      cardNode.classList.remove("disabled");
      planNode.textContent = copy.values.free;
      premiumNode.textContent = copy.values.inactive;
      queueNode.textContent = copy.values.standard;
      nextNode.textContent = copy.values.none;
      pillNode.textContent = copy.values.free;
      noteNode.textContent = copy.noteFree;
      deviceNode.textContent = copy.values.none;
    }
  }

  function pbxCloseProfileMenu() {
    const menu = document.getElementById("profile-menu");
    if (menu) menu.classList.remove("open");
  }

  function toggleProfileMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById("profile-menu");
    if (!menu) return;
    document.getElementById("attach-menu").classList.remove("open");
    document.getElementById("model-menu").classList.remove("open");
    menu.classList.toggle("open");
  }

  function openLanguageFromMenu() {
    pbxCloseProfileMenu();
    openSettings();
    const node = document.getElementById("ui-language-select");
    if (node) node.focus();
  }

  function loginWithGoogle() {
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      showToast("Google 로그인 SDK를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      return;
    }
    const clientId = window.PB_GOOGLE_CLIENT_ID || "243688916223-7vp3gveim7mjo7ra804nv33fdqt0bfok.apps.googleusercontent.com";
    if (!clientId || clientId === "REPLACE_WITH_GOOGLE_CLIENT_ID") {
      showToast("Google Client ID가 아직 설정되지 않았습니다.");
      return;
    }
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        try {
          const payload = pbxDecodeJwtPayload(response.credential || "");
          if (!payload) throw new Error("invalid-jwt");
          const normalizedName = pbxNormalizeUserName(payload.name || payload.given_name || "", payload.email || "");
          const user = {
            name: normalizedName || "Google User",
            email: payload.email || "",
            picture: payload.picture || "",
            sub: payload.sub || "",
            token: response.credential || "",
            time: Date.now(),
          };
          pbxSetUser(user);
          pbxRenderProfileMenu();
          loadConversationList();
          showToast(`${user.name || user.email || "계정"} 로그인 완료`);
        } catch (_error) {
          showToast("Google 로그인 처리 중 오류가 발생했습니다.");
        }
      },
      auto_select: true,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.prompt();
  }

  function pbxDecodeJwtPayload(token) {
    try {
      const part = String(token || "").split(".")[1] || "";
      if (!part) return null;
      const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
      const pad = normalized.length % 4;
      const padded = pad ? `${normalized}${"=".repeat(4 - pad)}` : normalized;
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const jsonText = new TextDecoder("utf-8").decode(bytes);
      return JSON.parse(jsonText);
    } catch (_error) {
      return null;
    }
  }

  function pbxNormalizeUserName(name, email) {
    const candidate = trim(name || "");
    if (!candidate) return trim(String(email || "").split("@")[0] || "");
    if (candidate.includes("�")) return trim(String(email || "").split("@")[0] || candidate);
    if (/[ÃÂÐÑ]/.test(candidate)) return trim(String(email || "").split("@")[0] || candidate);
    return candidate;
  }

  function logoutUser() {
    if (!confirm("로그아웃하시겠습니까? 저장된 대화와 메모리는 계정별로 유지됩니다.")) return;
    const user = pbxCurrentUser();
    if (user && user.email && window.google && window.google.accounts && window.google.accounts.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
        window.google.accounts.id.revoke(user.email, () => {});
      } catch (_error) {}
    }
    pbxSetUser(null);
    pbxCloseProfileMenu();
    pbxRenderProfileMenu();
    showToast("로그아웃되었습니다.");
  }

  function pbxRenderMemoryList() {
    const container = document.getElementById("memory-list");
    if (!container) return;
    const memories = pbxLoadMemories();
    container.innerHTML = "";
    if (!pbxCurrentUser()) {
      container.innerHTML = '<div class="memory-empty">Google 로그인 후 메모리를 저장하고 관리할 수 있습니다.</div>';
      return;
    }
    if (!memories.length) {
      container.innerHTML = '<div class="memory-empty">저장된 메모리가 아직 없습니다.</div>';
      return;
    }
    memories.forEach((memory) => {
      const item = document.createElement("div");
      item.className = "memory-item";
      item.innerHTML = `
        <div class="memory-item-main">
          <div class="memory-item-title">${escapeHtml(memory.title || "저장 메모")}</div>
          <div class="memory-item-body">${escapeHtml(memory.text || "")}</div>
        </div>
        <button class="settings-action" type="button" style="width:auto;padding:8px 10px" onclick="deleteMemoryById('${escapeHtml(memory.id)}')">삭제</button>
      `;
      container.appendChild(item);
    });
  }

  function deleteMemoryById(memoryId) {
    if (!pbxEnsureAuth("Google 로그인 후 메모리를 관리할 수 있습니다.")) return;
    const memories = pbxLoadMemories();
    const target = memories.find((memory) => memory.id === memoryId);
    if (!target) return;
    if (!confirm(`메모 '${target.title || "저장 메모"}'를 삭제할까요?`)) return;
    pbxSaveMemories(memories.filter((memory) => memory.id !== memoryId));
    pbxRenderMemoryList();
    showToast("메모리를 삭제했습니다.");
  }

  function clearAllMemories() {
    if (!pbxEnsureAuth("Google 로그인 후 메모리를 관리할 수 있습니다.")) return;
    if (!confirm("저장된 메모리를 모두 삭제할까요?")) return;
    pbxSaveMemories([]);
    pbxRenderMemoryList();
    showToast("모든 메모리를 삭제했습니다.");
  }

  function pbxExtractMemoryRequest(prompt) {
    const source = trim(prompt);
    if (!source) return "";
    const memoryRequest = source.match(/(?:저장해줘|기억해줘|메모(?:리에)?\s*저장해줘|기억해 둬|기억해줘)\s*[:：]?\s*(.+)$/u);
    if (memoryRequest && memoryRequest[1]) return trim(memoryRequest[1]);
    const quoted = source.match(/["“](.+?)["”]\s*(?:저장해줘|기억해줘)/u);
    if (quoted && quoted[1]) return trim(quoted[1]);
    return "";
  }

  function pbxWantsMemoryList(prompt) {
    return containsAny(lower(prompt), ["기억한 거", "저장한 거", "메모리 보여", "내 정보 보여", "what do you remember"]);
  }

  function pbxRememberText(text) {
    if (!pbxEnsureAuth("Google 로그인 후 메모리를 저장할 수 있습니다.")) return false;
    const memories = pbxLoadMemories();
    const item = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: pbxInferConversationTitle(text),
      text: shorten(trim(text), 260),
      createdAt: Date.now(),
    };
    memories.unshift(item);
    pbxSaveMemories(memories.slice(0, 80));
    pbxRenderMemoryList();
    return true;
  }

  function pbxMemorySummary(language) {
    if (!pbxEnsureAuth("Google 로그인 후 저장된 메모리를 볼 수 있습니다.")) {
      return language === "ko" ? "Google 로그인 후 저장된 메모리를 확인할 수 있어요." : "Please sign in with Google to view saved memories.";
    }
    const memories = pbxLoadMemories();
    if (!memories.length) return language === "ko" ? "저장된 메모리가 아직 없어요." : "No memories are saved yet.";
    const lines = memories.slice(0, 8).map((memory, index) => `${index + 1}. ${memory.title}: ${memory.text}`);
    return language === "ko"
      ? `현재 저장된 메모리는 아래와 같아요.\n\n${lines.join("\n")}`
      : `Here are the saved memories.\n\n${lines.join("\n")}`;
  }

  function pbxHistoryContextMenu(x, y, conversationId) {
    const menu = document.getElementById("history-context-menu");
    if (!menu) return;
    PBX_CONTEXT_MENU.open = true;
    PBX_CONTEXT_MENU.conversationId = conversationId;
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    menu.classList.add("open");
  }

  function pbxCloseHistoryContextMenu() {
    const menu = document.getElementById("history-context-menu");
    if (!menu) return;
    menu.classList.remove("open");
    PBX_CONTEXT_MENU.open = false;
    PBX_CONTEXT_MENU.conversationId = "";
  }

  function renameConversationFromMenu() {
    const target = state.conversations.find((conversation) => conversation.id === PBX_CONTEXT_MENU.conversationId);
    pbxCloseHistoryContextMenu();
    if (!target) return;
    const next = prompt("채팅방 이름을 입력해 주세요.", target.title || "");
    if (!next) return;
    target.title = shorten(trim(next), 48) || target.title;
    persistConversations();
    loadConversationList();
    showToast("채팅방 이름을 변경했습니다.");
  }

  function deleteConversationFromMenu() {
    const target = state.conversations.find((conversation) => conversation.id === PBX_CONTEXT_MENU.conversationId);
    pbxCloseHistoryContextMenu();
    if (!target) return;
    if (!confirm(`'${target.title || "대화"}' 채팅방을 삭제할까요?`)) return;
    state.conversations = state.conversations.filter((conversation) => conversation.id !== target.id);
    if (state.sessionId === target.id) {
      state.sessionId = createSessionId();
      state.history = [];
      document.getElementById("messages").innerHTML = "";
      showHome();
      pbxSetRandomWelcome();
    }
    persistConversations();
    loadConversationList();
    showToast("채팅방을 삭제했습니다.");
  }

  function appendTyping() {
    const messages = document.getElementById("messages");
    const id = `typing_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const wrapper = document.createElement("div");
    wrapper.className = "message ai";
    wrapper.id = id;
    wrapper.innerHTML = `<div class="avatar ai" style="background:none">${AI_AVATAR_SVG}</div><div class="bubble ai"><div class="thinking-status">생각중.. <strong class="thinking-seconds">0s</strong></div><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
    const started = Date.now();
    const intervalId = setInterval(() => {
      const secondsNode = wrapper.querySelector(".thinking-seconds");
      if (!secondsNode) return;
      secondsNode.textContent = `${Math.max(0, Math.floor((Date.now() - started) / 1000))}s`;
    }, 1000);
    wrapper.dataset.thinkInterval = String(intervalId);
    messages.appendChild(wrapper);
    scrollBottom();
    return id;
  }

  function removeTyping(id) {
    const node = document.getElementById(id);
    if (!node) return;
    const intervalId = Number(node.dataset.thinkInterval || "0");
    if (intervalId) clearInterval(intervalId);
    node.remove();
  }

  function pbxClearAllTyping() {
    document.querySelectorAll("[id^='typing_']").forEach((node) => {
      const intervalId = Number(node.dataset.thinkInterval || "0");
      if (intervalId) clearInterval(intervalId);
      node.remove();
    });
  }

  function getLocalStatusMessage(_status) {
    return "";
  }

  function applySettingsToUI() {
    const ui = getUiText();
    document.documentElement.lang = getActiveUiLanguage();
    setText("logo-subtitle", ui.logoSubtitle);
    setText("new-chat-label", ui.newChat);
    setText("history-section-label", ui.history);
    setText("attach-topbar-label", ui.attach);
    setText("home-card-1-title", ui.card1Title);
    setText("home-card-1-desc", ui.card1Desc);
    setText("home-card-2-title", ui.card2Title);
    setText("home-card-2-desc", ui.card2Desc);
    setText("home-card-3-title", ui.card3Title);
    setText("home-card-3-desc", ui.card3Desc);
    setText("home-card-4-title", ui.card4Title);
    setText("home-card-4-desc", ui.card4Desc);
    setText("local-badge-label", ui.localBadge);
    setText("model-menu-subtitle", ui.modelSubtitle);
    setText("deep-think-label", ui.deepThinkLabel);
    setText("deep-think-subtitle", ui.deepThinkSubtitle);
    setText("footer-note", ui.footerNote);
    setText("settings-title", ui.settingsTitle);
    setText("settings-subtitle", ui.settingsSubtitle);
    setText("settings-ui-title", ui.settingsUiTitle);
    setText("settings-ui-desc", ui.settingsUiDesc);
    setText("settings-ui-language-label", ui.settingsUiLanguageLabel);
    setText("settings-theme-label", getActiveUiLanguage() === "ko" ? "테마" : getActiveUiLanguage() === "ja" ? "テーマ" : "Theme");
    setText("settings-typing-label", ui.settingsTypingLabel);
    setText("settings-reply-title", ui.settingsReplyTitle);
    setText("settings-reply-desc", ui.settingsReplyDesc);
    setText("settings-reply-language-label", ui.settingsReplyLanguageLabel);
    setText("settings-style-label", ui.settingsStyleLabel);
    setText("settings-memory-title", ui.settingsMemoryTitle);
    setText("settings-memory-desc", ui.settingsMemoryDesc);
    setText("remember-chat-label", ui.rememberChatLabel);
    setText("remember-chat-subtitle", ui.rememberChatSubtitle);
    setText("privacy-help", ui.privacyHelp);
    setText("clear-chats-btn", ui.clearChats);
    setText("settings-language-support-title", ui.languageSupportTitle);
    setText("settings-language-support-desc", ui.languageSupportDesc);
    setText("settings-memory-bank-title", getActiveUiLanguage() === "ko" ? "메모리" : getActiveUiLanguage() === "ja" ? "メモリ" : "Memories");
    setText("settings-memory-bank-desc", getActiveUiLanguage() === "ko" ? "저장해줘/기억해줘 요청으로 기록된 사용자 메모리입니다. 필요할 때 답변 참고에 사용됩니다." : getActiveUiLanguage() === "ja" ? "「覚えて」「保存して」で記録されたユーザーメモです。必要なとき回答の参考に使います。" : "Saved user memories from remember/store requests. They are used as context.");
    setText("clear-memories-btn", getActiveUiLanguage() === "ko" ? "저장된 메모리 전체 삭제" : getActiveUiLanguage() === "ja" ? "保存メモをすべて削除" : "Delete all saved memories");
    setText("memory-help", getActiveUiLanguage() === "ko" ? "메모리 삭제는 확인 후 진행됩니다." : getActiveUiLanguage() === "ja" ? "削除前に確認ダイアログを表示します。" : "Memory deletion asks for confirmation.");
    setText("settings-logout-btn", getActiveUiLanguage() === "ko" ? "로그아웃" : getActiveUiLanguage() === "ja" ? "ログアウト" : "Log out");
    setText("google-login-label", getActiveUiLanguage() === "ko" ? "Google 로그인" : getActiveUiLanguage() === "ja" ? "Google ログイン" : "Google sign in");

    const field = document.getElementById("input-field");
    if (field) field.placeholder = ui.inputPlaceholder;
    setSelectOptions("ui-language-select", ui.uiLanguageOptions);
    setSelectOptions("typing-speed-select", ui.typingOptions);
    setSelectOptions("reply-language-select", ui.replyLanguageOptions);
    setSelectOptions("reply-style-select", ui.replyStyleOptions);
    pbxApplyTheme();
    pbxSetRandomWelcome();
    pbxRenderProfileMenu();
    pbxRefreshContributorSidebar().catch(() => {});
  }

  function saveConversation() {
    if (!state.settings.rememberChats) return;
    if (!pbxEnsureAuth("Google 로그인 후 최근 대화를 저장할 수 있습니다.")) return;
    if (!state.history.length) return;
    const firstUser = state.history.find((entry) => entry.role === "user");
    if (!firstUser) return;
    const title = pbxInferConversationTitle(trim(firstUser.content) || ((firstUser.attachments && firstUser.attachments[0] && firstUser.attachments[0].name) || ""));
    const conversation = { id: state.sessionId, title, history: state.history.map(serializeMessage), time: Date.now() };
    const index = state.conversations.findIndex((item) => item.id === state.sessionId);
    if (index >= 0) state.conversations[index] = conversation;
    else state.conversations.unshift(conversation);
    state.conversations.sort((left, right) => right.time - left.time);
    state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
    persistConversations();
  }

  function loadConversationList() {
    const list = document.getElementById("chat-history-list");
    if (!list) return;
    list.innerHTML = "";
    if (!state.settings.rememberChats || !pbxCurrentUser()) return;
    state.conversations.forEach((conversation) => {
      const item = document.createElement("div");
      item.className = `history-item${conversation.id === state.sessionId ? " active" : ""}`;
      item.innerHTML = `<i class="ph ph-chat-circle" style="font-size:13px;flex-shrink:0"></i>${escapeHtml(conversation.title)}`;
      item.onclick = () => loadConversation(conversation);
      item.oncontextmenu = (event) => {
        event.preventDefault();
        pbxHistoryContextMenu(event.clientX, event.clientY, conversation.id);
      };
      list.appendChild(item);
    });
  }

  function persistConversations() {
    if (!state.settings.rememberChats || !pbxCurrentUser()) {
      localStorage.removeItem(pbxConversationKey());
      return;
    }
    try {
      localStorage.setItem(pbxConversationKey(), JSON.stringify(state.conversations));
    } catch (_error) {
      state.conversations = state.conversations.slice(0, 10);
      localStorage.setItem(pbxConversationKey(), JSON.stringify(state.conversations));
    }
  }

  function loadStoredConversations(rememberChats = true) {
    if (!rememberChats || !pbxCurrentUser()) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(pbxConversationKey()) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function toggleRememberChats(checkbox) {
    const ui = getUiText();
    const enabled = !!checkbox.checked;
    if (!enabled) {
      if (!confirm("최근 대화 저장을 끌까요? 이후 메시지는 저장되지 않습니다.")) {
        checkbox.checked = true;
        return;
      }
      state.settings.rememberChats = false;
      state.conversations = [];
      localStorage.removeItem(pbxConversationKey());
      persistSettings();
      loadConversationList();
      showToast(ui.rememberOff);
      return;
    }
    if (!pbxEnsureAuth("Google 로그인 후 최근 대화를 저장할 수 있습니다.")) {
      checkbox.checked = false;
      return;
    }
    if (!confirm("최근 대화 저장을 켤까요?")) {
      checkbox.checked = false;
      return;
    }
    state.settings.rememberChats = true;
    persistSettings();
    state.conversations = loadStoredConversations(true);
    loadConversationList();
    showToast(ui.rememberOn);
  }

  function clearStoredChats() {
    const ui = getUiText();
    if (!confirm("저장된 최근 대화를 모두 삭제할까요?")) return;
    state.conversations = [];
    localStorage.removeItem(pbxConversationKey());
    loadConversationList();
    showToast(ui.chatsCleared);
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "첨부한 자료를 분석해줘";
    const language = getReplyLanguage(prompt, []);
    const loweredPrompt = lower(prompt);

    const isCorrectionTurn = isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt);
    const previousPrompt = previousUserPrompt(userEntry.id);
    const memoryRequest = pbxExtractMemoryRequest(prompt);
    if (memoryRequest) {
      if (!pbxRememberText(memoryRequest)) return { text: "Google 로그인 후 메모리를 저장할 수 있어요.", meta: "" };
      return { text: `좋아요. 메모리에 저장했어요: ${memoryRequest}`, meta: "" };
    }
    if (containsAny(loweredPrompt, ["중요", "important", "핵심 메모"]) && prompt.length >= 18 && pbxCurrentUser()) {
      pbxRememberText(prompt.replace(/^(중요|important)\s*[:：-]?\s*/iu, ""));
    }
    if (pbxWantsMemoryList(prompt)) return { text: pbxMemorySummary(language), meta: "" };

    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    const historyDocs = collectHistoryDocuments(state.history);
    const intentPrompt = buildIntentPrompt(userEntry);
    const loweredIntentPrompt = lower(intentPrompt);
    const replyStyle = getReplyStyle(intentPrompt || prompt, "general");

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredIntentPrompt)) {
      const searchReply = buildWebsiteSearchReply(intentPrompt, language);
      if (searchReply) return searchReply;
    }
    if (!currentDocs.length && isWeatherQuestion(loweredIntentPrompt)) {
      const weatherReply = await buildWeatherReply(intentPrompt, language);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(language), meta: "" };
    }
    if (currentDocs.length) {
      const docReply = replyFromDocuments(intentPrompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(language),
        language,
        style: replyStyle,
      });
      if (docReply) return docReply;
    }

    const memories = pbxLoadMemories().slice(0, 5).map((memory) => `${memory.title}: ${memory.text}`).join("\n");
    const modelPrompt = memories ? `${intentPrompt}\n\nKnown user memory:\n${memories}\nAssistant:` : intentPrompt;
    const modelReply = await tryModelFirstReply(modelPrompt, language);
    if (modelReply) return { text: modelReply, meta: "" };

    if (historyDocs.length) {
      const effectiveQuery = buildEffectiveQuery(intentPrompt, state.history);
      const localDocs = searchDocuments(effectiveQuery, historyDocs, 6);
      const evidence = collectEvidence(effectiveQuery, dedupeDocuments(localDocs).slice(0, 8));
      if (evidence.length) {
        return {
          text: composeFromEvidence("general", intentPrompt, evidence, { language, style: replyStyle }),
          meta: buildSourcesLine(evidence, { language }),
        };
      }
    }

    if (containsAny(loweredPrompt, ["안녕", "하이", "hello", "hi"])) return { text: buildGreetingReply(language), meta: "" };
    if (containsAny(loweredPrompt, ["누구야", "자기소개"])) return { text: buildIdentityReply(language), meta: "" };
    if (containsAny(loweredPrompt, ["뭐할래", "뭐 할래"])) return { text: buildOpenQuestionReply(prompt, language, replyStyle), meta: "" };

    return { text: buildOpenQuestionReply(prompt, language, replyStyle), meta: "", code: "PB-FALLBACK-001" };
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    const normalized = trim(prompt);
    if (!normalized || normalized.length < 2) return "";
    if (
      isWebsiteSearchPrompt(loweredPrompt) ||
      isWeatherQuestion(loweredPrompt) ||
      isKnownLinkPrompt(loweredPrompt)
    ) {
      return "";
    }

    const timeoutMs = state.deepThink ? 16000 : 10000;
    const timedOut = new Promise((_, reject) => setTimeout(() => reject(new Error("model-timeout")), timeoutMs));
    try {
      const generated = await Promise.race([
        generateReasonedChatReply(prompt, language),
        timedOut,
      ]);
      const cleaned = cleanupBrowserModelReply(generated, prompt);
      if (
        cleaned &&
        cleaned.length >= 3 &&
        cleaned.length <= 900 &&
        normalizeDialogueText(cleaned) !== normalizeDialogueText(lastAssistantText(state.history)) &&
        !containsAny(lower(cleaned), ["localhost server inference", "question core", "at a glance"])
      ) {
        return cleaned;
      }
    } catch (_error) {
      return "";
    }
    return "";
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;
    const raw = trim(field.value);
    const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
    if (!raw && !attachments.length) return;

    if (!pbxCurrentUser()) {
      showToast("Google 로그인 후 대화 저장과 개인화 메모리를 사용할 수 있습니다.");
    }

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast("첫 질문 응답은 모델 준비 때문에 평소보다 조금 느릴 수 있어요.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    document.getElementById("char-count").textContent = "0 / 2000";

    const userEntry = { id: `msg_${Date.now()}`, role: "user", content: raw || "첨부 자료를 분석해줘", attachments, meta: "" };
    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    state.isStreaming = true;
    document.getElementById("send-btn").disabled = true;

    const typingId = appendTyping();
    try {
      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), 30000)),
      ]);
      removeTyping(typingId);
      if (reply && reply.code) showToast(`${reply.code} · 모델 응답이 비어 fallback으로 전환됨`);
      const safeText = shorten(trim(reply.text || ""), 1200) || "답을 만드는 중 문제가 있어 짧게 먼저 답했어요.";
      const aiEntry = { id: `msg_${Date.now()}_ai`, role: "assistant", content: safeText, attachments: [], meta: reply.meta || "" };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
    } catch (_error) {
      removeTyping(typingId);
      const aiEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: "응답 처리 중 잠시 문제가 생겼어요. 같은 질문을 다시 보내주면 바로 이어서 처리할게요.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.content);
      state.history.push(aiEntry);
    } finally {
      pbxClearAllTyping();
      state.isStreaming = false;
      document.getElementById("send-btn").disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  function newChat() {
    if (state.history.length) saveConversation();
    state.history = [];
    state.sessionId = createSessionId();
    document.getElementById("messages").innerHTML = "";
    showHome();
    pbxSetRandomWelcome();
    loadConversationList();
  }

  function openSettings() {
    document.getElementById("attach-menu").classList.remove("open");
    document.getElementById("model-menu").classList.remove("open");
    pbxCloseProfileMenu();
    document.getElementById("settings-backdrop").classList.add("open");
    hydrateSettingsControls();
    pbxRenderMemoryList();
  }

  function setupSettings() {
    hydrateSettingsControls();
    const uiLanguageSelect = document.getElementById("ui-language-select");
    const replyLanguageSelect = document.getElementById("reply-language-select");
    const replyStyleSelect = document.getElementById("reply-style-select");
    const typingSpeedSelect = document.getElementById("typing-speed-select");
    const themeSelect = document.getElementById("theme-select");
    if (uiLanguageSelect) {
      uiLanguageSelect.addEventListener("change", (event) => {
        state.settings.uiLanguage = event.target.value;
        persistSettings();
        applySettingsToUI();
      });
    }
    if (replyLanguageSelect) {
      replyLanguageSelect.addEventListener("change", (event) => {
        state.settings.replyLanguage = event.target.value;
        persistSettings();
      });
    }
    if (replyStyleSelect) {
      replyStyleSelect.addEventListener("change", (event) => {
        state.settings.replyStyle = event.target.value;
        persistSettings();
      });
    }
    if (typingSpeedSelect) {
      typingSpeedSelect.addEventListener("change", (event) => {
        state.settings.typingSpeed = event.target.value;
        persistSettings();
      });
    }
    if (themeSelect) {
      themeSelect.addEventListener("change", (event) => {
        pbxSetTheme(event.target.value);
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSettings();
    });
  }

  function hydrateSettingsControls() {
    const uiLanguage = document.getElementById("ui-language-select");
    const replyLanguage = document.getElementById("reply-language-select");
    const replyStyle = document.getElementById("reply-style-select");
    const typingSpeed = document.getElementById("typing-speed-select");
    const rememberToggle = document.getElementById("remember-chat-toggle");
    const themeSelect = document.getElementById("theme-select");
    if (uiLanguage) uiLanguage.value = state.settings.uiLanguage;
    if (replyLanguage) replyLanguage.value = state.settings.replyLanguage;
    if (replyStyle) replyStyle.value = state.settings.replyStyle;
    if (typingSpeed) typingSpeed.value = state.settings.typingSpeed;
    if (rememberToggle) rememberToggle.checked = !!state.settings.rememberChats;
    if (themeSelect) themeSelect.value = state.settings.theme || localStorage.getItem(PBX_THEME_KEY) || "dark";
  }

  function pbxEnhanceUiBindings() {
    applySettingsToUI();
    pbxApplyTheme();
    pbxSetRandomWelcome();
    syncRequiredConsentUi();
    pbxRenderProfileMenu();
    if (state.settings.rememberChats && pbxCurrentUser()) {
      state.conversations = loadStoredConversations(true);
      loadConversationList();
    }
    document.addEventListener("click", (event) => {
      const profileWrap = document.querySelector(".profile-wrap");
      if (profileWrap && !profileWrap.contains(event.target)) pbxCloseProfileMenu();
      const contextMenu = document.getElementById("history-context-menu");
      if (contextMenu && !contextMenu.contains(event.target)) pbxCloseHistoryContextMenu();
    });
    document.addEventListener("contextmenu", (event) => {
      const list = document.getElementById("chat-history-list");
      if (!list || !list.contains(event.target)) pbxCloseHistoryContextMenu();
    });
    if (!hasRequiredConsents()) {
      openConsentModal();
    } else {
      closeConsentModal(true);
    }
  }

  const PBX_WELCOME_TEMPLATES = [
    "{name} 님, 오늘은 어떤 이야기부터 시작할까요?",
    "{name} 님, 지금 떠오르는 질문 하나만 던져 주세요.",
    "{name} 님, 준비되면 바로 시작해요.",
    "{name} 님, 지금 가장 급한 문제부터 함께 볼게요.",
    "{name} 님, 편하게 말해 주세요. 바로 이어서 도와드릴게요.",
    "{name} 님, 오늘 목표를 한 줄로 알려 주세요.",
    "{name} 님, 코드든 문서든 같이 정리해 드릴 수 있어요.",
    "{name} 님, 어디서 막혔는지 먼저 짚어볼까요?",
    "{name} 님, 필요한 자료가 있으면 바로 붙여 주세요.",
    "{name} 님, 지금 상황을 짧게 알려 주시면 바로 시작할게요.",
    "{name} 님, 대화 이어서 진행해 볼까요?",
    "{name} 님, 오늘은 어떤 결과를 만들고 싶으세요?",
    "{name} 님, 에러 로그가 있으면 함께 보면 빨라요.",
    "{name} 님, 먼저 핵심부터 깔끔하게 정리해 드릴게요.",
    "{name} 님, 원하는 톤으로 맞춰서 답변해 드릴게요.",
    "{name} 님, 짧게 물어보셔도 괜찮아요.",
    "{name} 님, 지금 바로 시작해도 좋습니다.",
    "{name} 님, 한 문장으로 목표를 알려 주세요.",
    "{name} 님, 지금 필요한 정보부터 찾을게요.",
    "{name} 님, 문제를 단계별로 풀어볼까요?",
    "{name} 님, 오늘도 같이 끝까지 가봅시다.",
    "{name} 님, 문장 하나만 주셔도 진행할 수 있어요.",
    "{name} 님, 바로 답이 필요한 질문부터 주세요.",
    "{name} 님, 최근 대화 기준으로 이어서 도와드릴게요.",
    "{name} 님, 지금 상황에 맞는 최단 경로로 안내할게요.",
    "{name} 님, 바로 실전으로 들어가도 괜찮아요.",
    "{name} 님, 원하는 방향으로 톤을 맞춰볼게요.",
    "{name} 님, 먼저 무엇을 해결하면 좋을까요?",
    "{name} 님, 핵심만 빠르게 정리해 드릴게요.",
    "{name} 님, 지금 가장 궁금한 걸 질문해 주세요.",
    "{name} 님, 대화형으로 편하게 진행해요.",
    "{name} 님, 파일이나 캡처를 올려 주셔도 됩니다.",
    "{name} 님, 답변 길이도 원하는 스타일로 맞출 수 있어요.",
    "{name} 님, 지금 단계에서 필요한 다음 행동을 제안해 드릴게요.",
    "{name} 님, 바로 시작하겠습니다.",
    "{name} 님, 오늘도 천천히 정확하게 가볼게요.",
    "{name} 님, 복잡한 내용도 단계적으로 정리해 드릴게요.",
    "{name} 님, 지금 바로 질문해 주세요.",
    "{name} 님, 먼저 현재 상태를 확인해볼까요?",
    "{name} 님, 어떤 언어로 답하면 좋을지도 알려 주세요.",
    "{name} 님, 오늘은 무엇을 만들고 싶으세요?",
    "{name} 님, 필요한 만큼만 간결하게 답변해 드릴게요.",
    "{name} 님, 자세한 설명이 필요하면 길게도 가능해요.",
    "{name} 님, 이어서 같이 문제를 해결해봐요.",
    "{name} 님, 지금부터 차근차근 진행할게요.",
    "{name} 님, 당장 필요한 결과부터 만들어볼까요?",
    "{name} 님, 질문을 주시면 바로 분석 시작합니다.",
    "{name} 님, 빠르게 처리할 수 있게 핵심부터 주세요.",
    "{name} 님, 오늘도 도와드릴 준비가 됐어요.",
    "{name} 님, 무엇이든 편하게 물어보세요.",
  ];

  function pbxWaitForGoogleSdk(timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        resolve(true);
        return;
      }
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 120);
    });
  }

  function pbxCurrentUser() {
    try {
      const backupKey = `${PBX_USER_KEY}_backup`;
      const primaryRaw = localStorage.getItem(PBX_USER_KEY);
      const backupRaw = localStorage.getItem(backupKey);
      const raw = primaryRaw || backupRaw;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const email = trim(String(parsed.email || ""));
      const sub = trim(String(parsed.sub || ""));
      if (!email && !sub) return null;
      const normalized = {
        ...parsed,
        email,
        sub,
        name: pbxNormalizeUserName(parsed.name || "", email),
      };
      const serialized = JSON.stringify(normalized);
      if (serialized !== primaryRaw) localStorage.setItem(PBX_USER_KEY, serialized);
      if (serialized !== backupRaw) localStorage.setItem(backupKey, serialized);
      return normalized;
    } catch (_error) {
      return null;
    }
  }

  function pbxSetUser(user) {
    const backupKey = `${PBX_USER_KEY}_backup`;
    if (!user) {
      localStorage.removeItem(PBX_USER_KEY);
      localStorage.removeItem(backupKey);
      return;
    }
    const email = trim(String(user.email || ""));
    const sub = trim(String(user.sub || ""));
    const normalized = {
      ...user,
      email,
      sub,
      name: pbxNormalizeUserName(user.name || "", email),
      time: Number(user.time || Date.now()),
    };
    const serialized = JSON.stringify(normalized);
    localStorage.setItem(PBX_USER_KEY, serialized);
    localStorage.setItem(backupKey, serialized);
  }

  function pbxGetDisplayName() {
    const user = pbxCurrentUser();
    if (!user) return "UserName";
    return pbxNormalizeUserName(user.name || "", user.email || "") || "UserName";
  }

  function pbxLooksBrokenText(value) {
    const text = trim(String(value || ""));
    if (!text) return true;
    if (text.includes("\uFFFD")) return true;
    if (/占/.test(text)) return true;
    if (/(Ã|Â|Ð|Ñ|Ė|¤|�)/.test(text)) return true;
    if (/[횄횂횖횗]/.test(text)) return true;
    const allowed = (text.match(/[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣぁ-ゔァ-ヴー々〆〤一-龥._\-\s]/g) || []).length;
    if (text.length >= 3 && allowed / text.length < 0.55) return true;
    return false;
  }

  function pbxRepairMojibakeName(value) {
    const source = trim(String(value || ""));
    if (!source) return "";
    try {
      const latin1 = Uint8Array.from(Array.from(source), (ch) => ch.charCodeAt(0) & 0xff);
      const repaired = trim(new TextDecoder("utf-8", { fatal: false }).decode(latin1));
      if (repaired && !pbxLooksBrokenText(repaired)) return repaired;
    } catch (_error) {
      // Keep the original value when repair fails.
    }
    return source;
  }

  function pbxNormalizeUserName(name, email) {
    const safeEmail = trim(String(email || "").split("@")[0] || "");
    const candidate = pbxRepairMojibakeName(name);
    if (!candidate) return safeEmail || "UserName";
    if (pbxLooksBrokenText(candidate)) return safeEmail || "UserName";
    const stripped = candidate.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    return stripped || safeEmail || "UserName";
  }

  function pbxSetRandomWelcome() {
    const node = document.getElementById("home-subtitle");
    if (!node) return;
    const template = PBX_WELCOME_TEMPLATES[Math.floor(Math.random() * PBX_WELCOME_TEMPLATES.length)];
    const name = pbxGetDisplayName();
    node.textContent = template.replace(/\{name\}/g, name);
  }

  function pbxRenderProfileMenu() {
    const user = pbxCurrentUser();
    const emailNode = document.getElementById("profile-email");
    const titleNode = document.getElementById("profile-head-title");
    const loginBtn = document.getElementById("google-login-btn");
    const logoutBtn = document.getElementById("profile-logout-btn");
    const displayName = user ? pbxNormalizeUserName(user.name || "", user.email || "") : "";
    if (titleNode) titleNode.textContent = user ? displayName : "로그인 필요";
    if (emailNode) {
      emailNode.textContent = user
        ? (user.email || "")
        : "Google 계정을 연결하면 최근 대화와 메모리를 사용자별로 유지할 수 있습니다.";
    }
    if (loginBtn) loginBtn.style.display = user ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = user ? "" : "none";
    pbxRenderMemoryList();
  }

  function pbxConversationKey() {
    const user = pbxCurrentUser();
    if (!user) return STORAGE_KEY;
    const raw = trim(String(user.sub || user.email || ""));
    if (!raw) return STORAGE_KEY;
    return `${STORAGE_KEY}_${encodeURIComponent(raw.toLowerCase())}`;
  }

  function pbxLegacyConversationKey() {
    const user = pbxCurrentUser();
    if (!user || !user.email) return STORAGE_KEY;
    return `${STORAGE_KEY}_${lower(user.email)}`;
  }

  function pbxMemoryKey() {
    const user = pbxCurrentUser();
    if (!user) return "";
    const raw = trim(String(user.sub || user.email || ""));
    if (!raw) return "";
    return `${PBX_MEMORY_PREFIX}${encodeURIComponent(raw.toLowerCase())}`;
  }

  function pbxLegacyMemoryKey() {
    const user = pbxCurrentUser();
    if (!user || !user.email) return "";
    return `${PBX_MEMORY_PREFIX}${lower(user.email)}`;
  }

  function pbxLoadMemories() {
    const keys = [pbxMemoryKey(), pbxLegacyMemoryKey()].filter(Boolean);
    for (const key of keys) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(parsed)) return parsed;
      } catch (_error) {
        // Try next key.
      }
    }
    return [];
  }

  function pbxSaveMemories(memories) {
    const key = pbxMemoryKey();
    if (!key) return;
    const serialized = JSON.stringify((memories || []).slice(0, 100));
    localStorage.setItem(key, serialized);
    const legacy = pbxLegacyMemoryKey();
    if (legacy) localStorage.setItem(legacy, serialized);
  }

  function persistConversations() {
    if (!state.settings.rememberChats || !pbxCurrentUser()) {
      localStorage.removeItem(pbxConversationKey());
      localStorage.removeItem(pbxLegacyConversationKey());
      return;
    }
    try {
      const serialized = JSON.stringify(state.conversations);
      localStorage.setItem(pbxConversationKey(), serialized);
      localStorage.setItem(pbxLegacyConversationKey(), serialized);
    } catch (_error) {
      state.conversations = state.conversations.slice(0, 8);
      const serialized = JSON.stringify(state.conversations);
      localStorage.setItem(pbxConversationKey(), serialized);
      localStorage.setItem(pbxLegacyConversationKey(), serialized);
    }
  }

  function loadStoredConversations(rememberChats = true) {
    if (!rememberChats || !pbxCurrentUser()) return [];
    const keys = [pbxConversationKey(), pbxLegacyConversationKey()].filter(Boolean);
    for (const key of keys) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch (_error) {
        // Try next key.
      }
    }
    return [];
  }

  function getLocalStatusMessage(status) {
    if (status === "loading") {
      return getActiveUiLanguage() === "ko" ? "온디바이스 엔진을 준비 중입니다..." : "Preparing on-device engine...";
    }
    if (status === "error") {
      return getActiveUiLanguage() === "ko" ? "온디바이스 엔진 초기화에 실패했습니다." : "On-device engine initialization failed.";
    }
    return "";
  }

  function pbxIsGarbageReply(text) {
    const value = trim(String(text || ""));
    if (!value) return true;
    if (value.length < 2) return true;
    if (pbxLooksBrokenText(value)) return true;
    const compact = normalizeWhitespace(value);
    if (compact.length >= 8) {
      const words = compact.split(/\s+/).filter(Boolean);
      if (words.length > 5) {
        const uniq = new Set(words.map((word) => lower(word))).size;
        if (uniq <= Math.max(2, Math.floor(words.length * 0.35))) return true;
      }
    }
    return false;
  }

  function pbxBuildAdaptiveFallback(prompt, language) {
    const source = trim(prompt);
    const loweredPrompt = lower(source);
    if (containsAny(loweredPrompt, ["안녕", "하이", "hello", "hi"])) {
      if (language === "ko") return `${pbxGetDisplayName()} 님 안녕하세요. 편하게 질문 주세요.`;
      return `Hi ${pbxGetDisplayName()}. Ask me anything.`;
    }
    if (containsAny(loweredPrompt, ["강아지", "dog"])) {
      if (language === "ko") return "강아지는 사람과 교감이 좋은 반려동물이에요. 품종마다 성격과 활동량이 달라서 생활 패턴에 맞춰 선택하는 게 중요해요.";
      return "Dogs are companion animals known for social bonding. Temperament and activity level vary by breed.";
    }
    if (containsAny(loweredPrompt, ["파이썬", "python"])) {
      if (language === "ko") return "네, 파이썬 도와드릴 수 있어요. 에러 로그나 코드 조각을 붙여주면 바로 수정 방향을 제안할게요.";
      return "Yes, I can help with Python. Share code or an error and I will suggest a fix.";
    }
    if (source.length <= 3) {
      if (language === "ko") return "좋아요. 한 줄만 더 적어주시면 정확하게 이어서 답할게요.";
      return "Sure. Add one more short line and I can answer more precisely.";
    }
    if (language === "ko") {
      return `${pbxGetDisplayName()} 님 질문을 이해했어요. 핵심부터 간단히 답하면: ${shorten(source, 52)} 관련해서 바로 정리해드릴게요.`;
    }
    return `I understood your request. I will answer directly about: ${shorten(source, 52)}.`;
  }

  async function generateReasonedChatReply(prompt, language) {
    await ensureEngineReady();
    if (!engine.browserRuntime) return "";
    const trimmedPrompt = trim(prompt);
    if (!trimmedPrompt) return "";

    const profile = state.deepThink
      ? { maxNewTokens: 96, temperature: 0.72, topK: 40, topP: 0.94 }
      : { maxNewTokens: 64, temperature: 0.64, topK: 32, topP: 0.92 };

    const promptVariant = buildBrowserModelPrompt(trimmedPrompt, language);
    const runInference = async () => {
      if (!engine._warmDone) {
        try {
          await Promise.race([
            engine.browserRuntime.generateReply("Hello", { maxNewTokens: 8, temperature: 0.2, topK: 8, topP: 0.8 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("warmup-timeout")), 5000)),
          ]);
        } catch (_error) {
          // Ignore warm-up failures.
        }
        engine._warmDone = true;
      }

      const generated = await Promise.race([
        engine.browserRuntime.generateReply(promptVariant, profile),
        new Promise((_, reject) => setTimeout(() => reject(new Error("model-timeout")), state.deepThink ? 20000 : 12000)),
      ]);
      const cleaned = cleanupBrowserModelReply(generated, trimmedPrompt);
      if (pbxIsGarbageReply(cleaned)) return "";
      if (!isLanguageCompatible(cleaned, language)) return "";
      if (normalizeDialogueText(cleaned) === normalizeDialogueText(lastAssistantText(state.history))) return "";
      return cleaned;
    };

    const chain = (engine._inferenceChain || Promise.resolve()).catch(() => {});
    const queued = chain.then(runInference, runInference);
    engine._inferenceChain = queued.finally(() => {});
    try {
      return await queued;
    } catch (_error) {
      return "";
    }
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt)) return "";
    return generateReasonedChatReply(prompt, language);
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || "질문을 입력해 주세요.";
    const language = getReplyLanguage(prompt, []);
    const loweredPrompt = lower(prompt);

    const memoryRequest = pbxExtractMemoryRequest(prompt);
    if (memoryRequest) {
      if (!pbxRememberText(memoryRequest)) return { text: "Google 로그인 후 메모리를 저장할 수 있어요.", meta: "" };
      return { text: `좋아요. 메모리에 저장했어요: ${memoryRequest}`, meta: "" };
    }
    if (pbxWantsMemoryList(prompt)) return { text: pbxMemorySummary(language), meta: "" };

    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    if (currentDocs.length) {
      const docReply = replyFromDocuments(prompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(language),
        language,
        style: getReplyStyle(prompt, "general"),
      });
      if (docReply) return docReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredPrompt)) {
      const weatherReply = await buildWeatherReply(prompt, language);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(language), meta: "" };
    }
    if (!currentDocs.length && isWebsiteSearchPrompt(loweredPrompt)) {
      const searchReply = buildWebsiteSearchReply(prompt, language);
      if (searchReply) return searchReply;
    }

    const memories = pbxLoadMemories().slice(0, 5).map((memory) => `${memory.title}: ${memory.text}`).join("\n");
    const modelPrompt = memories ? `${prompt}\n\nUser memory:\n${memories}\nAssistant:` : prompt;
    const modelReply = await tryModelFirstReply(modelPrompt, language);
    if (modelReply) return { text: modelReply, meta: "" };

    const historyDocs = collectHistoryDocuments(state.history);
    if (historyDocs.length) {
      const effectiveQuery = buildEffectiveQuery(prompt, state.history);
      const evidence = collectEvidence(effectiveQuery, dedupeDocuments(searchDocuments(effectiveQuery, historyDocs, 6)).slice(0, 8));
      if (evidence.length) {
        return {
          text: composeFromEvidence("general", prompt, evidence, { language, style: "balanced" }),
          meta: buildSourcesLine(evidence, { language }),
          code: "PB-FALLBACK-CTX",
        };
      }
    }

    return {
      text: pbxBuildAdaptiveFallback(prompt, language),
      meta: "",
      code: "PB-FALLBACK-001",
    };
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;
    const raw = trim(field.value);
    const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
    if (!raw && !attachments.length) return;

    if (!pbxCurrentUser()) {
      showToast("Google 로그인 후 최근 대화/메모리 저장 기능을 사용할 수 있어요.");
    }

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast("첫 질문은 엔진 준비 때문에 평소보다 1~2초 더 걸릴 수 있어요.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    const counter = document.getElementById("char-count");
    if (counter) counter.textContent = "0 / 2000";

    const userEntry = { id: `msg_${Date.now()}`, role: "user", content: raw || "질문을 입력해 주세요.", attachments, meta: "" };
    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);

    state.isStreaming = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const typingId = appendTyping();

    try {
      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), 35000)),
      ]);
      if (reply && reply.code) showToast(reply.code);
      const safeText = shorten(trim(reply && reply.text ? reply.text : ""), 1400) || "응답 생성에 실패했어요. 같은 뜻으로 한 번만 더 보내주세요.";
      const aiEntry = { id: `msg_${Date.now()}_ai`, role: "assistant", content: safeText, attachments: [], meta: (reply && reply.meta) || "" };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
    } catch (_error) {
      const aiEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: "요청 처리 중 잠시 문제가 생겼어요. 같은 질문을 한 번만 다시 보내주시면 바로 이어서 처리할게요.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.content);
      state.history.push(aiEntry);
    } finally {
      removeTyping(typingId);
      pbxClearAllTyping();
      state.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  function pbxBuildSignedInUser(payload, token) {
    return {
      name: pbxNormalizeUserName(payload && (payload.name || payload.given_name || ""), payload && payload.email ? payload.email : ""),
      email: payload && payload.email ? payload.email : "",
      picture: payload && payload.picture ? payload.picture : "",
      sub: payload && payload.sub ? payload.sub : "",
      token: token || "",
      time: Date.now(),
    };
  }

  function pbxApplySignedInUser(user) {
    pbxSetUser(user);
    state.settings.rememberChats = true;
    persistSettings();
    state.conversations = loadStoredConversations(true);
    loadConversationList();
    pbxRenderProfileMenu();
    pbxSetRandomWelcome();
  }

  async function pbxFetchGoogleUserInfo(accessToken) {
    if (!accessToken) return null;
    try {
      const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  async function loginWithGoogle() {
    if (!ensureRequiredConsent()) return;
    const sdkReady = await pbxWaitForGoogleSdk(7000);
    if (!sdkReady) {
      showToast("Google 로그인 SDK 로드가 지연되고 있어요. 새로고침 후 다시 시도해 주세요.");
      return;
    }
    const clientId = window.PB_GOOGLE_CLIENT_ID || "243688916223-7vp3gveim7mjo7ra804nv33fdqt0bfok.apps.googleusercontent.com";
    if (!clientId || clientId === "REPLACE_WITH_GOOGLE_CLIENT_ID") {
      showToast("Google Client ID가 설정되지 않았습니다.");
      return;
    }

    const onPayload = (payload, token = "") => {
      if (!payload || (!payload.email && !payload.sub)) return false;
      const user = pbxBuildSignedInUser(payload, token);
      pbxApplySignedInUser(user);
      showToast(`${user.name} 계정으로 로그인되었습니다.`);
      return true;
    };

    const ensureGoogleIdInitialized = () => {
      if (state._googleInited || window.__PB_GOOGLE_ID_INIT__) {
        state._googleInited = true;
        return;
      }
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          const payload = pbxDecodeJwtPayload(response && response.credential ? response.credential : "");
          if (!onPayload(payload, response && response.credential ? response.credential : "")) {
            showToast("Google 로그인 처리 중 오류가 발생했습니다.");
          }
        },
        auto_select: true,
        cancel_on_tap_outside: true,
      });
      state._googleInited = true;
      window.__PB_GOOGLE_ID_INIT__ = true;
    };

    // Primary path: explicit OAuth popup to avoid "button click does nothing" cases.
    if (window.google.accounts.oauth2 && typeof window.google.accounts.oauth2.initTokenClient === "function") {
      const oauthOk = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        let client = null;
        try {
          client = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: "openid email profile",
            callback: async (tokenResponse) => {
              if (!tokenResponse || tokenResponse.error || !tokenResponse.access_token) {
                finish(false);
                return;
              }
              const profile = await pbxFetchGoogleUserInfo(tokenResponse.access_token);
              finish(onPayload(profile, ""));
            },
            error_callback: () => finish(false),
          });
          client.requestAccessToken({ prompt: "select_account" });
          setTimeout(() => finish(false), 15000);
        } catch (_error) {
          finish(false);
        }
      });
      if (oauthOk) return;
    }

    // Fallback path: render ID button host + one tap prompt.
    ensureGoogleIdInitialized();
    let host = document.getElementById("google-signin-anchor");
    if (!host) {
      host = document.createElement("div");
      host.id = "google-signin-anchor";
      host.style.position = "fixed";
      host.style.top = "72px";
      host.style.right = "18px";
      host.style.zIndex = "1300";
      host.style.padding = "8px";
      host.style.borderRadius = "12px";
      host.style.border = "1px solid var(--border)";
      host.style.background = "var(--card)";
      document.body.appendChild(host);
    }
    host.innerHTML = "";
    try {
      window.google.accounts.id.renderButton(host, {
        type: "standard",
        theme: document.body.classList.contains("theme-light") ? "outline" : "filled_black",
        size: "large",
        shape: "pill",
        text: "signin_with",
      });
    } catch (_error) {
      // Keep prompt fallback below.
    }

    let promptShown = true;
    try {
      window.google.accounts.id.prompt((notification) => {
        if (notification && (notification.isNotDisplayed?.() || notification.isSkippedMoment?.())) {
          promptShown = false;
        }
      });
    } catch (_error) {
      promptShown = false;
    }
    if (!promptShown) {
      showToast("Google 로그인 창이 차단되면 우측 상단 로그인 버튼을 한 번 더 눌러주세요.");
      return;
    }
    showToast("Google 로그인 창이 보이지 않으면 우측 상단 로그인 버튼을 한 번 더 눌러주세요.");
  }

  function getRuntimeModelMeta() {
    const registry = state.modelRegistry;
    const currentId = getSelectedRuntimeModelId() || (registry && registry.current_model_id) || "purple-bee-1-3";
    const models = registry && Array.isArray(registry.models) ? registry.models : [];
    return models.find((model) => model && model.id === currentId)
      || models[0]
      || {
        id: currentId,
        display_name: "Purple Bee 1.3",
        architecture_name: "Purple Bee 100M",
      };
  }

  function getLocalStatusMessage(status) {
    const uiLanguage = getActiveUiLanguage();
    const currentModel = getRuntimeModelMeta();
    const label = currentModel.display_name || "Purple Bee";
    if (uiLanguage === "ko") {
      if (status === "loading") return `${label} 엔진을 현재 기기에서 준비하고 있어요. 첫 질문은 조금 더 느릴 수 있어요.`;
      if (status === "error") return `${label} 엔진 초기화에 실패했어요. 잠시 후 다시 시도하거나 다른 모델로 전환해 주세요.`;
      return "";
    }
    if (status === "loading") return `Preparing ${label} on this device. The first reply can take a little longer.`;
    if (status === "error") return `${label} failed to initialize on this device. Please retry or switch models.`;
    return "";
  }

  async function loadModelRegistry() {
    try {
      const response = await fetch(MODEL_REGISTRY_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`registry-${response.status}`);
      const registry = await response.json();
      if (!registry || !Array.isArray(registry.models) || !registry.models.length) throw new Error("registry-empty");
      state.modelRegistry = registry;
    } catch (_error) {
      state.modelRegistry = {
        family_name: "Purple Bee",
        current_model_id: "purple-bee-1-3",
        latest_model_id: "purple-bee-1-3",
        models: [
          {
            id: "purple-bee-1-3",
            display_name: "Purple Bee 1.3",
            architecture_name: "Purple Bee 100M",
            current: true,
            latest: true,
            trainable: false,
          },
        ],
      };
    }

    const selected = getSelectedRuntimeModelId();
    const hasSelectedModel = !!(
      selected
      && state.modelRegistry
      && Array.isArray(state.modelRegistry.models)
      && state.modelRegistry.models.some((model) => model && model.id === selected)
    );
    if ((!selected || !hasSelectedModel) && state.modelRegistry && state.modelRegistry.current_model_id) {
      localStorage.setItem(RUNTIME_MODEL_KEY, state.modelRegistry.current_model_id);
    }
    const installSelected = getSelectedInstallModelId();
    const hasInstallSelectedModel = !!(
      installSelected
      && state.modelRegistry
      && Array.isArray(state.modelRegistry.models)
      && state.modelRegistry.models.some((model) => model && model.id === installSelected)
    );
    if ((!installSelected || !hasInstallSelectedModel) && state.modelRegistry && state.modelRegistry.current_model_id) {
      localStorage.setItem(INSTALL_MODEL_KEY, state.modelRegistry.current_model_id);
    }
    renderModelRegistry();
  }

  function resetRuntimeEngine() {
    engine.browserRuntime = null;
    engine.model = null;
    engine.loading = null;
    engine.runtimeKind = "none";
    engine.lastError = "";
    engine._warmDone = false;
    engine._inferenceChain = null;
  }

  function switchRuntimeModel(modelId) {
    const nextId = trim(modelId);
    if (!nextId) return;
    const prevId = getSelectedRuntimeModelId();
    localStorage.setItem(RUNTIME_MODEL_KEY, nextId);
    if (prevId !== nextId) {
      resetRuntimeEngine();
    }
    renderModelRegistry();
    setEngineStatus("idle", getRuntimeModelLabel(), getLocalStatusMessage("idle"));
    const menu = document.getElementById("model-menu");
    if (menu) menu.classList.remove("open");
    if (prevId && prevId !== nextId) {
      showToast(getActiveUiLanguage() === "ko" ? `${getRuntimeModelLabel()} 로 전환했어요.` : `Switched to ${getRuntimeModelLabel()}.`);
    }
  }

  function renderModelRegistry() {
    const registry = state.modelRegistry;
    const header = document.getElementById("model-menu-header");
    const currentNameNode = document.getElementById("current-model-name");
    const subtitleNode = document.getElementById("model-menu-subtitle");
    const list = document.getElementById("model-version-list");
    const topSep = document.getElementById("model-version-sep-top");
    const bottomSep = document.getElementById("model-version-sep-bottom");
    const current = getRuntimeModelMeta();
    const currentId = current.id || "";
    const uiLanguage = getActiveUiLanguage();

    if (header) header.textContent = registry && registry.family_name ? registry.family_name : "Purple Bee";
    if (currentNameNode) currentNameNode.textContent = current.display_name || "Purple Bee";
    if (subtitleNode) {
      subtitleNode.textContent = uiLanguage === "ko"
        ? (currentId === "purple-bee-1-3" ? "현재 기기에서 직접 계산하는 메인 모델" : "현재 기기에서 직접 실행하는 보조 모델")
        : (currentId === "purple-bee-1-3" ? "Main model running on this device" : "Bridge model running on this device");
    }

    setEngineStatus(engine.browserRuntime || engine.model ? "ready" : engine.loading ? "loading" : "idle", getRuntimeModelLabel(), getLocalStatusMessage(engine.browserRuntime || engine.model ? "ready" : engine.loading ? "loading" : "idle"));

    if (!list) return;
    list.innerHTML = "";
    list.style.display = "none";
    if (topSep) topSep.style.display = "none";
    if (bottomSep) bottomSep.style.display = "none";
    if (!registry || !Array.isArray(registry.models) || registry.models.length <= 1) return;

    let rendered = 0;
    registry.models.forEach((model) => {
      if (!model || model.id === currentId) return;
      const badges = [];
      if (model.latest) badges.push("latest");
      if (model.trainable) badges.push("trainable");

      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-menu-item";
      item.innerHTML = `
        <span class="item-icon" style="background:rgba(139,92,246,.12)">
          <i class="ph ph-cube" style="color:var(--accent-light)"></i>
        </span>
        <span>
          <div style="color:var(--text)">${escapeHtml(model.display_name || model.id || "Purple Bee")}</div>
          <div style="font-size:10px;color:var(--text-3)">${escapeHtml([model.architecture_name || "", badges.join(" · ")].filter(Boolean).join(" · "))}</div>
        </span>
      `;
      item.addEventListener("click", () => switchRuntimeModel(model.id));
      list.appendChild(item);
      rendered += 1;
    });

    if (rendered > 0) {
      list.style.display = "";
      if (topSep) topSep.style.display = "";
      if (bottomSep) bottomSep.style.display = "";
    }
  }

  function pbxSetRandomWelcome() {
    const node = document.getElementById("home-subtitle");
    if (!node) return;
    const displayName = typeof pbxGetDisplayName === "function" ? pbxGetDisplayName() : "UserName";
    const lines = [
      `${displayName}님, 어떻게 도와드릴까요?`,
      "오늘은 어떤 이야기를 같이 풀어볼까요?",
      "준비되면 편하게 말해 주세요.",
      "지금 가장 먼저 보고 싶은 것부터 시작해도 좋아요.",
      "질문 하나만 던져주면 바로 이어서 볼게요.",
      "문서, 코드, 이미지, 아이디어 중 무엇이든 괜찮아요.",
      "막히는 부분부터 짚어도 되고, 큰 그림부터 봐도 돼요.",
      "오늘 목표가 있으면 그 방향에 맞춰 도와드릴게요.",
      "가볍게 시작해도 좋아요. 한 줄이면 충분해요.",
      "지금 떠오르는 문제를 그대로 적어 주세요.",
      "최근 흐름을 이어서 보고 싶다면 바로 말해 주세요.",
      "설명, 정리, 분석, 다음 단계 제안까지 같이 할 수 있어요.",
    ];
    node.textContent = lines[Math.floor(Math.random() * lines.length)];
  }

  function pbxInferConversationTitle(text) {
    const source = normalizeWhitespace(String(text || "").replace(/[!?.,]+$/g, ""));
    if (!source) return getActiveUiLanguage() === "ko" ? "새 대화" : "New chat";
    const loweredPrompt = lower(source);
    if (containsAny(loweredPrompt, ["날씨", "weather", "forecast"])) return getActiveUiLanguage() === "ko" ? "날씨 확인" : "Weather";
    if (containsAny(loweredPrompt, ["코드", "코딩", "python", "bug", "error", "debug"])) return getActiveUiLanguage() === "ko" ? "코드 점검" : "Code help";
    if (containsAny(loweredPrompt, ["요약", "정리", "summary"])) return getActiveUiLanguage() === "ko" ? "요약 요청" : "Summary";
    if (containsAny(loweredPrompt, ["번역", "translate"])) return getActiveUiLanguage() === "ko" ? "번역" : "Translation";
    if (containsAny(loweredPrompt, ["기억", "메모리", "저장해줘"])) return getActiveUiLanguage() === "ko" ? "메모리" : "Memory";
    return shorten(source, 34);
  }

  function pbxNormalizeUserName(name, email) {
    const candidate = trim(name || "");
    const fallback = trim(String(email || "").split("@")[0] || "UserName");
    if (!candidate) return fallback;
    if (candidate.includes("�")) return fallback;
    if (typeof pbxLooksBrokenText === "function" && pbxLooksBrokenText(candidate)) return fallback;
    return candidate;
  }

  function pbxRenderProfileMenu() {
    const user = pbxCurrentUser();
    const emailNode = document.getElementById("profile-email");
    const titleNode = document.getElementById("profile-head-title");
    const loginBtn = document.getElementById("google-login-btn");
    const logoutBtn = document.getElementById("profile-logout-btn");
    if (titleNode) titleNode.textContent = user ? (user.name || "UserName") : (getActiveUiLanguage() === "ko" ? "로그인 필요" : "Sign in required");
    if (emailNode) {
      emailNode.textContent = user
        ? (user.email || "")
        : (getActiveUiLanguage() === "ko"
          ? "Google 계정을 연결하면 대화와 메모리를 사용자별로 유지합니다."
          : "Connect a Google account to keep chats and memories per user.");
    }
    if (loginBtn) loginBtn.style.display = user ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = user ? "" : "none";
    pbxRenderMemoryList();
  }

  function pbxBuildAdaptiveFallback(prompt, language) {
    const source = trim(prompt);
    const loweredPrompt = lower(source);
    const displayName = typeof pbxGetDisplayName === "function" ? pbxGetDisplayName() : "UserName";

    if (containsAny(loweredPrompt, ["안녕", "하이", "hello", "hi", "hey"])) {
      return language === "ko"
        ? `${displayName}님, 안녕하세요. 편하게 이어서 말해 주세요.`
        : `Hi ${displayName}. Feel free to continue naturally.`;
    }
    if (containsAny(loweredPrompt, ["강아지", "dog"])) {
      return language === "ko"
        ? "강아지는 사람과 교감이 깊은 대표적인 반려동물이에요. 품종마다 성격과 활동량이 달라서 생활 방식에 맞게 보는 게 중요해요."
        : "Dogs are companion animals known for strong social bonding. Breed and temperament vary a lot.";
    }
    if (containsAny(loweredPrompt, ["파이썬", "python"])) {
      return language === "ko"
        ? "네, 파이썬도 도와줄 수 있어요. 코드나 에러를 붙여주면 원인부터 수정 방향까지 같이 볼게요."
        : "Yes, I can help with Python. If you share code or an error, I'll walk through the cause and fix.";
    }
    if (source.length <= 3) {
      return language === "ko"
        ? "좋아요. 한 줄만 더 붙여주면 더 정확하게 이어서 답할게요."
        : "Sure. Add one more short line and I can answer more precisely.";
    }
    return language === "ko"
      ? `${displayName}님, 지금 질문은 "${shorten(source, 52)}" 쪽으로 이해했어요. 바로 이어서 도와드릴게요.`
      : `I understood your question as: "${shorten(source, 52)}". I'll continue from there.`;
  }

  async function generateReasonedChatReply(prompt, language) {
    try {
      await ensureEngineReady();
    } catch (error) {
      engine.lastError = String(error && error.message ? error.message : error || "runtime init failed");
      return "";
    }
    if (!engine.browserRuntime) return "";

    const trimmedPrompt = trim(prompt);
    if (!trimmedPrompt) return "";
    const promptVariant = buildBrowserModelPrompt(trimmedPrompt, language);
    const profiles = state.deepThink
      ? [
          { maxNewTokens: 96, temperature: 0.72, topK: 40, topP: 0.94 },
          { maxNewTokens: 72, temperature: 0.86, topK: 32, topP: 0.96 },
        ]
      : [
          { maxNewTokens: 64, temperature: 0.64, topK: 32, topP: 0.92 },
          { maxNewTokens: 56, temperature: 0.82, topK: 24, topP: 0.95 },
        ];

    const runOnce = async (profile) => {
      if (!engine._warmDone) {
        try {
          await Promise.race([
            engine.browserRuntime.generateReply("Hello", { maxNewTokens: 8, temperature: 0.2, topK: 8, topP: 0.8 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("warmup-timeout")), 5000)),
          ]);
        } catch (_error) {
          // Ignore warm-up failures and continue.
        }
        engine._warmDone = true;
      }

      const generated = await Promise.race([
        engine.browserRuntime.generateReply(promptVariant, profile),
        new Promise((_, reject) => setTimeout(() => reject(new Error("model-timeout")), state.deepThink ? 20000 : 12000)),
      ]);
      const cleaned = cleanupBrowserModelReply(generated, trimmedPrompt);
      if (!cleaned) return "";
      if (pbxIsGarbageReply(cleaned)) return "";
      if (!isLanguageCompatible(cleaned, language)) return "";
      if (normalizeDialogueText(cleaned) === normalizeDialogueText(lastAssistantText(state.history))) return "";
      return cleaned;
    };

    const chain = (engine._inferenceChain || Promise.resolve()).catch(() => {});
    const queued = chain.then(async () => {
      for (const profile of profiles) {
        try {
          const reply = await runOnce(profile);
          if (reply) return reply;
        } catch (_error) {
          // Try the next sampling profile.
        }
      }
      return "";
    });
    engine._inferenceChain = queued.finally(() => {});

    try {
      return await queued;
    } catch (_error) {
      return "";
    }
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message.");
    const language = getReplyLanguage(prompt, []);

    const memoryRequest = pbxExtractMemoryRequest(prompt);
    if (memoryRequest) {
      if (!pbxRememberText(memoryRequest)) {
        return {
          text: language === "ko" ? "Google 로그인 후 메모리를 저장할 수 있어요." : "Sign in with Google to save memories.",
          meta: "",
        };
      }
      return {
        text: language === "ko" ? `좋아요. 메모리에 저장했어요: ${memoryRequest}` : `Saved to memory: ${memoryRequest}`,
        meta: "",
      };
    }

    if (pbxWantsMemoryList(prompt)) {
      return { text: pbxMemorySummary(language), meta: "" };
    }

    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    if (currentDocs.length) {
      const docReply = replyFromDocuments(prompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(language),
        language,
        style: getReplyStyle(prompt, "general"),
      });
      if (docReply) return docReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredPrompt)) {
      const weatherReply = await buildWeatherReply(prompt, language);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(language), meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredPrompt)) {
      const searchReply = buildWebsiteSearchReply(prompt, language);
      if (searchReply) return searchReply;
    }

    const memories = pbxLoadMemories()
      .slice(0, 5)
      .map((memory) => `${memory.title}: ${memory.text}`)
      .join("\n");
    const modelPromptParts = [];
    if (isCorrectionTurn && previousPrompt) {
      modelPromptParts.push(`Previous user request: ${previousPrompt}`);
    }
    modelPromptParts.push(prompt);
    if (memories) {
      modelPromptParts.push(`Remembered user facts:\n${memories}`);
    }
    const modelPrompt = modelPromptParts.filter(Boolean).join("\n\n");
    const modelReply = await tryModelFirstReply(modelPrompt, language);
    if (modelReply) {
      return { text: modelReply, meta: "" };
    }

    return {
      text: "",
      meta: "",
      code: "PB-ANSWER-FAILED",
    };
  }

  async function sendMessage() {
    if (!ensureRequiredConsent()) return;
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;

    const raw = trim(field.value);
    const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
    if (!raw && !attachments.length) return;

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast(getActiveUiLanguage() === "ko" ? "첫 질문은 모델 준비 때문에 평소보다 조금 더 느릴 수 있어요." : "The first reply can be a little slower while the model warms up.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    const counter = document.getElementById("char-count");
    if (counter) counter.textContent = "0 / 2000";

    const userEntry = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: raw || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message."),
      attachments,
      meta: "",
    };

    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    if (state.history.filter((entry) => entry.role === "user").length === 1) {
      const active = state.conversations.find((conversation) => conversation.id === state.sessionId);
      if (active) active.title = pbxInferConversationTitle(userEntry.content);
    }

    state.isStreaming = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const typingId = appendTyping();

    try {
      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), 35000)),
      ]);

      const safeText = shorten(trim(reply && reply.text ? reply.text : ""), 1400)
        || (getActiveUiLanguage() === "ko"
          ? "이번에는 답을 만들지 못했어요. 같은 뜻으로 한 번만 더 적어주시면 바로 다시 볼게요."
          : "I couldn't build a useful reply this time. Please try once more with the same meaning.");
      const aiEntry = {
        id: `msg_${Date.now()}_ai`,
        role: "assistant",
        content: safeText,
        attachments: [],
        meta: (reply && reply.meta) || "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
    } catch (_error) {
      const aiEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: getActiveUiLanguage() === "ko"
          ? "지금은 응답을 만드는 중에 잠시 문제가 생겼어요. 같은 질문을 한 번만 더 보내주시면 바로 이어서 볼게요."
          : "A temporary issue interrupted the reply. Please send the same question once more.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.content);
      state.history.push(aiEntry);
    } finally {
      removeTyping(typingId);
      pbxClearAllTyping();
      state.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  function pbxNormalizeUserName(name, email) {
    const candidate = trim(name || "");
    const fallback = trim(String(email || "").split("@")[0] || "UserName");
    if (!candidate) return fallback;
    if (candidate.includes("�")) return fallback;
    if (typeof pbxLooksBrokenText === "function" && pbxLooksBrokenText(candidate)) return fallback;
    return candidate;
  }

  function getLocalStatusMessage(status) {
    const uiLanguage = getActiveUiLanguage();
    const currentModel = getRuntimeModelMeta();
    const label = currentModel.display_name || "Purple Bee";
    if (uiLanguage === "ko") {
      if (status === "loading") return `${label} 준비 중이에요. 첫 질문은 평소보다 조금 더 걸릴 수 있어요.`;
      if (status === "error") return `${label} 초기화에 문제가 생겼어요. 다시 시도하거나 다른 모델로 전환해 주세요.`;
      return "";
    }
    if (status === "loading") return `Preparing ${label} on this device. The first reply can take a little longer.`;
    if (status === "error") return `${label} failed to initialize on this device. Please retry or switch models.`;
    return "";
  }

  function pbxSetRandomWelcome() {
    const node = document.getElementById("home-subtitle");
    if (!node) return;
    const displayName = typeof pbxGetDisplayName === "function" ? pbxGetDisplayName() : "UserName";
    const lines = [
      `${displayName} 님, 어떻게 도와드릴까요?`,
      "오늘은 무슨 이야기를 할까요?",
      "준비되면 편하게 얘기해 주세요.",
      "지금 보고 있는 문제부터 같이 풀어봐도 좋아요.",
      "질문 한 줄만 적어주면 바로 이어서 도와드릴게요.",
      "문서, 코드, 파일, 아이디어 중 무엇이든 괜찮아요.",
      "막히는 부분이 있으면 그 부분만 짚어서 말해줘도 돼요.",
      "오늘 목표가 있으면 그 방향에 맞춰 같이 정리해드릴게요.",
      "가볍게 시작해도 좋아요. 한 줄이면 충분해요.",
      "지금 떠오르는 질문부터 그대로 적어주세요.",
      "최근에 하던 작업이 있으면 이어서 봐드릴 수 있어요.",
      "설명, 정리, 분석, 다음 단계 제안까지 같이 갈 수 있어요.",
    ];
    node.textContent = lines[Math.floor(Math.random() * lines.length)];
  }

  function pbxInferConversationTitle(text) {
    const source = normalizeWhitespace(String(text || "").replace(/[!?.,]+$/g, ""));
    if (!source) return getActiveUiLanguage() === "ko" ? "새 대화" : "New chat";
    const loweredPrompt = lower(source);
    if (containsAny(loweredPrompt, ["날씨", "weather", "forecast"])) return getActiveUiLanguage() === "ko" ? "날씨 확인" : "Weather";
    if (containsAny(loweredPrompt, ["코드", "코딩", "python", "bug", "error", "debug"])) return getActiveUiLanguage() === "ko" ? "코드 도움" : "Code help";
    if (containsAny(loweredPrompt, ["요약", "정리", "summary"])) return getActiveUiLanguage() === "ko" ? "요약 요청" : "Summary";
    if (containsAny(loweredPrompt, ["번역", "translate"])) return getActiveUiLanguage() === "ko" ? "번역" : "Translation";
    if (containsAny(loweredPrompt, ["기억", "메모리", "저장해줘", "remember"])) return getActiveUiLanguage() === "ko" ? "메모리" : "Memory";
    return shorten(source, 34);
  }

  function pbxRenderProfileMenu() {
    const user = pbxCurrentUser();
    const emailNode = document.getElementById("profile-email");
    const titleNode = document.getElementById("profile-head-title");
    const loginBtn = document.getElementById("google-login-btn");
    const logoutBtn = document.getElementById("profile-logout-btn");
    if (titleNode) {
      titleNode.textContent = user
        ? (user.name || "UserName")
        : (getActiveUiLanguage() === "ko" ? "로그인이 필요해요" : "Sign in required");
    }
    if (emailNode) {
      emailNode.textContent = user
        ? (user.email || "")
        : (getActiveUiLanguage() === "ko"
          ? "Google 계정을 연결하면 최근 대화와 메모리를 사용자별로 유지할 수 있어요."
          : "Connect a Google account to keep chats and memories per user.");
    }
    if (loginBtn) loginBtn.style.display = user ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = user ? "" : "none";
    pbxRenderMemoryList();
  }

  function pbxBuildAdaptiveFallback(prompt, language) {
    const source = trim(prompt);
    const loweredPrompt = lower(source);
    const displayName = typeof pbxGetDisplayName === "function" ? pbxGetDisplayName() : "UserName";

    if (containsAny(loweredPrompt, ["안녕", "안녕하세요", "hello", "hi", "hey"])) {
      return language === "ko"
        ? `${displayName} 님, 안녕하세요. 편하게 이어서 말해 주세요.`
        : `Hi ${displayName}. Feel free to continue naturally.`;
    }
    if (containsAny(loweredPrompt, ["강아지", "dog"])) {
      return language === "ko"
        ? "강아지는 사람과 오래 함께해 온 대표적인 반려동물이야. 품종마다 성격과 특징이 꽤 달라."
        : "Dogs are companion animals known for strong social bonding. Breed and temperament vary a lot.";
    }
    if (containsAny(loweredPrompt, ["파이썬", "python"])) {
      return language === "ko"
        ? "응, 파이썬도 도와줄 수 있어. 코드나 에러를 붙여주면 원인부터 수정 방향까지 같이 볼게."
        : "Yes, I can help with Python. If you share code or an error, I'll walk through the cause and fix.";
    }
    if (source.length <= 3) {
      return language === "ko"
        ? "좋아. 한 줄만 더 붙여주면 더 정확하게 이어서 답할게."
        : "Sure. Add one more short line and I can answer more precisely.";
    }
    return language === "ko"
      ? `${displayName} 님, 지금 질문은 "${shorten(source, 52)}" 쪽으로 이해했어요. 바로 이어서 도와드릴게요.`
      : `I understood your question as: "${shorten(source, 52)}". I'll continue from there.`;
  }

  async function generateReasonedChatReply(prompt, language) {
    try {
      await ensureEngineReady();
    } catch (error) {
      engine.lastError = String(error && error.message ? error.message : error || "runtime init failed");
      return "";
    }
    if (!engine.browserRuntime) return "";

    const trimmedPrompt = trim(prompt);
    if (!trimmedPrompt) return "";

    const currentModelId = getSelectedRuntimeModelId() || "purple-bee-1-3";
    const promptVariant = buildBrowserModelPrompt(trimmedPrompt, language);
    const profiles = currentModelId === "purple-bee-1-3"
      ? [{ maxNewTokens: 48, temperature: 0.54, topK: 16, topP: 0.88 }]
      : (state.deepThink
        ? [
            { maxNewTokens: 96, temperature: 0.72, topK: 40, topP: 0.94 },
            { maxNewTokens: 72, temperature: 0.86, topK: 32, topP: 0.96 },
          ]
        : [
            { maxNewTokens: 64, temperature: 0.64, topK: 32, topP: 0.92 },
            { maxNewTokens: 56, temperature: 0.82, topK: 24, topP: 0.95 },
          ]);

    let sawTimeout = false;
    const runOnce = async (profile) => {
      if (!engine._warmDone) {
        try {
          await Promise.race([
            engine.browserRuntime.generateReply("Hello", { maxNewTokens: 8, temperature: 0.2, topK: 8, topP: 0.8 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("warmup-timeout")), currentModelId === "purple-bee-1-3" ? 2500 : 5000)),
          ]);
        } catch (_error) {
          // Ignore warm-up failures and continue.
        }
        engine._warmDone = true;
      }

      try {
        const generated = await Promise.race([
          engine.browserRuntime.generateReply(promptVariant, profile),
          new Promise((_, reject) => setTimeout(() => reject(new Error("model-timeout")), currentModelId === "purple-bee-1-3" ? 7000 : (state.deepThink ? 20000 : 12000))),
        ]);
        const cleaned = cleanupBrowserModelReply(generated, trimmedPrompt);
        if (!cleaned) return "";
        if (pbxIsGarbageReply(cleaned)) return "";
        if (!isLanguageCompatible(cleaned, language)) return "";
        if (normalizeDialogueText(cleaned) === normalizeDialogueText(lastAssistantText(state.history))) return "";
        return cleaned;
      } catch (error) {
        if (String(error && error.message ? error.message : error || "").includes("timeout")) {
          sawTimeout = true;
        }
        throw error;
      }
    };

    const previousChain = (engine._inferenceChain || Promise.resolve()).catch(() => {});
    const queued = previousChain.then(async () => {
      for (const profile of profiles) {
        try {
          const reply = await runOnce(profile);
          if (reply) return reply;
        } catch (_error) {
          // Try the next sampling profile.
        }
      }
      return "";
    });
    engine._inferenceChain = queued;

    try {
      const reply = await queued;
      if (!reply && currentModelId === "purple-bee-1-3" && sawTimeout) {
        resetRuntimeEngine();
      }
      return reply;
    } catch (_error) {
      if (currentModelId === "purple-bee-1-3") {
        resetRuntimeEngine();
      }
      return "";
    } finally {
      if (engine._inferenceChain === queued) {
        engine._inferenceChain = null;
      }
    }
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt)) return "";
    return generateReasonedChatReply(prompt, language);
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message.");
    const language = getReplyLanguage(prompt, []);

    const memoryRequest = pbxExtractMemoryRequest(prompt);
    if (memoryRequest) {
      if (!pbxRememberText(memoryRequest)) {
        return {
          text: language === "ko" ? "Google 로그인이 있어야 메모리를 저장할 수 있어요." : "Sign in with Google to save memories.",
          meta: "",
        };
      }
      return {
        text: language === "ko" ? `좋아. 메모리에 저장해뒀어: ${memoryRequest}` : `Saved to memory: ${memoryRequest}`,
        meta: "",
      };
    }

    if (pbxWantsMemoryList(prompt)) {
      return { text: pbxMemorySummary(language), meta: "" };
    }

    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    if (currentDocs.length) {
      const docReply = replyFromDocuments(prompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(language),
        language,
        style: getReplyStyle(prompt, "general"),
      });
      if (docReply) return docReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredPrompt)) {
      const weatherReply = await buildWeatherReply(prompt, language);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(language), meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredPrompt)) {
      const searchReply = buildWebsiteSearchReply(prompt, language);
      if (searchReply) return searchReply;
    }

    const memories = pbxLoadMemories()
      .slice(0, 5)
      .map((memory) => `${memory.title}: ${memory.text}`)
      .join("\n");
    const modelPrompt = memories ? `${prompt}\n\nRemembered user facts:\n${memories}\nAssistant:` : prompt;
    let modelReply = await tryModelFirstReply(modelPrompt, language);
    if (modelReply) {
      return { text: modelReply, meta: "" };
    }

    const historyDocs = collectHistoryDocuments(state.history);
    if (historyDocs.length) {
      const effectiveQuery = buildEffectiveQuery(prompt, state.history);
      const evidence = collectEvidence(
        effectiveQuery,
        dedupeDocuments(searchDocuments(effectiveQuery, historyDocs, 6)).slice(0, 8),
      );
      if (evidence.length) {
        return {
          text: composeFromEvidence("general", prompt, evidence, { language, style: "balanced" }),
          meta: buildSourcesLine(evidence, { language }),
          code: "PB-FALLBACK-CTX",
        };
      }
    }

    try {
      const _pbxHist = (typeof state !== "undefined" && state.history) ? state.history : [];
      const _pbxReply = await pbxBackendBuildReply(prompt, _pbxHist);
      if (_pbxReply && _pbxReply.length > 1) {
        return { text: _pbxReply, meta: "", code: "PB-BACKEND-OK" };
      }
    } catch (_pbxErr) {}

    return {
      text: pbxBuildAdaptiveFallback(prompt, language),
      meta: "",
      code: "PB-FALLBACK-001",
    };
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;

    const raw = trim(field.value);
    const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
    if (!raw && !attachments.length) return;

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast(getActiveUiLanguage() === "ko" ? "첫 질문은 모델 준비 때문에 평소보다 조금 더 걸릴 수 있어요." : "The first reply can be a little slower while the model warms up.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    const counter = document.getElementById("char-count");
    if (counter) counter.textContent = "0 / 2000";

    const userEntry = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: raw || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message."),
      attachments,
      meta: "",
    };

    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    if (state.history.filter((entry) => entry.role === "user").length === 1) {
      const active = state.conversations.find((conversation) => conversation.id === state.sessionId);
      if (active) active.title = pbxInferConversationTitle(userEntry.content);
    }

    state.isStreaming = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const typingId = appendTyping();

    try {
      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), 18000)),
      ]);

      const safeText = shorten(trim(reply && reply.text ? reply.text : ""), 1400)
        || (getActiveUiLanguage() === "ko"
          ? "이번에는 쓸 만한 답을 만들지 못했어요. 같은 뜻으로 한 번만 더 적어주시면 바로 다시 볼게요."
          : "I couldn't build a useful reply this time. Please try once more with the same meaning.");
      const aiEntry = {
        id: `msg_${Date.now()}_ai`,
        role: "assistant",
        content: safeText,
        attachments: [],
        meta: (reply && reply.meta) || "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
    } catch (_error) {
      const aiEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: getActiveUiLanguage() === "ko"
          ? "지금은 답변을 만드는 중에 잠시 문제가 생겼어요. 같은 질문을 한 번만 더 보내주시면 바로 이어서 볼게요."
          : "A temporary issue interrupted the reply. Please send the same question once more.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.content);
      state.history.push(aiEntry);
    } finally {
      removeTyping(typingId);
      pbxClearAllTyping();
      state.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  function pbxRuntimeTimeouts() {
    const askedUserCount = state.history.filter((entry) => entry && entry.role === "user").length;
    const isFirstTurn = askedUserCount <= 1;
    return {
      isFirstTurn,
      warmupMs: isFirstTurn ? 30000 : 12000,
      modelMs: isFirstTurn ? 120000 : (state.deepThink ? 45000 : 30000),
      replyMs: isFirstTurn ? 180000 : 60000,
    };
  }

  async function generateReasonedChatReply(prompt, language) {
    try {
      await ensureEngineReady();
    } catch (error) {
      engine.lastError = String(error && error.message ? error.message : error || "runtime init failed");
      return "";
    }
    if (!engine.browserRuntime) return "";

    const trimmedPrompt = trim(prompt);
    if (!trimmedPrompt) return "";

    const currentModelId = getSelectedRuntimeModelId() || "purple-bee-1-3";
    const promptVariant = buildBrowserModelPrompt(trimmedPrompt, language);
    const timeouts = pbxRuntimeTimeouts();
    const profiles = currentModelId === "purple-bee-1-3"
      ? (state.deepThink
        ? [
            { maxNewTokens: 96, temperature: 0.42, topK: 24, topP: 0.90 },
            { maxNewTokens: 80, temperature: 0.52, topK: 28, topP: 0.92 },
          ]
        : [
            { maxNewTokens: 80, temperature: 0.36, topK: 20, topP: 0.88 },
            { maxNewTokens: 64, temperature: 0.46, topK: 24, topP: 0.90 },
          ])
      : (state.deepThink
        ? [
            { maxNewTokens: 96, temperature: 0.72, topK: 40, topP: 0.94 },
            { maxNewTokens: 80, temperature: 0.82, topK: 32, topP: 0.96 },
          ]
        : [
            { maxNewTokens: 72, temperature: 0.62, topK: 32, topP: 0.92 },
            { maxNewTokens: 56, temperature: 0.74, topK: 24, topP: 0.94 },
          ]);

    const previousChain = (engine._inferenceChain || Promise.resolve()).catch(() => {});
    const queued = previousChain.then(async () => {
      if (!engine._warmDone) {
        engine._warmDone = true;
      }

      for (const profile of profiles) {
        try {
          const generated = await Promise.race([
            engine.browserRuntime.generateReply(promptVariant, profile),
            new Promise((_, reject) => setTimeout(() => reject(new Error("model-timeout")), timeouts.modelMs)),
          ]);
          const cleaned = cleanupBrowserModelReply(generated, trimmedPrompt);
          if (!cleaned) continue;
          if (pbxIsGarbageReply(cleaned)) continue;
          if (!isLanguageCompatible(cleaned, language)) continue;
          if (normalizeDialogueText(cleaned) === normalizeDialogueText(lastAssistantText(state.history))) continue;
          return cleaned;
        } catch (error) {
          engine.lastError = String(error && error.message ? error.message : error || "model generation failed");
        }
      }
      return "";
    });
    engine._inferenceChain = queued;

    try {
      return await queued;
    } catch (_error) {
      return "";
    } finally {
      if (engine._inferenceChain === queued) {
        engine._inferenceChain = null;
      }
    }
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;
    const raw = field.value || "";
    const attachments = Array.isArray(state.pendingAttachments) ? [...state.pendingAttachments] : [];
    if (!trim(raw) && !attachments.length) return;

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast(getActiveUiLanguage() === "ko" ? "첫 질문은 모델 준비와 파일 로딩 때문에 평소보다 조금 더 걸릴 수 있어요." : "The first reply can take a little longer while the model is loading on this device.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    const counter = document.getElementById("char-count");
    if (counter) counter.textContent = "0 / 2000";

    const userEntry = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: raw || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message."),
      attachments,
      meta: "",
    };

    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    if (state.history.filter((entry) => entry.role === "user").length === 1) {
      const active = state.conversations.find((conversation) => conversation.id === state.sessionId);
      if (active) active.title = pbxInferConversationTitle(userEntry.content);
    }

    state.isStreaming = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const typingId = appendTyping();
    const timeouts = pbxRuntimeTimeouts();

    try {
      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), timeouts.replyMs)),
      ]);

      const safeText = shorten(trim(reply && reply.text ? reply.text : ""), 1400)
        || (getActiveUiLanguage() === "ko"
          ? "이번에는 쓸 만한 답을 만들지 못했어요. 같은 뜻으로 한 번만 더 적어주시면 바로 다시 볼게요."
          : "I couldn't build a useful reply this time. Please try once more with the same meaning.");
      const aiEntry = {
        id: `msg_${Date.now()}_ai`,
        role: "assistant",
        content: safeText,
        attachments: [],
        meta: (reply && reply.meta) || "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
      state.history.push(aiEntry);
    } catch (_error) {
      const aiEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: getActiveUiLanguage() === "ko"
          ? "지금은 답변을 만드는 데 시간이 더 필요해요. 잠시 기다렸다가 같은 질문을 다시 보내주시면 바로 이어서 볼게요."
          : "The reply needs more time to finish on this device. Please wait a moment and send the same question again.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", aiEntry);
      await streamToBubble(bubble, aiEntry.content);
      state.history.push(aiEntry);
    } finally {
      removeTyping(typingId);
      pbxClearAllTyping();
      state.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;
    const raw = field.value || "";
    const attachments = Array.isArray(state.pendingAttachments) ? [...state.pendingAttachments] : [];
    if (!trim(raw) && !attachments.length) return;

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast(getActiveUiLanguage() === "ko" ? "첫 질문은 모델 준비 때문에 조금 더 느릴 수 있어요." : "The first reply can take a little longer while the model is loading on this device.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    const counter = document.getElementById("char-count");
    if (counter) counter.textContent = "0 / 2000";

    const userEntry = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: trim(raw) || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message."),
      attachments,
      meta: "",
    };

    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    if (state.history.filter((entry) => entry.role === "user").length === 1) {
      const active = state.conversations.find((conversation) => conversation.id === state.sessionId);
      if (active) active.title = pbxInferConversationTitle(userEntry.content);
    }

    state.isStreaming = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const typingId = appendTyping();
    const timeouts = pbxRuntimeTimeouts();

    try {
      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), timeouts.replyMs)),
      ]);

      const replyCode = trim(reply && reply.code ? reply.code : "");
      const safeText = shorten(trim(reply && reply.text ? reply.text : ""), 1400);
      const isFailureReply = !safeText || replyCode === "PB-ANSWER-FAILED";

      if (isFailureReply) {
        const failureEntry = {
          id: `msg_${Date.now()}_fail`,
          role: "assistant",
          content: getActiveUiLanguage() === "ko"
            ? "답변 생성에 실패했어요. 잠시 후 다시 시도해 주세요."
            : "Reply generation failed. Please try again in a moment.",
          attachments: [],
          meta: "",
        };
        const bubble = appendMessage("ai", "", failureEntry);
        await streamToBubble(bubble, failureEntry.content);
      } else {
        const aiEntry = {
          id: `msg_${Date.now()}_ai`,
          role: "assistant",
          content: safeText,
          attachments: [],
          meta: (reply && reply.meta) || "",
        };
        const bubble = appendMessage("ai", "", aiEntry);
        await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
        state.history.push(aiEntry);
      }
    } catch (_error) {
      const failureEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: getActiveUiLanguage() === "ko"
          ? "답변 생성에 실패했어요. 잠시 후 다시 시도해 주세요."
          : "Reply generation failed. Please try again in a moment.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", failureEntry);
      await streamToBubble(bubble, failureEntry.content);
    } finally {
      removeTyping(typingId);
      pbxClearAllTyping();
      state.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message.");
    const language = getReplyLanguage(prompt, []);
    const loweredPrompt = lower(prompt);
    const isCorrectionTurn = isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt);
    const previousPrompt = previousUserPrompt(userEntry.id);

    const memoryRequest = pbxExtractMemoryRequest(prompt);
    if (memoryRequest) {
      if (!pbxRememberText(memoryRequest)) {
        return {
          text: language === "ko" ? "Google 로그인 후 메모리를 저장할 수 있어요." : "Sign in with Google to save memories.",
          meta: "",
        };
      }
      return {
        text: language === "ko" ? `좋아요. 메모리에 저장했어요: ${memoryRequest}` : `Saved to memory: ${memoryRequest}`,
        meta: "",
      };
    }

    if (pbxWantsMemoryList(prompt)) {
      return { text: pbxMemorySummary(language), meta: "" };
    }

    const currentDocs = attachmentsToDocuments(userEntry.attachments);
    if (currentDocs.length) {
      const docReply = replyFromDocuments(prompt, currentDocs, {
        metaPrefix: getAttachmentMetaPrefix(language),
        language,
        style: getReplyStyle(prompt, "general"),
      });
      if (docReply) return docReply;
    }

    if (!currentDocs.length && isWeatherQuestion(loweredPrompt)) {
      const weatherReply = await buildWeatherReply(prompt, language);
      if (weatherReply) return weatherReply;
      return { text: buildWeatherMissingLocationReply(language), meta: "" };
    }

    if (!currentDocs.length && isWebsiteSearchPrompt(loweredPrompt)) {
      const searchReply = buildWebsiteSearchReply(prompt, language);
      if (searchReply) return searchReply;
    }

    const memories = pbxLoadMemories()
      .slice(0, 5)
      .map((memory) => `${memory.title}: ${memory.text}`)
      .join("\n");

    const modelPromptParts = [];
    if (isCorrectionTurn && previousPrompt) {
      modelPromptParts.push(`Previous user request: ${previousPrompt}`);
    }
    modelPromptParts.push(prompt);
    if (memories) {
      modelPromptParts.push(`Remembered user facts:\n${memories}`);
    }

    const modelReply = await tryModelFirstReply(modelPromptParts.filter(Boolean).join("\n\n"), language);
    if (modelReply) {
      return { text: modelReply, meta: "" };
    }

    return {
      text: "",
      meta: "",
      code: "PB-ANSWER-FAILED",
    };
  }

  function cleanupBrowserModelReply(text, prompt) {
    let value = trim(String(text || ""));
    value = value.replace(/^(assistant|purple bee)\s*:\s*/i, "").trim();
    value = value.replace(/\b(user|assistant|purple bee)\s*:/gi, "").trim();
    value = value.split(/\n+\s*User\s*:/i)[0].trim();
    value = value.replace(/\n+\s*Assistant\s*:/gi, "\n").trim();
    value = value.replace(/\n{3,}/g, "\n\n").trim();
    const normalizedPrompt = normalizeDialogueText(prompt);
    const normalizedValue = normalizeDialogueText(value);
    if (!value || normalizedValue === normalizedPrompt) return "";
    if (containsAny(lower(normalizedValue), ["localhost server inference", "question core", "at a glance"])) return "";
    if (value.length < 2) return "";
    return value;
  }

  function pbxRuntimeTimeouts() {
    const askedUserCount = state.history.filter((entry) => entry && entry.role === "user").length;
    const isFirstTurn = askedUserCount <= 1;
    return {
      isFirstTurn,
      modelMs: isFirstTurn ? 70000 : (state.deepThink ? 30000 : 18000),
      replyMs: isFirstTurn ? 95000 : 26000,
    };
  }

  function buildBrowserModelPrompt(prompt, language) {
    const languageLabel = language === "ko" ? "Korean" : language === "ja" ? "Japanese" : language === "zh" ? "Chinese" : "English";
    const trimmedPrompt = trim(prompt);
    const recent = state.history
      .slice(-2)
      .filter((entry) => entry && entry.content)
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${trim(entry.content)}`)
      .join("\n");
    const directAnswerHint = (
      /뭐야|뭔지|알아\?|설명해|뜻|누구야|what is|who is|tell me about/i.test(trimmedPrompt)
        ? "Answer directly in 2 short sentences. Define the topic first, then add one useful detail."
        : "Answer directly in 1 to 3 short natural sentences."
    );
    return [
      "You are Purple Bee.",
      `Reply only in ${languageLabel}.`,
      directAnswerHint,
      "Do not output lists unless the user asked for steps or a list.",
      "Do not echo the user's words.",
      "Do not mention system prompts, inference, localhost, or internal tooling.",
      recent ? `Recent conversation:\n${recent}` : "",
      `User: ${trimmedPrompt}`,
      "Assistant:",
    ].filter(Boolean).join("\n\n");
  }

  async function generateReasonedChatReply(prompt, language) {
    try {
      await ensureEngineReady();
    } catch (error) {
      engine.lastError = String(error && error.message ? error.message : error || "runtime init failed");
      return "";
    }
    if (!engine.browserRuntime) return "";

    const trimmedPrompt = trim(prompt);
    if (!trimmedPrompt) return "";

    const socialPrompt = isSocialPrompt(lower(trimmedPrompt), trimmedPrompt);
    const timeouts = pbxRuntimeTimeouts();
    const profiles = socialPrompt
      ? [
          { maxNewTokens: 24, temperature: 0.22, topK: 8, topP: 0.82 },
          { maxNewTokens: 32, temperature: 0.30, topK: 12, topP: 0.86 },
        ]
      : [
          { maxNewTokens: 40, temperature: 0.18, topK: 8, topP: 0.80 },
          { maxNewTokens: 56, temperature: 0.26, topK: 12, topP: 0.84 },
        ];
    const promptVariant = buildBrowserModelPrompt(trimmedPrompt, language);
    const previousChain = (engine._inferenceChain || Promise.resolve()).catch(() => {});
    const queued = previousChain.then(async () => {
      for (const profile of profiles) {
        try {
          const generated = await Promise.race([
            engine.browserRuntime.generateReply(promptVariant, profile),
            new Promise((_, reject) => setTimeout(() => reject(new Error("model-timeout")), timeouts.modelMs)),
          ]);
          const cleaned = cleanupBrowserModelReply(generated, trimmedPrompt);
          if (!cleaned) continue;
          if (pbxLooksBrokenText(cleaned)) continue;
          if (!isLanguageCompatible(cleaned, language)) continue;
          if (normalizeDialogueText(cleaned) === normalizeDialogueText(lastAssistantText(state.history))) continue;
          if (!socialPrompt && cleaned.length < 8) continue;
          return cleaned;
        } catch (error) {
          engine.lastError = String(error && error.message ? error.message : error || "model generation failed");
        }
      }
      return "";
    });
    engine._inferenceChain = queued;

    try {
      return await queued;
    } catch (_error) {
      return "";
    } finally {
      if (engine._inferenceChain === queued) engine._inferenceChain = null;
    }
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (!trim(prompt)) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt)) return "";
    try {
      const generated = await generateReasonedChatReply(prompt, language);
      const cleaned = cleanupBrowserModelReply(generated, prompt);
      if (!cleaned) return "";
      if (pbxLooksBrokenText(cleaned)) return "";
      if (!isLanguageCompatible(cleaned, language)) return "";
      return cleaned;
    } catch (_error) {
      return "";
    }
  }

  async function buildReply(userEntry) {
    const prompt = trim(userEntry.content) || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message.");
    const language = getReplyLanguage(prompt, []);
    const loweredPrompt = lower(prompt);

    const memoryRequest = pbxExtractMemoryRequest(prompt);
    if (memoryRequest) {
      if (!pbxRememberText(memoryRequest)) {
        return {
          text: language === "ko" ? "Google 로그인 후 메모리를 저장할 수 있어요." : "Sign in with Google to save memories.",
          meta: "",
        };
      }
      return {
        text: language === "ko" ? `좋아요. 메모리에 저장했어요: ${memoryRequest}` : `Saved to memory: ${memoryRequest}`,
        meta: "",
      };
    }

    if (pbxWantsMemoryList(prompt)) {
      return { text: pbxMemorySummary(language), meta: "" };
    }

    const previousPrompt = trim(previousUserPrompt(userEntry.id));
    const isCorrectionTurn = isNegativeCorrectionPrompt(loweredPrompt) || isConfusionPrompt(loweredPrompt);
    const modelPrompt = isCorrectionTurn && previousPrompt
      ? `${previousPrompt}\n\nThe previous answer missed the user's intent. Now answer this follow-up directly.\n\n${prompt}`
      : prompt;
    const modelReply = await tryModelFirstReply(modelPrompt, language);
    if (modelReply) return { text: modelReply, meta: "" };

    return {
      text: "",
      meta: "",
      code: "PB-ANSWER-FAILED",
    };
  }

  function pbxLocalRuntimeCandidates() {
    const origin = String(window.location.origin || "").trim();
    const values = [];
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      values.push(origin);
    }
    values.push("http://127.0.0.1:7860", "http://localhost:7860");
    return Array.from(new Set(values.filter(Boolean)));
  }

  async function pbxFetchLocalRuntimeStatus(base) {
    const response = await fetch(`${base}/api/local_runtime/status`, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`local-runtime-status-${response.status}`);
    }
    const payload = await response.json();
    if (!payload || payload.ok === false) {
      throw new Error("local-runtime-status-invalid");
    }
    return payload;
  }

  async function pbxResolveLocalRuntime(force = false) {
    const checkedRecently = engine.localRuntimeCheckedAt && (Date.now() - engine.localRuntimeCheckedAt) < 12000;
    if (!force && checkedRecently) {
      return engine.localRuntimeBase || "";
    }
    if (!force && engine._localRuntimeProbe) {
      return engine._localRuntimeProbe;
    }

    const probe = (async () => {
      for (const base of pbxLocalRuntimeCandidates()) {
        try {
          const payload = await pbxFetchLocalRuntimeStatus(base);
          engine.localRuntimeBase = base;
          engine.localRuntimeStatus = payload;
          engine.localRuntimeCheckedAt = Date.now();
          engine.browserRuntime = null;
          engine.model = {
            kind: "local-runtime",
            modelId: payload.model_id || getSelectedRuntimeModelId() || "purple-bee-1-3",
          };
          engine.runtimeKind = "local-runtime";
          engine.lastError = "";
          setEngineStatus(
            "ready",
            payload.display_name || getRuntimeModelLabel(),
            getActiveUiLanguage() === "ko"
              ? "로컬 Purple Bee Runtime에 연결되었습니다."
              : "Connected to local Purple Bee Runtime.",
          );
          return base;
        } catch (_error) {
          // Try the next candidate.
        }
      }

      engine.localRuntimeBase = "";
      engine.localRuntimeStatus = null;
      engine.localRuntimeCheckedAt = Date.now();
      engine.browserRuntime = null;
      engine.model = null;
      engine.runtimeKind = "error";
      engine.lastError = "local-runtime-offline";
      setEngineStatus(
        "error",
        getRuntimeModelLabel(),
        getActiveUiLanguage() === "ko"
          ? "로컬 Purple Bee Runtime을 찾지 못했습니다. Purple_Bee_AI_실행.bat을 먼저 실행해 주세요."
          : "Local Purple Bee Runtime was not found. Launch Purple_Bee_AI_실행.bat first.",
      );
      return "";
    })();

    engine._localRuntimeProbe = probe;
    try {
      return await probe;
    } finally {
      if (engine._localRuntimeProbe === probe) {
        engine._localRuntimeProbe = null;
      }
    }
  }

  async function pbxBackendBuildReplyToBase(base, prompt, history) {
    try {
      const response = await fetch(`${base}/api/pbx_chat_sync`, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          history: Array.isArray(history) ? history : [],
          web_search: true,
          session_id: state.sessionId,
        }),
      });
      if (!response.ok) {
        throw new Error(`local-runtime-chat-${response.status}`);
      }
      const payload = await response.json();
      return trim(payload && payload.reply ? payload.reply : "");
    } catch (error) {
      engine.lastError = String(error && error.message ? error.message : error || "local runtime chat failed");
      return "";
    }
  }

  function resetRuntimeEngine() {
    pbxTerminateInferenceWorker();
    engine.browserRuntime = null;
    engine.model = null;
    engine.loading = null;
    engine.runtimeKind = "none";
    engine.lastError = "";
    engine.localRuntimeBase = "";
    engine.localRuntimeStatus = null;
    engine.localRuntimeCheckedAt = 0;
    engine._localRuntimeProbe = null;
  }

  function getLocalStatusMessage(status) {
    const installMeta = getInstallModelMeta();
    const label = installMeta && installMeta.display_name ? installMeta.display_name : "선택한 모델";
    if (status === "loading") {
      return getActiveUiLanguage() === "ko"
        ? `${label} 준비 상태를 현재 기기에서 확인하는 중입니다...`
        : `Preparing ${label} on this device...`;
    }
    if (status === "error") {
      return getActiveUiLanguage() === "ko"
        ? `${label} 준비 상태를 이 기기에서 확인하지 못했습니다.`
        : `${label} could not be prepared on this device.`;
    }
    return getActiveUiLanguage() === "ko"
      ? "설치된 선택 모델이 이 기기에서 백그라운드로 답변합니다."
      : "The installed model answers in the background on this device.";
  }

  async function ensureEngineReady() {
    if (engine.runtimeKind === "browser-worker-runtime" && engine.inferenceWorker && engine.model) {
      return engine;
    }
    if (engine.loading) {
      return engine.loading;
    }
    engine.loading = (async () => {
      setEngineStatus("loading", getRuntimeModelLabel(), getLocalStatusMessage("loading"));
      try {
        const plan = await pbxFetchPackagePlan();
        await pbxEnsureInferenceWorker(plan);
        engine.lastError = "";
        setEngineStatus("ready", getRuntimeModelLabel(), getLocalStatusMessage("ready"));
      } catch (error) {
        pbxTerminateInferenceWorker();
        engine.browserRuntime = null;
        engine.model = null;
        engine.runtimeKind = "error";
        engine.lastError = String(error && error.message ? error.message : error || "browser worker runtime failed");
        setEngineStatus("error", getRuntimeModelLabel(), getLocalStatusMessage("error"));
      }
      return engine;
    })().finally(() => {
      engine.loading = null;
    });
    return engine.loading;
  }

  function pbxRuntimeTimeouts() {
    const askedUserCount = state.history.filter((entry) => entry && entry.role === "user").length;
    const isFirstTurn = askedUserCount <= 1;
    return {
      isFirstTurn,
      modelMs: isFirstTurn ? 120000 : 45000,
      replyMs: isFirstTurn ? 140000 : 60000,
    };
  }

  async function generateReasonedChatReply(prompt, language) {
    try {
      await ensureEngineReady();
    } catch (error) {
      engine.lastError = String(error && error.message ? error.message : error || "browser worker runtime init failed");
      return "";
    }
    if (!engine.model || !engine.inferenceWorker) return "";

    const promptVariant = buildBrowserModelPrompt(prompt, language);
    const profiles = [
      { maxNewTokens: 48, temperature: 0.35, topK: 14, topP: 0.88 },
      { maxNewTokens: 64, temperature: 0.42, topK: 18, topP: 0.90 },
    ];

    for (const profile of profiles) {
      try {
        const result = await pbxWorkerRequest(engine.inferenceWorker, "generate", {
          prompt: promptVariant,
          options: profile,
        }, pbxRuntimeTimeouts().modelMs);
        const cleaned = cleanupBrowserModelReply(result && result.text ? result.text : "", prompt);
        if (!cleaned) continue;
        if (pbxLooksBrokenText(cleaned)) continue;
        if (!isLanguageCompatible(cleaned, language)) continue;
        if (normalizeDialogueText(cleaned) === normalizeDialogueText(lastAssistantText(state.history))) continue;
        return cleaned;
      } catch (error) {
        engine.lastError = String(error && error.message ? error.message : error || "browser worker reply failed");
      }
    }
    return "";
  }

  async function tryModelFirstReply(prompt, language) {
    const loweredPrompt = lower(prompt);
    if (!trim(prompt)) return "";
    if (isWebsiteSearchPrompt(loweredPrompt) || isWeatherQuestion(loweredPrompt)) return "";
    const generated = await generateReasonedChatReply(prompt, language);
    const cleaned = cleanupBrowserModelReply(generated, prompt);
    if (!cleaned) return "";
    if (pbxLooksBrokenText(cleaned)) return "";
    if (!isLanguageCompatible(cleaned, language)) return "";
    return cleaned;
  }

  const PBX_INSTALL_DB_NAME = "pb_install_db_v1";
  const PBX_INSTALL_STORE = "handles";
  const PBX_INSTALL_KEY = "purple_bee_assets_dir";
  const PBX_RUNTIME_DB_NAME = "pb_runtime_assets_v1";
  const PBX_RUNTIME_STORE = "packages";

  function pbxOpenInstallDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PBX_INSTALL_DB_NAME, 1);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(PBX_INSTALL_STORE)) {
          db.createObjectStore(PBX_INSTALL_STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("install-db-open-failed")); };
    });
  }

  async function pbxInstallStoreGet(key) {
    const db = await pbxOpenInstallDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PBX_INSTALL_STORE, "readonly");
      const store = tx.objectStore(PBX_INSTALL_STORE);
      const request = store.get(key);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("install-db-get-failed")); };
    });
  }

  async function pbxInstallStoreSet(key, value) {
    const db = await pbxOpenInstallDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PBX_INSTALL_STORE, "readwrite");
      const store = tx.objectStore(PBX_INSTALL_STORE);
      const request = store.put(value, key);
      request.onsuccess = function () { resolve(true); };
      request.onerror = function () { reject(request.error || new Error("install-db-set-failed")); };
    });
  }

  function pbxOpenRuntimeDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PBX_RUNTIME_DB_NAME, 1);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(PBX_RUNTIME_STORE)) {
          db.createObjectStore(PBX_RUNTIME_STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("runtime-db-open-failed")); };
    });
  }

  async function pbxRuntimeStoreGet(key) {
    const db = await pbxOpenRuntimeDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PBX_RUNTIME_STORE, "readonly");
      const store = tx.objectStore(PBX_RUNTIME_STORE);
      const request = store.get(key);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error || new Error("runtime-db-get-failed")); };
    });
  }

  async function pbxRuntimeStoreSet(key, value) {
    const db = await pbxOpenRuntimeDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PBX_RUNTIME_STORE, "readwrite");
      const store = tx.objectStore(PBX_RUNTIME_STORE);
      const request = store.put(value, key);
      request.onsuccess = function () { resolve(true); };
      request.onerror = function () { reject(request.error || new Error("runtime-db-set-failed")); };
    });
  }

  async function pbxRuntimeStoreDelete(key) {
    const db = await pbxOpenRuntimeDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PBX_RUNTIME_STORE, "readwrite");
      const store = tx.objectStore(PBX_RUNTIME_STORE);
      const request = store.delete(key);
      request.onsuccess = function () { resolve(true); };
      request.onerror = function () { reject(request.error || new Error("runtime-db-delete-failed")); };
    });
  }

  async function pbxGetInstalledRuntimePackage(modelId) {
    try {
      const payload = await pbxRuntimeStoreGet(String(modelId || "purple-bee-1-3"));
      return payload || null;
    } catch (_error) {
      return null;
    }
  }

  async function pbxSaveInstalledRuntimePackage(modelId, payload) {
    await pbxRuntimeStoreSet(String(modelId || "purple-bee-1-3"), payload);
    engine.installedPackage = payload || null;
    return true;
  }

  async function pbxDeleteInstalledRuntimePackage(modelId) {
    await pbxRuntimeStoreDelete(String(modelId || "purple-bee-1-3"));
    engine.installedPackage = null;
    return true;
  }

  async function pbxLoadAssetsDirectoryHandle() {
    try {
      return await pbxInstallStoreGet(PBX_INSTALL_KEY);
    } catch (_error) {
      return null;
    }
  }

  async function pbxSaveAssetsDirectoryHandle(handle) {
    try {
      await pbxInstallStoreSet(PBX_INSTALL_KEY, handle);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function pbxCheckHandlePermission(handle, writable = false) {
    if (!handle || typeof handle.queryPermission !== "function") return "denied";
    const options = { mode: writable ? "readwrite" : "read" };
    try {
      return await handle.queryPermission(options);
    } catch (_error) {
      return "denied";
    }
  }

  function pbxFormatMb(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return "-";
    return `${Math.round(number)} MB`;
  }

  function fileNameFromUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw, window.location.origin);
      const pathname = String(parsed.pathname || "");
      const last = pathname.split("/").filter(Boolean).pop() || "";
      return decodeURIComponent(last);
    } catch (_error) {
      const cleaned = raw.split("#")[0].split("?")[0];
      const last = cleaned.split("/").filter(Boolean).pop() || "";
      return last;
    }
  }

  function pbxGetInstallPreset(modelId) {
    return MODEL_INSTALL_PRESETS[String(modelId || "").trim()] || {
      download_bytes: 445315993,
      minimum: {
        memory_gb: 8,
        cpu_threads: 6,
        free_storage_mb: 1600,
      },
      recommended: {
        memory_gb: 16,
        cpu_threads: 10,
        free_storage_mb: 2800,
      },
    };
  }

  function pbxRequirementMark(ok) {
    return ok ? '<span class="pbx-assets-spec-check ok">✓</span>' : '<span class="pbx-assets-spec-check no">✕</span>';
  }

  function pbxSetAssetsProgress(label, percent, detail = "") {
    const fill = document.getElementById("pbx-assets-progress-fill");
    const text = document.getElementById("pbx-assets-progress-text");
    const sub = document.getElementById("pbx-assets-progress-sub");
    const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
    if (fill) fill.style.width = `${safePercent}%`;
    if (text) text.textContent = `${Math.round(safePercent)}%`;
    if (sub) sub.textContent = detail ? `${label} · ${detail}` : label;
  }

  async function pbxDetectDeviceProfile(plan) {
    const storage = (navigator.storage && navigator.storage.estimate)
      ? await navigator.storage.estimate().catch(() => null)
      : null;
    const freeBytes = Number(storage && storage.quota ? (storage.quota - (storage.usage || 0)) : 0);
    const freeStorageMb = Math.max(0, Math.floor(freeBytes / (1024 * 1024)));
    const memoryGb = Number(navigator.deviceMemory || 0);
    const cpuThreads = Number(navigator.hardwareConcurrency || 0);
    const preset = pbxGetInstallPreset(plan?.model_id || getSelectedInstallModelId());
    const minimum = {
      memory_gb: preset.minimum.memory_gb,
      cpu_threads: preset.minimum.cpu_threads,
      free_storage_mb: preset.minimum.free_storage_mb,
      ...(plan?.requirements?.minimum || {}),
    };
    const recommended = {
      memory_gb: preset.recommended.memory_gb,
      cpu_threads: preset.recommended.cpu_threads,
      free_storage_mb: preset.recommended.free_storage_mb,
      ...(plan?.requirements?.recommended || {}),
    };
    const featureSupport = {
      worker: typeof Worker !== "undefined",
      indexedDb: typeof indexedDB !== "undefined",
      directoryPicker: typeof window.showDirectoryPicker === "function",
    };
    const meetsMinimum = (
      featureSupport.worker &&
      featureSupport.indexedDb &&
      memoryGb >= Number(minimum.memory_gb || 0) &&
      cpuThreads >= Number(minimum.cpu_threads || 0) &&
      freeStorageMb >= Number(minimum.free_storage_mb || 0)
    );
    const meetsRecommended = (
      meetsMinimum &&
      memoryGb >= Number(recommended.memory_gb || 0) &&
      cpuThreads >= Number(recommended.cpu_threads || 0) &&
      freeStorageMb >= Number(recommended.free_storage_mb || 0)
    );

    return {
      memoryGb,
      cpuThreads,
      freeStorageMb,
      selectedModelId: String(plan?.model_id || getSelectedInstallModelId() || ""),
      selectedModelLabel: String(plan?.display_name || getInstallModelMeta().display_name || "선택한 모델"),
      featureSupport,
      minimum,
      recommended,
      meetsMinimum,
      meetsRecommended,
      tier: !featureSupport.worker || !featureSupport.indexedDb ? "unsupported" : meetsRecommended ? "recommended" : meetsMinimum ? "minimum" : "low",
    };
  }

  async function pbxProbeAssetBytes(url) {
    const cacheKey = `asset-size:${url}`;
    if (DEVICE_CACHE.has(cacheKey)) return DEVICE_CACHE.get(cacheKey);
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (!response.ok) throw new Error(`head-${response.status}`);
      const bytes = Number(response.headers.get("content-length") || response.headers.get("x-linked-size") || 0);
      DEVICE_CACHE.set(cacheKey, bytes);
      return bytes;
    } catch (_error) {
      DEVICE_CACHE.set(cacheKey, 0);
      return 0;
    }
  }

  async function pbxBuildRuntimeAssetState(plan) {
    const cacheKey = `runtime-assets:${String(plan?.model_id || "")}:${String(plan?.asset_version || "")}`;
    if (DEVICE_CACHE.has(cacheKey)) {
      return DEVICE_CACHE.get(cacheKey);
    }
    const manifest = await pbxFetchRuntimeManifest(plan);
    const browserAssets = manifest?.browser_assets || {};
    const descriptors = [
      {
        role: "onnx",
        url: String(browserAssets.onnx || "").trim(),
        description: "메인 추론 모델 파일",
        kind: "runtime-model",
      },
      {
        role: "onnx_data",
        url: String(browserAssets.onnx_data || "").trim(),
        description: "대형 모델 가중치 데이터",
        kind: "runtime-model-data",
      },
      {
        role: "tokenizer",
        url: String(browserAssets.tokenizer || "").trim(),
        description: "문장을 토큰으로 바꾸는 토크나이저",
        kind: "runtime-tokenizer",
      },
    ].filter((item) => item.url);
    const assets = [];
    let totalBytes = 0;
    for (const item of descriptors) {
      const bytes = await pbxProbeAssetBytes(item.url);
      totalBytes += Number(bytes || 0);
      assets.push({
        ...item,
        filename: fileNameFromUrl(item.url) || `${item.role}.bin`,
        bytes,
      });
    }
    const payload = {
      manifest,
      assets,
      totalBytes,
      totalMb: Math.round(totalBytes / (1024 * 1024)),
    };
    DEVICE_CACHE.set(cacheKey, payload);
    return payload;
  }

  async function pbxReadRuntimeBlob(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`runtime-asset-${response.status}`);
    }
    return await response.blob();
  }

  async function pbxReadRuntimeBlobWithProgress(url, onProgress) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`runtime-asset-${response.status}`);
    }
    const total = Number(response.headers.get("content-length") || 0);
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) {
      const blob = await response.blob();
      if (typeof onProgress === "function") onProgress(blob.size, blob.size || total || 1);
      return blob;
    }
    let loaded = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        if (typeof onProgress === "function") onProgress(loaded, total || loaded || 1);
      }
    }
    return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
  }

  async function pbxFetchRuntimeManifest(plan) {
    const response = await fetch(`/api/runtime/browser-manifest?model_id=${encodeURIComponent(plan?.model_id || "purple-bee-1-3")}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`browser-manifest-${response.status}`);
    return await response.json();
  }

  async function pbxWriteBlobFile(handle, filename, blob) {
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function pbxRemoveFolderAssetFile(handle, filename) {
    if (!handle || !filename || typeof handle.removeEntry !== "function") return;
    try {
      await handle.removeEntry(filename);
    } catch (_error) {
      // Ignore missing files.
    }
  }

  async function pbxLoadRuntimePackageState(plan) {
    const modelId = String(plan?.model_id || (getSelectedRuntimeModelId ? getSelectedRuntimeModelId() : "purple-bee-1-3"));
    const saved = await pbxGetInstalledRuntimePackage(modelId);
    if (!saved || !saved.manifest || !saved.assets || !saved.assets.onnx || !saved.assets.tokenizer) {
      return { installed: false, reason: "runtime-missing", packageState: saved };
    }
    const requiresExternalData = Boolean(saved?.manifest?.browser_assets?.onnx_data);
    if (requiresExternalData && !saved?.assets?.onnx_data) {
      return { installed: false, reason: "runtime-extra-asset-missing", packageState: saved };
    }
    const installedVersion = pbxNormalizeVersionTag(saved.asset_version);
    const latestVersion = pbxNormalizeVersionTag(plan?.asset_version);
    return {
      installed: true,
      needsUpdate: Boolean(latestVersion && installedVersion && latestVersion !== installedVersion),
      packageState: saved,
      assetVersion: installedVersion || latestVersion,
    };
  }

  function pbxTerminateInferenceWorker() {
    try {
      if (engine.inferenceWorker) engine.inferenceWorker.terminate();
    } catch (_error) {}
    engine.inferenceWorker = null;
    engine.inferenceWorkerPromise = null;
  }

  function pbxWorkerRequest(worker, type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = `req_${Date.now()}_${++engine.inferenceRequestId}`;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${type}-timeout`));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      }

      function onError(event) {
        cleanup();
        reject(new Error(event?.message || `${type}-worker-error`));
      }

      function onMessage(event) {
        const data = event && event.data && typeof event.data === "object" ? event.data : {};
        if (String(data?.payload?.requestId || data?.requestId || "") !== requestId) return;
        cleanup();
        if (data.type === "error") {
          reject(new Error(String(data?.payload?.message || "worker-error")));
          return;
        }
        resolve(data.payload || {});
      }

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ type, requestId, payload });
    });
  }

  async function pbxEnsureInferenceWorker(plan) {
    if (engine.inferenceWorker && engine.inferenceWorkerPromise) {
      return engine.inferenceWorkerPromise;
    }
    const runtimeState = await pbxLoadRuntimePackageState(plan);
    if (!runtimeState.installed) {
      throw new Error(runtimeState.reason || "runtime-missing");
    }
    const pkg = runtimeState.packageState;
    const worker = new Worker(`/static/purple-bee-inference-worker.js?v=20260407a`);
    engine.inferenceWorker = worker;
    engine.inferenceWorkerPromise = pbxWorkerRequest(worker, "init", {
      manifest: pkg.manifest,
      assets: {
        onnx: pkg.assets.onnx,
        tokenizer: pkg.assets.tokenizer,
        onnx_data: pkg.assets.onnx_data || null,
      },
    }, 120000).then((result) => {
      engine.runtimeKind = "browser-worker-runtime";
      engine.model = { kind: "browser-worker-runtime", modelId: pkg.model_id || "purple-bee-1-3" };
      engine.lastError = "";
      return result;
    }).catch((error) => {
      pbxTerminateInferenceWorker();
      engine.runtimeKind = "error";
      engine.model = null;
      engine.lastError = String(error && error.message ? error.message : error || "worker-init-failed");
      throw error;
    });
    return engine.inferenceWorkerPromise;
  }

  async function pbxWriteInstallManifest(handle) {
    const fileHandle = await handle.getFileHandle("purple-bee-package.json", { create: true });
    const writable = await fileHandle.createWritable();
    const installMeta = getInstallModelMeta();
    const payload = {
      family_name: "Purple Bee",
      model_id: installMeta.id || "purple-bee-1-3",
      display_name: installMeta.display_name || "Purple Bee",
      runtime_mode: "public-server-runtime",
      linked_at: new Date().toISOString(),
      website_origin: window.location.origin,
      note: "This folder is linked as the Purple Bee AI assets folder for this browser.",
    };
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
  }

  async function pbxReadJsonFile(handle, filename) {
    try {
      const fileHandle = await handle.getFileHandle(filename);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text || "{}");
    } catch (_error) {
      return null;
    }
  }

  function pbxNormalizeVersionTag(value) {
    return String(value || "").trim();
  }

  async function pbxVerifyAssetsFolder(handle, repairPermission = false) {
    if (!handle) return { installed: false, reason: "missing-handle" };
    let permission = await pbxCheckHandlePermission(handle, false);
    if (permission !== "granted") {
      if (repairPermission && typeof handle.requestPermission === "function") {
        try {
          permission = await handle.requestPermission({ mode: "readwrite" });
        } catch (_error) {
          permission = "denied";
        }
      }
      if (permission !== "granted") {
        return { installed: false, reason: "permission-needed" };
      }
    }
    try {
      const manifestHandle = await handle.getFileHandle("purple-bee-package.json");
      const file = await manifestHandle.getFile();
      const text = await file.text();
      const payload = JSON.parse(text || "{}");
      if (String(payload.family_name || "").trim() !== "Purple Bee") {
        return { installed: false, reason: "invalid-manifest" };
      }
      const assetsIndex = await pbxReadJsonFile(handle, "purple-bee-assets-index.json");
      return {
        installed: true,
        manifest: payload,
        assetsIndex,
        assetVersion: pbxNormalizeVersionTag(payload.asset_version || assetsIndex?.asset_version),
      };
    } catch (_error) {
      return { installed: false, reason: "manifest-missing" };
    }
  }

  function pbxInstallGuideText(reason) {
    const ko = {
      unsupported: "이 브라우저에서는 AI 준비물 폴더 확인 기능을 지원하지 않아요. 최신 Edge에서 접속해 주세요.",
      "runtime-missing": "이 기기에 Purple Bee 준비물이 아직 설치되지 않았어요. 상단의 'AI 준비물' 버튼을 눌러 먼저 설치해 주세요.",
      "runtime-extra-asset-missing": "모델을 실행하는 데 필요한 추가 가중치 파일이 빠져 있어요. 상단의 'AI 준비물' 버튼에서 업데이트를 한 번 다시 눌러 주세요.",
      "no-folder-linked": "AI 준비물 폴더가 아직 연결되지 않았어요. 상단의 'AI 준비물' 버튼을 눌러 폴더를 연결하면 설치 상태를 더 쉽게 관리할 수 있어요.",
      "permission-needed": "AI 준비물 폴더 권한이 끊어졌어요. 다만 브라우저 안에 설치된 모델은 그대로일 수 있으니, 필요하면 상단의 'AI 준비물' 버튼으로 다시 연결해 주세요.",
      "manifest-missing": "선택한 폴더에 Purple Bee 설치 마커가 없어요. 상단의 'AI 준비물' 버튼으로 다시 연결해 주세요.",
      "invalid-manifest": "연결된 폴더가 Purple Bee 준비물 폴더가 아니에요. 올바른 폴더를 다시 연결해 주세요.",
      default: "AI 준비물 상태를 확인하지 못했어요. 상단의 'AI 준비물' 버튼을 눌러 확인해 주세요.",
    };
    return ko[reason] || ko.default;
  }

  function pbxResolveInstallState(plan, verify, deviceProfile) {
    const latestVersion = pbxNormalizeVersionTag(plan?.asset_version);
    if (deviceProfile && deviceProfile.tier === "unsupported") {
      return {
        kind: "error",
        title: "이 환경에서는 준비를 진행하기 어려워요",
        body: "Worker 또는 IndexedDB를 사용할 수 없어 설치를 완료하기 어려워요. 최신 Edge 또는 Chrome에서 다시 열어 주세요.",
        cta: "지원 필요",
        needsUpdate: false,
        installed: false,
        canDelete: false,
      };
    }

    if (deviceProfile && deviceProfile.tier === "low") {
      return {
        kind: "warn",
        title: "최소 사양에 가까운 환경이에요",
        body: "설치는 진행할 수 있지만 첫 준비 시간과 긴 답변 생성이 더 느릴 수 있어요. 메모리 여유를 조금 확보하면 더 안정적입니다.",
        cta: "저사양",
        needsUpdate: false,
        installed: false,
        canDelete: false,
      };
    }

    if (!verify || !verify.installed) {
      if (verify?.reason === "runtime-extra-asset-missing") {
        return {
          kind: "warn",
          title: "추가 자산 업데이트가 필요해요",
          body: pbxInstallGuideText("runtime-extra-asset-missing"),
          cta: "업데이트 필요",
          needsUpdate: true,
          installed: false,
          canDelete: true,
        };
      }
      return {
        kind: "warn",
        title: "아직 설치가 완료되지 않았어요",
        body: pbxInstallGuideText(verify?.reason || "no-folder-linked"),
        cta: "설치 필요",
        needsUpdate: false,
        installed: false,
        canDelete: false,
      };
    }

    const installedVersion = pbxNormalizeVersionTag(verify.assetVersion || verify.manifest?.asset_version);
    if (latestVersion && installedVersion && latestVersion !== installedVersion) {
      return {
        kind: "warn",
        title: "새 준비물이 배포되어 있어요",
        body: `현재 설치된 자산은 ${installedVersion} 버전이고, 사이트에서 제공하는 최신 자산은 ${latestVersion} 버전이에요. 업데이트를 누르면 필요한 파일만 다시 내려받아 최신 상태로 맞춥니다.`,
        cta: "업데이트 필요",
        needsUpdate: true,
        installed: true,
        canDelete: true,
      };
    }

    return {
      kind: "ok",
      title: "최신 준비물이 설치되어 있어요",
      body: "선택한 모델에 필요한 자산이 이미 이 기기에 설치되어 있고 현재 배포 버전과도 일치합니다. 지금은 다시 설치할 필요가 없어요.",
      cta: "최신 상태",
      needsUpdate: false,
      installed: true,
      canDelete: true,
    };
  }

  async function pbxEnsureAiAssetsInstalled(repairPermission = false, modelId = null) {
    if (!("indexedDB" in window)) {
      return { installed: false, reason: "unsupported" };
    }
    const plan = await pbxFetchPackagePlan(modelId).catch(() => null);
    const runtimeState = await pbxLoadRuntimePackageState(plan);
    if (!runtimeState.installed) {
      return { installed: false, reason: runtimeState.reason || "runtime-missing", runtimeState };
    }
    const handle = await pbxLoadAssetsDirectoryHandle();
    if (!handle) {
      return { installed: true, reason: "no-folder-linked", runtimeState, folderLinked: false };
    }
    const folderState = await pbxVerifyAssetsFolder(handle, repairPermission);
    return {
      installed: true,
      reason: folderState.installed ? "" : folderState.reason || "",
      runtimeState,
      folderState,
      folderLinked: folderState.installed,
      assetVersion: runtimeState.assetVersion,
      packageState: runtimeState.packageState,
    };
  }

  async function linkAiAssetsFolder() {
    if (!("showDirectoryPicker" in window)) {
      showToast(getActiveUiLanguage() === "ko"
        ? "이 브라우저에서는 폴더 연결 기능을 지원하지 않아요."
        : "This browser does not support folder linking.");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "purple-bee-assets-folder" });
      const writePermission = await pbxCheckHandlePermission(handle, true);
      if (writePermission !== "granted" && typeof handle.requestPermission === "function") {
        const requested = await handle.requestPermission({ mode: "readwrite" });
        if (requested !== "granted") {
          showToast(getActiveUiLanguage() === "ko" ? "폴더 권한이 필요해요." : "Folder permission is required.");
          return;
        }
      }
      await pbxWriteInstallManifest(handle);
      await pbxSaveAssetsDirectoryHandle(handle);
      showToast(getActiveUiLanguage() === "ko"
        ? "AI 준비물 폴더를 연결했어요."
        : "The AI assets folder is now linked.");
    } catch (_error) {
      showToast(getActiveUiLanguage() === "ko"
        ? "AI 준비물 폴더 연결을 취소했어요."
        : "AI assets folder linking was cancelled.");
    }
  }

  async function pbxFetchPackagePlan(modelId = null) {
    const resolvedModelId = trim(modelId || "") || (getSelectedInstallModelId ? getSelectedInstallModelId() : "purple-bee-1-3");
    const response = await fetch(`/api/runtime/package-plan?model_id=${encodeURIComponent(resolvedModelId)}`, {
      cache: "no-store",
      headers: { "accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`package-plan-${response.status}`);
    }
    return await response.json();
  }

  async function pbxWriteTextFile(handle, filename, content) {
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(String(content || ""));
    await writable.close();
  }

  async function pbxWriteJsonFile(handle, filename, payload) {
    await pbxWriteTextFile(handle, filename, JSON.stringify(payload, null, 2));
  }

  async function pbxFetchTextAsset(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`asset-fetch-${response.status}`);
    }
    return await response.text();
  }

  async function pbxInstallAssetsToFolder(handle, plan, runtimeManifest = null, runtimeAssets = null) {
    const installedAt = new Date().toISOString();
    const installMeta = getInstallModelMeta();
    const modelId = String(plan?.model_id || installMeta.id || "purple-bee-1-3");
    const displayName = String(plan?.display_name || installMeta.display_name || "Purple Bee");
    const manifest = {
      family_name: "Purple Bee",
      model_id: modelId,
      display_name: displayName,
      runtime_mode: "browser-worker-runtime",
      linked_at: installedAt,
      installed_at: installedAt,
      asset_version: String(plan?.asset_version || "current"),
      website_origin: window.location.origin,
      backend_mode: plan?.backend?.configured ? "public-purple-bee-backend" : "worker-server-runtime",
      note: "This folder stores the Purple Bee install metadata and mirrored runtime assets for this browser.",
    };
    await pbxWriteJsonFile(handle, "purple-bee-package.json", manifest);

    const generatedAssets = (plan && typeof plan.generated_assets === "object" && plan.generated_assets) || {};
    for (const [filename, payload] of Object.entries(generatedAssets)) {
      if (typeof payload === "string") {
        await pbxWriteTextFile(handle, filename, payload);
      } else {
        await pbxWriteJsonFile(handle, filename, payload);
      }
    }

    const written = [];
    const assets = Array.isArray(plan?.assets) ? plan.assets : [];
    for (const asset of assets) {
      if (!asset || !asset.filename || String(asset.filename) === "purple-bee-package.json") continue;
      if (runtimeManifest && asset.filename === "purple-bee-browser-manifest.json") {
        await pbxWriteJsonFile(handle, asset.filename, runtimeManifest);
        written.push({ filename: asset.filename, kind: asset.kind, generated: true });
      } else if (String(asset.kind || "").startsWith("download-") && asset.url) {
        const text = await pbxFetchTextAsset(asset.url);
        await pbxWriteTextFile(handle, asset.filename, text);
        written.push({ filename: asset.filename, kind: asset.kind, url: asset.url });
      } else if (String(asset.kind || "").startsWith("generated-")) {
        written.push({ filename: asset.filename, kind: asset.kind, generated: true });
      }
    }

    const runtimeBrowserAssets = runtimeManifest?.browser_assets || {};
    if (runtimeAssets && runtimeAssets.onnx && runtimeBrowserAssets.onnx) {
      const onnxName = fileNameFromUrl(runtimeBrowserAssets.onnx) || "model.onnx";
      await pbxWriteBlobFile(handle, onnxName, runtimeAssets.onnx);
      written.push({ filename: onnxName, kind: "runtime-model", bytes: runtimeAssets.onnx.size || 0 });
    }
    if (runtimeAssets && runtimeAssets.onnx_data && runtimeBrowserAssets.onnx_data) {
      const onnxDataName = fileNameFromUrl(runtimeBrowserAssets.onnx_data) || "model.onnx.data";
      await pbxWriteBlobFile(handle, onnxDataName, runtimeAssets.onnx_data);
      written.push({ filename: onnxDataName, kind: "runtime-model-data", bytes: runtimeAssets.onnx_data.size || 0 });
    }
    if (runtimeAssets && runtimeAssets.tokenizer && runtimeBrowserAssets.tokenizer) {
      const tokenizerName = fileNameFromUrl(runtimeBrowserAssets.tokenizer) || "tokenizer.json";
      await pbxWriteBlobFile(handle, tokenizerName, runtimeAssets.tokenizer);
      written.push({ filename: tokenizerName, kind: "runtime-tokenizer", bytes: runtimeAssets.tokenizer.size || 0 });
    }

    await pbxWriteJsonFile(handle, "purple-bee-assets-index.json", {
      family_name: "Purple Bee",
      model_id: modelId,
      display_name: displayName,
      installed_at: installedAt,
      asset_version: String(plan?.asset_version || "current"),
      install_mode: String(plan?.install_mode || "public-server-runtime"),
      backend: plan?.backend || {},
      files: written,
    });

    return manifest;
  }

  async function pbxDeleteAssetsFromFolder(handle, plan, runtimeManifest = null) {
    if (!handle) return;
    const runtimeBrowserAssets = runtimeManifest?.browser_assets || {};
    const removableFiles = [
      "purple-bee-package.json",
      "purple-bee-assets-index.json",
      "purple-bee-endpoints.json",
      "purple-bee-release-notes.txt",
      "purple-bee-health.json",
      "purple-bee-browser-manifest.json",
      "purple-bee-model-registry.json",
      fileNameFromUrl(runtimeBrowserAssets.onnx),
      fileNameFromUrl(runtimeBrowserAssets.onnx_data),
      fileNameFromUrl(runtimeBrowserAssets.tokenizer),
    ].filter(Boolean);
    for (const filename of Array.from(new Set(removableFiles))) {
      await pbxRemoveFolderAssetFile(handle, filename);
    }
  }

  function pbxEnsureAssetsModal() {
    let modal = document.getElementById("pbx-assets-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "pbx-assets-modal";
    modal.className = "pbx-assets-backdrop";
    modal.innerHTML = `
      <div class="pbx-assets-dialog">
        <div class="pbx-assets-header">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;width:100%">
            <div>
              <div class="pbx-assets-title">AI 준비물</div>
              <div id="pbx-assets-modal-subtitle" class="pbx-assets-subtitle">설치 여부, 업데이트 필요 여부, 예상 용량을 한 번에 확인하고 필요한 작업만 진행할 수 있어요.</div>
            </div>
            <button type="button" id="pbx-assets-modal-close" class="pbx-assets-close">×</button>
          </div>
        </div>
        <div class="pbx-assets-content">
          <div class="pbx-assets-status-card">
            <div class="pbx-assets-status-top">
              <div>
                <div id="pbx-assets-status-pill" class="pbx-assets-pill">상태 확인 중...</div>
                <div id="pbx-assets-status-title" class="pbx-assets-status-title" style="margin-top:12px">준비 상태를 확인하는 중이에요</div>
                <div id="pbx-assets-status-text" class="pbx-assets-status-body">잠시만 기다려 주세요.</div>
              </div>
            </div>
            <div class="pbx-assets-mini-grid">
              <div class="pbx-assets-mini">
                <div class="pbx-assets-mini-label">현재 모델</div>
                <div id="pbx-assets-model-name" class="pbx-assets-mini-value">Purple Bee 1.3</div>
              </div>
              <div class="pbx-assets-mini">
                <div class="pbx-assets-mini-label">설치 상태</div>
                <div id="pbx-assets-install-state" class="pbx-assets-mini-value">확인 중</div>
              </div>
              <div class="pbx-assets-mini">
                <div class="pbx-assets-mini-label">자산 버전</div>
                <div id="pbx-assets-version-state" class="pbx-assets-mini-value">확인 중</div>
              </div>
            </div>
          </div>
          <div class="pbx-assets-files-card">
            <div class="pbx-assets-files-head">
              <div>
                <div class="pbx-assets-files-title">이 기기에 설치할 모델</div>
                <div class="pbx-assets-files-sub">이 기기에 둘 모델을 선택하세요. 선택한 모델 기준으로 설치 상태와 업데이트 기준을 계산합니다.</div>
              </div>
            </div>
            <div id="pbx-assets-model-picker" class="pbx-assets-model-picker"></div>
          </div>
          <div class="pbx-assets-files-card">
            <div class="pbx-assets-files-head">
              <div>
                <div class="pbx-assets-files-title">이 기기 상태</div>
                <div id="pbx-assets-device-summary" class="pbx-assets-files-sub">브라우저가 확인할 수 있는 실행 환경 정보를 바탕으로 설치 가능성을 점검하는 중이에요.</div>
              </div>
              <div id="pbx-assets-device-pill" class="pbx-assets-help">확인 중</div>
            </div>
            <div class="pbx-assets-mini-grid">
              <div class="pbx-assets-mini">
                <div class="pbx-assets-mini-label">확인된 메모리</div>
                <div id="pbx-assets-memory" class="pbx-assets-mini-value">-</div>
              </div>
              <div class="pbx-assets-mini">
                <div class="pbx-assets-mini-label">확인된 CPU 스레드</div>
                <div id="pbx-assets-cpu" class="pbx-assets-mini-value">-</div>
              </div>
              <div class="pbx-assets-mini">
                <div class="pbx-assets-mini-label">남은 저장 공간</div>
                <div id="pbx-assets-storage" class="pbx-assets-mini-value">-</div>
              </div>
            </div>
            <div id="pbx-assets-spec-grid" class="pbx-assets-spec-grid"></div>
            <div class="pbx-assets-help">정확한 CPU·GPU·RAM 모델명은 브라우저만으로 모두 읽을 수 없어요. 실제 부품 기준 평가는 기여 구독용 데스크톱 클라이언트에서 확인합니다.</div>
            <div class="pbx-assets-progress">
              <div class="pbx-assets-progress-head">
                <div>
                  <div class="pbx-assets-progress-title">설치 진행 상태</div>
                  <div id="pbx-assets-progress-sub" class="pbx-assets-progress-sub">아직 설치를 시작하지 않았어요.</div>
                </div>
                <div id="pbx-assets-progress-text" class="pbx-assets-help">0%</div>
              </div>
              <div class="pbx-assets-progress-bar">
                <div id="pbx-assets-progress-fill" class="pbx-assets-progress-fill"></div>
              </div>
            </div>
          </div>
          <div class="pbx-assets-files-card">
            <div class="pbx-assets-files-head">
              <div>
                <div class="pbx-assets-files-title">이번에 준비되는 파일</div>
                <div id="pbx-assets-model-summary" class="pbx-assets-files-sub"></div>
              </div>
              <div id="pbx-assets-download-estimate" class="pbx-assets-help">다운로드 크기를 계산하는 중이에요.</div>
            </div>
            <div id="pbx-assets-list" class="pbx-assets-list"></div>
          </div>
        </div>
        <div class="pbx-assets-actions" style="padding:0 24px 24px">
          <button type="button" id="pbx-assets-choose-btn" class="pbx-assets-btn">폴더 연결</button>
          <button type="button" id="pbx-assets-delete-btn" class="pbx-assets-btn">준비물 삭제</button>
          <button type="button" id="pbx-assets-install-btn" class="pbx-assets-btn primary">준비물 설치</button>
        </div>
      </div>
    `;
    modal.addEventListener("click", function (event) {
      if (event.target === modal) {
        pbxCloseAssetsSetupModal();
      }
    });
    document.body.appendChild(modal);
    document.getElementById("pbx-assets-modal-close").onclick = function () { pbxCloseAssetsSetupModal(); };
    document.getElementById("pbx-assets-choose-btn").onclick = async function () { await pbxChooseAssetsFolderFromModal(); };
    document.getElementById("pbx-assets-delete-btn").onclick = async function () { await pbxDeleteAssetsFromModal(); };
    document.getElementById("pbx-assets-install-btn").onclick = async function () { await pbxInstallAssetsFromModal(); };
    return modal;
  }

  function pbxCloseAssetsSetupModal() {
    const modal = document.getElementById("pbx-assets-modal");
    if (modal) modal.classList.remove("open");
  }

  function pbxSetAssetsModalStatus(kind, title, text) {
    const pill = document.getElementById("pbx-assets-status-pill");
    const heading = document.getElementById("pbx-assets-status-title");
    const body = document.getElementById("pbx-assets-status-text");
    if (!pill || !body || !heading) return;
    const palette = {
      loading: { bg: "rgba(124,92,255,.12)", color: "var(--accent-light)" },
      ok: { bg: "rgba(16,185,129,.12)", color: "var(--green)" },
      warn: { bg: "rgba(245,158,11,.12)", color: "var(--yellow)" },
      error: { bg: "rgba(239,68,68,.12)", color: "var(--red)" },
    };
    const chosen = palette[kind] || palette.loading;
    pill.style.background = chosen.bg;
    pill.style.color = chosen.color;
    pill.textContent = kind === "ok" ? "준비 완료" : kind === "warn" ? "확인 필요" : kind === "error" ? "문제 발생" : "확인 중";
    heading.textContent = title || "";
    body.textContent = text;
  }

  function pbxRenderDeviceProfile(profile) {
    const summary = document.getElementById("pbx-assets-device-summary");
    const pill = document.getElementById("pbx-assets-device-pill");
    const memory = document.getElementById("pbx-assets-memory");
    const cpu = document.getElementById("pbx-assets-cpu");
    const storage = document.getElementById("pbx-assets-storage");
    const specGrid = document.getElementById("pbx-assets-spec-grid");
    if (memory) memory.textContent = profile?.memoryGb ? `${profile.memoryGb} GB` : "확인되지 않음";
    if (cpu) cpu.textContent = profile?.cpuThreads ? `${profile.cpuThreads} threads` : "확인되지 않음";
    if (storage) storage.textContent = pbxFormatMb(profile?.freeStorageMb);
    if (!summary || !pill) return;

    if (!profile) {
      summary.textContent = "이 기기 상태를 아직 확인하지 못했어요.";
      pill.textContent = "확인 중";
      return;
    }

    if (specGrid) {
      const currentRows = [
        { label: "메모리", value: profile.memoryGb ? `${profile.memoryGb} GB` : "알 수 없음", ok: profile.memoryGb >= Number(profile.minimum.memory_gb || 0) },
        { label: "CPU 스레드", value: profile.cpuThreads ? `${profile.cpuThreads}` : "알 수 없음", ok: profile.cpuThreads >= Number(profile.minimum.cpu_threads || 0) },
        { label: "남은 저장 공간", value: pbxFormatMb(profile.freeStorageMb), ok: profile.freeStorageMb >= Number(profile.minimum.free_storage_mb || 0) },
      ];
      const minimumRows = [
        { label: "메모리", value: `${profile.minimum.memory_gb} GB`, ok: currentRows[0].ok },
        { label: "CPU 스레드", value: `${profile.minimum.cpu_threads}`, ok: currentRows[1].ok },
        { label: "저장 공간", value: pbxFormatMb(profile.minimum.free_storage_mb), ok: currentRows[2].ok },
      ];
      const recommendedRows = [
        { label: "메모리", value: `${profile.recommended.memory_gb} GB`, ok: profile.memoryGb >= Number(profile.recommended.memory_gb || 0) },
        { label: "CPU 스레드", value: `${profile.recommended.cpu_threads}`, ok: profile.cpuThreads >= Number(profile.recommended.cpu_threads || 0) },
        { label: "저장 공간", value: pbxFormatMb(profile.recommended.free_storage_mb), ok: profile.freeStorageMb >= Number(profile.recommended.free_storage_mb || 0) },
      ];
      const cards = [
        { title: "현재 기기에서 확인된 값", rows: currentRows },
        { title: "최소 사양", rows: minimumRows },
        { title: "권장 사양", rows: recommendedRows },
      ];
      specGrid.innerHTML = cards.map((card) => `
        <div class="pbx-assets-spec-card">
          <div class="pbx-assets-spec-title">${card.title}</div>
          ${card.rows.map((row) => `
            <div class="pbx-assets-spec-row">
              <span>${row.label}</span>
              <span>${row.value} ${pbxRequirementMark(row.ok)}</span>
            </div>
          `).join("")}
        </div>
      `).join("");
    }

    if (profile.tier === "recommended") {
      pill.textContent = "권장 사양";
      summary.textContent = "선택한 모델을 준비하고 실행하기에 여유가 있는 편이에요. 실제 부품명 확인은 기여 구독용 데스크톱 클라이언트에서 지원합니다.";
      return;
    }
    if (profile.tier === "minimum") {
      pill.textContent = "최소 사양";
      summary.textContent = "실행은 가능하지만 첫 설치와 긴 답변은 더 느릴 수 있어요. 여유 자원이 적으면 설치 전에 다른 앱을 정리하는 편이 좋습니다.";
      return;
    }
    if (profile.tier === "low") {
      pill.textContent = "저사양 주의";
      summary.textContent = `최소 기준은 메모리 ${profile.minimum.memory_gb}GB / ${profile.minimum.cpu_threads}스레드 / 저장 공간 ${profile.minimum.free_storage_mb}MB예요. 현재 환경에서는 설치 또는 실행 속도가 크게 떨어질 수 있어요.`;
      return;
    }
    pill.textContent = "지원 필요";
    summary.textContent = "이 브라우저에서는 Worker 또는 저장 기능이 부족해서 설치를 진행하기 어려워요. 최신 Edge에서 다시 시도해 주세요.";
  }

  function pbxRenderModelPicker() {
    const picker = document.getElementById("pbx-assets-model-picker");
    if (!picker) return;
    const models = getRegistryModelList();
    const installId = getSelectedInstallModelId();
    const runtimeId = getSelectedRuntimeModelId();
    picker.innerHTML = models.map((model) => {
      const checked = model.id === installId;
      const isRuntime = model.id === runtimeId;
      return `
        <label class="pbx-assets-model-option ${checked ? "selected" : ""}">
          <input type="radio" name="pbx-install-model" value="${escapeHtml(model.id)}" ${checked ? "checked" : ""}>
          <div class="pbx-assets-model-option-main">
            <div class="pbx-assets-model-option-title">${escapeHtml(model.display_name || model.id || "Purple Bee")}</div>
            <div class="pbx-assets-model-option-sub">${escapeHtml(model.architecture_name || "Purple Bee runtime")}</div>
          </div>
          <div class="pbx-assets-model-option-badges">
            ${checked ? '<span class="pbx-assets-model-badge active">설치 예정</span>' : ""}
            ${isRuntime ? '<span class="pbx-assets-model-badge">현재 사용 모델</span>' : ""}
          </div>
        </label>
      `;
    }).join("");
    picker.querySelectorAll('input[name="pbx-install-model"]').forEach((input) => {
      input.addEventListener("change", async (event) => {
        const nextId = trim(event.target && event.target.value);
        if (!nextId || nextId === getSelectedInstallModelId()) return;
        setSelectedInstallModelId(nextId);
        showToast(getActiveUiLanguage() === "ko" ? "설치할 모델을 바꿨어요." : "Updated the install model.");
        await pbxOpenAssetsSetupModal("model-changed");
      });
    });
  }

  function pbxRenderAssetsList(plan, runtimeDownload = null) {
    const list = document.getElementById("pbx-assets-list");
    const summary = document.getElementById("pbx-assets-model-summary");
    const modelName = document.getElementById("pbx-assets-model-name");
    const estimate = document.getElementById("pbx-assets-download-estimate");
    if (!list || !summary) return;
    const metadataAssets = Array.isArray(plan?.assets) ? plan.assets : [];
    const runtimeAssets = Array.isArray(runtimeDownload?.assets) ? runtimeDownload.assets : [];
    const assets = [...runtimeAssets, ...metadataAssets];
    if (modelName) modelName.textContent = String(plan?.display_name || "Purple Bee");
    const totalBytes = Number(runtimeDownload?.totalBytes || plan?.download?.estimated_bytes || pbxGetInstallPreset(plan?.model_id).download_bytes || 0);
    summary.textContent = `${String(plan?.display_name || "Purple Bee")} 실행에 필요한 파일 ${assets.length}개를 확인했어요. 이번 설치 또는 업데이트 예상 용량은 ${formatBytes(totalBytes)}입니다.`;
    if (estimate) {
      estimate.textContent = runtimeAssets.length
        ? `모델 자산 예상 용량 ${formatBytes(totalBytes)} · 메타데이터는 매우 작아서 설치 시간에 큰 영향을 주지 않아요.`
        : "정확한 다운로드 크기를 계산하는 중이에요.";
    }
    list.innerHTML = assets.map((asset) => `
      <div class="pbx-assets-item">
        <div class="pbx-assets-item-icon"><i class="ph ph-file-text"></i></div>
        <div class="pbx-assets-item-main">
          <div class="pbx-assets-item-name">${String(asset.filename || "")}</div>
          <div class="pbx-assets-item-desc">${String(asset.description || "")}</div>
          <div class="pbx-assets-item-kind">${String(asset.kind || "")}${asset.bytes ? ` · ${formatBytes(Number(asset.bytes || 0))}` : ""}</div>
        </div>
      </div>
    `).join("");
  }

  async function pbxRefreshAssetsButtonState() {
    const button = document.getElementById("ai-assets-btn");
    const label = document.getElementById("ai-assets-label");
    if (!button) return;
    try {
      const plan = await pbxFetchPackagePlan(getSelectedInstallModelId());
      const status = await pbxEnsureAiAssetsInstalled(false);
      const deviceProfile = await pbxDetectDeviceProfile(plan);
      const resolved = pbxResolveInstallState(plan, status.runtimeState || status, deviceProfile);
      button.style.opacity = "1";
      button.title = resolved.body;
      if (label) {
        label.textContent = resolved.needsUpdate
          ? "업데이트 필요"
          : resolved.installed
            ? "최신 설치됨"
            : "AI 준비물";
      }
    } catch (_error) {
      button.style.opacity = ".92";
      if (label) label.textContent = "AI 준비물";
    }
  }

  async function pbxOpenAssetsSetupModal(reason = "") {
    const modal = pbxEnsureAssetsModal();
    modal.classList.add("open");
    pbxSetAssetsModalStatus("loading", "준비 상태를 확인하고 있어요", "잠시만 기다려 주세요.");
    try {
      pbxRenderModelPicker();
      const [plan, handle] = await Promise.all([
        pbxFetchPackagePlan(getSelectedInstallModelId()),
        pbxLoadAssetsDirectoryHandle(),
      ]);
      const runtimeDownload = await pbxBuildRuntimeAssetState(plan).catch(() => null);
      const enrichedPlan = {
        ...plan,
        download: {
          ...(plan?.download || {}),
          estimated_bytes: Number(runtimeDownload?.totalBytes || plan?.download?.estimated_bytes || 0),
          estimated_mb: Math.round(Number(runtimeDownload?.totalBytes || plan?.download?.estimated_bytes || 0) / (1024 * 1024)),
        },
      };
      const deviceProfile = await pbxDetectDeviceProfile(enrichedPlan).catch(() => null);
      modal._pbxPlan = enrichedPlan;
      modal._pbxRuntimeManifest = runtimeDownload?.manifest || null;
      modal._pbxRuntimeDownload = runtimeDownload || null;
      pbxRenderAssetsList(enrichedPlan, runtimeDownload);
      pbxRenderDeviceProfile(deviceProfile);
      const runtimeState = await pbxLoadRuntimePackageState(enrichedPlan);
      const folderState = handle ? await pbxVerifyAssetsFolder(handle, false) : { installed: false, reason: "no-folder-linked" };
      const resolved = pbxResolveInstallState(enrichedPlan, runtimeState, deviceProfile);
      pbxSetAssetsModalStatus(resolved.kind, resolved.title, resolved.body);
      const installState = document.getElementById("pbx-assets-install-state");
      const versionState = document.getElementById("pbx-assets-version-state");
      const installBtn = document.getElementById("pbx-assets-install-btn");
      const deleteBtn = document.getElementById("pbx-assets-delete-btn");
      if (installState) {
        installState.textContent = runtimeState.installed
          ? (folderState.installed ? "최신 설치됨 · 폴더 연결됨" : "최신 설치됨")
          : runtimeState.reason === "runtime-extra-asset-missing"
            ? "업데이트 필요"
          : "설치되지 않음";
      }
      if (versionState) {
        versionState.textContent = runtimeState.installed
          ? `설치 ${pbxNormalizeVersionTag(runtimeState.assetVersion || "-")} · 최신 ${pbxNormalizeVersionTag(enrichedPlan?.asset_version || "-")}`
          : pbxNormalizeVersionTag(enrichedPlan?.asset_version || "확인 중");
      }
      if (installBtn) {
        const alreadyLatest = resolved.installed && !resolved.needsUpdate;
        installBtn.disabled = Boolean(alreadyLatest);
        installBtn.textContent = resolved.needsUpdate
          ? "준비물 업데이트"
          : alreadyLatest
            ? "이미 최신 버전"
            : "준비물 설치";
      }
      if (deleteBtn) {
        deleteBtn.disabled = !resolved.canDelete;
      }
    } catch (_error) {
      pbxSetAssetsModalStatus("error", "준비 목록을 불러오지 못했어요", "사이트에서 최신 준비물 목록을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  async function pbxDeleteAssetsFromModal() {
    const confirmed = window.confirm(
      getActiveUiLanguage() === "ko"
        ? "현재 선택한 모델 준비물을 이 브라우저와 연결된 폴더에서 삭제할까요?"
        : "Delete the selected model assets from this browser and linked folder?"
    );
    if (!confirmed) return;
    const modal = document.getElementById("pbx-assets-modal");
    const plan = modal?._pbxPlan || await pbxFetchPackagePlan(getSelectedInstallModelId());
    const manifest = modal?._pbxRuntimeManifest || await pbxFetchRuntimeManifest(plan).catch(() => null);
    const handle = await pbxLoadAssetsDirectoryHandle();
    pbxSetAssetsModalStatus("loading", "준비물을 지우는 중이에요", "이 브라우저에 저장된 모델 데이터와 연결된 폴더의 준비물 파일을 정리하고 있어요.");
    pbxSetAssetsProgress("준비물 삭제", 8, "저장된 자산을 확인하고 있어요.");
    await pbxDeleteInstalledRuntimePackage(plan?.model_id);
    pbxTerminateInferenceWorker();
    pbxSetAssetsProgress("브라우저 저장소 정리", 62, "이 브라우저에 저장된 모델 자산을 삭제하고 있어요.");
    if (handle) {
      await pbxDeleteAssetsFromFolder(handle, plan, manifest);
    }
    pbxSetAssetsProgress("삭제 완료", 100, "이 모델의 준비물을 지웠어요.");
    await pbxRefreshAssetsButtonState();
    showToast(getActiveUiLanguage() === "ko" ? "AI 준비물을 삭제했어요." : "AI assets were removed.");
    await pbxOpenAssetsSetupModal("deleted");
  }

  async function pbxChooseAssetsFolderFromModal() {
    if (!("showDirectoryPicker" in window)) {
      pbxSetAssetsModalStatus("error", "이 브라우저에서는 지원되지 않아요", "폴더 연결 기능은 최신 Edge에서 가장 안정적으로 동작해요. 가능하면 Edge에서 다시 열어 주세요.");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "purple-bee-assets-folder" });
      const writePermission = await pbxCheckHandlePermission(handle, true);
      if (writePermission !== "granted" && typeof handle.requestPermission === "function") {
        const requested = await handle.requestPermission({ mode: "readwrite" });
        if (requested !== "granted") {
          pbxSetAssetsModalStatus("warn", "폴더 권한이 필요해요", "준비물 파일을 폴더에 넣으려면 읽기/쓰기 권한이 필요해요.");
          return;
        }
      }
      await pbxSaveAssetsDirectoryHandle(handle);
      pbxSetAssetsModalStatus("ok", "폴더를 연결했어요", "좋아요. 이 폴더는 사용자가 준비물 상태를 직접 확인하거나 업데이트할 때 쓰게 될 거예요.");
      await pbxRefreshAssetsButtonState();
      await pbxOpenAssetsSetupModal();
    } catch (_error) {
      pbxSetAssetsModalStatus("warn", "폴더 연결을 취소했어요", "괜찮아요. 다시 시도할 때는 빈 폴더나 Purple Bee 전용 폴더를 추천해요.");
    }
  }

  async function pbxInstallAssetsFromModal() {
    try {
      let handle = await pbxLoadAssetsDirectoryHandle();
      if (!handle) {
        await pbxChooseAssetsFolderFromModal();
        handle = await pbxLoadAssetsDirectoryHandle();
      }
      if (!handle) {
        pbxSetAssetsModalStatus("warn", "먼저 폴더를 연결해 주세요", "설치나 업데이트를 시작하려면 준비물 폴더가 먼저 연결되어 있어야 해요.");
        return;
      }
      const modal = document.getElementById("pbx-assets-modal");
      const plan = modal?._pbxPlan || await pbxFetchPackagePlan(getSelectedInstallModelId());
      const runtimeDownload = modal?._pbxRuntimeDownload || await pbxBuildRuntimeAssetState(plan);
      pbxSetAssetsModalStatus("loading", "준비물을 맞추는 중이에요", "모델 파일을 내려받고, 이 기기에 저장하고, 선택한 폴더와도 맞춰 두고 있어요. 첫 설치는 조금 더 걸릴 수 있어요.");
      const totalBytes = Number(runtimeDownload?.totalBytes || plan?.download?.estimated_bytes || 0);
      let completedBytes = 0;
      pbxSetAssetsProgress("준비 시작", 1, `예상 다운로드 ${formatBytes(totalBytes || 0)}`);
      const manifest = modal?._pbxRuntimeManifest || runtimeDownload?.manifest || await pbxFetchRuntimeManifest(plan);
      pbxSetAssetsProgress("설치 정보 확인", 5, "브라우저용 실행 정보를 읽고 있어요.");
      const runtimeAssetBytes = Object.fromEntries((runtimeDownload?.assets || []).map((asset) => [asset.role, Number(asset.bytes || 0)]));
      const progressFor = (label, baseBytes) => (loaded, total) => {
        const effectiveLoaded = Math.min(Number(baseBytes || 0), Number(loaded || 0));
        const dynamicTotal = totalBytes > 0 ? totalBytes : Number(total || 1);
        const current = Math.min(dynamicTotal, completedBytes + effectiveLoaded);
        pbxSetAssetsProgress(label, (current / Math.max(dynamicTotal, 1)) * 100, `${formatBytes(current)} / ${formatBytes(dynamicTotal)}`);
      };
      const onnxBlob = await pbxReadRuntimeBlobWithProgress(manifest?.browser_assets?.onnx, progressFor("모델 파일 다운로드", runtimeAssetBytes.onnx || 0));
      completedBytes += Number(onnxBlob.size || 0);
      pbxSetAssetsProgress("모델 파일 저장", (completedBytes / Math.max(totalBytes || completedBytes || 1, 1)) * 100, `${formatBytes(completedBytes)} / ${formatBytes(totalBytes || completedBytes)}`);
      const tokenizerBlob = await pbxReadRuntimeBlobWithProgress(manifest?.browser_assets?.tokenizer, progressFor("토크나이저 다운로드", runtimeAssetBytes.tokenizer || 0));
      completedBytes += Number(tokenizerBlob.size || 0);
      let onnxDataBlob = null;
      if (manifest?.browser_assets?.onnx_data) {
        onnxDataBlob = await pbxReadRuntimeBlobWithProgress(manifest.browser_assets.onnx_data, progressFor("추가 자산 다운로드", runtimeAssetBytes.onnx_data || 0));
        completedBytes += Number(onnxDataBlob.size || 0);
      }
      const installedAt = new Date().toISOString();
      const packagePayload = {
        family_name: "Purple Bee",
        model_id: String(plan?.model_id || "purple-bee-1-3"),
        display_name: String(plan?.display_name || "Purple Bee"),
        asset_version: String(plan?.asset_version || "current"),
        installed_at: installedAt,
        manifest,
        assets: {
          onnx: onnxBlob,
          tokenizer: tokenizerBlob,
          onnx_data: onnxDataBlob,
        },
      };
      pbxSetAssetsProgress("브라우저 저장소에 설치", 88, "이 기기에서 바로 쓸 수 있도록 저장하고 있어요.");
      await pbxSaveInstalledRuntimePackage(packagePayload.model_id, packagePayload);
      pbxSetAssetsProgress("폴더 동기화", 94, "선택한 폴더에도 설치 상태를 맞추는 중이에요.");
      await pbxInstallAssetsToFolder(handle, plan, manifest, packagePayload.assets);
      pbxSetAssetsProgress("실행 엔진 준비", 97, "첫 질문 전에 백그라운드 엔진이 열리는지 확인하고 있어요.");
      pbxTerminateInferenceWorker();
      await pbxEnsureInferenceWorker(plan);
      pbxSetAssetsProgress("설치 완료", 100, `총 ${formatBytes(totalBytes || completedBytes)} 설치를 마쳤어요.`);
      pbxSetAssetsModalStatus("ok", "설치/업데이트가 끝났어요", "이 기기에 모델 준비물을 저장했고, 폴더에도 설치 상태를 맞춰뒀어요. 이제 바로 질문을 이어가면 됩니다.");
      await pbxRefreshAssetsButtonState();
      showToast(getActiveUiLanguage() === "ko" ? "AI 준비물 설치가 완료됐어요." : "AI assets are ready.");
      await pbxOpenAssetsSetupModal();
    } catch (_error) {
      console.error("[Purple Bee][AI Prep] install failed", _error);
      pbxSetAssetsProgress("설치 중단", 0, String(_error && _error.message ? _error.message : "install-failed"));
      pbxSetAssetsModalStatus("error", "설치/업데이트 중 문제가 생겼어요", "폴더에 파일을 쓰는 과정에서 오류가 났어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  async function linkAiAssetsFolder() {
    await pbxOpenAssetsSetupModal();
  }

  async function sendMessage() {
    const field = document.getElementById("input-field");
    if (!field || state.isStreaming) return;
    const raw = field.value || "";
    const attachments = Array.isArray(state.pendingAttachments) ? [...state.pendingAttachments] : [];
    if (!trim(raw) && !attachments.length) return;

    const isFirstUserQuestion = !state.history.some((entry) => entry.role === "user");
    if (isFirstUserQuestion) {
      showToast(getActiveUiLanguage() === "ko" ? "첫 질문은 모델 준비 때문에 조금 더 느릴 수 있어요." : "The first reply can take a little longer while the model is loading.");
    }

    state.pendingAttachments = [];
    updateAttachmentStrip();
    field.value = "";
    field.style.height = "auto";
    const counter = document.getElementById("char-count");
    if (counter) counter.textContent = "0 / 2000";

    const userEntry = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: trim(raw) || (getActiveUiLanguage() === "ko" ? "질문을 입력해 주세요." : "Please enter a message."),
      attachments,
      meta: "",
    };

    showChat();
    appendMessage("user", userEntry.content, userEntry);
    state.history.push(userEntry);
    if (state.history.filter((entry) => entry.role === "user").length === 1) {
      const active = state.conversations.find((conversation) => conversation.id === state.sessionId);
      if (active) active.title = pbxInferConversationTitle(userEntry.content);
    }

    state.isStreaming = true;
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const typingId = appendTyping();

    try {
      const installStatus = await pbxEnsureAiAssetsInstalled(true, getSelectedRuntimeModelId());
      if (!installStatus.installed) {
        pbxOpenAssetsSetupModal(installStatus.reason).catch(() => {});
        const failureEntry = {
          id: `msg_${Date.now()}_install`,
          role: "assistant",
          content: pbxInstallGuideText(installStatus.reason),
          attachments: [],
          meta: "",
        };
        const bubble = appendMessage("ai", "", failureEntry);
        await streamToBubble(bubble, failureEntry.content);
        return;
      }
      if (installStatus.reason === "permission-needed") {
        showToast("AI 준비물 폴더 권한은 끊어졌지만, 이 브라우저 안에 설치된 모델로는 계속 답할 수 있어요.");
      }
      const latestPlan = await pbxFetchPackagePlan(getSelectedRuntimeModelId()).catch(() => null);
      const deviceProfile = await pbxDetectDeviceProfile(latestPlan).catch(() => null);
      const resolvedInstall = pbxResolveInstallState(latestPlan, installStatus.runtimeState || installStatus, deviceProfile);
      if (resolvedInstall.needsUpdate) {
        showToast("AI 준비물 업데이트가 있어요. 지금 답변은 가능하지만, 상단 버튼에서 최신 상태로 맞출 수 있어요.");
      }

      const reply = await Promise.race([
        buildReply(userEntry),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reply-timeout")), pbxRuntimeTimeouts().replyMs)),
      ]);

      const replyCode = trim(reply && reply.code ? reply.code : "");
      const safeText = shorten(trim(reply && reply.text ? reply.text : ""), 1400);
      const isFailureReply = !safeText || replyCode === "PB-ANSWER-FAILED";

      if (isFailureReply) {
        if (engine.lastError) {
          console.error("[Purple Bee][Reply Failed]", engine.lastError);
        }
        const failureEntry = {
          id: `msg_${Date.now()}_fail`,
          role: "assistant",
          content: getActiveUiLanguage() === "ko"
            ? "답변 생성에 실패했어요. 잠시 후 다시 시도해 주세요."
            : "Reply generation failed. Please try again in a moment.",
          attachments: [],
          meta: "",
        };
        const bubble = appendMessage("ai", "", failureEntry);
        await streamToBubble(bubble, failureEntry.content);
      } else {
        const aiEntry = {
          id: `msg_${Date.now()}_ai`,
          role: "assistant",
          content: safeText,
          attachments: [],
          meta: (reply && reply.meta) || "",
        };
        const bubble = appendMessage("ai", "", aiEntry);
        await streamToBubble(bubble, aiEntry.meta ? `${aiEntry.content}\n\n> ${aiEntry.meta}` : aiEntry.content);
        state.history.push(aiEntry);
      }
    } catch (_error) {
      console.error("[Purple Bee][Reply Exception]", _error, engine.lastError || "");
      const failureEntry = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: getActiveUiLanguage() === "ko"
          ? "답변 생성에 실패했어요. 잠시 후 다시 시도해 주세요."
          : "Reply generation failed. Please try again in a moment.",
        attachments: [],
        meta: "",
      };
      const bubble = appendMessage("ai", "", failureEntry);
      await streamToBubble(bubble, failureEntry.content);
    } finally {
      removeTyping(typingId);
      pbxClearAllTyping();
      state.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      field.focus();
      saveConversation();
      loadConversationList();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      pbxEnhanceUiBindings();
      pbxRefreshAssetsButtonState().catch(() => {});
      pbxRefreshContributorSidebar().catch(() => {});
    });
  } else {
    pbxEnhanceUiBindings();
    pbxRefreshAssetsButtonState().catch(() => {});
    pbxRefreshContributorSidebar().catch(() => {});
  }

  Object.assign(window, {
    toggleSidebar,
    newChat,
    quickSend,
    quickAction,
    sendMessage,
    toggleAttachMenu,
    toggleModelMenu,
    toggleDeepThink,
    openFilePicker,
    openSettings,
    closeSettings,
    toggleRememberChats,
    clearStoredChats,
    clearAllMemories,
    deleteMemoryById,
    pasteClipboardImage,
    clearPendingAttachments,
    copyText,
    reportMessage,
    regenerate,
    toggleProfileMenu,
    openLanguageFromMenu,
    loginWithGoogle,
    logoutUser,
    linkAiAssetsFolder,
    openUpgradePage: pbxOpenUpgradePage,
    openContributorHub: pbxOpenContributorHub,
    closeContributorHub: pbxCloseContributorHub,
    updateContributorComputeMode: pbxUpdateContributorComputeMode,
    downloadContributorApp: pbxDownloadContributorApp,
    refreshContributorSidebar: pbxRefreshContributorSidebar,
    renameConversationFromMenu,
    deleteConversationFromMenu,
    toggleRequiredConsent,
    submitRequiredConsent,
    openConsentModal,
    openConsentDocs,
  });
})();
