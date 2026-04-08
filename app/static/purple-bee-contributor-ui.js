(function () {
  const byId = (id) => document.getElementById(id);
  const readJson = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const writeJson = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };
  const trim = (value) => String(value ?? "").trim();
  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[m]));
  const toast = (message) => {
    if (typeof window.showToast === "function") window.showToast(message);
  };
  const currentUser = () => readJson("pb_user_v1") || readJson("pb_user_backup_v1");
  const contributorUserId = () => {
    const user = currentUser() || {};
    const saved = trim(localStorage.getItem("pb_contributor_user_id"));
    const next =
      trim(user.sub || user.email || user.id) ||
      saved ||
      `pb_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("pb_contributor_user_id", next);
    return next;
  };
  const contributorUserName = () => {
    const user = currentUser() || {};
    return trim(user.name || user.email || "Purple Bee User");
  };
  const hasRequiredConsent = () => {
    const consent = readJson("pb_required_consents_v1") || {};
    return !!(consent.terms && consent.resource && consent.privacy);
  };
  const formatDateTime = (value) => {
    if (!value) return "없음";
    try {
      return new Date(value).toLocaleString("ko-KR", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(value);
    }
  };

  const PLANS = {
    Free: {
      badge: "기본",
      headline: "유지 조건 없음",
      summary: "내 기기 연산만 사용하는 기본 시작 플랜입니다.",
      detail: "기여 예약 없이 바로 사용할 수 있습니다.",
      features: ["기본 AI 대화", "내 기기 연산", "기본 우선순위", "일일 사용량 제한"],
      monthlyHours: 0,
      weeklyHours: 0,
      defaultMode: "local",
    },
    Basic: {
      badge: "입문",
      headline: "월 8시간 기여 유지",
      summary: "내 기기 연산에 보조 연산을 더할 수 있는 첫 단계입니다.",
      detail: "월 8시간 이상 기여하면 상태를 유지합니다.",
      features: ["보조 연산 모드 선택", "응답 제한 완화", "기여 앱 사용 가능", "월 8시간 유지 조건"],
      monthlyHours: 8,
      weeklyHours: 0,
      defaultMode: "hybrid",
    },
    Plus: {
      badge: "추천",
      headline: "주 10시간 · 월 40시간 유지",
      summary: "더 빠른 응답과 넓은 사용 범위를 위한 핵심 플랜입니다.",
      detail: "주 10시간, 월 40시간 이상 기여해야 유지됩니다.",
      features: ["상위 우선순위", "최신 모델 접근", "하이브리드 보조 연산", "주 10시간 / 월 40시간 유지"],
      monthlyHours: 40,
      weeklyHours: 10,
      defaultMode: "distributed",
    },
    Pro: {
      badge: "최상위",
      headline: "주 20시간 · 월 80시간 유지",
      summary: "대형 작업과 가장 높은 우선순위를 위한 상위 플랜입니다.",
      detail: "주 20시간, 월 80시간 이상 기여해야 유지됩니다.",
      features: ["최상위 우선순위", "긴 작업 처리", "강한 보조 연산 배정", "주 20시간 / 월 80시간 유지"],
      monthlyHours: 80,
      weeklyHours: 20,
      defaultMode: "distributed",
    },
  };

  const COMPUTE_MODES = {
    Free: [{ value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." }],
    Basic: [
      { value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." },
      { value: "hybrid", title: "내 기기 + 보조 연산", body: "내 기기를 우선 사용하고 부족한 경우에만 보조 연산을 붙입니다." },
    ],
    Plus: [
      { value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." },
      { value: "hybrid", title: "내 기기 + 보조 연산", body: "내 기기를 중심으로 사용하고 처리량이 늘 때 보조 연산을 추가합니다." },
      { value: "distributed", title: "기여 네트워크 우선", body: "내 기기를 유지하면서 기여 네트워크의 보조 연산 비중을 높입니다." },
    ],
    Pro: [
      { value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." },
      { value: "hybrid", title: "내 기기 + 보조 연산", body: "내 기기와 기여 네트워크를 함께 사용해 처리량을 높입니다." },
      { value: "distributed", title: "기여 네트워크 우선", body: "상위 플랜 기준으로 기여 네트워크 보조 연산 비중을 크게 높입니다." },
    ],
  };

  const state = {
    mode: "plans",
    step: 0,
    status: null,
    profile: null,
    linkCode: null,
    installClicked: !!readJson("pb_contributor_install_clicked_v1"),
    selectedPlan: trim(localStorage.getItem("pb_selected_contributor_plan")) || "Basic",
    selectedMode: trim(localStorage.getItem("pb_selected_compute_mode")) || "hybrid",
    timer: null,
  };

  function normalizePlan(value) {
    const plan = trim(value);
    return Object.prototype.hasOwnProperty.call(PLANS, plan) ? plan : "Free";
  }

  function currentPlan() {
    return normalizePlan(state.status?.account?.plan || "Free");
  }

  function linkedDevices() {
    return Array.isArray(state.status?.devices) ? state.status.devices : [];
  }

  function linkedDeviceCount() {
    return Number(state.status?.linked_device_count || linkedDevices().length || 0);
  }

  function linkedDeviceSummary() {
    const exact = trim(state.status?.exact_device_summary || "");
    if (exact) return exact;
    if (linkedDeviceCount() <= 0) return "아직 연결된 기기가 없습니다.";
    const first = linkedDevices()[0];
    if (!first) return `연결된 기기 ${linkedDeviceCount()}대`;
    return linkedDeviceCount() === 1 ? trim(first.device_name || "연결된 기기 1대") : `${trim(first.device_name || "연결된 기기")} 외 ${linkedDeviceCount() - 1}대`;
  }

  function nextReservation() {
    return (state.status?.reservations || []).find((item) => item.status === "scheduled") || null;
  }

  function lockInfo(targetPlan) {
    const until = trim(state.status?.plan_change_locked_until || "");
    const current = currentPlan();
    const requested = normalizePlan(targetPlan || current);
    const locked = !!until && requested !== current && requested !== "Free";
    return {
      locked,
      text: locked ? `플랜은 한 달에 한 번만 변경할 수 있습니다. 다음 변경 가능 시각은 ${formatDateTime(until)}입니다.` : "",
    };
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      const error = new Error(body.message || body.error || "request_failed");
      error.payload = body;
      throw error;
    }
    return body;
  }

  async function refreshStatus(renderModalAfter) {
    try {
      state.status = await api(`/api/contributor/status?user_id=${encodeURIComponent(contributorUserId())}`);
    } catch (error) {
      console.warn("[Purple Bee][Contributor] status", error);
    }
    try {
      const storage = await navigator.storage?.estimate?.().catch(() => null);
      state.profile = {
        cpuThreads: Number(navigator.hardwareConcurrency || 0),
        memoryGb: Number(navigator.deviceMemory || 0),
        freeStorageGb: storage?.quota ? Math.max((storage.quota - (storage.usage || 0)) / 1073741824, 0) : 0,
      };
    } catch {}
    updateSidebar();
    if (renderModalAfter) renderModal();
  }

  function updateSidebar() {
    const upgrade = byId("upgrade-plan-btn");
    const card = byId("contributor-card");
    if (!upgrade || !card) return;
    const loggedIn = !!currentUser();
    const plan = currentPlan();
    const showUpgrade = !loggedIn || plan === "Free";
    upgrade.classList.toggle("hidden", !showUpgrade);
    card.classList.toggle("hidden", showUpgrade);

    const premium = !!state.status?.premium_active;
    const queue = trim(state.status?.account?.contributor_status || "기본");
    const next = nextReservation();

    if (byId("upgrade-plan-title")) byId("upgrade-plan-title").textContent = "⚡ 플랜 업그레이드";
    if (byId("upgrade-plan-sub")) byId("upgrade-plan-sub").textContent = "기여 시간 기준 플랜과 유지 조건을 비교해 보세요.";
    if (byId("contributor-card-title")) byId("contributor-card-title").textContent = "✨ 기여 구독 상태";
    if (byId("contributor-card-sub")) byId("contributor-card-sub").textContent = "현재 플랜과 다음 기여 예약만 간단히 보여드립니다.";
    if (byId("contributor-card-pill")) byId("contributor-card-pill").textContent = plan;
    if (byId("contributor-plan-value")) byId("contributor-plan-value").textContent = plan;
    if (byId("contributor-premium-value")) byId("contributor-premium-value").textContent = premium ? "활성" : "비활성";
    if (byId("contributor-queue-value")) byId("contributor-queue-value").textContent = queue;
    if (byId("contributor-next-value")) byId("contributor-next-value").textContent = next ? formatDateTime(next.starts_at) : "없음";
    if (byId("contributor-card-note")) {
      byId("contributor-card-note").textContent =
        plan === "Free"
          ? "Free에서는 내 기기 연산만 사용합니다."
          : "앱 설치와 연동을 마치면 예약과 유지 조건을 여기서 바로 확인할 수 있습니다.";
    }
    if (byId("contributor-device-value")) byId("contributor-device-value").textContent = linkedDeviceSummary();
    if (byId("contributor-card-hint")) {
      byId("contributor-card-hint").textContent =
        plan === "Free"
          ? "기여 시간 플랜을 시작하려면 눌러서 업그레이드 단계를 진행하세요."
          : "눌러서 연결 상태와 다음 예약을 확인하세요.";
    }
  }

  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(() => {
      refreshStatus(true);
    }, 15000);
  }

  function openModal(title, subtitle, mode) {
    state.mode = mode;
    byId("contributor-hub-title").textContent = title;
    byId("contributor-hub-subtitle").textContent = subtitle;
    byId("contributor-hub-backdrop").classList.add("open");
    byId("contributor-hub-section-plans").classList.toggle("active", mode === "plans");
    byId("contributor-hub-section-status").classList.toggle("active", mode === "status");
    startPolling();
  }

  function closeContributorHub(event) {
    if (event?.target && event.target !== byId("contributor-hub-backdrop")) return;
    byId("contributor-hub-backdrop").classList.remove("open");
    stopPolling();
  }

  function detectStep() {
    if (!hasRequiredConsent()) return 0;
    if (!state.installClicked) return 1;
    if (linkedDeviceCount() <= 0) return 2;
    if (!state.profile) return 3;
    return 4;
  }

  function recommendPlan() {
    const cpu = Number(state.profile?.cpuThreads || 0);
    const ram = Number(state.profile?.memoryGb || 0);
    if (cpu >= 12 && ram >= 16) return "Pro";
    if (cpu >= 8 && ram >= 8) return "Plus";
    if (cpu >= 4 && ram >= 4) return "Basic";
    return "Free";
  }

  function renderStepCard(stepNumber, title, description) {
    const current = state.step === stepNumber;
    const done =
      state.step > stepNumber ||
      (stepNumber === 0 && hasRequiredConsent()) ||
      (stepNumber === 1 && state.installClicked) ||
      (stepNumber === 2 && linkedDeviceCount() > 0) ||
      (stepNumber === 3 && !!state.profile);
    return `
      <div class="contributor-status-step"${current ? ' style="border-color:rgba(139,92,246,.5);box-shadow:0 10px 30px rgba(139,92,246,.12)"' : ""}>
        <span class="contributor-status-step-chip">${done ? "✓" : stepNumber + 1}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>
      </div>`;
  }

  function planCardsHtml() {
    const current = currentPlan();
    const lock = lockInfo(state.selectedPlan);
    return Object.entries(PLANS).map(([name, meta]) => {
      const active = name === state.selectedPlan;
      const isCurrent = name === current;
      const disabled = lock.locked && name !== current && name !== "Free";
      const buttonLabel = name === "Free" ? "기본 플랜" : isCurrent ? "현재 플랜" : disabled ? "이번 달 변경 잠금" : "이 플랜 선택";
      return `
        <article class="contributor-plan-card ${active ? "active" : ""}">
          <div class="contributor-plan-head">
            <div class="contributor-plan-name">${escapeHtml(name)}</div>
            <span class="contributor-plan-badge">${escapeHtml(meta.badge)}</span>
          </div>
          <div class="contributor-plan-price">${escapeHtml(meta.headline)}</div>
          <div class="contributor-plan-copy">${escapeHtml(meta.summary)}</div>
          <button class="contributor-plan-btn" type="button" ${disabled ? "disabled" : ""} onclick="selectContributorPlan('${escapeHtml(name)}')">${escapeHtml(buttonLabel)}</button>
          <ul class="contributor-plan-list">${meta.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul>
          <div class="contributor-plan-foot">${escapeHtml(meta.detail)}</div>
        </article>`;
    }).join("");
  }

  function modeOptionsHtml() {
    return (COMPUTE_MODES[normalizePlan(state.selectedPlan)] || COMPUTE_MODES.Free)
      .map((mode) => `<option value="${escapeHtml(mode.value)}"${state.selectedMode === mode.value ? " selected" : ""}>${escapeHtml(mode.title)}</option>`)
      .join("");
  }

  function selectedModeDescription() {
    return ((COMPUTE_MODES[normalizePlan(state.selectedPlan)] || COMPUTE_MODES.Free).find(
      (mode) => mode.value === state.selectedMode,
    ) || COMPUTE_MODES.Free[0]).body;
  }

  function defaultStartValue() {
    const date = new Date(Date.now() + 3600000);
    date.setMinutes(0, 0, 0);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderPlans() {
    const section = byId("contributor-hub-section-plans");
    const footLeft = byId("contributor-hub-foot-left");
    const footRight = byId("contributor-hub-foot-right");
    const lock = lockInfo(state.selectedPlan);

    section.innerHTML = `
      <div class="contributor-status-card">
        <div class="contributor-status-title">플랜 업그레이드</div>
        <div class="contributor-status-copy">기여 시간 기반 플랜은 순서대로 설정합니다. 약관 확인부터 앱 설치, 연동, 기기 확인을 마친 뒤 마지막 단계에서 예약을 저장하세요.</div>
        <div class="contributor-status-steps">
          ${renderStepCard(0, "약관 확인", "필수 동의 3종을 먼저 확인합니다.")}
          ${renderStepCard(1, "앱 설치", "Setup.exe를 내려받아 설치를 진행합니다.")}
          ${renderStepCard(2, "연동 확인", "앱과 이 사이트를 연결합니다.")}
          ${renderStepCard(3, "PC 성능 확인", "현재 연결 상태와 기기 상태를 확인합니다.")}
          ${renderStepCard(4, "플랜 선택", "유지 조건을 보고 예약을 저장합니다.")}
        </div>

        ${state.step === 0 ? `
          <div class="contributor-status-banner">
            <strong>약관과 자원 사용 범위를 먼저 확인해 주세요</strong>
            <p>기여 앱은 별도 프로그램으로 실행되며, 사용 가능한 자원과 중단 조건을 먼저 확인해야 다음 단계로 넘어갈 수 있습니다.</p>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn" type="button" onclick="openConsentDocs()">정책 문서 보기</button>
            <button class="contributor-status-btn primary" type="button" onclick="continueContributorTerms()">동의 확인 후 계속</button>
          </div>
        ` : ""}

        ${state.step === 1 ? `
          <div class="contributor-status-banner">
            <strong>기여 앱 설치</strong>
            <p>아래 버튼으로 Setup.exe를 내려받은 뒤 더블클릭해서 설치를 진행하세요. 설치가 끝나면 다음 단계로 넘어갑니다.</p>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn primary" type="button" onclick="downloadContributorApp()">Setup.exe 받기</button>
            <button class="contributor-status-btn" type="button" onclick="markContributorInstalled()">설치 완료 · 다음</button>
          </div>
        ` : ""}

        ${state.step === 2 ? `
          <div class="contributor-status-grid">
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">연동 코드</div>
              <div class="contributor-status-stat-value">${escapeHtml(state.linkCode?.code || "발급 전")}</div>
              <div class="contributor-status-stat-copy">앱에서 이 코드를 입력해 계정을 연결하세요.</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">연결된 기기</div>
              <div class="contributor-status-stat-value">${linkedDeviceCount()}</div>
              <div class="contributor-status-stat-copy">${escapeHtml(linkedDeviceSummary())}</div>
            </div>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn" type="button" onclick="copyContributorLinkCode()">연동 코드 복사</button>
            <button class="contributor-status-btn primary" type="button" onclick="verifyContributorLink()">연동 확인</button>
          </div>
        ` : ""}

        ${state.step === 3 ? `
          <div class="contributor-status-grid">
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">CPU 스레드</div>
              <div class="contributor-status-stat-value">${Number(state.profile?.cpuThreads || 0) >= 4 ? "✓" : "✕"} ${escapeHtml(String(state.profile?.cpuThreads || 0))}</div>
              <div class="contributor-status-stat-copy">4 이상이면 안정적으로 기여할 수 있습니다.</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">메모리</div>
              <div class="contributor-status-stat-value">${Number(state.profile?.memoryGb || 0) >= 8 ? "✓" : "✕"} ${escapeHtml(String(state.profile?.memoryGb || 0))} GB</div>
              <div class="contributor-status-stat-copy">8GB 이상 권장</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">남은 저장 공간</div>
              <div class="contributor-status-stat-value">${Number(state.profile?.freeStorageGb || 0) >= 4 ? "✓" : "✕"} ${escapeHtml(Number(state.profile?.freeStorageGb || 0).toFixed(1))} GB</div>
              <div class="contributor-status-stat-copy">4GB 이상 권장</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">추천 플랜</div>
              <div class="contributor-status-stat-value">${escapeHtml(recommendPlan())}</div>
              <div class="contributor-status-stat-copy">현재 기기 기준 추천</div>
            </div>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn primary" type="button" onclick="goContributorStep(4)">다음 단계로</button>
          </div>
        ` : ""}

        ${state.step === 4 ? `
          ${lock.locked ? `
            <div class="contributor-status-banner">
              <strong>이번 달 플랜 변경 잠금</strong>
              <p>${escapeHtml(lock.text)}</p>
            </div>
          ` : ""}
          <div class="contributor-plan-grid">${planCardsHtml()}</div>
          <div class="contributor-status-card" style="margin-top:16px;border-style:dashed">
            <div class="contributor-status-title" style="font-size:22px">선택한 플랜 예약</div>
            <div class="contributor-status-copy">플랜 변경은 한 달에 한 번만 가능하고, 취소는 언제든 할 수 있습니다.</div>
            <div class="contributor-status-fields">
              <div class="contributor-status-field">
                <label>선택 플랜</label>
                <input type="text" value="${escapeHtml(state.selectedPlan)}" disabled>
              </div>
              <div class="contributor-status-field">
                <label>유지 조건</label>
                <input type="text" value="${escapeHtml(PLANS[normalizePlan(state.selectedPlan)].headline)}" disabled>
              </div>
              <div class="contributor-status-field">
                <label>연산 모드</label>
                <select onchange="updateContributorComputeMode(this.value)">${modeOptionsHtml()}</select>
              </div>
              <div class="contributor-status-field">
                <label>다음 예약 시작</label>
                <input id="contributor-starts-at" type="datetime-local" value="${defaultStartValue()}">
              </div>
              <div class="contributor-status-field full">
                <label>연산 모드 설명</label>
                <input type="text" value="${escapeHtml(selectedModeDescription())}" disabled>
              </div>
            </div>
            <div class="contributor-status-actions">
              <button class="contributor-status-btn primary" type="button" ${lock.locked ? "disabled" : ""} onclick="reserveContributorPlan()">${state.selectedPlan === "Free" ? "기본 플랜 유지" : `${escapeHtml(state.selectedPlan)} 예약 저장`}</button>
              <button class="contributor-status-btn" type="button" ${(currentPlan() === "Free" && !nextReservation()) ? "disabled" : ""} onclick="cancelContributorPlan()">플랜 취소</button>
            </div>
          </div>
        ` : ""}
      </div>`;

    footLeft.textContent = state.step < 4 ? "각 단계가 끝나면 다음 단계로 이어집니다." : "플랜은 한 달에 한 번만 변경할 수 있고, 취소는 언제든 가능합니다.";
    footRight.textContent = state.step < 4 ? "연동 상태는 자동으로 갱신됩니다." : "예약과 유지 조건은 상태 화면에서 다시 확인할 수 있습니다.";
  }

  function renderStatus() {
    byId("contributor-hub-section-status").innerHTML = `
      <div class="contributor-status-shell">
        <div class="contributor-status-card">
          <div class="contributor-status-title">기여 구독 상태</div>
          <div class="contributor-status-copy">현재 플랜, 연결 기기, 다음 예약만 간결하게 보여드립니다.</div>
          <div class="contributor-status-grid">
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">현재 플랜</div>
              <div class="contributor-status-stat-value">${escapeHtml(currentPlan())}</div>
              <div class="contributor-status-stat-copy">${escapeHtml(PLANS[currentPlan()].headline)}</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">프리미엄</div>
              <div class="contributor-status-stat-value">${state.status?.premium_active ? "활성" : "비활성"}</div>
              <div class="contributor-status-stat-copy">${state.status?.account?.premium_until ? `${formatDateTime(state.status.account.premium_until)}까지` : "유지 조건을 충족하면 자동으로 활성화됩니다."}</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">연결된 기기</div>
              <div class="contributor-status-stat-value">${linkedDeviceCount()}</div>
              <div class="contributor-status-stat-copy">${escapeHtml(linkedDeviceSummary())}</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">다음 예약</div>
              <div class="contributor-status-stat-value">${nextReservation() ? formatDateTime(nextReservation().starts_at) : "없음"}</div>
              <div class="contributor-status-stat-copy">${nextReservation() ? `${escapeHtml(nextReservation().plan)} · ${escapeHtml(String(nextReservation().hours))}시간` : "예약을 저장하면 여기에 표시됩니다."}</div>
            </div>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn primary" type="button" onclick="jumpToContributorSetup()">앱 설치 / 연동</button>
            <button class="contributor-status-btn" type="button" onclick="openUpgradePage()">플랜 보기</button>
            <button class="contributor-status-btn" type="button" ${(currentPlan() === "Free" && !nextReservation()) ? "disabled" : ""} onclick="cancelContributorPlan()">플랜 취소</button>
          </div>
        </div>
        <div class="contributor-status-card">
          <div class="contributor-status-title" style="font-size:22px">현재 연산 모드</div>
          <div class="contributor-status-banner">
            <strong>${escapeHtml(((COMPUTE_MODES[currentPlan()] || COMPUTE_MODES.Free).find((mode) => mode.value === state.selectedMode) || COMPUTE_MODES.Free[0]).title)}</strong>
            <p>${escapeHtml(selectedModeDescription())}</p>
          </div>
          <div class="contributor-status-detail">
            <div class="contributor-status-detail-item">
              <strong>기여 앱 상태</strong>
              <p>${linkedDeviceCount() > 0 ? "연결이 확인되었습니다. 다음 예약과 유지 조건을 이 화면에서 계속 확인할 수 있습니다." : "먼저 기여 앱 설치와 연동을 완료해야 보조 연산을 사용할 수 있습니다."}</p>
            </div>
            <div class="contributor-status-detail-item">
              <strong>플랜 변경 규칙</strong>
              <p>플랜은 한 달에 한 번만 변경할 수 있습니다. 취소는 언제든 가능하지만, 다음 변경 가능 시각은 그대로 유지됩니다.</p>
            </div>
          </div>
        </div>
      </div>`;
    byId("contributor-hub-foot-left").textContent = "기여 구독 상태는 연결 기기와 다음 예약만 간단히 보여줍니다.";
    byId("contributor-hub-foot-right").textContent = "상태는 자동으로 갱신됩니다.";
  }

  function renderModal() {
    if (state.mode === "plans") renderPlans();
    else renderStatus();
  }

  async function openUpgradePage(event) {
    if (event?.preventDefault) event.preventDefault();
    await refreshStatus(false);
    state.step = detectStep();
    openModal("플랜 업그레이드", "기여 시간 기반 플랜을 단계별로 설정합니다.", "plans");
    renderModal();
  }

  async function openContributorHub(mode) {
    await refreshStatus(false);
    if (mode === "status") {
      openModal("기여 구독 상태", "현재 플랜과 다음 예약만 간단히 보여드립니다.", "status");
    } else {
      state.step = detectStep();
      openModal("플랜 업그레이드", "기여 시간 기반 플랜을 단계별로 설정합니다.", "plans");
    }
    renderModal();
  }

  function continueContributorTerms() {
    if (!hasRequiredConsent()) {
      if (typeof window.openConsentModal === "function") window.openConsentModal();
      toast("필수 동의를 먼저 완료해 주세요.");
      return;
    }
    state.step = 1;
    renderModal();
  }

  async function downloadContributorApp() {
    const link = document.createElement("a");
    link.href = `/api/contributor/client/download?user_id=${encodeURIComponent(contributorUserId())}&display_name=${encodeURIComponent(contributorUserName())}`;
    link.download = "PurpleBeeContributorSetup.exe";
    document.body.appendChild(link);
    link.click();
    link.remove();
    state.installClicked = true;
    writeJson("pb_contributor_install_clicked_v1", true);
    toast("Setup.exe 다운로드를 시작했습니다. 설치가 끝나면 다음 단계로 넘어가 주세요.");
  }

  function markContributorInstalled() {
    state.installClicked = true;
    writeJson("pb_contributor_install_clicked_v1", true);
    state.step = 2;
    renderModal();
  }

  async function ensureLinkCode() {
    if (state.linkCode?.code) return state.linkCode;
    const body = await api("/api/contributor/link-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: contributorUserId(),
        display_name: contributorUserName(),
        plan: state.selectedPlan,
      }),
    });
    state.linkCode = body.link_code;
    return state.linkCode;
  }

  async function copyContributorLinkCode() {
    const code = (await ensureLinkCode())?.code;
    if (!code) {
      toast("연동 코드를 발급하지 못했습니다.");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      toast("연동 코드를 복사했습니다.");
    } catch {
      toast(`연동 코드: ${code}`);
    }
  }

  async function verifyContributorLink() {
    await refreshStatus(false);
    if (linkedDeviceCount() > 0) {
      state.step = 3;
      renderModal();
      toast("기여 앱 연동이 확인되었습니다.");
      return;
    }
    await ensureLinkCode();
    toast("아직 앱 연동이 확인되지 않았습니다. 앱에서 연동 코드를 입력한 뒤 다시 눌러 주세요.");
  }

  function goContributorStep(stepNumber) {
    state.step = Math.max(0, Math.min(4, Number(stepNumber) || 0));
    renderModal();
  }

  function jumpToContributorSetup() {
    state.mode = "plans";
    state.step = detectStep();
    byId("contributor-hub-section-plans").classList.add("active");
    byId("contributor-hub-section-status").classList.remove("active");
    byId("contributor-hub-title").textContent = "플랜 업그레이드";
    byId("contributor-hub-subtitle").textContent = "기여 시간 기반 플랜을 단계별로 설정합니다.";
    renderModal();
  }

  function selectContributorPlan(plan) {
    const nextPlan = normalizePlan(plan);
    const lock = lockInfo(nextPlan);
    if (lock.locked && nextPlan !== currentPlan() && nextPlan !== "Free") {
      toast(lock.text);
      return;
    }
    state.selectedPlan = nextPlan;
    localStorage.setItem("pb_selected_contributor_plan", nextPlan);
    state.selectedMode = (PLANS[nextPlan] || PLANS.Free).defaultMode;
    localStorage.setItem("pb_selected_compute_mode", state.selectedMode);
    renderModal();
  }

  function updateContributorComputeMode(value) {
    state.selectedMode = trim(value) || "local";
    localStorage.setItem("pb_selected_compute_mode", state.selectedMode);
    renderModal();
  }

  async function reserveContributorPlan() {
    const startsAtField = byId("contributor-starts-at");
    const startsAt = trim(startsAtField?.value || "");
    const plan = normalizePlan(state.selectedPlan);
    const rule = PLANS[plan] || PLANS.Free;
    const payload = {
      user_id: contributorUserId(),
      display_name: contributorUserName(),
      plan,
      hours: rule.monthlyHours || 0,
      starts_at: startsAt,
      cpu_cap: 70,
      gpu_cap: 70,
      device_profile: {
        cpu_threads: Number(state.profile?.cpuThreads || 0),
        memory_gb: Number(state.profile?.memoryGb || 0),
        storage_free_gb: Number(state.profile?.freeStorageGb || 0),
      },
      compute_mode: state.selectedMode,
    };
    try {
      await api("/api/contributor/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await refreshStatus(false);
      openContributorHub("status");
      toast("플랜 예약을 저장했습니다.");
    } catch (error) {
      toast(error.message || "플랜 예약 저장에 실패했습니다.");
    }
  }

  async function cancelContributorPlan() {
    try {
      await api("/api/contributor/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: contributorUserId() }),
      });
      await refreshStatus(false);
      renderModal();
      toast("플랜 예약을 취소했습니다.");
    } catch (error) {
      toast(error.message || "플랜 취소에 실패했습니다.");
    }
  }

  function openConsentDocs() {
    if (typeof window.openConsentModal === "function") {
      closeContributorHub();
      window.openConsentModal();
      return;
    }
    window.open("/index/purple-bee/legal/terms/", "_blank", "noopener");
  }

  window.openUpgradePage = openUpgradePage;
  window.openContributorHub = openContributorHub;
  window.closeContributorHub = closeContributorHub;
  window.continueContributorTerms = continueContributorTerms;
  window.downloadContributorApp = downloadContributorApp;
  window.markContributorInstalled = markContributorInstalled;
  window.copyContributorLinkCode = copyContributorLinkCode;
  window.verifyContributorLink = verifyContributorLink;
  window.goContributorStep = goContributorStep;
  window.jumpToContributorSetup = jumpToContributorSetup;
  window.selectContributorPlan = selectContributorPlan;
  window.updateContributorComputeMode = updateContributorComputeMode;
  window.reserveContributorPlan = reserveContributorPlan;
  window.cancelContributorPlan = cancelContributorPlan;

  document.addEventListener("DOMContentLoaded", () => {
    refreshStatus(false);
  });
})();
