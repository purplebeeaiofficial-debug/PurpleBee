(function () {
  const strings = {
    ko: {
      upgradeTitle: '⚡ 플랜 업그레이드',
      upgradeSub: '월간 플랜만 비교하고 바로 선택할 수 있어요.',
      upgradeCardTitle: '플랜 업그레이드',
      upgradeCardSub: 'Free, Basic, Plus, Pro 월간 플랜을 확인합니다.',
      statusCardTitle: '✨ 기여 구독 상태',
      statusCardSub: '앱 설치와 연결 상태를 간단히 확인합니다.',
      freePlan: 'Free', active: '활성', inactive: '비활성', none: '없음',
      plan: '플랜', premium: '프리미엄', queue: '큐', nextWindow: '다음 기여', computeMode: '연산 모드', linkedDevice: '연결된 기기',
      noDevice: '연결된 기기가 없습니다.',
      cardHint: '앱 설치와 연동이 끝나면 예약을 이어서 진행할 수 있어요.',
      freeCardNote: 'Free에서는 내 기기 연산만 사용합니다.',
      paidCardNote: '기여 앱 설치와 연동이 완료되면 예약과 보조 연산 모드를 사용할 수 있어요.',
      plansModalTitle: '플랜 업그레이드',
      plansModalSub: '월간 플랜만 비교하고 선택합니다.',
      statusModalTitle: '기여 구독 상태',
      statusModalSub: '앱 설치부터 연동, 기기 확인, 예약까지 이 화면에서 진행합니다.',
      footerPlans: '플랜을 고른 뒤 기여 앱 설치와 연동 단계로 이어집니다.',
      footerStatus: '연결 상태는 자동으로 갱신됩니다.',
      currentPlan: '현재 플랜',
      beginFlow: '이 플랜 선택',
      currentUsing: '현재 이용 중',
      monthly: '월간',
      installTitle: '앱 설치',
      installCopy: '작은 설치 파일을 내려받아 더블클릭하면 설치 마법사가 시작됩니다.',
      linkedTitle: '사이트 연동',
      linkedCopy: '앱에 연동 코드를 붙여넣어 계정과 기기를 연결합니다.',
      hardwareTitle: '기기 확인',
      hardwareCopy: '연결된 앱이 CPU, GPU, RAM, 저장 공간을 읽어 안정적인 기여 범위를 계산합니다.',
      recommendationTitle: '추천 플랜',
      recommendationCopy: '연결된 기기 성능과 유지 조건을 기준으로 추천 플랜을 안내합니다.',
      reserveTitle: '기여 예약',
      reserveCopy: '기여 시간을 저장하면 구독 유지 조건을 관리할 수 있습니다.',
      appButton: '🧩 앱 설치하기',
      copyCodeButton: '🔑 연동 코드 복사',
      saveReservationButton: '📅 기여 예약 저장',
      localMode: '내 기기 연산',
      hybridMode: '내 기기 + 보조 연산',
      distributedMode: '보조 연산 우선',
      modeDescFree: 'Free에서는 내 기기 연산만 사용할 수 있습니다.',
      modeDescPaid: 'Basic 이상부터 보조 연산 모드를 선택할 수 있습니다.',
      selectedPlan: '선택한 플랜',
      monthlyHours: '월 기여 시간',
      startAt: '다음 시작 시각',
      cpuCap: 'CPU 상한 (%)',
      gpuCap: 'GPU 상한 (%)',
      maintenanceTarget: '유지 조건',
      recommendLabel: '추천',
      signInNeeded: 'Google 로그인 후 이용해 주세요.',
      appInstallStarted: '기여 앱 설치 파일 다운로드가 시작됐습니다.',
      appInstallFailed: '기여 앱 설치 파일을 내려받지 못했습니다.',
      linkCopied: '연동 코드를 복사했습니다.',
      generateCodeFirst: '앱 설치를 시작하면 연동 코드가 발급됩니다.',
      reservationSaved: '기여 예약을 저장했습니다.',
      reservationFailed: '기여 예약을 저장하지 못했습니다.',
      linkRequired: '기여 앱 설치와 연동을 먼저 완료해 주세요.',
      freeBadge: '기본', basicBadge: '입문', plusBadge: '추천', proBadge: '상위',
      plusRule: '주 10시간 · 월 40시간 유지',
      proRule: '주 20시간 · 월 80시간 유지',
      basicRule: '월 8시간 유지',
      freeRule: '월 유지 조건 없음',
      pricingFreeTitle: '가볍게 시작', pricingBasicTitle: '보조 연산 시작', pricingPlusTitle: '더 빠른 응답과 넓은 접근', pricingProTitle: '최상위 우선순위',
      pricingFreeCopy: '일상 질문과 기본 분석을 위한 시작 플랜입니다.',
      pricingBasicCopy: '내 기기 연산을 유지하면서 보조 연산을 함께 사용할 수 있습니다.',
      pricingPlusCopy: '가장 많이 선택하는 핵심 플랜입니다.',
      pricingProCopy: '대형 작업과 최고 우선순위를 위한 플랜입니다.',
      connectedAppNeeded: '기여 앱 설치와 연동이 완료된 뒤 예약을 진행할 수 있습니다.',
      freeOnlyUpgrade: 'Free에서는 월간 플랜 비교만 제공합니다.',
      statusPillActive: '연결됨', statusPillPending: '연동 필요', refreshAuto: '상태는 자동으로 갱신됩니다.',
      linkedOk: '연결 완료', linkedPending: '연결 전',
      deviceSummaryTitle: '연결 기기 요약',
      appNotInstalled: '기여 앱을 먼저 설치해 주세요.',
      stepInstall: '1. 앱 설치', stepLink: '2. 연동 확인', stepCheck: '3. PC 성능 확인', stepPlan: '4. 플랜 선택', stepReserve: '5. 예약 완료'
    },
    en: {
      upgradeTitle: '⚡ Upgrade plans', upgradeSub: 'Compare monthly plans only.', upgradeCardTitle: 'Upgrade plans', upgradeCardSub: 'Review Free, Basic, Plus, and Pro monthly plans.', statusCardTitle: '✨ Contributor status', statusCardSub: 'A compact view of app and link status.', freePlan: 'Free', active: 'Active', inactive: 'Inactive', none: 'None', plan: 'Plan', premium: 'Premium', queue: 'Queue', nextWindow: 'Next', computeMode: 'Compute mode', linkedDevice: 'Linked device', noDevice: 'No linked device yet.', cardHint: 'Install and link the app before saving contribution time.', freeCardNote: 'Free uses local compute only.', paidCardNote: 'Install and link the contributor app to enable reservations and assist modes.', plansModalTitle: 'Upgrade plans', plansModalSub: 'Compare monthly plans only.', statusModalTitle: 'Contributor status', statusModalSub: 'Install the app, confirm the link, check hardware, and save reservations here.', footerPlans: 'App setup starts after you choose a plan.', footerStatus: 'Status refreshes automatically.', currentPlan: 'Current plan', beginFlow: 'Choose this plan', currentUsing: 'Current plan', monthly: 'monthly', installTitle: 'Install app', installCopy: 'Download the small installer and double-click it to start the setup wizard.', linkedTitle: 'Link this site', linkedCopy: 'Paste the link code into the app to connect your account and device.', hardwareTitle: 'Check device', hardwareCopy: 'The linked app reads CPU, GPU, RAM, and storage to estimate a safe contribution range.', recommendationTitle: 'Recommended plan', recommendationCopy: 'A suggested plan appears after your device is linked.', reserveTitle: 'Reserve contribution', reserveCopy: 'Save contribution windows to maintain your plan.', appButton: '🧩 Install app', copyCodeButton: '🔑 Copy link code', saveReservationButton: '📅 Save reservation', localMode: 'Local compute', hybridMode: 'Local + assist', distributedMode: 'Assist-first', modeDescFree: 'Free uses local compute only.', modeDescPaid: 'Basic and above can choose assist modes.', selectedPlan: 'Selected plan', monthlyHours: 'Monthly hours', startAt: 'Next start time', cpuCap: 'CPU cap (%)', gpuCap: 'GPU cap (%)', maintenanceTarget: 'Maintenance target', recommendLabel: 'Recommended', signInNeeded: 'Sign in with Google first.', appInstallStarted: 'Contributor installer download started.', appInstallFailed: 'Could not download the contributor installer.', linkCopied: 'Link code copied.', generateCodeFirst: 'Start the app install first to create a link code.', reservationSaved: 'Reservation saved.', reservationFailed: 'Could not save reservation.', linkRequired: 'Install and link the contributor app first.', freeBadge: 'Base', basicBadge: 'Starter', plusBadge: 'Popular', proBadge: 'Top', plusRule: '10h/week · 40h/month', proRule: '20h/week · 80h/month', basicRule: '8h/month', freeRule: 'No maintenance required', pricingFreeTitle: 'Start light', pricingBasicTitle: 'Assist compute begins', pricingPlusTitle: 'Faster answers and broader access', pricingProTitle: 'Highest priority', pricingFreeCopy: 'A lightweight plan for everyday chat and basic analysis.', pricingBasicCopy: 'Keep local compute and add assist compute when needed.', pricingPlusCopy: 'The core plan with stronger priority and broader access.', pricingProCopy: 'For the highest priority and larger jobs.', connectedAppNeeded: 'Reservations open after the contributor app is installed and linked.', freeOnlyUpgrade: 'Free shows plan comparison only.', statusPillActive: 'Linked', statusPillPending: 'Needs link', refreshAuto: 'Status refreshes automatically.', linkedOk: 'Linked', linkedPending: 'Not linked', deviceSummaryTitle: 'Linked device', appNotInstalled: 'Install the contributor app first.', stepInstall: '1. Install app', stepLink: '2. Confirm link', stepCheck: '3. Check hardware', stepPlan: '4. Choose plan', stepReserve: '5. Finish reservation'
    }
  };

  function localeKey() { return (document.documentElement.lang || '').toLowerCase().startsWith('ko') ? 'ko' : 'en'; }
  function S() { return strings[localeKey()]; }
  function text(v) { return String(v == null ? '' : v).trim(); }
  function esc(v) { return text(v).replace(/[&<>"']/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]; }); }
  function safeJson(key) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_e) { return null; } }
  function getUser() { return safeJson('pb_user_v1') || safeJson('pb_user_backup_v1'); }
  function getUserId() {
    const user = getUser();
    const fallback = text(localStorage.getItem('pb_contributor_user_id'));
    const value = text(user && (user.sub || user.email || user.id)) || fallback || ('pb_' + Math.random().toString(36).slice(2, 10));
    localStorage.setItem('pb_contributor_user_id', value);
    return value;
  }
  function planName(v) { const lower = text(v).toLowerCase(); return lower === 'basic' ? 'Basic' : lower === 'plus' ? 'Plus' : lower === 'pro' ? 'Pro' : 'Free'; }
  function isPaidPlan(v) { return planName(v) !== 'Free'; }
  function toast(message) { if (typeof window.showToast === 'function') window.showToast(message); }
  function setNodeText(id, value) { const node = document.getElementById(id); if (node) node.textContent = value; }
  function formatDate(value) {
    if (!value) return S().none;
    try { return new Date(value).toLocaleString(localeKey() === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_e) { return String(value); }
  }
  function queueLabel(raw) {
    const lower = text(raw).toLowerCase();
    if (lower.includes('pro')) return localeKey() === 'ko' ? '최상위' : 'Top';
    if (lower.includes('plus')) return localeKey() === 'ko' ? '상위' : 'High';
    if (lower.includes('basic')) return localeKey() === 'ko' ? '우선' : 'Priority';
    return localeKey() === 'ko' ? '기본' : 'Standard';
  }
  function planCatalog() {
    const t = S();
    return {
      Free: { badge: t.freeBadge, rule: t.freeRule, title: t.pricingFreeTitle, copy: t.pricingFreeCopy, features: localeKey() === 'ko' ? ['기본 AI 대화', '내 기기 연산', '표준 우선순위'] : ['Basic AI chat', 'Local compute', 'Standard priority'] },
      Basic: { badge: t.basicBadge, rule: t.basicRule, title: t.pricingBasicTitle, copy: t.pricingBasicCopy, features: localeKey() === 'ko' ? ['보조 연산 모드 선택', '요청 제한 완화', '월 8시간 유지'] : ['Assist mode available', 'Softer request limits', '8h monthly maintenance'] },
      Plus: { badge: t.plusBadge, rule: t.plusRule, title: t.pricingPlusTitle, copy: t.pricingPlusCopy, features: localeKey() === 'ko' ? ['상위 우선순위', '더 넓은 기능 접근', '주간/월간 유지 조건'] : ['Higher priority', 'Broader access', 'Weekly and monthly target'] },
      Pro: { badge: t.proBadge, rule: t.proRule, title: t.pricingProTitle, copy: t.pricingProCopy, features: localeKey() === 'ko' ? ['최상위 우선순위', '강한 보조 연산', '대형 작업 대응'] : ['Top priority', 'Stronger assist', 'Larger jobs'] }
    };
  }
  function recommendedPlan(profile) {
    const cpu = Number(profile?.cpu_threads || 0);
    const ram = Number(profile?.memory_gb || 0);
    if (cpu >= 12 && ram >= 16) return 'Pro';
    if (cpu >= 8 && ram >= 8) return 'Plus';
    return 'Basic';
  }
  function computeModeOptions(plan) {
    const t = S();
    if (plan === 'Pro' || plan === 'Plus') return [{ value: 'local', label: t.localMode }, { value: 'hybrid', label: t.hybridMode }, { value: 'distributed', label: t.distributedMode }];
    if (plan === 'Basic') return [{ value: 'local', label: t.localMode }, { value: 'hybrid', label: t.hybridMode }];
    return [{ value: 'local', label: t.localMode }];
  }
  const state = { mode: 'plans', status: null, profile: null, linkCode: '', selectedPlan: localStorage.getItem('pb_selected_contributor_plan') || 'Basic', selectedHours: Number(localStorage.getItem('pb_selected_contributor_hours') || 8) };

  async function detectDeviceProfile() {
    const profile = { platform: navigator.platform || navigator.userAgent || '', cpu_threads: Number(navigator.hardwareConcurrency || 0), memory_gb: Number(navigator.deviceMemory || 0), disk_free_gb: 0 };
    try { const estimate = await navigator.storage?.estimate?.(); const quota = Number(estimate?.quota || 0); const usage = Number(estimate?.usage || 0); if (quota > 0) profile.disk_free_gb = +((quota - usage) / (1024 ** 3)).toFixed(1); } catch (_e) {}
    state.profile = profile; return profile;
  }
  async function fetchContributorStatus() {
    const user = getUser();
    if (!user) return null;
    const response = await fetch('/api/contributor/status?user_id=' + encodeURIComponent(getUserId()));
    const payload = await response.json();
    if (!payload?.ok) throw new Error('status_failed');
    state.status = payload; return payload;
  }
  async function requestLinkCode() {
    const user = getUser();
    if (!user) throw new Error('signin_required');
    const response = await fetch('/api/contributor/link-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: getUserId(), display_name: text(user.name || user.email), plan: state.selectedPlan }) });
    const payload = await response.json();
    if (!payload?.ok || !payload.link_code?.code) throw new Error('link_code_failed');
    state.linkCode = payload.link_code.code; return state.linkCode;
  }
  function summarizeDevice(payload) {
    const exact = text(payload?.exact_device_summary);
    if (exact) return exact;
    const devices = Array.isArray(payload?.devices) ? payload.devices : [];
    if (!devices.length) return S().noDevice;
    const top = devices[0];
    return text(top.device_name || top.device_id || S().linkedDevice);
  }
  function applySidebarCopy() {
    const t = S();
    setNodeText('upgrade-plan-title', t.upgradeTitle);
    setNodeText('upgrade-plan-sub', t.upgradeSub);
    setNodeText('contributor-card-title', t.statusCardTitle);
    setNodeText('contributor-card-sub', t.statusCardSub);
    setNodeText('contributor-stat-plan-label', t.plan);
    setNodeText('contributor-stat-premium-label', t.premium);
    setNodeText('contributor-stat-queue-label', t.queue);
    setNodeText('contributor-stat-next-label', t.nextWindow);
    setNodeText('contributor-device-label', t.linkedDevice);
    setNodeText('contributor-card-hint', t.cardHint);
  }
  async function refreshContributorSidebar() {
    applySidebarCopy();
    const upgrade = document.getElementById('upgrade-plan-btn');
    const card = document.getElementById('contributor-card');
    if (!upgrade || !card) return;
    const user = getUser();
    if (!user) { upgrade.classList.remove('hidden'); card.classList.add('hidden'); return; }
    try {
      const payload = await fetchContributorStatus();
      const account = payload.account || {};
      const plan = planName(account.plan || 'Free');
      const reservations = Array.isArray(payload.reservations) ? payload.reservations : [];
      const nextReservation = reservations.find((entry) => String(entry.status || '').toLowerCase() === 'scheduled') || reservations[0] || null;
      const paid = isPaidPlan(plan);
      upgrade.classList.toggle('hidden', paid);
      card.classList.toggle('hidden', !paid);
      if (!paid) return;
      setNodeText('contributor-plan-value', plan);
      setNodeText('contributor-premium-value', payload.premium_active ? S().active : S().inactive);
      setNodeText('contributor-queue-value', queueLabel(account?.latest_quote?.queue_mode || payload.queue_mode || ''));
      setNodeText('contributor-next-value', nextReservation ? formatDate(nextReservation.starts_at) : S().none);
      setNodeText('contributor-card-pill', payload.linked_device_count ? S().statusPillActive : S().statusPillPending);
      setNodeText('contributor-card-note', payload.linked_device_count ? S().paidCardNote : S().connectedAppNeeded);
      setNodeText('contributor-device-value', summarizeDevice(payload));
    } catch (_e) {
      upgrade.classList.remove('hidden');
      card.classList.add('hidden');
    }
  }
  function setHubChrome(mode) {
    const t = S();
    setNodeText('contributor-hub-title', mode === 'plans' ? t.plansModalTitle : t.statusModalTitle);
    setNodeText('contributor-hub-subtitle', mode === 'plans' ? t.plansModalSub : t.statusModalSub);
    setNodeText('contributor-hub-foot-left', mode === 'plans' ? t.footerPlans : t.footerStatus);
    setNodeText('contributor-hub-foot-right', mode === 'plans' ? t.freeOnlyUpgrade : t.refreshAuto);
  }
  function renderPlans() {
    const root = document.getElementById('contributor-hub-section-plans');
    const statusRoot = document.getElementById('contributor-hub-section-status');
    if (!root || !statusRoot) return;
    const plans = planCatalog();
    const current = planName(state.status?.account?.plan || 'Free');
    setHubChrome('plans');
    root.classList.add('active'); statusRoot.classList.remove('active');
    root.innerHTML = '<div class="contributor-plan-grid">' + ['Free','Basic','Plus','Pro'].map(function (id) {
      const plan = plans[id]; const isCurrent = current === id;
      const buttonText = id === 'Free' ? S().currentUsing : (isCurrent ? S().currentUsing : S().beginFlow);
      return '<article class="contributor-plan-card' + (isCurrent ? ' active' : '') + '">' +
        '<div class="contributor-plan-head"><div class="contributor-plan-name">' + esc(id) + '</div><span class="contributor-plan-badge">' + esc(plan.badge) + '</span></div>' +
        '<div class="contributor-plan-price">' + esc(id === 'Free' ? '₩0' : plan.rule) + ' <small>' + esc(S().monthly) + '</small></div>' +
        '<div class="contributor-plan-copy">' + esc(plan.title) + '</div>' +
        '<p class="contributor-plan-copy" style="margin-top:10px">' + esc(plan.copy) + '</p>' +
        '<ul class="contributor-plan-list">' + plan.features.map(function (feature) { return '<li>' + esc(feature) + '</li>'; }).join('') + '</ul>' +
        '<button class="contributor-plan-btn" ' + (id === 'Free' ? 'disabled' : '') + ' onclick="selectContributorPlan(\'' + id + '\')">' + esc(buttonText) + '</button>' +
        '<div class="contributor-plan-foot">' + esc(plan.rule) + '</div>' +
      '</article>';
    }).join('') + '</div>';
  }
  function renderStatus() {
    const root = document.getElementById('contributor-hub-section-status');
    const plansRoot = document.getElementById('contributor-hub-section-plans');
    if (!root || !plansRoot) return;
    const payload = state.status || {};
    const account = payload.account || {};
    const devices = Array.isArray(payload.devices) ? payload.devices : [];
    const reservations = Array.isArray(payload.reservations) ? payload.reservations : [];
    const nextReservation = reservations.find((entry) => String(entry.status || '').toLowerCase() === 'scheduled') || reservations[0] || null;
    const plan = planName(state.selectedPlan || account.plan || 'Basic');
    const profile = state.profile || { cpu_threads: 0, memory_gb: 0, disk_free_gb: 0 };
    const recommended = recommendedPlan(profile);
    const modeOptions = computeModeOptions(plan);
    const currentMode = localStorage.getItem('pb_contributor_compute_mode') || 'local';
    setHubChrome('status');
    root.classList.add('active'); plansRoot.classList.remove('active');
    root.innerHTML =
      '<div class="contributor-status-shell">' +
        '<section class="contributor-status-card">' +
          '<div class="contributor-status-title">' + esc(S().statusCardTitle) + '</div>' +
          '<div class="contributor-status-copy">' + esc(S().statusModalSub) + '</div>' +
          '<div class="contributor-status-grid">' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().plan) + '</div><div class="contributor-status-stat-value">' + esc(plan) + '</div><div class="contributor-status-stat-copy">' + esc(planCatalog()[plan].rule) + '</div></div>' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().premium) + '</div><div class="contributor-status-stat-value">' + esc(payload.premium_active ? S().active : S().inactive) + '</div><div class="contributor-status-stat-copy">' + esc(payload.linked_device_count ? S().linkedOk : S().linkedPending) + '</div></div>' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().queue) + '</div><div class="contributor-status-stat-value">' + esc(queueLabel(account?.latest_quote?.queue_mode || payload.queue_mode || '')) + '</div><div class="contributor-status-stat-copy">' + esc(plan === 'Basic' ? S().modeDescPaid : S().modeDescPaid) + '</div></div>' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().nextWindow) + '</div><div class="contributor-status-stat-value">' + esc(nextReservation ? formatDate(nextReservation.starts_at) : S().none) + '</div><div class="contributor-status-stat-copy">' + esc(nextReservation ? S().reservationSaved : S().connectedAppNeeded) + '</div></div>' +
          '</div>' +
          '<div class="contributor-status-banner"><strong>' + esc(S().deviceSummaryTitle) + '</strong><p>' + esc(summarizeDevice(payload)) + '</p></div>' +
          '<div class="contributor-status-steps">' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">1</span><strong>' + esc(S().stepInstall) + '</strong><p>' + esc(S().installCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">2</span><strong>' + esc(S().stepLink) + '</strong><p>' + esc(S().linkedCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">3</span><strong>' + esc(S().stepCheck) + '</strong><p>' + esc(S().hardwareCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">4</span><strong>' + esc(S().stepPlan) + '</strong><p>' + esc(S().recommendationCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">5</span><strong>' + esc(S().stepReserve) + '</strong><p>' + esc(S().reserveCopy) + '</p></div>' +
          '</div>' +
        '</section>' +
        '<section class="contributor-status-card">' +
          '<div class="contributor-status-detail">' +
            '<div class="contributor-status-detail-item"><strong>' + esc(S().installTitle) + '</strong><p>' + esc(S().appInstallStarted) + '</p></div>' +
            '<div class="contributor-status-detail-item"><strong>' + esc(S().linkedTitle) + '</strong><p>' + (state.linkCode ? esc(state.linkCode) : esc(S().generateCodeFirst)) + '</p></div>' +
            '<div class="contributor-status-detail-item"><strong>' + esc(S().recommendLabel) + '</strong><p>' + esc(recommended) + ' · ' + esc(planCatalog()[recommended].rule) + '</p></div>' +
          '</div>' +
          '<div class="contributor-status-fields">' +
            '<label class="contributor-status-field"><span>' + esc(S().selectedPlan) + '</span><select id="contributor-plan-select" onchange="selectContributorPlan(this.value)">' + ['Basic','Plus','Pro'].map(function (id) { return '<option value="' + id + '" ' + (plan === id ? 'selected' : '') + '>' + id + '</option>'; }).join('') + '</select></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().monthlyHours) + '</span><input id="contributor-hours-input" type="number" min="1" step="1" value="' + esc(String(state.selectedHours)) + '"></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().startAt) + '</span><input id="contributor-starts-at-input" type="datetime-local" value="' + esc(nextReservation?.starts_at ? new Date(nextReservation.starts_at).toISOString().slice(0,16) : new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0,16)) + '"></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().computeMode) + '</span><select id="contributor-compute-mode-select" onchange="updateContributorComputeMode(this.value)">' + modeOptions.map(function (opt) { return '<option value="' + opt.value + '" ' + (currentMode === opt.value ? 'selected' : '') + '>' + esc(opt.label) + '</option>'; }).join('') + '</select></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().cpuCap) + '</span><input id="contributor-cpu-cap-input" type="number" min="20" max="90" step="5" value="70"></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().gpuCap) + '</span><input id="contributor-gpu-cap-input" type="number" min="20" max="90" step="5" value="70"></label>' +
          '</div>' +
          '<div class="contributor-status-actions">' +
            '<button class="contributor-status-btn" type="button" onclick="downloadContributorApp()">' + esc(S().appButton) + '</button>' +
            '<button class="contributor-status-btn" type="button" onclick="copyContributorLinkCode()">' + esc(S().copyCodeButton) + '</button>' +
            '<button class="contributor-status-btn primary" type="button" onclick="reserveContributorPlan()" ' + (devices.length ? '' : 'disabled') + '>' + esc(S().saveReservationButton) + '</button>' +
          '</div>' +
          '<div class="contributor-status-banner"><strong>' + esc(S().maintenanceTarget) + '</strong><p>' + esc(planCatalog()[plan].rule) + '</p></div>' +
        '</section>' +
      '</div>';
  }
  async function openContributorHub(mode) {
    const backdrop = document.getElementById('contributor-hub-backdrop'); if (!backdrop) return;
    backdrop.classList.add('open'); state.mode = mode === 'plans' ? 'plans' : 'status';
    if (state.mode === 'status') {
      try { await fetchContributorStatus(); } catch (_e) {}
      await detectDeviceProfile();
      if (!state.linkCode && !(state.status?.linked_device_count > 0)) { try { await requestLinkCode(); } catch (_e) {} }
      renderStatus(); return;
    }
    renderPlans();
  }
  function closeContributorHub(event) { if (event?.target && event.target.id !== 'contributor-hub-backdrop') return; document.getElementById('contributor-hub-backdrop')?.classList.remove('open'); }
  function openUpgradePage(event) { event?.preventDefault?.(); openContributorHub('plans'); }
  function selectContributorPlan(plan) {
    state.selectedPlan = planName(plan);
    state.selectedHours = state.selectedPlan === 'Basic' ? 8 : state.selectedPlan === 'Plus' ? 40 : 80;
    localStorage.setItem('pb_selected_contributor_plan', state.selectedPlan);
    localStorage.setItem('pb_selected_contributor_hours', String(state.selectedHours));
    openContributorHub('status').catch(function () {});
  }
  function updateContributorComputeMode(mode) { const allowed = ['local', 'hybrid', 'distributed']; localStorage.setItem('pb_contributor_compute_mode', allowed.includes(mode) ? mode : 'local'); }
  async function downloadContributorApp() {
    const user = getUser(); if (!user) { toast(S().signInNeeded); return; }
    try {
      if (!state.linkCode) await requestLinkCode();
      const response = await fetch('/api/contributor/client/download?user_id=' + encodeURIComponent(getUserId()) + '&display_name=' + encodeURIComponent(text(user.name || user.email)));
      if (!response.ok) throw new Error('download_failed');
      const blob = await response.blob(); const href = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = href; a.download = 'PurpleBeeContributor.exe'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 2000); toast(S().appInstallStarted); renderStatus();
    } catch (_e) { toast(S().appInstallFailed); }
  }
  function copyContributorLinkCode() { if (!state.linkCode) { toast(S().generateCodeFirst); return; } navigator.clipboard?.writeText(state.linkCode).then(function () { toast(S().linkCopied); }).catch(function () { toast(state.linkCode); }); }
  async function reserveContributorPlan() {
    const user = getUser(); if (!user) { toast(S().signInNeeded); return; }
    if (!(state.status?.linked_device_count > 0)) { toast(S().linkRequired); return; }
    const plan = planName(document.getElementById('contributor-plan-select')?.value || state.selectedPlan || 'Basic');
    const hours = Math.max(1, Number(document.getElementById('contributor-hours-input')?.value || state.selectedHours || 8));
    state.selectedPlan = plan; state.selectedHours = hours;
    localStorage.setItem('pb_selected_contributor_plan', plan); localStorage.setItem('pb_selected_contributor_hours', String(hours));
    try {
      const response = await fetch('/api/contributor/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: getUserId(), display_name: text(user.name || user.email), plan, hours, starts_at: text(document.getElementById('contributor-starts-at-input')?.value), cpu_cap: Math.max(20, Math.min(90, Number(document.getElementById('contributor-cpu-cap-input')?.value || 70))), gpu_cap: Math.max(20, Math.min(90, Number(document.getElementById('contributor-gpu-cap-input')?.value || 70))), device_profile: await detectDeviceProfile() }) });
      const payload = await response.json();
      if (!payload?.ok) throw new Error(payload?.error || 'reserve_failed');
      toast(S().reservationSaved); await fetchContributorStatus(); renderStatus(); await refreshContributorSidebar();
    } catch (_e) { toast(S().reservationFailed); }
  }
  window.openUpgradePage = openUpgradePage;
  window.openContributorHub = openContributorHub;
  window.closeContributorHub = closeContributorHub;
  window.selectContributorPlan = selectContributorPlan;
  window.updateContributorComputeMode = updateContributorComputeMode;
  window.downloadContributorApp = downloadContributorApp;
  window.copyContributorLinkCode = copyContributorLinkCode;
  window.reserveContributorPlan = reserveContributorPlan;
  window.refreshContributorSidebar = refreshContributorSidebar;
  setTimeout(function () {
    refreshContributorSidebar().catch(function () {});
    setInterval(function () {
      refreshContributorSidebar().catch(function () {});
      if (document.getElementById('contributor-hub-backdrop')?.classList.contains('open') && state.mode === 'status') {
        fetchContributorStatus().then(detectDeviceProfile).then(renderStatus).catch(function () {});
      }
    }, 15000);
  }, 0);
})();
