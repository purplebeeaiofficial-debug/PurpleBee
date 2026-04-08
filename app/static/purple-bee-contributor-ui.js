(function () {
  const $ = (id) => document.getElementById(id);
  const readJson = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const safe = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (match) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[match]));
  const trim = (value) => String(value ?? "").trim();
  const toast = (message) => {
    if (typeof window.showToast === "function") {
      window.showToast(message);
    }
  };
  const currentUser = () => readJson("pb_user_v1") || readJson("pb_user_backup_v1");
  const consentsAccepted = () => {
    const consent = readJson("pb_required_consents_v1") || {};
    return !!(consent.terms && consent.resource && consent.privacy);
  };
  const contributorUserId = () => {
    const user = currentUser();
    const saved = trim(localStorage.getItem("pb_contributor_user_id"));
    const resolved =
      trim(user && (user.sub || user.email || user.id)) ||
      saved ||
      `pb_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("pb_contributor_user_id", resolved);
    return resolved;
  };

  const PLAN_COPY = {
    Free: {
      badge: "기본",
      headline: "유지 조건 없음",
      lead: "가볍게 시작하는 기본 플랜입니다.",
      features: ["기본 AI 대화", "내 기기 연산", "기본 우선순위", "일일 사용량 제한"],
    },
    Basic: {
      badge: "입문",
      headline: "월 8시간 기여 유지",
      lead: "내 기기 연산에 보조 연산을 더할 수 있는 첫 단계입니다.",
      features: ["보조 연산 모드 선택", "응답 제한 완화", "기여 앱 사용", "월 8시간 유지"],
    },
    Plus: {
      badge: "추천",
      headline: "주 10시간 · 월 40시간 유지",
      lead: "응답 속도와 사용 범위를 함께 넓히는 핵심 플랜입니다.",
      features: ["상위 우선순위", "최신 모델 접근", "하이브리드 보조 연산", "주 10시간 / 월 40시간 유지"],
    },
    Pro: {
      badge: "최상위",
      headline: "주 20시간 · 월 80시간 유지",
      lead: "대형 작업과 가장 높은 우선순위를 위한 플랜입니다.",
      features: ["최상위 우선순위", "긴 작업 처리", "강한 보조 연산 배정", "주 20시간 / 월 80시간 유지"],
    },
  };

  const state = {
    status: null,
    profile: null,
    selectedPlan: localStorage.getItem("pb_selected_contributor_plan") || "Basic",
    selectedHours: +(localStorage.getItem("pb_selected_contributor_hours") || 8),
    linkCode: "",
    installClicked: false,
    step: 0,
  };

  function setHubMode(mode) {
    const title = $("contributor-hub-title");
    const subtitle = $("contributor-hub-subtitle");
    const footLeft = $("contributor-hub-foot-left");
    const footRight = $("contributor-hub-foot-right");
    const plans = $("contributor-hub-section-plans");
    const status = $("contributor-hub-section-status");
    if (!title || !subtitle || !footLeft || !footRight || !plans || !status) {
      return;
    }
    const isStatus = mode === "status";
    title.textContent = isStatus ? "기여 구독 상태" : "플랜 업그레이드";
    subtitle.textContent = isStatus
      ? "연결 상태와 다음 예약만 간단히 확인하세요."
      : "약관 확인부터 앱 설치, 연동, 성능 확인, 플랜 선택까지 순서대로 진행합니다.";
    footLeft.textContent = isStatus
      ? "기여 앱이 연결되면 상태가 자동으로 갱신됩니다."
      : "기여 앱 설치와 연동이 끝난 뒤 예약을 저장할 수 있습니다.";
    footRight.textContent = isStatus
      ? "예약 변경은 여기에서 바로 이어집니다."
      : "기여 시간 기반 업그레이드";
    plans.classList.toggle("active", !isStatus);
    status.classList.toggle("active", isStatus);
  }

  function formatDate(value) {
    if (!value) return "없음";
    try {
      return new Date(value).toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(value);
    }
  }

  function planName(raw) {
    return ["Basic", "Plus", "Pro"].includes(trim(raw)) ? trim(raw) : "Free";
  }

  function queueLabel(raw) {
    const value = trim(raw).toLowerCase();
    if (value.includes("pro")) return "최상위";
    if (value.includes("plus")) return "상위";
    if (value.includes("basic")) return "우선";
    return "기본";
  }

  function computeModes(plan) {
    if (plan === "Plus" || plan === "Pro") {
      return [
        { value: "local", name: "내 기기 연산", desc: "모든 처리를 현재 기기에서 수행합니다." },
        { value: "hybrid", name: "내 기기 + 보조 연산", desc: "현재 기기 우선 처리 후 부족한 만큼만 보조 연산을 붙입니다." },
        { value: "distributed", name: "보조 연산 우선", desc: "기여 네트워크 보조 연산을 더 강하게 활용합니다." },
      ];
    }
    return [
      { value: "local", name: "내 기기 연산", desc: "모든 처리를 현재 기기에서 수행합니다." },
      { value: "hybrid", name: "내 기기 + 보조 연산", desc: "현재 기기와 보조 연산을 함께 사용합니다." },
    ];
  }

  async function detectProfile() {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    state.profile = {
      cpu_threads: +(navigator.hardwareConcurrency || 0),
      memory_gb: +(navigator.deviceMemory || 0),
      disk_free_gb: estimate?.quota
        ? +(((+estimate.quota - +(estimate.usage || 0)) / 1024 ** 3).toFixed(1))
        : 0,
    };
    return state.profile;
  }

  async function fetchStatus() {
    if (!currentUser()) return null;
    const response = await fetch(`/api/contributor/status?user_id=${encodeURIComponent(contributorUserId())}`);
    const payload = await response.json();
    if (!payload?.ok) throw new Error(payload?.error || "status_failed");
    state.status = payload;
    return payload;
  }

  async function ensureLinkCode() {
    if (!currentUser()) throw new Error("signin_required");
    if (state.linkCode) return state.linkCode;
    const response = await fetch("/api/contributor/link-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: contributorUserId(),
        display_name: trim(currentUser()?.name || currentUser()?.email),
        plan: state.selectedPlan,
      }),
    });
    const payload = await response.json();
    if (!payload?.ok || !payload?.link_code?.code) {
      throw new Error(payload?.error || "link_failed");
    }
    state.linkCode = payload.link_code.code;
    return state.linkCode;
  }

  function sidebarText() {
    const upgradeTitle = $("upgrade-plan-title");
    const upgradeSub = $("upgrade-plan-sub");
    const cardTitle = $("contributor-card-title");
    const cardSub = $("contributor-card-sub");
    if (upgradeTitle) upgradeTitle.textContent = "⚡ 플랜 업그레이드";
    if (upgradeSub) upgradeSub.textContent = "기여 시간 기준으로 유지 조건과 업그레이드 범위를 확인합니다.";
    if (cardTitle) cardTitle.textContent = "✨ 기여 구독 상태";
    if (cardSub) cardSub.textContent = "현재 플랜과 연결 상태만 간단히 보여드립니다.";
  }

  function deviceSummary(status) {
    const exact = trim(status?.exact_device_summary);
    if (exact) return exact;
    const first = status?.devices?.[0];
    if (trim(first?.device_name)) return trim(first.device_name);
    return "아직 연결된 기기가 없습니다.";
  }

  async function refreshSidebar() {
    sidebarText();
    const upgrade = $("upgrade-plan-btn");
    const card = $("contributor-card");
    if (!upgrade || !card) return;

    const user = currentUser();
    if (!user) {
      upgrade.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    let status = state.status;
    try {
      status = await fetchStatus();
    } catch {
      status = state.status;
    }

    const plan = planName(status?.account?.plan || "Free");
    const isPaid = plan !== "Free";
    upgrade.classList.toggle("hidden", isPaid);
    card.classList.toggle("hidden", !isPaid);
    if (!isPaid) return;

    $("contributor-card-pill").textContent = status?.premium_active ? `${plan} Active` : plan;
    $("contributor-plan-value").textContent = plan;
    $("contributor-premium-value").textContent = status?.premium_active ? "활성" : "비활성";
    $("contributor-queue-value").textContent = queueLabel(status?.queue_mode || status?.account?.latest_quote?.queue_mode || "");
    $("contributor-next-value").textContent = status?.next_reservation ? formatDate(status.next_reservation.starts_at) : "없음";
    $("contributor-card-note").textContent = "기여 앱 설치와 연동이 끝난 뒤 다음 기여 예약을 관리할 수 있습니다.";
    $("contributor-device-value").textContent = deviceSummary(status);
    $("contributor-card-hint").textContent = "눌러서 상태, 연결 기기, 예약 일정을 확인하세요.";
  }

  function renderSteps(current) {
    const labels = ["약관 확인", "앱 설치", "연동 확인", "PC 성능 확인", "플랜 선택"];
    return `
      <div class="contributor-status-steps">
        ${labels
          .map((label, index) => {
            const phase = index < current ? "완료" : index === current ? "현재 단계" : "대기";
            return `
              <div class="contributor-status-step">
                <span class="contributor-status-step-chip">${index + 1}</span>
                <strong>${safe(label)}</strong>
                <p>${phase}</p>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderPlanCards() {
    return ["Free", "Basic", "Plus", "Pro"]
      .map((plan) => {
        const info = PLAN_COPY[plan];
        const active = plan === state.selectedPlan;
        const buttonLabel = plan === "Free" ? "기본 플랜" : active ? "선택됨" : "이 플랜 선택";
        return `
          <article class="contributor-plan-card ${active ? "active" : ""}">
            <div class="contributor-plan-head">
              <div class="contributor-plan-name">${safe(plan)}</div>
              <span class="contributor-plan-badge">${safe(info.badge)}</span>
            </div>
            <div class="contributor-plan-price">${safe(info.headline)}</div>
            <div class="contributor-plan-copy">${safe(info.lead)}</div>
            <button class="contributor-plan-btn" type="button" onclick="selectContributorPlan('${plan}')">${safe(buttonLabel)}</button>
            <ul class="contributor-plan-list">${info.features.map((feature) => `<li>${safe(feature)}</li>`).join("")}</ul>
            <div class="contributor-plan-foot">유지 조건을 충족하면 프리미엄 상태가 연장됩니다.</div>
          </article>
        `;
      })
      .join("");
  }

  function renderPlans() {
    setHubMode("plans");
    const root = $("contributor-hub-section-plans");
    if (!root) return;

    if (state.step === 0) {
      root.innerHTML = `
        <div class="contributor-status-card">
          <div class="contributor-status-title">약관 먼저 확인하기</div>
          <div class="contributor-status-copy">기여 구독은 자원 사용, 책임 범위, 개인정보 처리에 대한 동의가 먼저 필요합니다.</div>
          ${renderSteps(0)}
          <div class="contributor-status-banner">
            <strong>${consentsAccepted() ? "필수 동의가 이미 완료되어 있어요." : "필수 동의 3가지를 먼저 완료해 주세요."}</strong>
            <p>이용약관, 컴퓨터 자원 사용 동의, 개인정보 처리방침을 모두 확인한 뒤 다음 단계로 이동합니다.</p>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn" type="button" onclick="openConsentDocs()">약관과 정책 보기</button>
            <button class="contributor-status-btn primary" type="button" onclick="PurpleBeeContributorUI.nextFromTerms()">동의 확인 후 계속</button>
          </div>
        </div>
      `;
      return;
    }

    if (state.step === 1) {
      root.innerHTML = `
        <div class="contributor-status-card">
          <div class="contributor-status-title">1단계 · 기여 앱 설치</div>
          <div class="contributor-status-copy">작은 설치 파일을 내려받아 실행하면 설치 마법사가 시작됩니다. 설치가 끝나면 다음 단계로 넘어가세요.</div>
          ${renderSteps(1)}
          <div class="contributor-status-banner">
            <strong>예상 다운로드 용량 · 약 13.1MB</strong>
            <p>설치가 끝난 뒤 앱을 한 번 실행하고, 다음 단계에서 연동 코드를 입력합니다.</p>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn primary" type="button" onclick="downloadContributorApp()">기여 앱 다운로드</button>
            <button class="contributor-status-btn" type="button" ${state.installClicked ? "" : "disabled"} onclick="PurpleBeeContributorUI.gotoStep(2)">설치 완료, 다음 단계</button>
          </div>
        </div>
      `;
      return;
    }

    if (state.step === 2) {
      root.innerHTML = `
        <div class="contributor-status-card">
          <div class="contributor-status-title">2단계 · 사이트와 연동</div>
          <div class="contributor-status-copy">앱에 아래 연동 코드를 입력한 뒤, 이 화면에서 연동 확인을 눌러 주세요.</div>
          ${renderSteps(2)}
          <div class="contributor-status-banner">
            <strong>연동 코드</strong>
            <p>${safe(state.linkCode || "코드를 생성하는 중입니다.")}</p>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn" type="button" onclick="copyContributorLinkCode()">코드 복사</button>
            <button class="contributor-status-btn primary" type="button" onclick="PurpleBeeContributorUI.verifyLink()">연동 확인</button>
          </div>
        </div>
      `;
      return;
    }

    if (state.step === 3) {
      const profile = (state.status?.devices || [])[0]?.hardware || state.profile || {};
      const recommended = recommendPlan(profile);
      root.innerHTML = `
        <div class="contributor-status-card">
          <div class="contributor-status-title">3단계 · PC 성능 확인</div>
          <div class="contributor-status-copy">연동된 기기 기준으로 추천 플랜을 계산합니다.</div>
          ${renderSteps(3)}
          <div class="contributor-status-grid">
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">CPU</div>
              <div class="contributor-status-stat-value">${safe(String(profile.cpu_threads || 0))}</div>
              <div class="contributor-status-stat-copy">논리 스레드</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">RAM</div>
              <div class="contributor-status-stat-value">${safe(String(profile.memory_gb || 0))}GB</div>
              <div class="contributor-status-stat-copy">연결된 기기 기준</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">GPU</div>
              <div class="contributor-status-stat-value">${safe(trim(profile.gpu_name || "미확인") || "미확인")}</div>
              <div class="contributor-status-stat-copy">가능한 경우 표시</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">추천 플랜</div>
              <div class="contributor-status-stat-value">${safe(recommended)}</div>
              <div class="contributor-status-stat-copy">${safe(PLAN_COPY[recommended].headline)}</div>
            </div>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn primary" type="button" onclick="PurpleBeeContributorUI.gotoStep(4)">플랜 선택으로 이동</button>
          </div>
        </div>
      `;
      return;
    }

    const plan = state.selectedPlan;
    const modes = computeModes(plan);
    const currentMode = localStorage.getItem("pb_contributor_compute_mode") || "local";
    root.innerHTML = `
      <div class="contributor-status-card">
        <div class="contributor-status-title">4단계 · 플랜 선택과 예약</div>
        <div class="contributor-status-copy">결제가 아니라 기여 시간으로 플랜을 유지합니다. 원하는 플랜을 고른 뒤 예약을 저장하세요.</div>
        ${renderSteps(4)}
        <div class="contributor-plan-grid">${renderPlanCards()}</div>
        <div class="contributor-status-fields">
          <div class="contributor-status-field">
            <label>예약 시간 (시간)</label>
            <input id="contributor-hours-input" type="number" min="1" step="1" value="${safe(String(state.selectedHours))}">
          </div>
          <div class="contributor-status-field">
            <label>다음 시작 시각</label>
            <input id="contributor-starts-at-input" type="datetime-local" value="${safe(new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 16))}">
          </div>
          <div class="contributor-status-field">
            <label>연산 모드</label>
            <select id="contributor-compute-mode-select" onchange="updateContributorComputeMode(this.value)">
              ${modes.map((mode) => `<option value="${mode.value}"${mode.value === currentMode ? " selected" : ""}>${safe(mode.name)}</option>`).join("")}
            </select>
          </div>
          <div class="contributor-status-field">
            <label>CPU 상한 (%)</label>
            <input id="contributor-cpu-cap-input" type="number" min="20" max="90" step="5" value="70">
          </div>
          <div class="contributor-status-field">
            <label>GPU 상한 (%)</label>
            <input id="contributor-gpu-cap-input" type="number" min="20" max="90" step="5" value="70">
          </div>
        </div>
        <div class="contributor-status-actions">
          <button class="contributor-status-btn primary" type="button" onclick="reserveContributorPlan()">이 플랜으로 예약 저장</button>
        </div>
      </div>
    `;
  }

  function renderStatus() {
    setHubMode("status");
    const root = $("contributor-hub-section-status");
    if (!root) return;
    const status = state.status || {};
    const plan = planName(status?.account?.plan || "Free");
    const linked = +(status.linked_device_count || 0) > 0;
    const mode = localStorage.getItem("pb_contributor_compute_mode") || "local";
    const modeMeta = computeModes(plan).find((item) => item.value === mode) || computeModes(plan)[0];

    root.innerHTML = `
      <div class="contributor-status-shell">
        <section class="contributor-status-card">
          <div class="contributor-status-title">기여 구독 상태</div>
          <div class="contributor-status-copy">현재 플랜과 연결된 기기, 다음 예약만 간단하게 보여드립니다.</div>
          <div class="contributor-status-grid">
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">플랜</div>
              <div class="contributor-status-stat-value">${safe(plan)}</div>
              <div class="contributor-status-stat-copy">${safe(PLAN_COPY[plan].headline)}</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">프리미엄</div>
              <div class="contributor-status-stat-value">${safe(status.premium_active ? "활성" : "비활성")}</div>
              <div class="contributor-status-stat-copy">${safe(linked ? "기기 연결됨" : "연동 필요")}</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">큐</div>
              <div class="contributor-status-stat-value">${safe(queueLabel(status.queue_mode || status?.account?.latest_quote?.queue_mode || ""))}</div>
              <div class="contributor-status-stat-copy">${safe(modeMeta.desc)}</div>
            </div>
            <div class="contributor-status-stat">
              <div class="contributor-status-stat-label">다음 기여</div>
              <div class="contributor-status-stat-value">${safe(status.next_reservation ? formatDate(status.next_reservation.starts_at) : "없음")}</div>
              <div class="contributor-status-stat-copy">${safe(status.next_reservation ? "예약이 저장되어 있습니다." : "아직 예약이 없습니다.")}</div>
            </div>
          </div>
          <div class="contributor-status-banner">
            <strong>연결된 기기</strong>
            <p>${safe(deviceSummary(status))}</p>
          </div>
          <div class="contributor-status-actions">
            <button class="contributor-status-btn" type="button" onclick="downloadContributorApp()">앱 다운로드</button>
            <button class="contributor-status-btn" type="button" onclick="copyContributorLinkCode()">연동 코드</button>
            <button class="contributor-status-btn primary" type="button" onclick="PurpleBeeContributorUI.jumpToSetup()">${safe(linked ? "예약 변경" : "앱 설치 이어서")}</button>
          </div>
        </section>
        <section class="contributor-status-card">
          <div class="contributor-status-detail">
            <div class="contributor-status-detail-item">
              <strong>연결 상태</strong>
              <p>${safe(linked ? "기여 앱이 계정과 연결되어 있습니다." : "앱 설치 뒤 연동 코드를 입력해 연결을 완료해 주세요.")}</p>
            </div>
            <div class="contributor-status-detail-item">
              <strong>연산 모드</strong>
              <p>${safe(modeMeta.name)} · ${safe(modeMeta.desc)}</p>
            </div>
            <div class="contributor-status-detail-item">
              <strong>유지 조건</strong>
              <p>${safe(PLAN_COPY[plan].headline)}</p>
            </div>
            <div class="contributor-status-detail-item">
              <strong>다음 단계</strong>
              <p>${safe(linked ? "필요하면 예약 시간과 연산 모드를 다시 조정하세요." : "먼저 앱 설치와 사이트 연동을 완료하세요.")}</p>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function recommendPlan(profile) {
    const cpu = +(profile?.cpu_threads || 0);
    const memory = +(profile?.memory_gb || 0);
    if (cpu >= 12 && memory >= 16) return "Pro";
    if (cpu >= 8 && memory >= 8) return "Plus";
    return "Basic";
  }

  function openUpgradePage(event) {
    event?.preventDefault?.();
    $("contributor-hub-backdrop")?.classList.add("open");
    state.step = 0;
    renderPlans();
  }

  async function openContributorHub(mode) {
    $("contributor-hub-backdrop")?.classList.add("open");
    if (mode === "status") {
      try {
        await fetchStatus();
      } catch {
        // keep previous state if the refresh fails
      }
      renderStatus();
      return;
    }
    renderPlans();
  }

  function closeContributorHub(event) {
    if (event?.target && event.target.id !== "contributor-hub-backdrop") return;
    $("contributor-hub-backdrop")?.classList.remove("open");
  }

  function selectContributorPlan(plan) {
    state.selectedPlan = planName(plan);
    state.selectedHours = state.selectedPlan === "Basic" ? 8 : state.selectedPlan === "Plus" ? 40 : 80;
    localStorage.setItem("pb_selected_contributor_plan", state.selectedPlan);
    localStorage.setItem("pb_selected_contributor_hours", String(state.selectedHours));
    renderPlans();
  }

  function updateContributorComputeMode(mode) {
    localStorage.setItem("pb_contributor_compute_mode", mode);
  }

  async function downloadContributorApp() {
    if (!currentUser()) {
      toast("Google 로그인 후 진행해 주세요.");
      return;
    }
    try {
      await ensureLinkCode();
      state.installClicked = true;
      const anchor = document.createElement("a");
      anchor.href = "/static/downloads/PurpleBeeContributor.exe?v=20260408c";
      anchor.download = "PurpleBeeContributor.exe";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast("기여 앱 다운로드를 시작했어요.");
      if (state.step < 2) {
        state.step = 2;
        renderPlans();
      }
    } catch {
      toast("기여 앱을 내려받지 못했어요.");
    }
  }

  function copyContributorLinkCode() {
    if (!state.linkCode) {
      toast("먼저 앱 다운로드를 시작해 주세요.");
      return;
    }
    navigator.clipboard?.writeText(state.linkCode)
      .then(() => toast("연동 코드를 복사했어요."))
      .catch(() => toast(state.linkCode));
  }

  async function verifyLink() {
    try {
      await ensureLinkCode();
      await fetchStatus();
      if (+(state.status?.linked_device_count || 0) > 0) {
        await detectProfile();
        state.step = 3;
        renderPlans();
        await refreshSidebar();
        toast("기기 연동이 확인됐어요.");
        return;
      }
      toast("앱에 연동 코드를 입력한 뒤 다시 확인해 주세요.");
    } catch {
      toast("연동 상태를 아직 확인하지 못했어요.");
    }
  }

  async function reserveContributorPlan() {
    if (!currentUser()) {
      toast("Google 로그인 후 진행해 주세요.");
      return;
    }
    if (!(+(state.status?.linked_device_count || 0) > 0)) {
      toast("기여 앱 설치와 연동 확인이 먼저 필요해요.");
      return;
    }
    state.selectedHours = Math.max(+( $("contributor-hours-input")?.value || state.selectedHours || 8), 1);
    localStorage.setItem("pb_selected_contributor_hours", String(state.selectedHours));

    try {
      const response = await fetch("/api/contributor/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: contributorUserId(),
          display_name: trim(currentUser()?.name || currentUser()?.email),
          plan: state.selectedPlan,
          hours: state.selectedHours,
          starts_at: trim($("contributor-starts-at-input")?.value),
          cpu_cap: Math.max(20, Math.min(90, +($("contributor-cpu-cap-input")?.value || 70))),
          gpu_cap: Math.max(20, Math.min(90, +($("contributor-gpu-cap-input")?.value || 70))),
          device_profile: state.profile || await detectProfile(),
        }),
      });
      const payload = await response.json();
      if (!payload?.ok) {
        toast(payload?.message || "기여 예약을 저장하지 못했어요.");
        return;
      }
      toast("기여 예약을 저장했어요.");
      await fetchStatus();
      await refreshSidebar();
      closeContributorHub();
      openContributorHub("status");
    } catch {
      toast("기여 예약을 저장하지 못했어요.");
    }
  }

  function nextFromTerms() {
    if (!consentsAccepted()) {
      if (typeof window.openConsentModal === "function") {
        window.openConsentModal();
      }
      toast("필수 동의 3가지를 먼저 완료해 주세요.");
      return;
    }
    state.step = 1;
    renderPlans();
  }

  function gotoStep(step) {
    state.step = step;
    if (step === 2 && !state.linkCode) {
      ensureLinkCode().then(() => renderPlans()).catch(() => renderPlans());
      return;
    }
    renderPlans();
  }

  function jumpToSetup() {
    state.step = +(state.status?.linked_device_count || 0) > 0 ? 4 : 1;
    setHubMode("plans");
    renderPlans();
  }

  Object.assign(window, {
    openUpgradePage,
    openContributorHub,
    closeContributorHub,
    selectContributorPlan,
    updateContributorComputeMode,
    downloadContributorApp,
    copyContributorLinkCode,
    reserveContributorPlan,
  });
  window.PurpleBeeContributorUI = {
    nextFromTerms,
    gotoStep,
    verifyLink,
    jumpToSetup,
    refreshSidebar,
  };

  setTimeout(() => {
    refreshSidebar().catch(() => {});
    setInterval(() => {
      refreshSidebar().catch(() => {});
      const statusSection = $("contributor-hub-section-status");
      const backdrop = $("contributor-hub-backdrop");
      if (backdrop?.classList.contains("open") && statusSection?.classList.contains("active")) {
        fetchStatus().then(renderStatus).catch(() => {});
      }
    }, 15000);
  }, 0);
})();
