(function () {
  const $ = (id) => document.getElementById(id);
  const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } };
  const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const trim = (v) => String(v ?? "").trim();
  const safe = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const toast = (m) => { if (typeof window.showToast === "function") window.showToast(m); };
  const user = () => readJson("pb_user_v1") || readJson("pb_user_backup_v1");
  const uid = () => {
    const u = user();
    const saved = trim(localStorage.getItem("pb_contributor_user_id"));
    const id = trim(u && (u.sub || u.email || u.id)) || saved || `pb_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("pb_contributor_user_id", id);
    return id;
  };
  const uname = () => trim((user() || {}).name || (user() || {}).email || "Purple Bee User");
  const hasConsent = () => {
    const c = readJson("pb_required_consents_v1") || {};
    return !!(c.terms && c.resource && c.privacy);
  };
  const PLAN = {
    Free: { badge: "기본", headline: "유지 조건 없음", summary: "내 기기 연산만으로 시작합니다.", features: ["기본 AI 대화", "내 기기 연산", "기본 우선순위", "일일 사용량 제한"], hours: 0, mode: "local" },
    Basic: { badge: "입문", headline: "월 8시간 기여 유지", summary: "서버 보조 연산을 처음 여는 플랜입니다.", features: ["보조 연산 모드 선택", "응답 제한 완화", "기여 앱 사용 가능", "월 8시간 유지"], hours: 8, mode: "hybrid" },
    Plus: { badge: "추천", headline: "주 10시간 · 월 40시간 유지", summary: "더 빠른 응답과 넓은 사용 범위를 위한 플랜입니다.", features: ["상위 우선순위", "최신 모델 접근", "하이브리드 보조 연산", "주 10시간 / 월 40시간 유지"], hours: 40, mode: "distributed" },
    Pro: { badge: "최상위", headline: "주 20시간 · 월 80시간 유지", summary: "대형 작업과 최고 우선순위를 위한 플랜입니다.", features: ["최상위 우선순위", "긴 작업 처리", "강화 보조 연산 배정", "주 20시간 / 월 80시간 유지"], hours: 80, mode: "distributed" },
  };
  const MODES = {
    Free: [{ value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." }],
    Basic: [{ value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." }, { value: "hybrid", title: "내 기기 + 보조 연산", body: "내 기기를 우선 사용하고 부족할 때만 보조 연산을 붙입니다." }],
    Plus: [{ value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." }, { value: "hybrid", title: "내 기기 + 보조 연산", body: "내 기기를 중심으로 사용하고 처리량이 몰릴 때만 보조 연산을 붙입니다." }, { value: "distributed", title: "기여 네트워크 우선", body: "내 기기를 유지하면서 기여 네트워크 보조 연산 비중을 높입니다." }],
    Pro: [{ value: "local", title: "내 기기 연산", body: "모든 응답을 현재 기기에서만 처리합니다." }, { value: "hybrid", title: "내 기기 + 보조 연산", body: "내 기기와 기여 네트워크를 균형 있게 사용합니다." }, { value: "distributed", title: "기여 네트워크 우선", body: "상위 플랜에 맞춰 기여 네트워크 보조 연산을 적극 사용합니다." }],
  };
  const state = {
    mode: "plans",
    step: 0,
    status: null,
    linkCode: null,
    profile: null,
    selectedPlan: localStorage.getItem("pb_selected_contributor_plan") || "Basic",
    selectedMode: localStorage.getItem("pb_selected_compute_mode") || "hybrid",
    installClicked: !!readJson("pb_contributor_install_clicked_v1"),
    timer: null,
  };

  const api = async (url, options) => {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const err = new Error(body.message || body.error || "request_failed");
      err.payload = body;
      throw err;
    }
    return body;
  };
  const fmt = (value) => {
    if (!value) return "없음";
    try { return new Date(value).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return String(value); }
  };
  const pname = (raw) => Object.prototype.hasOwnProperty.call(PLAN, trim(raw)) ? trim(raw) : "Free";
  const currentPlan = () => pname(state.status?.account?.plan || "Free");
  const linkedCount = () => Number(state.status?.linked_device_count || 0);
  const linkedSummary = () => trim(state.status?.exact_device_summary || "") || (linkedCount() > 0 ? `연결된 기기 ${linkedCount()}대` : "연결된 기기 없음");
  const nextReservation = () => (state.status?.reservations || []).find((r) => r.status === "scheduled");
  const lockInfo = (target) => {
    const until = trim(state.status?.plan_change_locked_until || "");
    const current = currentPlan();
    const requested = pname(target || current);
    const locked = !!until && requested !== current && requested !== "Free";
    return { locked, text: locked ? `플랜은 한 달에 한 번만 변경할 수 있어요. 다음 변경 가능 시각은 ${fmt(until)} 입니다.` : "" };
  };

  async function refreshStatus(render) {
    try {
      state.status = await api(`/api/contributor/status?user_id=${encodeURIComponent(uid())}`);
    } catch (e) {
      console.warn("[Purple Bee][Contributor]", e);
    }
    try {
      const storage = await navigator.storage?.estimate?.().catch(() => null);
      state.profile = {
        cpu_threads: Number(navigator.hardwareConcurrency || 0),
        memory_gb: Number(navigator.deviceMemory || 0),
        storage_free_gb: storage?.quota ? Math.max((storage.quota - (storage.usage || 0)) / 1073741824, 0) : 0,
      };
    } catch {}
    updateSidebar();
    if (render) renderModal();
  }

  function updateSidebar() {
    const upgrade = $("upgrade-plan-btn");
    const card = $("contributor-card");
    if (!upgrade || !card) return;
    const loggedIn = !!user();
    const plan = currentPlan();
    upgrade.classList.toggle("hidden", loggedIn && plan !== "Free");
    card.classList.toggle("hidden", !loggedIn || plan === "Free");
    $("upgrade-plan-title").textContent = "⚡ 플랜 업그레이드";
    $("upgrade-plan-sub").textContent = "기여 시간 기준 플랜과 유지 조건을 비교해 보세요.";
    $("contributor-card-title").textContent = "✨ 기여 구독 상태";
    $("contributor-card-sub").textContent = "앱 연결과 다음 예약만 간략하게 확인합니다.";
    $("contributor-card-pill").textContent = plan;
    $("contributor-plan-value").textContent = plan;
    $("contributor-premium-value").textContent = state.status?.premium_active ? "활성" : "비활성";
    $("contributor-queue-value").textContent = trim(state.status?.account?.contributor_status || "standard");
    $("contributor-next-value").textContent = nextReservation() ? fmt(nextReservation().starts_at) : "없음";
    $("contributor-card-note").textContent = plan === "Free" ? "Free에서는 내 기기 연산만 사용합니다." : "앱 설치와 연동이 끝나면 다음 기여 시간과 유지 조건을 여기서 확인할 수 있습니다.";
    $("contributor-device-value").textContent = linkedSummary();
    $("contributor-card-hint").textContent = plan === "Free" ? "플랜 업그레이드에서 기여 구독을 시작하세요." : "눌러서 기여 앱 연결과 예약 상태를 확인하세요.";
  }

  function startPolling() { stopPolling(); state.timer = setInterval(() => refreshStatus(true), 15000); }
  function stopPolling() { if (state.timer) clearInterval(state.timer); state.timer = null; }
  function openBackdrop(title, subtitle, mode) {
    state.mode = mode;
    $("contributor-hub-title").textContent = title;
    $("contributor-hub-subtitle").textContent = subtitle;
    $("contributor-hub-backdrop").classList.add("open");
    $("contributor-hub-section-plans").classList.toggle("active", mode === "plans");
    $("contributor-hub-section-status").classList.toggle("active", mode === "status");
    startPolling();
  }
  function closeContributorHub(event) {
    if (event?.target && event.target !== $("contributor-hub-backdrop")) return;
    $("contributor-hub-backdrop").classList.remove("open");
    stopPolling();
  }
  function detectStep() {
    if (!hasConsent()) return 0;
    if (!state.installClicked) return 1;
    if (linkedCount() <= 0) return 2;
    if (!state.profile) return 3;
    return 4;
  }
  function recommendPlan() {
    const cpu = Number(state.profile?.cpu_threads || 0), ram = Number(state.profile?.memory_gb || 0);
    if (cpu >= 12 && ram >= 16) return "Pro";
    if (cpu >= 8 && ram >= 8) return "Plus";
    if (cpu >= 4 && ram >= 4) return "Basic";
    return "Free";
  }
  function renderStepCard(i, title, copy) {
    const done = state.step > i || (i === 0 && hasConsent()) || (i === 1 && state.installClicked) || (i === 2 && linkedCount() > 0) || (i === 3 && !!state.profile);
    return `<div class="contributor-status-step" ${state.step === i ? 'style="border-color:rgba(139,92,246,.5);box-shadow:0 10px 30px rgba(139,92,246,.12)"' : ""}><span class="contributor-status-step-chip">${done ? "✓" : i + 1}</span><strong>${safe(title)}</strong><p>${safe(copy)}</p></div>`;
  }
  function renderPlanCards() {
    const plan = currentPlan();
    const lock = lockInfo(state.selectedPlan);
    return Object.entries(PLAN).map(([name, meta]) => {
      const selected = name === state.selectedPlan;
      const current = name === plan;
      const disabled = lock.locked && name !== plan && name !== "Free";
      const button = name === "Free" ? "기본 플랜" : current ? "현재 플랜" : disabled ? "이번 달 변경 잠금" : "이 플랜 선택";
      return `<article class="contributor-plan-card ${selected ? "active" : ""}"><div class="contributor-plan-head"><div class="contributor-plan-name">${safe(name)}</div><span class="contributor-plan-badge">${safe(meta.badge)}</span></div><div class="contributor-plan-price">${safe(meta.headline)}</div><div class="contributor-plan-copy">${safe(meta.summary)}</div><button class="contributor-plan-btn" type="button" ${disabled ? "disabled" : ""} onclick="selectContributorPlan('${safe(name)}')">${safe(button)}</button><ul class="contributor-plan-list">${meta.features.map((f) => `<li>${safe(f)}</li>`).join("")}</ul><div class="contributor-plan-foot">${name === "Free" ? "유지 조건 없이 바로 사용할 수 있습니다." : "유지 조건을 충족하면 이 플랜을 유지합니다."}</div></article>`;
    }).join("");
  }
  function computeModeOptions() {
    return (MODES[pname(state.selectedPlan)] || MODES.Free).map((m) => `<option value="${safe(m.value)}" ${state.selectedMode === m.value ? "selected" : ""}>${safe(m.title)}</option>`).join("");
  }
  function computeModeDesc() {
    return (MODES[pname(state.selectedPlan)] || MODES.Free).find((m) => m.value === state.selectedMode)?.body || "";
  }
  function defaultStart() {
    const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderPlans() {
    const footLeft = $("contributor-hub-foot-left");
    const footRight = $("contributor-hub-foot-right");
    const section = $("contributor-hub-section-plans");
    const lock = lockInfo(state.selectedPlan);
    section.innerHTML = `
      <div class="contributor-status-card">
        <div class="contributor-status-title">플랜 업그레이드</div>
        <div class="contributor-status-copy">기여 시간으로 유지하는 플랜을 단계별로 설정합니다.</div>
        <div class="contributor-status-steps">
          ${renderStepCard(0, "약관 확인", "필수 동의 3종을 먼저 확인합니다.")}
          ${renderStepCard(1, "앱 설치", "설치 마법사를 내려받아 설치합니다.")}
          ${renderStepCard(2, "연동 확인", "앱과 웹사이트를 연결합니다.")}
          ${renderStepCard(3, "PC 성능 확인", "현재 연결 상태와 기기 수준을 살펴봅니다.")}
          ${renderStepCard(4, "플랜 선택", "이번 달 플랜을 선택하고 예약합니다.")}
        </div>
        ${state.step === 0 ? `<div class="contributor-status-banner"><strong>약관과 자원 사용 범위를 먼저 확인해 주세요.</strong><p>기여 앱 설치 전, 자원 사용 조건과 책임 범위를 확인해야 다음 단계로 넘어갈 수 있습니다.</p></div><div class="contributor-status-actions"><button class="contributor-status-btn" type="button" onclick="openConsentDocs()">정책 문서 보기</button><button class="contributor-status-btn primary" type="button" onclick="continueContributorTerms()">동의 확인하고 계속</button></div>` : ""}
        ${state.step === 1 ? `<div class="contributor-status-banner"><strong>기여 앱 설치</strong><p>작은 Setup.exe 설치 파일을 내려받은 뒤 더블클릭하면 설치 마법사가 시작됩니다.</p></div><div class="contributor-status-actions"><button class="contributor-status-btn primary" type="button" onclick="downloadContributorApp()">기여 앱 설치 파일 받기</button><button class="contributor-status-btn" type="button" onclick="markContributorInstalled()">설치 완료 후 다음</button></div>` : ""}
        ${state.step === 2 ? `<div class="contributor-status-grid"><div class="contributor-status-stat"><div class="contributor-status-stat-label">연동 코드</div><div class="contributor-status-stat-value">${safe(state.linkCode?.code || "발급 중")}</div><div class="contributor-status-stat-copy">앱 첫 화면에 이 코드를 넣어 계정을 연결해 주세요.</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">연결된 기기</div><div class="contributor-status-stat-value">${linkedCount()}</div><div class="contributor-status-stat-copy">${safe(linkedSummary())}</div></div></div><div class="contributor-status-actions"><button class="contributor-status-btn" type="button" onclick="copyContributorLinkCode()">연동 코드 복사</button><button class="contributor-status-btn primary" type="button" onclick="verifyContributorLink()">연동 확인</button></div>` : ""}
        ${state.step === 3 ? `<div class="contributor-status-grid"><div class="contributor-status-stat"><div class="contributor-status-stat-label">CPU 스레드</div><div class="contributor-status-stat-value">${Number(state.profile?.cpu_threads || 0) >= 4 ? "✓" : "✕"} ${safe(String(state.profile?.cpu_threads || 0))}</div><div class="contributor-status-stat-copy">4 이상이면 안정적입니다.</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">메모리</div><div class="contributor-status-stat-value">${Number(state.profile?.memory_gb || 0) >= 8 ? "✓" : "✕"} ${safe(String(state.profile?.memory_gb || 0))} GB</div><div class="contributor-status-stat-copy">8GB 이상 권장</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">남은 저장 공간</div><div class="contributor-status-stat-value">${Number(state.profile?.storage_free_gb || 0) >= 4 ? "✓" : "✕"} ${safe(Number(state.profile?.storage_free_gb || 0).toFixed(1))} GB</div><div class="contributor-status-stat-copy">4GB 이상 권장</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">추천 플랜</div><div class="contributor-status-stat-value">${safe(recommendPlan())}</div><div class="contributor-status-stat-copy">현재 기기 상태 기준 추천</div></div></div><div class="contributor-status-actions"><button class="contributor-status-btn primary" type="button" onclick="goContributorStep(4)">다음 단계로</button></div>` : ""}
        ${state.step === 4 ? `${lock.locked ? `<div class="contributor-status-banner"><strong>이번 달 플랜 변경 잠금</strong><p>${safe(lock.text)}</p></div>` : ""}<div class="contributor-plan-grid">${renderPlanCards()}</div><div class="contributor-status-card" style="margin-top:16px;border-style:dashed"><div class="contributor-status-title" style="font-size:22px">선택한 플랜 설정</div><div class="contributor-status-copy">플랜은 한 달에 한 번만 변경할 수 있고, 취소는 언제든 가능합니다.</div><div class="contributor-status-fields"><div class="contributor-status-field"><label>선택 플랜</label><input type="text" value="${safe(state.selectedPlan)}" disabled></div><div class="contributor-status-field"><label>유지 조건</label><input type="text" value="${safe(PLAN[pname(state.selectedPlan)].headline)}" disabled></div><div class="contributor-status-field"><label>연산 모드</label><select onchange="updateContributorComputeMode(this.value)">${computeModeOptions()}</select></div><div class="contributor-status-field"><label>다음 예약 시작</label><input id="contributor-starts-at" type="datetime-local" value="${defaultStart()}"></div><div class="contributor-status-field full"><label>연산 모드 설명</label><input type="text" value="${safe(computeModeDesc())}" disabled></div></div><div class="contributor-status-actions"><button class="contributor-status-btn primary" type="button" ${lock.locked ? "disabled" : ""} onclick="reserveContributorPlan()">${state.selectedPlan === "Free" ? "기본 플랜 유지" : `${safe(state.selectedPlan)} 예약 저장`}</button><button class="contributor-status-btn" type="button" ${currentPlan() === "Free" && !nextReservation() ? "disabled" : ""} onclick="cancelContributorPlan()">플랜 취소</button></div></div>` : ""}
      </div>`;
    footLeft.textContent = state.step < 4 ? "각 단계가 끝나면 다음 단계로 이어집니다." : "플랜은 한 달에 한 번만 변경할 수 있고, 취소는 언제든 가능합니다.";
    footRight.textContent = state.step < 4 ? "연동 상태는 자동으로 갱신됩니다." : "예약 저장 후 상태 화면에서 유지 조건을 다시 확인할 수 있습니다.";
  }

  function renderStatus() {
    $("contributor-hub-section-status").innerHTML = `<div class="contributor-status-shell"><div class="contributor-status-card"><div class="contributor-status-title">기여 구독 상태</div><div class="contributor-status-copy">현재 플랜, 앱 연결 상태, 다음 예약만 간결하게 보여줍니다.</div><div class="contributor-status-grid"><div class="contributor-status-stat"><div class="contributor-status-stat-label">현재 플랜</div><div class="contributor-status-stat-value">${safe(currentPlan())}</div><div class="contributor-status-stat-copy">${safe(PLAN[currentPlan()].headline)}</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">프리미엄</div><div class="contributor-status-stat-value">${state.status?.premium_active ? "활성" : "비활성"}</div><div class="contributor-status-stat-copy">${state.status?.account?.premium_until ? `${fmt(state.status.account.premium_until)} 까지` : "유지 시간이 확인되면 자동 활성화됩니다."}</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">연결된 기기</div><div class="contributor-status-stat-value">${linkedCount()}</div><div class="contributor-status-stat-copy">${safe(linkedSummary())}</div></div><div class="contributor-status-stat"><div class="contributor-status-stat-label">다음 예약</div><div class="contributor-status-stat-value">${nextReservation() ? fmt(nextReservation().starts_at) : "없음"}</div><div class="contributor-status-stat-copy">${nextReservation() ? `${safe(nextReservation().plan)} · ${safe(String(nextReservation().hours))}시간` : "예약을 저장하면 여기에 표시됩니다."}</div></div></div><div class="contributor-status-actions"><button class="contributor-status-btn primary" type="button" onclick="jumpToContributorSetup()">설치 / 연동 진행</button><button class="contributor-status-btn" type="button" onclick="openUpgradePage()">플랜 업그레이드</button><button class="contributor-status-btn" type="button" ${currentPlan() === "Free" && !nextReservation() ? "disabled" : ""} onclick="cancelContributorPlan()">플랜 취소</button></div></div><div class="contributor-status-card"><div class="contributor-status-title" style="font-size:22px">현재 연산 모드</div><div class="contributor-status-banner"><strong>${safe((MODES[currentPlan()] || MODES.Free).find((m) => m.value === state.selectedMode)?.title || "내 기기 연산")}</strong><p>${safe(computeModeDesc())}</p></div><div class="contributor-status-detail"><div class="contributor-status-detail-item"><strong>기여 앱 상태</strong><p>${linkedCount() > 0 ? "앱 연동이 확인되었습니다. 예약과 유지 조건을 이 화면에서 계속 확인할 수 있습니다." : "먼저 기여 앱 설치와 연동을 완료해야 보조 연산을 사용할 수 있습니다."}</p></div><div class="contributor-status-detail-item"><strong>플랜 정책</strong><p>유료 플랜은 한 달에 한 번만 변경할 수 있습니다. 취소는 언제든 할 수 있지만, 다음 변경 가능 시각은 그대로 유지됩니다.</p></div></div></div></div>`;
    $("contributor-hub-foot-left").textContent = "기여 앱 연결 상태와 다음 예약을 이 화면에서 간단히 확인할 수 있습니다.";
    $("contributor-hub-foot-right").textContent = "상태는 자동으로 갱신됩니다.";
  }
  function renderModal() { if (state.mode === "plans") renderPlans(); else renderStatus(); }

  async function openUpgradePage(event) {
    if (event?.preventDefault) event.preventDefault();
    await refreshStatus(false);
    state.step = detectStep();
    openBackdrop("플랜 업그레이드", "기여 시간 기반 플랜을 단계별로 설정합니다.", "plans");
    renderModal();
  }
  async function openContributorHub(mode) {
    await refreshStatus(false);
    openBackdrop(mode === "status" ? "기여 구독 상태" : "플랜 업그레이드", mode === "status" ? "앱 연결과 다음 예약만 간단히 확인합니다." : "기여 시간 기반 플랜을 단계별로 설정합니다.", mode === "status" ? "status" : "plans");
    if (mode !== "status") state.step = detectStep();
    renderModal();
  }
  function continueContributorTerms() {
    if (!hasConsent()) {
      if (typeof window.openConsentModal === "function") window.openConsentModal();
      toast("필수 동의를 먼저 완료해 주세요.");
      return;
    }
    state.step = 1;
    renderModal();
  }
  function markContributorInstalled() {
    state.installClicked = true;
    writeJson("pb_contributor_install_clicked_v1", true);
    state.step = 2;
    renderModal();
  }
  async function downloadContributorApp() {
    const a = document.createElement("a");
    a.href = `/api/contributor/client/download?user_id=${encodeURIComponent(uid())}&display_name=${encodeURIComponent(uname())}`;
    a.download = "PurpleBeeContributorSetup.exe";
    document.body.appendChild(a);
    a.click();
    a.remove();
    state.installClicked = true;
    writeJson("pb_contributor_install_clicked_v1", true);
    toast("설치 파일 다운로드를 시작했어요. 설치가 끝나면 다음 단계로 진행해 주세요.");
  }
  async function ensureCode() {
    if (state.linkCode?.code) return state.linkCode;
    const body = await api("/api/contributor/link-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: uid(), display_name: uname(), plan: state.selectedPlan }) });
    state.linkCode = body.link_code;
    return state.linkCode;
  }
  async function copyContributorLinkCode() {
    const code = (await ensureCode())?.code;
    if (!code) return toast("연동 코드를 아직 발급하지 못했어요.");
    try { await navigator.clipboard.writeText(code); toast("연동 코드를 복사했어요."); } catch { toast(`연동 코드: ${code}`); }
  }
  async function verifyContributorLink() {
    await refreshStatus(false);
    if (linkedCount() > 0) {
      state.step = 3;
      renderModal();
      toast("기여 앱 연동이 확인됐어요.");
    } else {
      await ensureCode();
      toast("아직 앱 연동이 확인되지 않았어요. 앱에 코드를 입력한 뒤 다시 확인해 주세요.");
      renderModal();
    }
  }
  function goContributorStep(step) { state.step = Math.max(0, Math.min(4, Number(step) || 0)); renderModal(); }
  function jumpToContributorSetup() { state.mode = "plans"; state.step = detectStep(); $("contributor-hub-section-plans").classList.add("active"); $("contributor-hub-section-status").classList.remove("active"); $("contributor-hub-title").textContent = "플랜 업그레이드"; $("contributor-hub-subtitle").textContent = "설치와 연동을 완료한 뒤 플랜을 선택합니다."; renderModal(); }
  function selectContributorPlan(plan) { state.selectedPlan = pname(plan); state.selectedMode = PLAN[state.selectedPlan].mode; localStorage.setItem("pb_selected_contributor_plan", state.selectedPlan); localStorage.setItem("pb_selected_compute_mode", state.selectedMode); renderModal(); }
  function updateContributorComputeMode(value) { state.selectedMode = trim(value) || PLAN[state.selectedPlan].mode; localStorage.setItem("pb_selected_compute_mode", state.selectedMode); renderModal(); }
  async function reserveContributorPlan() {
    try {
      const startsAt = $("contributor-starts-at")?.value || defaultStart();
      const body = await api("/api/contributor/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: uid(), display_name: uname(), plan: state.selectedPlan, hours: PLAN[pname(state.selectedPlan)].hours, starts_at: new Date(startsAt).toISOString(), cpu_cap: 70, gpu_cap: 70, device_profile: state.profile || {}, compute_mode: state.selectedMode }) });
      state.status = body.status || state.status;
      updateSidebar();
      openContributorHub("status");
      toast(body.message || "예약을 저장했어요.");
    } catch (e) {
      toast(e?.payload?.message || e.message || "예약 저장에 실패했어요.");
    }
  }
  async function cancelContributorPlan() {
    try {
      const body = await api("/api/contributor/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: uid() }) });
      state.status = body.status || state.status;
      updateSidebar();
      openContributorHub("status");
      toast(body.message || "플랜을 취소했어요.");
    } catch (e) {
      toast(e?.payload?.message || e.message || "플랜 취소에 실패했어요.");
    }
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && $("contributor-hub-backdrop")?.classList.contains("open")) refreshStatus(true); });
  Object.assign(window, { openUpgradePage, openContributorHub, closeContributorHub, continueContributorTerms, downloadContributorApp, markContributorInstalled, copyContributorLinkCode, verifyContributorLink, goContributorStep, jumpToContributorSetup, selectContributorPlan, updateContributorComputeMode, reserveContributorPlan, cancelContributorPlan });
  refreshStatus(false);
})();
