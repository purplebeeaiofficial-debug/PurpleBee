(function () {
  const T = {
    ko: {
      upgradeTitle:'⚡ 플랜 업그레이드', upgradeSub:'월간 플랜과 유지 조건만 비교합니다.',
      statusTitle:'✨ 기여 구독 상태', statusSub:'현재 상태와 다음 기여 일정만 간단히 보여줍니다.',
      plan:'플랜', premium:'프리미엄', queue:'큐', next:'다음 기여', device:'연결된 기기',
      active:'활성', inactive:'비활성', none:'없음', free:'Free', linked:'연결됨', pending:'연동 필요',
      qFree:'기본', qBasic:'우선', qPlus:'상위', qPro:'최상위',
      modalPlans:'플랜 업그레이드', modalPlansSub:'요금제 비교만 빠르게 확인하고 선택할 수 있어요.',
      modalStatus:'기여 구독 상태', modalStatusSub:'앱 설치, 연동 확인, 성능 확인, 예약 저장까지 이 화면에서 진행합니다.',
      footPlansL:'앱 설치와 기여 예약은 다음 단계에서 진행됩니다.', footPlansR:'월간 플랜 비교 전용 화면',
      footStatusL:'상태는 자동으로 갱신됩니다.', footStatusR:'앱 설치와 연동을 완료해야 예약을 저장할 수 있습니다.',
      current:'현재 이용 중', choose:'이 플랜 선택', month:'월', changePlan:'플랜 다시 보기',
      installTitle:'앱 설치', installCopy:'Windows 설치 파일(.exe)을 내려받아 더블클릭하면 설치 마법사가 시작됩니다.', installBtn:'🧩 기여 앱 설치',
      linkTitle:'연동 코드', linkEmpty:'앱 설치를 시작하면 연동 코드가 발급됩니다.', linkBtn:'🔑 연동 코드 복사',
      hardwareTitle:'연결 기기 요약', hardwareEmpty:'앱 설치와 연동이 끝나면 CPU, GPU, RAM 요약이 이곳에 표시됩니다.',
      recommendTitle:'추천 플랜', reserveBtn:'📅 기여 예약 저장', reserveBlocked:'기여 앱 설치와 연동을 먼저 완료해 주세요.',
      reserveSaved:'기여 예약을 저장했어요.', reserveFailed:'기여 예약을 저장하지 못했어요.', signIn:'Google 로그인 후 이용해 주세요.',
      appStart:'기여 앱 설치 파일 다운로드가 시작됐어요.', appFail:'기여 앱 설치 파일을 내려받지 못했어요.', linkCopied:'연동 코드를 복사했어요.',
      selectedPlan:'선택한 플랜', monthlyHours:'월 기여 시간', nextStart:'다음 시작 시각', mode:'연산 모드', cpu:'CPU 상한 (%)', gpu:'GPU 상한 (%)',
      local:'내 기기 연산', hybrid:'내 기기 + 보조 연산', distributed:'보조 연산 우선',
      dLocal:'모든 계산을 내 기기에서 처리합니다.', dHybrid:'내 기기 계산을 유지하면서 보조 연산을 함께 사용합니다.', dDistributed:'보조 연산 네트워크의 비중을 더 높여 처리합니다.',
      freeRule:'유지 조건 없음', basicRule:'월 8시간 유지', plusRule:'주 10시간 · 월 40시간 유지', proRule:'주 20시간 · 월 80시간 유지',
      freeLead:'기본 질문과 내 기기 연산으로 시작하는 플랜입니다.', basicLead:'내 기기 연산에 보조 연산을 더할 수 있는 첫 단계입니다.', plusLead:'가장 많이 선택하는 핵심 플랜입니다.', proLead:'가장 높은 우선순위와 대형 작업 대응을 위한 플랜입니다.',
      f1:'기본 AI 대화', f2:'내 기기 연산', f3:'표준 우선순위', f4:'기본 사용 한도',
      b1:'보조 연산 모드 선택', b2:'응답 제한 완화', b3:'기여 앱 설치 가능', b4:'월 8시간 유지',
      p1:'상위 우선순위', p2:'더 넓은 모델 접근', p3:'하이브리드·보조 연산', p4:'주 10시간 · 월 40시간 유지',
      pr1:'최상위 우선순위', pr2:'대형 작업 대응', pr3:'강한 보조 연산 배정', pr4:'주 20시간 · 월 80시간 유지'
    }
  };
  const L = () => (document.documentElement.lang || '').toLowerCase().startsWith('ko') ? 'ko' : 'ko';
  const S = () => T[L()];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const txt = (v) => String(v ?? '').trim();
  const j = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const user = () => j('pb_user_v1') || j('pb_user_backup_v1');
  const uid = () => {
    const u = user(); const saved = txt(localStorage.getItem('pb_contributor_user_id'));
    const v = txt(u && (u.sub || u.email || u.id)) || saved || ('pb_' + Math.random().toString(36).slice(2, 10));
    localStorage.setItem('pb_contributor_user_id', v); return v;
  };
  const planName = (v) => ({basic:'Basic',plus:'Plus',pro:'Pro'})[txt(v).toLowerCase()] || 'Free';
  const paid = (v) => planName(v) !== 'Free';
  const toast = (m) => typeof window.showToast === 'function' && window.showToast(m);
  const setText = (id, value) => { const n = document.getElementById(id); if (n) n.textContent = value; };
  const fdate = (v) => v ? new Date(v).toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : S().none;
  const qlabel = (v) => { const s = txt(v).toLowerCase(); if (s.includes('pro')) return S().qPro; if (s.includes('plus')) return S().qPlus; if (s.includes('basic')) return S().qBasic; return S().qFree; };
  const plans = () => ({
    Free:{price:'₩0',rule:S().freeRule,badge:'기본',lead:S().freeLead,features:[S().f1,S().f2,S().f3,S().f4]},
    Basic:{price:'₩9,900',rule:S().basicRule,badge:'입문',lead:S().basicLead,features:[S().b1,S().b2,S().b3,S().b4]},
    Plus:{price:'₩29,000',rule:S().plusRule,badge:'추천',lead:S().plusLead,features:[S().p1,S().p2,S().p3,S().p4]},
    Pro:{price:'₩79,000',rule:S().proRule,badge:'상위',lead:S().proLead,features:[S().pr1,S().pr2,S().pr3,S().pr4]}
  });
  const recPlan = (p) => { const c = Number(p?.cpu_threads||0), r = Number(p?.memory_gb||0); if (c >= 12 && r >= 16) return 'Pro'; if (c >= 8 && r >= 8) return 'Plus'; return 'Basic'; };
  const modes = (plan) => plan === 'Pro' || plan === 'Plus'
    ? [{v:'local',l:S().local,d:S().dLocal},{v:'hybrid',l:S().hybrid,d:S().dHybrid},{v:'distributed',l:S().distributed,d:S().dDistributed}]
    : [{v:'local',l:S().local,d:S().dLocal},{v:'hybrid',l:S().hybrid,d:S().dHybrid}];
  const state = { mode:'plans', status:null, profile:null, linkCode:'', selectedPlan:localStorage.getItem('pb_selected_contributor_plan')||'Basic', selectedHours:Number(localStorage.getItem('pb_selected_contributor_hours')||8) };
  async function detectProfile() {
    const p = { cpu_threads:Number(navigator.hardwareConcurrency||0), memory_gb:Number(navigator.deviceMemory||0), disk_free_gb:0 };
    try { const e = await navigator.storage?.estimate?.(); if (e?.quota) p.disk_free_gb = +((Number(e.quota)-Number(e.usage||0))/(1024**3)).toFixed(1); } catch {}
    state.profile = p; return p;
  }
  async function fetchStatus() {
    const u = user(); if (!u) return null;
    const res = await fetch('/api/contributor/status?user_id=' + encodeURIComponent(uid())); const data = await res.json();
    if (!data?.ok) throw new Error('status_failed'); state.status = data; return data;
  }
  async function ensureLinkCode() {
    const u = user(); if (!u) throw new Error('signin_required');
    if (state.linkCode) return state.linkCode;
    const res = await fetch('/api/contributor/link-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:uid(),display_name:txt(u.name||u.email),plan:state.selectedPlan})});
    const data = await res.json(); if (!data?.ok || !data.link_code?.code) throw new Error('link_code_failed'); state.linkCode = data.link_code.code; return state.linkCode;
  }
  function deviceSummary(payload) {
    const exact = txt(payload?.exact_device_summary); if (exact) return exact;
    const list = Array.isArray(payload?.devices) ? payload.devices : []; if (!list.length) return S().noDevice;
    return txt(list[0].device_name || list[0].device_id || S().device);
  }
  function sidebarCopy() {
    setText('upgrade-plan-title', S().upgradeTitle); setText('upgrade-plan-sub', S().upgradeSub);
    setText('contributor-card-title', S().statusTitle); setText('contributor-card-sub', S().statusSub);
    setText('contributor-stat-plan-label', S().plan); setText('contributor-stat-premium-label', S().premium);
    setText('contributor-stat-queue-label', S().queue); setText('contributor-stat-next-label', S().next);
    setText('contributor-device-label', S().device); setText('contributor-card-hint', S().reserveBlocked);
  }
  async function refreshContributorSidebar() {
    sidebarCopy();
    const up = document.getElementById('upgrade-plan-btn'), card = document.getElementById('contributor-card'); if (!up || !card) return;
    if (!user()) { up.classList.remove('hidden'); card.classList.add('hidden'); return; }
    try {
      const data = await fetchStatus(); const account = data.account || {}; const plan = planName(account.plan || 'Free');
      const next = (Array.isArray(data.reservations) ? data.reservations : []).find((x) => String(x.status||'').toLowerCase()==='scheduled') || null;
      up.classList.toggle('hidden', paid(plan)); card.classList.toggle('hidden', !paid(plan)); if (!paid(plan)) return;
      setText('contributor-plan-value', plan); setText('contributor-premium-value', data.premium_active ? S().active : S().inactive);
      setText('contributor-queue-value', qlabel(account?.latest_quote?.queue_mode || data.queue_mode || '')); setText('contributor-next-value', next ? fdate(next.starts_at) : S().none);
      setText('contributor-card-pill', data.linked_device_count ? S().linked : S().pending); setText('contributor-card-note', data.linked_device_count ? S().statusSub : S().reserveBlocked);
      setText('contributor-device-value', deviceSummary(data));
    } catch { up.classList.remove('hidden'); card.classList.add('hidden'); }
  }
  function setHub(mode) {
    setText('contributor-hub-title', mode === 'plans' ? S().modalPlans : S().modalStatus);
    setText('contributor-hub-subtitle', mode === 'plans' ? S().modalPlansSub : S().modalStatusSub);
    setText('contributor-hub-foot-left', mode === 'plans' ? S().footPlansL : S().footStatusL);
    setText('contributor-hub-foot-right', mode === 'plans' ? S().footPlansR : S().footStatusR);
  }
  function renderPlans() {
    const root = document.getElementById('contributor-hub-section-plans'), statusRoot = document.getElementById('contributor-hub-section-status'); if (!root || !statusRoot) return;
    const catalog = plans(), current = planName(state.status?.account?.plan || 'Free');
    setHub('plans'); root.classList.add('active'); statusRoot.classList.remove('active');
    root.innerHTML = '<div class="contributor-plan-grid">' + ['Free','Basic','Plus','Pro'].map((id) => {
      const p = catalog[id], currentPlan = current === id;
      return '<article class="contributor-plan-card' + (currentPlan ? ' active' : '') + '">' +
        '<div class="contributor-plan-head"><div class="contributor-plan-name">' + esc(id) + '</div><span class="contributor-plan-badge">' + esc(p.badge) + '</span></div>' +
        '<div class="contributor-plan-price">' + esc(p.price) + ' <small>/ ' + esc(S().month) + '</small></div>' +
        '<div class="contributor-plan-copy">' + esc(p.lead) + '</div>' +
        '<ul class="contributor-plan-list">' + p.features.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>' +
        '<button class="contributor-plan-btn" type="button" ' + (id === 'Free' ? 'disabled' : '') + ' onclick="selectContributorPlan(\'' + id + '\')">' + esc(currentPlan ? S().current : S().choose) + '</button>' +
        '<div class="contributor-plan-foot">' + esc(p.rule) + '</div>' +
      '</article>';
    }).join('') + '</div>';
  }
  function renderStatus() {
    const root = document.getElementById('contributor-hub-section-status'), plansRoot = document.getElementById('contributor-hub-section-plans'); if (!root || !plansRoot) return;
    const payload = state.status || {}, account = payload.account || {}, devices = Array.isArray(payload.devices) ? payload.devices : [];
    const next = (Array.isArray(payload.reservations) ? payload.reservations : []).find((x) => String(x.status||'').toLowerCase()==='scheduled') || null;
    const plan = planName(state.selectedPlan || account.plan || 'Basic'), catalog = plans(), linked = devices.length > 0, recommended = recPlan(state.profile || {}), currentMode = localStorage.getItem('pb_contributor_compute_mode') || 'local';
    const modeList = modes(plan), currentModeMeta = modeList.find((item) => item.v === currentMode) || modeList[0];
    setHub('status'); root.classList.add('active'); plansRoot.classList.remove('active');
    root.innerHTML =
      '<div class="contributor-status-shell">' +
        '<section class="contributor-status-card">' +
          '<div class="contributor-status-title">' + esc(S().statusTitle) + '</div>' +
          '<div class="contributor-status-copy">' + esc(S().modalStatusSub) + '</div>' +
          '<div class="contributor-status-grid">' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().plan) + '</div><div class="contributor-status-stat-value">' + esc(plan) + '</div><div class="contributor-status-stat-copy">' + esc(catalog[plan].rule) + '</div></div>' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().premium) + '</div><div class="contributor-status-stat-value">' + esc(payload.premium_active ? S().active : S().inactive) + '</div><div class="contributor-status-stat-copy">' + esc(linked ? S().linked : S().pending) + '</div></div>' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().queue) + '</div><div class="contributor-status-stat-value">' + esc(qlabel(account?.latest_quote?.queue_mode || payload.queue_mode || '')) + '</div><div class="contributor-status-stat-copy">' + esc(currentModeMeta.d) + '</div></div>' +
            '<div class="contributor-status-stat"><div class="contributor-status-stat-label">' + esc(S().next) + '</div><div class="contributor-status-stat-value">' + esc(next ? fdate(next.starts_at) : S().none) + '</div><div class="contributor-status-stat-copy">' + esc(linked ? S().reserveBtn.replace(/^📅\s*/, '') : S().reserveBlocked) + '</div></div>' +
          '</div>' +
          '<div class="contributor-status-banner"><strong>' + esc(S().hardwareTitle) + '</strong><p>' + esc(linked ? deviceSummary(payload) : S().hardwareEmpty) + '</p></div>' +
          '<div class="contributor-status-detail">' +
            '<div class="contributor-status-detail-item"><strong>' + esc(S().installTitle) + '</strong><p>' + esc(S().installCopy) + '</p></div>' +
            '<div class="contributor-status-detail-item"><strong>' + esc(S().linkTitle) + '</strong><p>' + esc(state.linkCode || S().linkEmpty) + '</p></div>' +
            '<div class="contributor-status-detail-item"><strong>' + esc(S().recommendTitle) + '</strong><p>' + esc(recommended + ' · ' + catalog[recommended].rule) + '</p></div>' +
          '</div>' +
        '</section>' +
        '<section class="contributor-status-card">' +
          '<div class="contributor-status-steps">' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">1</span><strong>' + esc(S().stepInstall) + '</strong><p>' + esc(S().stepInstallCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">2</span><strong>' + esc(S().stepLink) + '</strong><p>' + esc(S().stepLinkCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">3</span><strong>' + esc(S().stepInspect) + '</strong><p>' + esc(S().stepInspectCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">4</span><strong>' + esc(S().stepPlan) + '</strong><p>' + esc(S().stepPlanCopy) + '</p></div>' +
            '<div class="contributor-status-step"><span class="contributor-status-step-chip">5</span><strong>' + esc(S().stepReserve) + '</strong><p>' + esc(S().stepReserveCopy) + '</p></div>' +
          '</div>' +
          '<div class="contributor-status-fields">' +
            '<label class="contributor-status-field"><span>' + esc(S().selectedPlan) + '</span><select id="contributor-plan-select" onchange="selectContributorPlan(this.value)">' + ['Basic','Plus','Pro'].map((id) => '<option value="' + id + '"' + (plan === id ? ' selected' : '') + '>' + esc(id) + '</option>').join('') + '</select></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().monthlyHours) + '</span><input id="contributor-hours-input" type="number" min="1" step="1" value="' + esc(String(state.selectedHours)) + '"></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().nextStart) + '</span><input id="contributor-starts-at-input" type="datetime-local" value="' + esc(next?.starts_at ? new Date(next.starts_at).toISOString().slice(0,16) : new Date(Date.now()+30*60*1000).toISOString().slice(0,16)) + '"></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().mode) + '</span><select id="contributor-compute-mode-select" onchange="updateContributorComputeMode(this.value)">' + modeList.map((m) => '<option value="' + m.v + '"' + (currentMode === m.v ? ' selected' : '') + '>' + esc(m.l) + '</option>').join('') + '</select></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().cpu) + '</span><input id="contributor-cpu-cap-input" type="number" min="20" max="90" step="5" value="70"></label>' +
            '<label class="contributor-status-field"><span>' + esc(S().gpu) + '</span><input id="contributor-gpu-cap-input" type="number" min="20" max="90" step="5" value="70"></label>' +
          '</div>' +
          '<div class="contributor-status-actions">' +
            '<button class="contributor-status-btn" type="button" onclick="downloadContributorApp()">' + esc(S().installBtn) + '</button>' +
            '<button class="contributor-status-btn" type="button" onclick="copyContributorLinkCode()">' + esc(S().linkBtn) + '</button>' +
            '<button class="contributor-status-btn" type="button" onclick="openContributorHub(\'plans\')">' + esc(S().changePlan) + '</button>' +
            '<button class="contributor-status-btn primary" type="button" onclick="reserveContributorPlan()"' + (linked ? '' : ' disabled') + '>' + esc(S().reserveBtn) + '</button>' +
          '</div>' +
          '<div class="contributor-status-banner"><strong>' + esc(S().recommendTitle) + '</strong><p>' + esc(linked ? catalog[plan].rule : S().reserveBlocked) + '</p></div>' +
        '</section>' +
      '</div>';
  }
  async function openContributorHub(mode) {
    const back = document.getElementById('contributor-hub-backdrop'); if (!back) return;
    back.classList.add('open'); state.mode = mode === 'plans' ? 'plans' : 'status';
    if (state.mode === 'status') { try { await fetchStatus(); } catch {} await detectProfile(); if (!state.linkCode && !(state.status?.linked_device_count > 0)) { try { await ensureLinkCode(); } catch {} } renderStatus(); return; }
    renderPlans();
  }
  function closeContributorHub(event) { if (event?.target && event.target.id !== 'contributor-hub-backdrop') return; document.getElementById('contributor-hub-backdrop')?.classList.remove('open'); }
  function openUpgradePage(event) { event?.preventDefault?.(); openContributorHub('plans'); }
  function selectContributorPlan(plan) { state.selectedPlan = planName(plan); state.selectedHours = state.selectedPlan === 'Basic' ? 8 : state.selectedPlan === 'Plus' ? 40 : 80; localStorage.setItem('pb_selected_contributor_plan', state.selectedPlan); localStorage.setItem('pb_selected_contributor_hours', String(state.selectedHours)); openContributorHub('status').catch(() => {}); }
  function updateContributorComputeMode(mode) { localStorage.setItem('pb_contributor_compute_mode', ['local','hybrid','distributed'].includes(mode) ? mode : 'local'); }
  async function downloadContributorApp() {
    if (!user()) { toast(S().signIn); return; }
    try {
      if (!state.linkCode) await ensureLinkCode();
      const res = await fetch('/api/contributor/client/download?user_id=' + encodeURIComponent(uid()) + '&display_name=' + encodeURIComponent(txt(user().name || user().email)));
      if (!res.ok) throw new Error('download_failed');
      const blob = await res.blob(), href = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = href; a.download = 'PurpleBeeContributor.exe'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000); toast(S().appStart);
    } catch { toast(S().appFail); }
  }
  function copyContributorLinkCode() { if (!state.linkCode) { toast(S().linkEmpty); return; } navigator.clipboard?.writeText(state.linkCode).then(() => toast(S().linkCopied)).catch(() => toast(state.linkCode)); }
  async function reserveContributorPlan() {
    if (!user()) { toast(S().signIn); return; }
    if (!(state.status?.linked_device_count > 0)) { toast(S().reserveBlocked); return; }
    const plan = planName(document.getElementById('contributor-plan-select')?.value || state.selectedPlan || 'Basic');
    const hours = Math.max(1, Number(document.getElementById('contributor-hours-input')?.value || state.selectedHours || 8));
    state.selectedPlan = plan; state.selectedHours = hours; localStorage.setItem('pb_selected_contributor_plan', plan); localStorage.setItem('pb_selected_contributor_hours', String(hours));
    try {
      const res = await fetch('/api/contributor/reserve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ user_id:uid(), display_name:txt(user().name || user().email), plan, hours, starts_at:txt(document.getElementById('contributor-starts-at-input')?.value), cpu_cap:Math.max(20, Math.min(90, Number(document.getElementById('contributor-cpu-cap-input')?.value || 70))), gpu_cap:Math.max(20, Math.min(90, Number(document.getElementById('contributor-gpu-cap-input')?.value || 70))), device_profile:await detectProfile() }) });
      const data = await res.json(); if (!data?.ok) throw new Error(data?.error || 'reserve_failed');
      toast(S().reserveSaved); await fetchStatus(); renderStatus(); await refreshContributorSidebar();
    } catch { toast(S().reserveFailed); }
  }
  window.openUpgradePage = openUpgradePage; window.openContributorHub = openContributorHub; window.closeContributorHub = closeContributorHub;
  window.selectContributorPlan = selectContributorPlan; window.updateContributorComputeMode = updateContributorComputeMode; window.downloadContributorApp = downloadContributorApp; window.copyContributorLinkCode = copyContributorLinkCode; window.reserveContributorPlan = reserveContributorPlan; window.refreshContributorSidebar = refreshContributorSidebar;
  window.PurpleBeeContributorUI = { openUpgradePage, openContributorHub, closeContributorHub, selectContributorPlan, updateContributorComputeMode, downloadContributorApp, copyContributorLinkCode, reserveContributorPlan, refreshContributorSidebar };
  setTimeout(function () {
    refreshContributorSidebar().catch(() => {});
    setInterval(function () {
      refreshContributorSidebar().catch(() => {});
      if (document.getElementById('contributor-hub-backdrop')?.classList.contains('open') && state.mode === 'status') {
        fetchStatus().then(detectProfile).then(renderStatus).catch(() => {});
      }
    }, 15000);
  }, 0);
})();
