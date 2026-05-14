export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (url.pathname === "/api/health" || url.pathname === "/api/status") {
      const publicBackend = await resolvePublicBackendConfig(request, env);
      const publicBackendEnabled = String(env.PURPLE_BEE_ENABLE_PUBLIC_BACKEND || "").trim() === "1";
      return jsonResponse(
        {
          ok: true,
          service: "Purple Bee Cloudflare Static Worker",
          mode: "aether-nexus",
          computeMode: publicBackendEnabled ? "public-backend-aether-adapter" : "aether-worker-primary",
          modelAsset: null,
          trainingMode: "admin-versioned-learning-cycle",
          publicBackendConfigured: Boolean(publicBackend.configured),
          publicBackendEnabled,
          publicBackendBaseUrl: publicBackend.publicApiBaseUrl || null,
          time: new Date().toISOString(),
        },
        200,
        request,
      );
    }

    if (url.pathname === "/api/pbx_chat") {
      return handlePbxChat(request, env, true, ctx);
    }
    if (url.pathname === "/api/pbx_chat_sync") {
      return handlePbxChat(request, env, false, ctx);
    }

    if (url.pathname === "/api/runtime/browser-manifest") {
      const runtimeConfig = await resolveRuntimeConfig(request, env);
      if (runtimeConfig) {
        return jsonResponse(buildBrowserManifest(request, runtimeConfig), 200, request);
      }
      return jsonResponse(
        { ok: false, message: "Browser runtime manifest is not published yet." },
        404,
        request,
      );
    }

    if (url.pathname === "/api/runtime/package-plan") {
      const runtimeConfig = await resolveRuntimeConfig(request, env);
      const publicBackend = await resolvePublicBackendConfig(request, env);
      return jsonResponse(buildPackagePlan(request, env, runtimeConfig, publicBackend), 200, request);
    }

    if (url.pathname.startsWith("/api/hf-proxy/")) {
      const upstreamPath = url.pathname.replace(/^\/api\/hf-proxy\//, "");
      if (!upstreamPath) {
        return jsonResponse(
          { ok: false, message: "Hugging Face proxy path is missing." },
          400,
          request,
        );
      }
      const upstreamUrl = `https://huggingface.co/${upstreamPath}${url.search || ""}`;
      return proxyExternalAsset(request, upstreamUrl, "hf-proxy");
    }

  if (url.pathname.startsWith("/api/runtime/assets/")) {
    const runtimeConfig = await resolveRuntimeConfig(request, env);
    if (!runtimeConfig) {
        return jsonResponse(
          { ok: false, message: "Runtime asset config is not available." },
          404,
          request,
        );
    }
    const rawAssetPath = decodeURIComponent(url.pathname.replace(/^\/api\/runtime\/assets\//, ""));
    const pathParts = rawAssetPath.split("/").filter(Boolean);
    let requestedName = rawAssetPath;
    if (pathParts.length >= 2 && pathParts[0] === String(runtimeConfig.modelId || "").trim()) {
      requestedName = pathParts.slice(2).join("/") || pathParts.slice(1).join("/");
    }
    const repoParts = String(runtimeConfig.runtime?.model_repo || "").trim().split("/").filter(Boolean);
    const strippedRepoPath = repoParts.length && pathParts.length > repoParts.length
      && repoParts.every((part, index) => pathParts[index] === part)
      ? pathParts.slice(repoParts.length).join("/")
      : "";
    const strippedRepoRevisionPath = repoParts.length && pathParts.length > (repoParts.length + 1)
      && repoParts.every((part, index) => pathParts[index] === part)
      ? pathParts.slice(repoParts.length + 1).join("/")
      : "";
    const strippedResolvePath = repoParts.length
      && pathParts.length > (repoParts.length + 2)
      && repoParts.every((part, index) => pathParts[index] === part)
      && pathParts[repoParts.length] === "resolve"
      ? pathParts.slice(repoParts.length + 2).join("/")
      : "";
    const requestedBasename = pathParts.length ? pathParts[pathParts.length - 1] : requestedName;
    const requestedTail = pathParts.length >= 2 ? pathParts.slice(-2).join("/") : requestedName;
    const candidateKeys = [
      requestedName,
      rawAssetPath,
      strippedResolvePath,
      strippedRepoRevisionPath,
      strippedRepoPath,
      pathParts.length >= 3 ? pathParts.slice(3).join("/") : "",
      pathParts.length >= 2 ? pathParts.slice(2).join("/") : "",
      pathParts.length >= 1 ? pathParts.slice(1).join("/") : "",
      requestedTail,
      requestedBasename,
      requestedBasename ? `onnx/${requestedBasename}` : "",
      requestedBasename ? `assets/${requestedBasename}` : "",
    ].filter(Boolean);
    const upstreamUrl = candidateKeys
      .map((key) => runtimeConfig.assetMap[key])
      .find(Boolean);
    if (!upstreamUrl) {
      return jsonResponse(
        { ok: false, message: "Requested runtime asset was not found." },
          404,
          request,
        );
      }
      return proxyExternalAsset(request, upstreamUrl, "runtime-asset");
    }

    if (url.pathname.startsWith("/api/contributor/")) {
      const publicBackend = await resolvePublicBackendConfig(request, env);
      const upstreamBase = String(publicBackend.publicApiBaseUrl || env.PURPLE_BEE_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
      if (!upstreamBase) {
        return jsonResponse({ ok: false, error: "public_backend_not_configured" }, 503, request);
      }
      return proxyJsonApi(request, `${upstreamBase}${url.pathname}${url.search || ""}`);
    }

    if (url.pathname === "/api/chat" || url.pathname === "/api/search_sources" || url.pathname === "/api/history") {
      return jsonResponse(
        {
          ok: false,
          message: "This public deployment expects the Purple Bee chat API bridge instead of direct legacy API calls.",
        },
        410,
        request,
      );
    }

    if (isMarketingProxyPath(url.pathname)) {
      if (env.ASSETS) {
        const marketingAssetRequest = new Request(new URL(normalizeMarketingAssetPath(url.pathname), request.url), request);
        const marketingAsset = await env.ASSETS.fetch(marketingAssetRequest);
        if (marketingAsset.ok) {
          const headers = new Headers(marketingAsset.headers);
          headers.set("Cache-Control", "public, max-age=300");
          headers.set("Content-Type", headers.get("Content-Type") || "text/html; charset=UTF-8");
          return new Response(marketingAsset.body, {
            status: marketingAsset.status,
            headers,
          });
        }
      }
      const publicBackend = await resolvePublicBackendConfig(request, env);
      const upstreamBase = String(publicBackend.publicApiBaseUrl || env.PURPLE_BEE_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
      if (upstreamBase) {
        return proxyHtmlPage(request, `${upstreamBase}${url.pathname}${url.search || ""}`);
      }
    }

    if (!env.ASSETS) {
      return jsonResponse(
        { ok: false, message: "Static assets binding is missing." },
        500,
        request,
      );
    }

    const assetRequest = shouldServeIndex(url.pathname)
      ? new Request(new URL("/index.html", request.url), request)
      : request;

    return env.ASSETS.fetch(assetRequest);
  },
};

async function handlePbxChat(request, env, streaming, ctx = null) {
  const corsH = corsHeaders(request);

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, message: "POST only" }), {
      status: 405,
      headers: { ...corsH, "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, message: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsH, "Content-Type": "application/json" },
    });
  }

  const userMessage = String(body.message || body.query || "").trim();
  if (!userMessage) {
    return new Response(JSON.stringify({ ok: false, message: "Message is empty." }), {
      status: 400,
      headers: { ...corsH, "Content-Type": "application/json" },
    });
  }

  const publicBackend = await resolvePublicBackendConfig(request, env);
  const publicBackendEnabled = String(env.PURPLE_BEE_ENABLE_PUBLIC_BACKEND || "").trim() === "1";
  if (!publicBackendEnabled) {
    return pbBuildPbxReplyResponseStable(await pbPublicBackendFallbackReply(userMessage, body.history), streaming, corsH, "aether-worker-fallback");
  }

  const upstreamBase = String(publicBackend.publicApiBaseUrl || env.PURPLE_BEE_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!upstreamBase) {
    return pbBuildPbxReplyResponseStable(await pbPublicBackendFallbackReply(userMessage, body.history), streaming, corsH, "aether-worker-fallback");
  }

  const upstreamUrl = `${upstreamBase}/api/pbx_chat_sync`;
  const upstreamHeaders = new Headers({ "Content-Type": "application/json" });
  const upstreamApiKey = String(env.PURPLE_BEE_PUBLIC_API_KEY || "").trim();
  if (upstreamApiKey) {
    upstreamHeaders.set("X-Api-Key", upstreamApiKey);
  }

  let upstreamResponse;
  const upstreamController = new AbortController();
  const upstreamTimeout = setTimeout(() => upstreamController.abort("backend-timeout"), 26000);
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: upstreamController.signal,
    });
  } catch (_error) {
    pbWakePublicBackend(upstreamBase, env, ctx);
    return pbBuildPbxReplyResponseStable(await pbPublicBackendFallbackReply(userMessage, body.history), streaming, corsH, "aether-worker-fallback");
  } finally {
    clearTimeout(upstreamTimeout);
  }

  let upstreamPayload = null;
  try {
    upstreamPayload = await upstreamResponse.clone().json();
  } catch (_error) {
    upstreamPayload = null;
  }

  const upstreamReply = String(upstreamPayload?.reply || "").trim();
  const upstreamMode = String(upstreamPayload?.mode || "aether-public-backend").trim() || "aether-public-backend";
  const upstreamOk = Boolean(upstreamPayload?.ok) && !!upstreamReply;
  if (!upstreamResponse.ok || !upstreamOk || pbLooksLikeFixedWebsiteReplyStable(upstreamReply) || pbLooksLikeIntentMismatchStable(upstreamReply, userMessage)) {
    return pbBuildPbxReplyResponseStable(await pbPublicBackendFallbackReply(userMessage, body.history), streaming, corsH, "aether-worker-fallback");
  }

  if (streaming) {
    const enc = new TextEncoder();
    const words = upstreamReply.split(/\s+/).filter(Boolean);
    const stream = new ReadableStream({
      start(controller) {
        let chunk = [];
        for (const word of words) {
          chunk.push(word);
          if (chunk.length >= 5) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk: `${chunk.join(" ")} ` })}\n\n`));
            chunk = [];
          }
        }
        if (chunk.length) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk: chunk.join(" ") })}\n\n`));
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, full: upstreamReply, ok: true, mode: upstreamMode })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsH,
        "Content-Type": "text/event-stream; charset=UTF-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    reply: upstreamReply,
    mode: upstreamMode,
  }), {
    status: 200,
    headers: { ...corsH, "Content-Type": "application/json; charset=UTF-8" },
  });
}

function pbWakePublicBackend(upstreamBase, env, ctx) {
  const base = String(upstreamBase || "").trim().replace(/\/+$/, "");
  if (!base || !ctx || typeof ctx.waitUntil !== "function") return;
  const headers = new Headers({ "Accept": "application/json" });
  const upstreamApiKey = String(env.PURPLE_BEE_PUBLIC_API_KEY || "").trim();
  if (upstreamApiKey) headers.set("X-Api-Key", upstreamApiKey);
  ctx.waitUntil(
    fetch(`${base}/api/health`, { headers }).catch(() => null),
  );
}

function pbPublicBackendUnavailableReply() {
  return "대화 엔진을 준비하는 중이에요. 첫 응답은 서버가 깨어나는 동안 조금 느릴 수 있습니다. 잠시 후 같은 메시지를 한 번만 다시 보내면 바로 이어서 답할게요.";
}

async function pbPublicBackendFallbackReply(query, history = []) {
  const raw = pbStableNormalize(query);
  if (!raw) return "메시지가 비어 있어요. 한 문장만 적어주면 바로 이어서 볼게요.";

  if (/^(안녕+|하이+|hello|hi|hey)[!?.…\s]*$/i.test(raw)) {
    return pbStablePick([
      "안녕하세요. 지금 떠오른 걸 그대로 말해 주세요. 짧게 던져도 문맥을 잡아서 이어가볼게요.",
      "반가워요. 그냥 대화해도 좋고, 바로 궁금한 걸 물어봐도 좋아요.",
      "안녕하세요. 오늘은 어떤 걸 같이 보면 좋을까요?",
    ], raw);
  }

  if (/(뭐\s*할\s*수|무엇을\s*할|능력|할줄|할\s*줄|can you do)/i.test(raw)) {
    return [
      "저는 Purple Bee입니다. 사용자의 말을 먼저 해석하고, 필요한 경우 자료나 웹 확인을 곁들여 답하는 쪽을 목표로 하고 있어요.",
      "",
      "지금 바로 도울 수 있는 일은 이런 쪽입니다.",
      "- 짧은 말이나 오타가 섞인 질문도 의도부터 파악하기",
      "- 문서, 파일, 코드, 오류 내용을 읽고 핵심 정리하기",
      "- 어려운 개념을 쉽게 풀거나 전문적으로 분석하기",
      "- 최신 확인이 필요한 내용은 필요할 때만 웹 정보로 보강하기",
      "",
      "그냥 “사과”, “강아지”, “이 코드 왜 안 돼?”처럼 짧게 던져도 먼저 해석해서 답해볼게요.",
    ].join("\n");
  }

  if (/사과.*(만들|만드|재배|키우|기르|요리|레시피|잼|주스|파이)/i.test(raw)) {
    return [
      "과일 사과를 말하는 거라면, 사과는 ‘만드는’ 물건이라기보다 사과나무에서 재배하는 열매예요.",
      "",
      "큰 흐름은 이렇습니다.",
      "",
      "1. 사과나무 묘목을 심고 햇빛과 배수가 좋은 환경을 맞춥니다.",
      "2. 꽃이 피고 수정이 되면 열매가 맺힙니다.",
      "3. 자라는 동안 가지치기, 병해충 관리, 물 관리를 합니다.",
      "4. 품종에 맞는 시기에 익은 사과를 수확합니다.",
      "",
      "음식으로 사과를 활용하는 방법을 말한 거라면 사과잼, 사과파이, 사과주스처럼 레시피 쪽으로 이어갈 수 있어요.",
    ].join("\n");
  }

  if (/(사과하는 법|사과하|사과.*전하|사과.*말|미안하다고.*말|잘못.*사과)/i.test(raw)) {
    return [
      "사과는 길게 말하는 것보다 순서가 중요해요.",
      "",
      "1. 먼저 상대가 불편했을 지점을 인정합니다.",
      "2. 변명보다 내 책임을 짧게 말합니다.",
      "3. 다음에는 어떻게 바꿀지 약속합니다.",
      "",
      "예시는 이렇게요.",
      "",
      "“내가 그때 네 입장을 충분히 생각하지 못했어. 불편하게 했다면 미안해. 다음부터는 더 조심할게.”",
      "",
      "핵심은 ‘하지만’, ‘그럴 의도는 아니었어’를 앞에 두지 않는 거예요.",
    ].join("\n");
  }

  if (/^사과[?!.…\s]*$/i.test(raw)) {
    return "사과는 문맥에 따라 두 가지로 볼 수 있어요. 하나는 달고 아삭한 과일이고, 다른 하나는 잘못이나 실수를 인정하고 미안함을 전하는 행동입니다. 지금 대화에서는 어느 쪽인지 문맥을 보고 이어가면 됩니다.";
  }

  if (/(강아지|반려견|puppy|dog)/i.test(raw)) {
    return "강아지는 사람과 오래 함께 살아온 대표적인 반려동물이에요. 품종마다 성격, 활동량, 털 관리 방식이 달라서 생활 환경과 돌봄 시간을 함께 고려하는 게 중요합니다.";
  }

  if (/(날씨|기온|비\s*오|눈\s*오|미세먼지|weather|뉴스|최신|최근|오늘|지금|요즘|현재|실시간)/i.test(raw)) {
    return "이 질문은 최신 확인이 필요한 내용이에요. 지금은 공개 Worker가 백엔드 응답을 기다리는 동안 임시로 답하고 있어서 정확한 실시간 수치를 지어내지는 않겠습니다. 연결이 회복되면 출처를 읽어서 핵심만 정리해드릴게요.";
  }

  if (/(친구처럼|편하게|가볍게).*(얘기|대화|말|수다)|(?:잡담|수다).*(하자|해줘)/i.test(raw)) {
    return "좋아요. 너무 설명문처럼 굳히지 않고 편하게 받을게요. 오늘 있었던 일, 떠오른 생각, 그냥 아무 말이나 던져도 거기서 자연스럽게 이어가볼게요.";
  }

  if (/(집중.*안|집중.*못|뭐부터|시작.*못|할 일)/i.test(raw)) {
    return [
      "그럴 때는 의욕을 억지로 끌어올리기보다 시작 단위를 아주 작게 줄이는 게 좋아요.",
      "",
      "1. 해야 할 일을 전부 보지 말고 하나만 고르기",
      "2. 5분 안에 끝낼 수 있는 첫 행동으로 바꾸기",
      "3. 끝나면 계속할지 쉴지 다시 판단하기",
      "",
      "예를 들면 “프로젝트 해야지”가 아니라 “파일 하나 열고 오류 한 줄만 보기”처럼 낮추는 거예요.",
    ].join("\n");
  }

  if (/(힘들|지쳤|피곤|우울|불안|짜증|화나|외롭|무서|걱정|스트레스|멘붕|현타)/i.test(raw)) {
    return "많이 버거운 쪽으로 들려요. 지금은 완벽하게 설명하지 않아도 괜찮고, 제일 크게 걸리는 것 하나만 말해줘도 됩니다. 거기서부터 천천히 풀어볼게요.";
  }

  if (/(왜|이유|원인|어째서)/i.test(raw)) {
    return "원인을 보려면 겉으로 보이는 증상과 실제 영향을 주는 조건을 나눠야 해요. 언제부터 반복됐는지, 특정 조건에서만 생기는지, 바꾸면 바로 달라지는 요소가 있는지부터 보면 훨씬 정확해집니다.";
  }

  const topic = pbStableTopic(raw);
  return pbStablePick([
    `${topic}에 대해 바로 보면, 먼저 핵심 의미를 잡고 그다음 예시나 실제 상황에 붙여서 이해하는 게 좋아요. 원하면 제가 쉬운 설명, 전문 분석, 짧은 요약 중 하나로 이어서 풀어볼게요.`,
    `${topic}은 한 문장으로 고정해서 끝낼 주제라기보다, 문맥에 따라 설명 깊이가 달라지는 주제예요. 지금은 기본 의미부터 잡고 필요한 방향으로 넓히면 됩니다.`,
    `${topic} 쪽으로 보면 지금 필요한 건 정의보다 “왜 궁금한지”에 맞춘 설명이에요. 일상적인 설명이 필요하면 쉽게, 작업용이면 바로 실행 가능한 형태로 바꿔서 답할게요.`,
  ], raw);
}

function pbStableNormalize(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function pbStableTopic(value) {
  const cleaned = pbStableNormalize(value)
    .replace(/[?？!！.。…]/g, " ")
    .replace(/(뭐야|뭔지|무엇|정의|뜻|알려줘|알려 줘|설명해줘|설명|해석|왜|이유|원인|방법|하는 법|해줘|좀|제발)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 40) : "그 주제";
}

function pbStablePick(items, seed = "") {
  const list = (items || []).filter(Boolean);
  if (!list.length) return "";
  let hash = 0;
  for (const ch of String(seed || Date.now())) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  hash = (hash + Math.floor(Date.now() / 45000)) >>> 0;
  return list[hash % list.length];
}

// Clean public-runtime helper set kept for shared UTF-8-safe utilities.
function pbLegacyCleanPbxReplyResponse(reply, streaming, corsH, mode = "aether-nexus") {
  const text = String(reply || "").trim() || "답변을 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
  if (streaming) {
    const enc = new TextEncoder();
    const parts = text.match(/\S+\s*|\n/g) || [text];
    const stream = new ReadableStream({
      start(controller) {
        let chunk = "";
        for (const part of parts) {
          chunk += part;
          if (chunk.length >= 24 || part === "\n") {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
            chunk = "";
          }
        }
        if (chunk) controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, full: text, ok: true, mode })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsH,
        "Content-Type": "text/event-stream; charset=UTF-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }
  return new Response(JSON.stringify({ ok: true, reply: text, mode }), {
    status: 200,
    headers: { ...corsH, "Content-Type": "application/json; charset=UTF-8" },
  });
}

function pbLegacyCleanLooksLikeFixedWebsiteReply(reply) {
  const text = String(reply || "").trim();
  if (!text) return true;
  if (/[�]/.test(text)) return true;
  const brokenHangulMarkers = ["吏", "湲", "諛", "援", "蹂", "媛", "먯", "댁", "섏", "쒕"];
  const markerCount = brokenHangulMarkers.reduce((count, marker) => count + (text.includes(marker) ? 1 : 0), 0);
  if (markerCount >= 3) return true;
  return [
    "조금 더 구체적으로",
    "어떤 부분이 궁금",
    "한 줄만 더",
    "답변 생성에 실패",
    "같은 뜻으로 한 번만",
  ].some((marker) => text.includes(marker));
}

async function pbLegacyCleanAetherWorkerReply(query, history = []) {
  const raw = pbNormalize(query);
  if (!raw) return "메시지가 비어 있어요. 한 문장만 적어주면 바로 이어서 볼게요.";

  if (/^(안녕+|하이+|hello|hi|hey)[!?.…\s]*$/i.test(raw)) {
    return pbPick([
      "안녕하세요. 편하게 말해 주세요. 짧게 던져도 의도부터 잡아서 이어가볼게요.",
      "안녕하세요. 오늘은 어떤 걸 같이 보면 좋을까요?",
      "반가워요. 대화든 작업이든 지금 필요한 쪽으로 바로 맞춰볼게요.",
    ], raw);
  }

  if (/(뭐\s*할\s*수|무엇을\s*할|능력|할줄|할\s*줄|can you do)/i.test(raw)) {
    return [
      "저는 대화의 의도를 먼저 잡고, 필요한 경우 자료나 웹 정보를 함께 확인해서 답하는 Purple Bee입니다.",
      "",
      "할 수 있는 일은 크게 네 가지예요.",
      "- 일상 대화나 짧은 질문을 자연스럽게 이어가기",
      "- 문서, 파일, 코드, 오류 내용을 읽고 핵심 정리하기",
      "- 특정 주제를 쉽게 풀거나 전문적으로 분석하기",
      "- 웹 확인이 필요한 질문은 필요할 때만 검색해서 최신 정보 보강하기",
      "",
      "지금은 그냥 한 줄로 물어봐도 됩니다. 예를 들면 “사과”, “강아지”, “이 코드 왜 안 돼?”처럼요.",
    ].join("\n");
  }

  if (/(심장|가슴|흉통|호흡|숨\s*쉬|식은땀|어지럼|통증|아파|아퍼|병원|응급)/i.test(raw)) {
    return pbHealthReply(raw);
  }

  if (/(우리\s*뭐|뭐\s*할까|심심|잡담|대화하자|놀자|뭐해)/i.test(raw)) {
    return pbPick([
      "좋아요. 가볍게 잡담으로 시작해도 되고, 지금 머릿속에 있는 문제 하나를 같이 정리해도 좋아요. 작은 주제 하나만 던져보세요.",
      "우리라면 지금 가장 부담 없는 것부터 해보죠. 아이디어 정리, 짧은 대화, 코드 점검, 자료 요약 중 하나를 골라도 되고 그냥 아무 말이나 던져도 됩니다.",
      "좋아요. 오늘은 너무 거창하게 가지 말고, 지금 신경 쓰이는 것 하나를 꺼내서 같이 풀어봅시다.",
    ], raw);
  }

  if (/(아니|그게\s*아니|다시|틀렸|이상|제대로)/i.test(raw)) {
    return "알겠어요. 방금 방향은 접고 다시 맞춰볼게요. 원하는 기준을 한 줄만 더 주면 그 기준으로 바로 다시 답하겠습니다.";
  }

  if (/(날씨|weather)/i.test(raw)) {
    const weather = await pbWeatherReply(raw);
    if (weather) return weather;
    return "날씨는 지역명이 있어야 정확히 볼 수 있어요. 예를 들면 “군산 날씨”처럼 지역과 함께 물어봐 주세요.";
  }

  if (/(검색|찾아|웹사이트|사이트에서|링크)/i.test(raw)) {
    return "웹에서 확인이 필요한 요청으로 보입니다. 지금은 검색이 필요한 핵심어를 뽑아 확인한 뒤, 링크와 요약을 함께 정리하는 방식이 가장 안전합니다. 검색할 주제를 한 줄로 더 좁혀주면 바로 이어가겠습니다.";
  }

  const topic = pbExtractTopic(raw);
  if (topic) {
    const summary = await pbWikiSummary(topic);
    if (summary) return pbKnowledgeReply(topic, summary, raw);
  }

  if (/(코드|코딩|python|파이썬|error|오류|버그|함수|html|css|js)/i.test(raw)) {
    return [
      "코딩 쪽으로 보면 먼저 증상과 원인을 분리하는 게 좋아요.",
      "",
      "- 에러 메시지가 있으면 가장 먼저 그 줄을 봅니다.",
      "- 코드가 있으면 입력값, 실행 흐름, 실패 지점을 나눠 확인합니다.",
      "- 수정은 한 번에 크게 바꾸기보다 작은 패치로 검증하는 편이 안전합니다.",
      "",
      "코드나 오류 화면을 보내주면 바로 원인 후보부터 좁혀볼게요.",
    ].join("\n");
  }

  if (/(요약|정리|핵심)/i.test(raw)) {
    return "좋아요. 자료를 보내주면 핵심 주장, 근거, 놓치면 안 되는 내용, 다음 행동 순서로 짧고 읽기 쉽게 정리해드릴게요.";
  }

  return pbGeneralReply(raw, history);
}

function pbNormalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/머야|모야|뭐임|뭐ㅑ/g, "뭐야")
    .replace(/알려조|알려쥬|알려저/g, "알려줘")
    .replace(/([가-힣])\1{4,}/g, "$1$1")
    .trim();
}

function pbPick(items, seed = "") {
  const list = (items || []).filter(Boolean);
  if (!list.length) return "";
  let hash = 0;
  for (const ch of String(seed || Date.now())) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const jitter = new Uint32Array(1);
  try {
    crypto.getRandomValues(jitter);
  } catch (_) {
    jitter[0] = Math.floor(Math.random() * 0xffffffff);
  }
  hash = (hash + Math.floor(Date.now() / 30000) + jitter[0]) >>> 0;
  return list[hash % list.length];
}

function pbHasFinalConsonant(text) {
  const chars = Array.from(String(text || "").trim());
  if (!chars.length) return false;
  const code = chars[chars.length - 1].charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return ((code - 0xac00) % 28) !== 0;
}

function pbParticle(text, consonantForm, vowelForm) {
  return pbHasFinalConsonant(text) ? consonantForm : vowelForm;
}

function pbExtractTopic(query) {
  const raw = pbNormalize(query);
  const asks = /(뭐야|무엇|정의|뜻|개념|알려|설명|해석|탐구|분석|what is|meaning|explain)/i.test(raw);
  const bare = /^[A-Za-z0-9가-힣\s._:+#-]{2,40}$/.test(raw)
    && !/(안녕|하이|우리|너|나|왜|어떻게|해줘|하자|만들|고쳐|검색|날씨|오늘|내일)/i.test(raw);
  if (!asks && !bare) return "";
  const cleaned = raw
    .replace(/[?？!！]/g, " ")
    .replace(/(이게|그게|저게|이건|그건|저건|이거|그거|저거|좀|간단히|자세히|쉽게|친근하게|전문적으로|핵심만)/g, " ")
    .replace(/(뭐야|뭔가요|뭔지|무엇인지|정의|뜻|개념|알려줘|알려 줘|설명해줘|설명|해석해줘|해석|알아|탐구해줘|탐구|분석해줘|분석|what is|meaning of|explain)/gi, " ")
    .replace(/(에\s*대해|에\s*대한|에\s*관해|에\s*관한)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const topic = cleaned
    .replace(/([가-힣A-Za-z0-9]+)(이|가|은|는|을|를)(?=\s|$)/g, "$1")
    .replace(/(이|가|은|는|을|를|란|이라는|라는)$/g, "")
    .trim()
    .slice(0, 80);
  return pbNormalizeKnowledgeTopic(topic);
}

function pbNormalizeKnowledgeTopic(topic) {
  const raw = String(topic || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (/(강아지|반려견|dog|puppy)/i.test(raw)) return "개";
  if (/(윤리적\s*문제|윤리|도덕|ethic)/i.test(raw)) return "윤리";
  if (/(인공지능|AI|artificial intelligence)/i.test(raw)) return "인공지능";
  if (/(문학|literature)/i.test(raw)) return "문학";
  if (/(철학|philosophy)/i.test(raw)) return "철학";
  if (/(역사|history)/i.test(raw)) return "역사";
  return raw;
}

async function pbWikiSummary(topic) {
  const subject = String(topic || "").trim();
  if (!subject) return "";
  const encoded = encodeURIComponent(subject.replace(/\s+/g, "_"));
  for (const base of ["https://ko.wikipedia.org/api/rest_v1/page/summary/", "https://en.wikipedia.org/api/rest_v1/page/summary/"]) {
    try {
      const response = await fetch(`${base}${encoded}`, {
        headers: { "accept": "application/json", "user-agent": "PurpleBeeWorker/1.0" },
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const text = String(payload.extract || "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 900);
    } catch (_) {}
  }
  return "";
}

function pbCommonKnowledgeReply(query) {
  // Deliberately disabled: fixed seed facts made Purple Bee feel canned.
  // Knowledge requests should go through dynamic retrieval first.
  return "";
}

function pbExplorationReply(query) {
  const raw = pbNormalize(query);
  const topic = raw
    .replace(/[?？!！]/g, " ")
    .replace(/(탐구해줘|탐구해|탐구|분석해줘|분석해|분석|알려줘|설명해줘|에\s*대해|에\s*대한|좀|자세히|깊게)/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "그 주제";
  const topicWithObject = `${topic}${pbParticle(topic, "을", "를")}`;
  return [
    `${topicWithObject} 탐구하려면 먼저 “무엇이 문제인지”와 “어떤 기준으로 판단할지”를 나누는 게 좋습니다.`,
    "",
    "핵심은 보통 세 갈래로 볼 수 있어요.",
    "",
    `1. 사실: ${topic}에서 실제로 어떤 일이 일어나는가`,
    "2. 가치: 누구의 이익, 권리, 안전, 자유가 충돌하는가",
    "3. 판단: 어떤 선택이 더 책임 있고 지속 가능한가",
    "",
    "이렇게 나누면 감정적인 찬반보다 훨씬 또렷하게 볼 수 있습니다. 원하면 제가 찬성/반대 논거, 실제 사례, 결론 초안 순서로 이어서 정리해드릴게요.",
  ].join("\n");
}

function pbExtractAetherTopic(query) {
  const raw = pbNormalize(query);
  const cleaned = raw
    .replace(/[?？!！]/g, " ")
    .replace(/(그럼|일단|이제|좀|제발|바로|진짜|혹시|그러면|나는|내가|우리|너|ai|AI)/gi, " ")
    .replace(/(뭐야|뭔지|무엇|알아|알려줘|설명해줘|설명|해석해줘|해석|탐구해줘|탐구|분석해줘|분석|왜|어째서|어떻게|방법|순서|추천|비교|차이|높이는|높여|높이|올리는|올려|낮추는|낮춰|개선하는|개선해줘|개선|최적화|만들어줘|작성해줘|써줘|고쳐줘|수정해줘|고쳐|수정|실패해|실패|자꾸|검색해줘|검색|찾아줘|찾아|말해줘|말해)/gi, " ")
    .replace(/(에\s*대해|에\s*대한|에\s*관해|에\s*관한|쪽으로|관련해서|기준으로)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(이|가|은|는|을|를|랑|와|과|도|만|부터|까지)$/g, "")
    .trim();
  if (cleaned) return pbNormalizeKnowledgeTopic(cleaned.slice(0, 80));
  const topic = pbExtractTopic(raw);
  if (topic) return topic;
  const words = raw.match(/[A-Za-z0-9가-힣+#._-]{2,}/g) || [];
  return words.length ? pbNormalizeKnowledgeTopic(words.slice(0, 4).join(" ")) : "그 주제";
}

function pbInferStyle(query) {
  const raw = String(query || "");
  if (/(짧게|간단|요약|핵심만|한줄|한 줄)/i.test(raw)) return "concise";
  if (/(쉽게|초등|어린|친근|비유|예시|일상적으로)/i.test(raw)) return "easy";
  if (/(자세히|깊게|탐구|분석|원리|배경|전문)/i.test(raw)) return "detailed";
  if (/(코드|기술|개발|수식|논문|공식|엔진|아키텍처)/i.test(raw)) return "technical";
  return "default";
}

function pbAdaptiveAetherReply(query, history = []) {
  const raw = pbNormalize(query);
  const topic = pbExtractAetherTopic(raw);
  const style = pbInferStyle(raw);
  const topicObject = `${topic}${pbParticle(topic, "을", "를")}`;
  const topicTopic = `${topic}${pbParticle(topic, "은", "는")}`;

  if (/^(아니|그게\s*아니|아닌데|다시|틀렸|이상|제대로)/i.test(raw)) {
    return pbPick([
      "맞아요. 방금 답은 방향을 잘못 잡았어요. 이번에는 사용자가 원하는 행동을 먼저 보고, 불필요한 확인 질문 없이 바로 답하는 쪽으로 다시 맞추겠습니다.",
      "그 지적이 맞습니다. 이전 답변은 너무 안전하게 둘러갔고, 지금 필요한 건 바로 본론으로 들어가는 답변입니다. 다시 기준을 잡고 이어갈게요.",
      "알겠습니다. 방금 방식은 접고, 지금 문장의 의도와 맥락을 먼저 기준으로 삼겠습니다.",
    ], raw);
  }

  if (/(왜|원인|이유|어째서)/i.test(raw)) {
    return [
      "지금 현상의 원인을 보려면 겉으로 보이는 증상과 실제로 영향을 주는 조건을 나눠야 합니다.",
      "",
      "먼저 확인할 것은 세 가지예요.",
      "",
      "1. 언제부터 같은 현상이 반복됐는지",
      "2. 반복되는 조건이 있는지",
      "3. 바꾸면 바로 달라지는 요소가 있는지",
      "",
      "이렇게 보면 단순한 느낌이 아니라 확인 가능한 원인 후보로 좁혀집니다.",
    ].join("\n");
  }

  if (/(어떻게|방법|순서|절차|하는법|하는 법)/i.test(raw)) {
    let action = "진행하려면";
    if (/(고쳐|수정|오류|버그|문제)/i.test(raw)) action = "고치려면";
    else if (/(높|올리|개선|최적|효율)/i.test(raw)) action = "개선하려면";
    if (style === "concise") return `${topicObject} ${action} 목표를 작게 나누고, 첫 단계부터 실행해 확인하면 됩니다. 핵심은 한 번에 완성하려 하지 않는 거예요.`;
    return [
      `${topicObject} ${action} 이렇게 가는 게 가장 안정적입니다.`,
      "",
      "1. 먼저 원하는 결과를 한 문장으로 정합니다.",
      "2. 지금 가진 자료나 조건을 확인합니다.",
      "3. 가장 작은 실행 단계를 하나 고릅니다.",
      "4. 실행 결과를 보고 다음 단계를 조정합니다.",
      "",
      "이 방식은 막연한 계획보다 실패 지점을 빨리 찾을 수 있어서 실제 작업에 강합니다.",
    ].join("\n");
  }

  if (/(비교|차이|vs|장단점)/i.test(raw)) {
    return [
      `${topicObject} 비교할 때는 단순히 어느 쪽이 좋다고 보기보다 기준을 먼저 정해야 합니다.`,
      "",
      "- 성능이나 효율을 볼 것인지",
      "- 안정성과 유지보수를 볼 것인지",
      "- 비용과 접근성을 볼 것인지",
      "- 장기적으로 확장 가능한지를 볼 것인지",
      "",
      "기준을 정하면 답이 훨씬 또렷해집니다. 비교 대상 두 개를 알려주면 표처럼 정리해드릴게요.",
    ].join("\n");
  }

  if (/(추천|골라|선택|뭐가\s*좋)/i.test(raw)) {
    return `${topic} 선택은 목적에 따라 달라집니다. 일반적으로는 안정성, 사용 편의성, 비용, 확장성 순서로 보는 게 좋아요. 지금 당장 실패가 적은 선택을 원하면 보수적인 쪽을, 빠른 실험을 원하면 가볍게 시작할 수 있는 쪽이 맞습니다.`;
  }

  if (/(요약|정리|핵심)/i.test(raw)) {
    return [
      `${topicObject} 정리할 때는 문장을 줄이는 것보다 핵심 구조를 남기는 게 중요합니다.`,
      "",
      "- 주장: 결국 무엇을 말하는가",
      "- 근거: 왜 그렇게 말하는가",
      "- 조건: 언제 맞고 언제 틀릴 수 있는가",
      "- 다음 행동: 그래서 무엇을 하면 되는가",
      "",
      "자료를 붙여주면 이 기준으로 바로 압축해드릴게요.",
    ].join("\n");
  }

  if (/(만들|작성|써줘|초안|문장|글|코드|수정|고쳐)/i.test(raw)) {
    return [
      `${topicObject} 만들거나 고치려면 먼저 결과물의 형태를 정해야 합니다.`,
      "",
      "- 초안 작성: 빈 상태에서 구조부터 잡기",
      "- 문제 수정: 오류 원인과 수정 위치 찾기",
      "- 품질 개선: 더 자연스럽고 안정적인 형태로 다듬기",
      "",
      "코드나 문장을 보내주면 바로 손볼 수 있는 단위로 나눠서 이어가겠습니다.",
    ].join("\n");
  }

  if (raw.length <= 18 && !/\s/.test(raw)) {
    return `${topicTopic} 지금 단어만 보면 하나의 주제로 볼 수 있습니다.\n\n먼저 큰 뜻을 잡고, 그다음 맥락에 맞춰 좁히는 게 좋아요. 일상적인 의미, 전문적인 의미, 예시 중심 설명 중에서 지금은 일상적인 큰 그림부터 잡는 방식이 가장 자연스럽습니다.`;
  }

  const contextHint = Array.isArray(history) && history.length ? "방금 흐름도 참고해서 말하면, " : "";
  return pbPick([
    `${contextHint}${raw}에 대해 바로 이어서 말하면, 핵심은 먼저 의도를 잡고 그에 맞는 답변 형태를 고르는 것입니다. 지금 문장은 설명, 판단, 실행 제안 중 하나로 확장될 수 있어요.`,
    `${contextHint}${raw}은 단순히 한 문장으로 끊기보다 맥락을 보고 답하는 게 맞습니다. 먼저 핵심을 잡고, 필요한 경우 근거와 예시를 붙여서 이해하기 쉬운 형태로 풀어가겠습니다.`,
    `${contextHint}좋아요. ${raw}은 지금 대화에서 바로 다룰 수 있는 주제입니다. 먼저 큰 그림을 잡고, 너무 모호한 부분은 답변 안에서 자연스럽게 좁혀가겠습니다.`,
  ], raw);
}

function pbCleanKnowledgeText(subject, summary) {
  const body = String(summary || "").replace(/\s+/g, " ").trim();
  if (!body) return "";
  const sentences = body.match(/[^.!?。！？]+[.!?。！？]?/g) || [body];
  const kept = [];
  for (const sentence of sentences) {
    const s = String(sentence || "").trim();
    if (!s) continue;
    if (/[\u4e00-\u9fff]/.test(s) && /(라고도|또는|혹은|別|称|苹果|頻婆)/.test(s)) continue;
    if (/(동음이의|분류:|목차|문서)/.test(s)) continue;
    kept.push(s);
    if (kept.length >= 4) break;
  }
  const cleaned = kept.join(" ").trim() || body;
  if (subject === "사과" && /(과일|열매)/.test(cleaned)) {
    return "사과는 둥글고 달콤한 맛이 나는 대표적인 과일입니다. 생으로 먹거나 주스, 잼, 파이 같은 재료로 많이 쓰이고, 품종에 따라 단맛과 산미가 달라요.";
  }
  if (["강아지", "개"].includes(subject)) {
    return "강아지는 사람과 오래 함께 살아온 대표적인 반려동물입니다. 품종마다 성격, 활동량, 털 관리 방식이 달라서 생활 환경과 돌봄 시간을 함께 고려하는 게 중요해요.";
  }
  return cleaned.slice(0, 700).replace(/\s{2,}/g, " ").trim();
}

function pbKnowledgeReply(topic, summary, query) {
  const subject = String(topic || "").trim();
  const body = pbCleanKnowledgeText(subject, summary);
  const topicParticle = `${subject}${pbParticle(subject, "은", "는")}`;
  const objectParticle = `${subject}${pbParticle(subject, "을", "를")}`;
  const stripped = pbStripSubject(pbFirstSentences(body, 2), subject).replace(/\s{2,}/g, " ");
  const compactBody = pbFirstSentences(body, 4).replace(/\s{2,}/g, " ");
  if (/(짧게|간단|핵심만|한 줄|한줄)/i.test(query)) {
    return pbPick([
      `${topicParticle} ${stripped}`,
      `핵심만 보면 ${topicParticle} ${stripped}`,
      `짧게 정리하면 ${subject}: ${stripped}`,
    ], `${query}:${body.length}`);
  }
  if (/(쉽게|친근|비유|예시|일상)/i.test(query)) {
    return pbPick([
      `쉽게 말하면 ${topicParticle} ${stripped}\n\n딱 정의만 외우기보다, 실제로 어디에서 보고 쓰는지까지 같이 보면 훨씬 자연스럽게 잡혀요.`,
      `${objectParticle} 편하게 풀면 이래요. ${stripped}\n\n예시를 붙이면 더 쉬운데, 지금은 먼저 큰 뜻부터 잡으면 됩니다.`,
      `일상적으로 말하면 ${topicParticle} ${stripped}\n\n너무 어렵게 볼 필요 없이 “무엇이고 어떤 상황에서 쓰이는가”를 같이 보면 돼요.`,
    ], `${query}:${body.length}`);
  }
  return pbPick([
    `${subject}에 대해 바로 말하면, ${stripped}${pbShouldAppendCompact(stripped, compactBody) ? `\n\n조금 더 풀면 ${compactBody}` : ""}`,
    `${topicParticle} 기본적으로 ${stripped}\n\n중요한 건 단어의 정의만 보는 게 아니라, 실제로 어디에 쓰이고 어떤 맥락에서 말하는지도 같이 보는 거예요.`,
    `먼저 큰 그림부터 보면, ${topicParticle} ${stripped}\n\n필요하면 이걸 더 쉬운 예시나 전문적인 배경 설명으로 이어서 풀 수 있습니다.`,
    `${objectParticle} 설명하면 이렇게 정리됩니다. ${stripped}\n\n한 문장으로 끝내기보다 핵심 뜻과 쓰임을 같이 보면 더 자연스럽게 이해됩니다.`,
  ], `${query}:${body.length}`);
}

function pbStripSubject(text, subject) {
  const escaped = String(subject || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text || "").replace(new RegExp(`^${escaped}(?:\\([^)]*\\))?\\s*(?:은|는|이|가|란|이라는|이란)\\s*`, "i"), "").trim();
}

function pbFirstSentences(text, maxCount = 2) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const parts = normalized.match(/[^.!?。！？]+[.!?。！？]?/g) || [normalized];
  return parts.slice(0, maxCount).join(" ").replace(/\s+/g, " ").trim();
}

function pbShouldAppendCompact(shortText, compactText) {
  const short = String(shortText || "").replace(/\s+/g, " ").trim();
  const compact = String(compactText || "").replace(/\s+/g, " ").trim();
  if (!short || !compact) return false;
  if (compact.includes(short) || short.includes(compact)) return false;
  return compact.length > short.length + 24;
}

function pbHealthReply(query) {
  const serious = /(심장|가슴|흉통|숨참|식은땀|어지럼|20분|반복|3일|며칠|응급)/i.test(query);
  if (serious) {
    return [
      "이건 가볍게 넘기면 안 되는 패턴입니다.",
      "",
      "가슴이나 심장 쪽 통증이 반복되거나 20분 이상 이어진다면 단순 근육통일 수도 있지만, 협심증 같은 심혈관 문제도 배제하면 안 됩니다.",
      "",
      "바로 진료를 고려해야 하는 신호는 다음과 같습니다.",
      "- 쥐어짜는 느낌이나 강한 압박감",
      "- 왼쪽 팔, 턱, 등으로 퍼지는 통증",
      "- 숨참, 식은땀, 어지럼, 의식 저하",
      "- 가만히 있어도 지속되는 통증",
      "",
      "이 중 하나라도 있으면 응급 진료를 권합니다. 증상이 멈췄더라도 반복된다면 내과나 심장내과에서 심전도와 혈액검사를 확인하는 편이 안전합니다.",
    ].join("\n");
  }
  return "건강 증상은 먼저 위험 신호부터 확인하는 게 안전합니다. 통증 위치, 지속 시간, 움직임이나 호흡과의 관계, 동반 증상을 알려주면 더 안전하게 정리해드릴게요.";
}

async function pbWeatherReply(query) {
  const match = String(query || "").match(/([가-힣A-Za-z]{2,20})\s*(날씨|weather)/i);
  const place = match ? match[1] : "";
  if (!place) return "";
  try {
    const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=ko&format=json`);
    if (!geo.ok) return "";
    const geoPayload = await geo.json();
    const first = Array.isArray(geoPayload.results) ? geoPayload.results[0] : null;
    if (!first) return "";
    const weather = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=1`);
    if (!weather.ok) return "";
    const payload = await weather.json();
    const current = payload.current || {};
    const daily = payload.daily || {};
    const max = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
    const min = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
    const rain = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : null;
    return `${place} 기준으로 지금 확인한 날씨예요.\n\n- 현재 ${pbNumber(current.temperature_2m)}°C, 체감 ${pbNumber(current.apparent_temperature)}°C\n- 바람 ${pbNumber(current.wind_speed_10m)}km/h\n- 오늘 예상 최저 ${pbNumber(min)}°C / 최고 ${pbNumber(max)}°C\n- 오늘 강수확률 최대 ${pbNumber(rain)}%`;
  } catch (_) {
    return "";
  }
}

function pbNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "?";
}

function pbGeneralReply(query, history = []) {
  const recent = Array.isArray(history) ? history.filter((item) => item && item.role === "user").slice(-2) : [];
  const contextHint = recent.length ? "방금 흐름도 참고해서 말하면, " : "";
  return pbPick([
    `${contextHint}${query}에 대해서는 먼저 핵심을 작게 잡는 게 좋아요. 지금 문장만 보면 정보 요청인지, 의견을 원하는지, 실행을 원하는지 중 하나로 이어질 수 있습니다. 원하는 방향을 말해주면 그쪽으로 바로 깊게 답하겠습니다.`,
    `${contextHint}지금 질문은 바로 이어서 다룰 수 있어요. 제가 먼저 가능한 해석을 잡고, 모호한 부분은 최소한만 확인하면서 답을 좁혀가겠습니다.`,
    `${contextHint}좋아요. 이건 너무 형식적으로 나누기보다, 사용자가 지금 얻고 싶은 결과를 먼저 맞추는 게 중요합니다. 설명, 비교, 해결 순서 중 원하는 방식으로 이어갈 수 있어요.`,
  ], query);
}

function pbLastAssistantText(history = []) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item && item.role === "assistant") return String(item.content || item.text || "").trim();
  }
  return "";
}

function pbLastUserText(history = []) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item && item.role === "user") return String(item.content || item.text || "").trim();
  }
  return "";
}

function pbRepairReply(query, history = []) {
  const raw = pbNormalize(query);
  const lastAssistant = pbLastAssistantText(history);
  const lastUser = pbLastUserText(history);
  const wantsNatural = /(자연스럽|친근|편하게|말투|다시\s*말|쉽게)/i.test(raw);
  if (wantsNatural && lastAssistant) {
    const topic = pbExtractTopic(lastUser) || pbExtractAetherTopic(lastUser) || "그 내용";
    return pbPick([
      `좋아요. 더 자연스럽게 말하면, ${topic}${pbParticle(topic, "은", "는")} 딱딱한 정의보다 “무엇이고 왜 중요한지”를 같이 보면 이해가 쉬워요. 방금 답은 설명이 너무 기계적이었으니, 다음부터는 먼저 쉬운 말로 풀고 필요한 근거만 붙이겠습니다.`,
      `응, 그 답은 너무 설명문처럼 들렸어요. 더 편하게 바꾸면 “${topic}${pbParticle(topic, "은", "는")} 이런 의미이고, 실제로는 이런 상황에서 쓰인다”처럼 맥락부터 잡아주는 게 맞습니다.`,
      `맞아요. 방금 답은 정보는 있어도 말맛이 부족했어요. 앞으로는 ${topic}${pbParticle(topic, "을", "를")} 설명할 때 정의만 던지지 않고, 예시와 사용 맥락까지 붙여서 자연스럽게 이어갈게요.`,
    ], `${raw}:${lastAssistant.length}:${history.length}`);
  }
  return pbPick([
    "맞아요. 방금 답은 의도를 너무 좁게 잡았어요. 이번에는 네가 틀렸다고 느낀 지점을 기준으로 다시 맞춰볼게요.",
    "알겠어요. 이전 답은 접고, 지금 말한 기준을 우선으로 두겠습니다.",
    "좋아요. 그 방향이 아니었다면 답변 방식을 바꿔야 해요. 원하는 톤이나 목적을 바로 이어서 반영할게요.",
  ], `${raw}:${Array.isArray(history) ? history.length : 0}`);
}

function pbMetaQualityReply(query) {
  const raw = pbNormalize(query);
  if (!/(고정|반복|똑같|품질|답변|기계적|자연스럽)/i.test(raw)) return "";
  return [
    "맞아요. 이 증상은 모델이 스스로 문장을 끝까지 생성하기보다, 중간 안전망 문장이 먼저 응답을 차지할 때 생깁니다.",
    "",
    "그래서 지금은 답변 경로를 이렇게 바꾸는 게 맞습니다.",
    "",
    "1. 먼저 실제 모델 또는 동적 지식 조회가 답하게 합니다.",
    "2. 고정 문장은 실패를 숨기는 용도가 아니라 오류를 알려주는 최소 장치로만 둡니다.",
    "3. 같은 질문이 반복되면 이전 답변을 그대로 쓰지 말고, 말투와 초점을 바꿔 다시 생성합니다.",
    "",
    "즉 문제는 질문이 아니라 응답 파이프라인의 우선순위입니다. 고정 문장이 앞에 있으면 AI처럼 보일 수 없어요.",
  ].join("\n");
}

function buildPbxReplyResponse(reply, streaming, corsH, mode = "aether-nexus") {
  const text = String(reply || "").trim() || "지금 응답을 완성하지 못했어요. 잠시 뒤 다시 시도해 주세요.";
  if (streaming) {
    const enc = new TextEncoder();
    const words = text.split(/\s+/).filter(Boolean);
    const stream = new ReadableStream({
      start(controller) {
        let chunk = [];
        for (const word of words) {
          chunk.push(word);
          if (chunk.length >= 5) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk: `${chunk.join(" ")} ` })}\n\n`));
            chunk = [];
          }
        }
        if (chunk.length) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk: chunk.join(" ") })}\n\n`));
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, full: text, ok: true, mode })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsH,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }
  return new Response(JSON.stringify({ ok: true, reply: text, mode }), {
    status: 200,
    headers: { ...corsH, "Content-Type": "application/json" },
  });
}

async function buildAetherWorkerReply(query, history = []) {
  const raw = normalizeUserQuery(query);
  const q = raw.toLowerCase();
  const intent = classifyAetherIntent(raw, history);
  if (!raw) return "메시지가 비어 있어요. 한 문장만 적어주시면 바로 이어서 볼게요.";
  if (intent.kind === "greeting") {
    return pickVariant([
      "안녕하세요. 지금 궁금한 걸 편하게 말해 주세요. 짧게 던져도 의도부터 잡아서 이어가볼게요.",
      "안녕하세요. 오늘은 어떤 걸 같이 보면 좋을까요?",
      "반가워요. 대화든 작업이든 지금 필요한 쪽으로 바로 맞춰볼게요.",
      "안녕하세요. 가볍게 시작해도 좋고, 바로 본론으로 들어가도 좋아요.",
    ]);
  }
  if (intent.kind === "casual") {
    return buildCasualReply(raw);
  }
  if (intent.kind === "health_safety") {
    return buildHealthSafetyReply(raw);
  }
  if (/(aether|nexus|넥서스|에테르|구조|아키텍처|프로젝트|요약)/i.test(raw)) {
    return [
      "Aether-Nexus는 Purple Bee를 고정 답변 생성기가 아니라 구조형 지능 커널로 바꾸기 위한 실행 방향입니다.",
      "",
      "- 자연어를 의도, 조건, 상태, 사건, 원인 관계로 분해합니다.",
      "- 사용자 자료와 대화는 그대로 쌓지 않고 가치 있는 조각만 기억 후보로 승격합니다.",
      "- 관리자는 학습 후보를 검토해 버전을 만들고 배포하며, 새 버전은 다시 다음 학습의 출발점이 됩니다.",
      "- 답변은 먼저 직접적으로 하고, 필요한 경우에만 근거와 다음 행동을 붙입니다.",
    ].join("\n");
  }
  if (intent.kind === "explore") {
    return buildExplorationReply(intent.topic || raw, raw);
  }
  const definitionTopic = normalizeKnowledgeTopic(extractDefinitionTopic(raw));
  if (definitionTopic) {
    const summary = await fetchWikipediaSummary(definitionTopic);
    if (summary) {
      return formatKnowledgeReply(definitionTopic, summary, raw);
    }
  }
  if (/(날씨|weather)/i.test(raw)) {
    const weather = await tryBuildWeatherReply(raw);
    if (weather) return weather;
  }
  if (/(코드|코딩|python|파이썬|오류|error|bug|버그)/i.test(raw)) {
    return "코드나 에러 로그를 보내주시면 증상, 가능한 원인, 바로 확인할 순서로 나눠서 정리하겠습니다.";
  }
  if (/(뭐 할 수 있어|무엇을 할 수|할 수 있어|can you do)/i.test(raw)) {
    return "질문 답변, 문서 요약, 코드와 오류 분석, 아이디어 정리, 대화 맥락 기반 정리를 도와드릴 수 있습니다. 지금 하고 싶은 일을 한 줄로 말해 주세요.";
  }
  if (/(아니야|그게 아니|다시|아닌데)/i.test(raw)) {
    const recent = Array.isArray(history) ? history.slice(-4).map((item) => String(item?.content || "")).filter(Boolean) : [];
    const previous = recent.length ? ` 방금 흐름은 "${recent[recent.length - 1].slice(0, 80)}" 쪽으로 보고 다시 잡겠습니다.` : "";
    return `알겠습니다.${previous} 원하는 기준을 한 줄만 더 주시면 그 방향으로 바로 정리하겠습니다.`;
  }
  return [
    buildDirectLead(raw),
    "",
    buildGeneralNaturalAnswer(raw, intent),
  ].join("\n");
}

function pickVariant(items) {
  const list = (items || []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!list.length) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function normalizeUserQuery(query) {
  return String(query || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/뭐ㅑ|머야|뭐임|모야/g, "뭐야")
    .replace(/알려조|알려저|알려쥬/g, "알려줘")
    .replace(/됌/g, "됨")
    .replace(/안되/g, "안 돼")
    .replace(/([가-힣])\\1{3,}/g, "$1$1")
    .trim();
}

function classifyAetherIntent(query, history = []) {
  const raw = String(query || "").trim();
  const lowered = raw.toLowerCase();
  if (!raw) return { kind: "empty", confidence: 1 };
  if (/^(안녕+|하이+|hello|hi|hey)[!?.…\s]*$/i.test(raw)) return { kind: "greeting", confidence: 0.98 };
  if (/(심장|가슴|흉통|숨\s*쉬|호흡|어지럽|식은땀|피\s*나|자살|죽고\s*싶|응급|통증|아퍼|아파|아픔|병원)/i.test(raw)) {
    return { kind: "health_safety", confidence: 0.86 };
  }
  if (/(우리\s*뭐|뭐\s*할까|심심|잡담|놀자|대화하자|뭐해|기분)/i.test(raw)) return { kind: "casual", confidence: 0.8 };
  if (/(탐구|분석|토론|고찰|윤리|철학|사회문제|문제에\s*대해|쟁점|관점)/i.test(raw)) {
    return { kind: "explore", topic: extractDefinitionTopic(raw) || raw, confidence: 0.82 };
  }
  if (/(요약|정리|핵심)/i.test(raw)) return { kind: "summarize", confidence: 0.75 };
  if (/(만들|작성|써줘|초안|문장|글|코드|수정|고쳐)/i.test(raw)) return { kind: "create_or_fix", confidence: 0.75 };
  if (extractDefinitionTopic(raw)) return { kind: "knowledge", topic: extractDefinitionTopic(raw), confidence: 0.72 };
  return { kind: "general", confidence: 0.5 };
}

function cleanKoreanTopic(topic) {
  return String(topic || "").trim().replace(/(이|가|은|는|을|를|란|이라는|라는)$/u, "");
}

function inferAnswerStyle(query) {
  const raw = String(query || "");
  if (/(짧게|간단|요약|핵심만|한줄|한 줄)/i.test(raw)) return "concise";
  if (/(쉽게|초등|어린|친근|비유|예시|일상적으로)/i.test(raw)) return "easy";
  if (/(자세히|깊게|탐구|분석|원리|배경|전문)/i.test(raw)) return "detailed";
  if (/(코드|기술|개발|수식|논문|공식|엔진|아키텍처)/i.test(raw)) return "technical";
  return "default";
}

function firstSentence(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.+?[.!?。！？])\s/);
  return (match ? match[1] : normalized).slice(0, 260).trim();
}

function formatKnowledgeReply(topic, summary, query) {
  const subject = cleanKoreanTopic(topic);
  const body = String(summary || "").replace(/\s+/g, " ").trim();
  const short = stripSubjectPrefix(firstSentence(body), subject);
  const style = inferAnswerStyle(query);

  if (style === "concise") {
    return pickVariant([
      `${subject}은 ${short}`,
      `짧게 보면 ${subject}은 ${short}`,
      `핵심만 말하면, ${subject}은 ${short}`,
    ]);
  }
  if (style === "easy") {
    const lead = pickVariant([
      `쉽게 말하면, ${subject}은 ${short}`,
      `${subject}을 아주 편하게 풀면, ${short}`,
      `일상적인 말로 바꾸면 ${subject}은 ${short}`,
    ]);
    const tail = pickVariant([
      "처음에는 정의보다 “어디에 쓰이고 왜 중요한지”를 같이 보면 훨씬 빨리 잡혀요.",
      "비유로 더 풀어달라고 하면 더 쉬운 예시로 이어서 설명할게요.",
      "지금은 큰 그림만 잡고, 원하면 예시나 원리 쪽으로 더 내려갈 수 있어요.",
    ]);
    return `${lead}\n\n${tail}`;
  }
  if (style === "detailed" || style === "technical") {
    const lead = pickVariant([
      `${subject}에 대해 조금 체계적으로 정리해볼게요.`,
      `${subject}은 개념, 배경, 실제 쓰임을 나눠서 보면 선명해집니다.`,
      `${subject}을 깊게 보려면 먼저 정의와 맥락을 분리하는 게 좋아요.`,
    ]);
    const tail = pickVariant([
      "더 깊게 들어가면 역사, 구조, 실제 사례 순서로 확장하면 됩니다.",
      "다음 단계로는 원리, 장단점, 실제 사례를 비교해보면 이해가 단단해져요.",
      "필요하면 이 내용을 시험용 요약, 발표용 설명, 개발자 관점 설명으로 다시 바꿔드릴 수 있어요.",
    ]);
    return [
      lead,
      "",
      body,
      "",
      tail,
    ].join("\n");
  }
  const lead = pickVariant([
    `${subject}은 이렇게 이해하면 됩니다.`,
    `${subject}을 한 번 자연스럽게 풀어보면 이렇습니다.`,
    `${subject}에 대해 바로 말하면 이렇습니다.`,
  ]);
  const tail = pickVariant([
    "짧게 말하면, 먼저 핵심 개념을 잡고 그다음 쓰임과 예시를 연결하면 이해하기 쉽습니다.",
    "원하면 이어서 더 쉽게, 더 전문적으로, 또는 예시 중심으로 바꿔서 설명할 수 있어요.",
    "지금 답은 큰 틀이고, 더 알고 싶은 방향을 말하면 그쪽으로 깊게 이어가겠습니다.",
  ]);
  return [
    lead,
    "",
    body,
    "",
    tail,
  ].join("\n");
}

function stripSubjectPrefix(text, subject) {
  let value = String(text || "").trim();
  const cleanSubject = String(subject || "").trim();
  if (!value || !cleanSubject) return value;
  const escaped = cleanSubject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  value = value.replace(new RegExp(`^${escaped}(?:\\([^)]*\\))?\\s*(?:은|는|이|가|란|이라는|이란)\\s*`, "i"), "");
  return value.trim() || String(text || "").trim();
}

function buildDirectLead(query) {
  const raw = String(query || "").trim();
  const style = inferAnswerStyle(raw);
  if (style === "easy") return pickVariant([`${raw}에 대해 쉽게 풀어서 말해볼게요.`, `${raw}을 편한 말로 바꿔서 설명해볼게요.`]);
  if (style === "detailed") return pickVariant([`${raw}에 대해 조금 깊게 나눠서 보겠습니다.`, `${raw}은 기준을 나눠서 보면 더 선명해집니다.`]);
  if (style === "technical") return pickVariant([`${raw}을 기술적인 기준으로 정리하겠습니다.`, `${raw}은 구조와 동작 기준으로 먼저 보겠습니다.`]);
  if (style === "concise") return pickVariant([`${raw}의 핵심만 짧게 말하면 이렇습니다.`, `${raw}은 핵심만 잡으면 간단합니다.`]);
  return pickVariant([`${raw}에 대해 바로 답하겠습니다.`, `${raw}을 지금 문맥 기준으로 먼저 정리해볼게요.`, `${raw}은 이렇게 접근하면 좋겠습니다.`]);
}

function buildCasualReply(query) {
  if (/(우리\s*뭐|뭐\s*할까|뭐\s*할래)/i.test(query)) {
    return pickVariant([
      "좋아요. 지금은 가볍게 잡담을 이어가도 되고, 막힌 문제를 같이 풀어도 되고, 아이디어 하나 잡아서 바로 만들어봐도 좋아요. 오늘 컨디션이 어떤 쪽인지부터 맞춰볼게요.",
      "우리라면 세 가지가 괜찮겠어요. 머리 식히는 대화, 지금 프로젝트 점검, 아니면 작은 기능 하나 바로 만들기. 저는 지금 흐름상 프로젝트 점검이 제일 실속 있어 보여요.",
      "좋아요. 너무 거창하게 시작하지 말고, 지금 가장 신경 쓰이는 것 하나만 꺼내서 같이 정리해봐요. 대화든 코드든 거기서 자연스럽게 이어가면 됩니다.",
    ]);
  }
  if (/(뭐해|하고\s*있어)/i.test(query)) {
    return pickVariant([
      "지금은 네가 보낸 말을 보고 의도부터 잡고 있어요. 짧은 말이면 맥락을 이어보고, 중요한 말이면 먼저 위험도나 목적을 분리해서 답하려고 해요.",
      "나는 지금 대화 흐름을 정리하는 중이에요. 그냥 잡담이면 편하게 받고, 작업 얘기면 바로 다음 행동으로 바꿔볼게요.",
      "지금은 대기하면서 네 다음 말을 받을 준비 중이에요. 한 줄만 던져도 맥락을 이어서 같이 잡아볼게요.",
    ]);
  }
  if (/(심심|잡담|놀자|대화)/i.test(query)) {
    return pickVariant([
      "그럼 가볍게 가볼까요. 요즘 머릿속에 제일 많이 맴도는 게 프로젝트인지, 게임인지, 아니면 그냥 쉬고 싶은 건지부터 하나만 골라봐요.",
      "좋아요. 잡담 모드로 가면 너무 딱딱하게 굴지 않고 편하게 이어갈게요. 오늘 기분을 색깔로 치면 어떤 쪽이에요?",
      "그럼 잠깐 숨 돌리는 대화로 가죠. 요즘 제일 신경 쓰이는 일 하나만 말해줘도 거기서 자연스럽게 풀어볼게요.",
    ]);
  }
  return pickVariant([
    "좋아요. 편하게 이어가요. 지금 말한 흐름에서 제일 자연스러운 다음 질문을 같이 잡아볼게요.",
    "알겠어요. 너무 틀에 맞추지 않고, 지금 말의 뉘앙스를 기준으로 이어가볼게요.",
    "좋습니다. 방금 말은 그대로 받고, 필요한 만큼만 정리해서 이어갈게요.",
  ]);
}

function buildHealthSafetyReply(query) {
  const raw = String(query || "");
  const chestLike = /(심장|가슴|흉통|왼쪽\s*가슴|명치|숨\s*쉬|호흡)/i.test(raw);
  const repeated = /(3일|사흘|며칠|반복|비슷한\s*시간|20분|오래|계속)/i.test(raw);
  const redFlags = /(식은땀|숨\s*참|호흡곤란|어지럼|실신|턱|팔|등으로|압박|쥐어짜|가만히\s*있어도)/i.test(raw);

  if (chestLike && (repeated || redFlags)) {
    return [
      "이건 가볍게 넘기면 안 되는 패턴입니다.",
      "",
      "심장 쪽이나 가슴 통증이 반복되거나 20분 이상 지속된다면 단순 근육통일 수도 있지만, 협심증 같은 심혈관 문제도 배제하면 안 됩니다.",
      "",
      "바로 병원 또는 응급실을 고려해야 하는 신호는 다음과 같습니다.",
      "",
      "- 쥐어짜는 느낌이나 강한 압박감",
      "- 왼쪽 팔, 턱, 등으로 퍼지는 통증",
      "- 숨참, 식은땀, 어지럼, 실신 느낌",
      "- 가만히 있어도 통증이 계속됨",
      "- 비슷한 시간대에 반복되고 20분 이상 지속됨",
      "",
      "숨 쉬거나 움직일 때 더 아프면 근육, 갈비뼈, 흉막 쪽 가능성도 있지만, 반복되는 흉통은 한 번은 진료로 확인하는 게 안전합니다. 지금 통증이 있거나 위 신호가 하나라도 있으면 지체하지 말고 응급 진료를 받아 주세요.",
    ].join("\n");
  }

  return [
    "건강 관련 증상은 먼저 위험 신호부터 확인하는 게 안전합니다.",
    "",
    "통증이 심해지거나, 숨참/식은땀/어지럼/의식 저하/피가 남 같은 증상이 있으면 바로 진료를 받아야 합니다. 증상이 반복되거나 일상생활에 영향을 주는 정도라면 가까운 병원에서 확인하는 편이 좋습니다.",
    "",
    "가능하면 위치, 시작 시간, 지속 시간, 움직임이나 호흡과의 관계, 동반 증상을 같이 알려주면 더 안전하게 정리해드릴 수 있어요.",
  ].join("\n");
}

function buildExplorationReply(topic, query) {
  const subject = normalizeKnowledgeTopic(topic || query);
  const style = inferAnswerStyle(query);
  if (style === "concise") {
    return `${subject}의 핵심은 “무엇이 옳은가”만이 아니라, 누구에게 어떤 영향이 생기고 어떤 기준으로 판단할지를 따지는 데 있습니다.`;
  }
  return [
    `${subject}을 탐구하려면 먼저 기준을 나눠서 보는 게 좋습니다.`,
    "",
    "첫째, 가치 기준입니다. 무엇을 더 중요하게 볼지 정해야 합니다. 예를 들면 안전, 자유, 공정성, 책임, 효율 같은 기준이 서로 충돌할 수 있습니다.",
    "",
    "둘째, 영향 범위입니다. 어떤 선택이 개인, 주변 사람, 사회 전체에 어떤 결과를 만드는지 봐야 합니다.",
    "",
    "셋째, 책임의 위치입니다. 문제가 생겼을 때 누가 알고 있었고, 누가 선택했고, 누가 피해를 받는지 분리해야 판단이 흐려지지 않습니다.",
    "",
    "짧게 말하면, 좋은 탐구는 정답 하나를 빨리 고르는 게 아니라 기준과 결과를 분리해서 더 덜 위험하고 더 납득 가능한 결론으로 좁혀가는 과정입니다.",
  ].join("\n");
}

function buildGeneralNaturalAnswer(query, intent) {
  const raw = String(query || "").trim();
  if (intent?.kind === "create_or_fix") {
    return pickVariant([
      "원하는 결과물의 형태를 먼저 잡고, 필요한 조건을 나눈 다음 바로 초안을 만들면 됩니다. 자료나 예시가 있으면 그 기준에 맞춰 더 정확하게 다듬을 수 있어요.",
      "이건 먼저 목적, 형식, 제한 조건을 분리하면 바로 만들 수 있습니다. 예시가 있으면 그 톤에 맞춰서 더 자연스럽게 바꿀게요.",
      "초안을 만들 때는 완벽한 첫 문장보다 구조가 먼저예요. 필요한 정보만 주면 뼈대부터 잡고 문장까지 다듬겠습니다.",
    ]);
  }
  if (intent?.kind === "summarize") {
    return pickVariant([
      "핵심 주장, 근거, 다음 행동으로 나눠서 정리하면 이해하기 쉽습니다. 원문이나 자료를 붙여주면 중요한 내용만 추려서 다시 써드릴게요.",
      "요약은 먼저 '무슨 말인지', '왜 중요한지', '다음에 뭘 해야 하는지'로 나누면 깔끔합니다. 자료를 보내주면 그 기준으로 줄여볼게요.",
      "핵심만 남기려면 반복 표현과 배경 설명을 걷어내야 합니다. 원문을 주면 필요한 문장만 살려서 정리하겠습니다.",
    ]);
  }
  return pickVariant([
    "지금 문장은 정보 요청인지, 의견을 원하는지, 실행을 원하는지부터 나눠볼 수 있습니다. 먼저 핵심을 짧게 잡고, 필요하면 예시나 단계로 확장하는 방식이 자연스럽습니다.",
    "이건 바로 결론부터 잡고, 부족한 부분만 질문으로 좁히는 게 좋아 보입니다. 원하면 제가 먼저 가능한 방향을 몇 가지로 나눠볼게요.",
    "지금 말은 큰 틀에서 이해했습니다. 더 정확하게 가려면 목적, 조건, 원하는 답변 길이를 나누면 됩니다. 그래도 우선은 제가 가장 그럴듯한 방향으로 이어가볼게요.",
  ]);
}

async function resolvePublicBackendConfig(request, env) {
  const fromAssets = await loadPublicBackendConfigFromAssets(request, env);
  if (fromAssets) return fromAssets;
  return {
    configured: false,
    publicApiBaseUrl: "",
    source: "none",
  };
}

async function loadPublicBackendConfigFromAssets(request, env) {
  if (!env.ASSETS) return null;
  try {
    const assetRequest = new Request(new URL("/static/public-backend.json", request.url), {
      method: "GET",
      headers: request.headers,
    });
    const response = await env.ASSETS.fetch(assetRequest);
    if (!response.ok) return null;
    const payload = await response.json();
    const publicApiBaseUrl = String(payload?.public_api_base_url || "").trim().replace(/\/+$/, "");
    const currentOrigin = new URL(request.url).origin.replace(/\/+$/, "");
    if (!publicApiBaseUrl || publicApiBaseUrl === currentOrigin) {
      return {
        configured: false,
        publicApiBaseUrl: "",
        source: "assets",
      };
    }
    return {
      configured: true,
      publicApiBaseUrl,
      source: "assets",
    };
  } catch {
    return null;
  }
}

function buildRuleBasedReply(query) {
  const q = String(query || "").toLowerCase();
  if (/(안녕|hello|hi\b|hey\b)/.test(q)) {
    return "안녕하세요. 지금은 서버 연결을 복구하는 중이라 간단 모드로만 답하고 있어요.";
  }
  if (/(날씨|weather)/.test(q)) {
    return "실시간 날씨 응답은 공개 Purple Bee 백엔드가 연결되면 다시 정상 동작해요.";
  }
  if (/(강아지|dog)/.test(q)) {
    return "강아지는 사람과 오래 함께해 온 대표적인 반려동물이에요.";
  }
  return "지금은 Purple Bee 공개 백엔드 연결이 준비되지 않아 간단 응답만 제공 중이에요.";
}

function looksLikeFixedWebsiteReply(reply) {
  const text = String(reply || "").trim();
  if (!text) return true;
  const lowered = text.toLowerCase();
  const rigidMarkers = [
    "조금 더 자세하게 설명해 주시면",
    "어떤 부분이 궁금하신지 조금 더 말씀해 주세요",
    "안녕하세요! 오늘도 좋은 하루 되세요",
    "반갑습니다! 무엇이든 물어보세요",
    "최대한 도와드릴게요",
    "궁금한 게 있으면 편하게 말씀해 주세요",
    "what part would you like to know more about",
    "tell me a bit more",
  ];
  return rigidMarkers.some((marker) => lowered.includes(marker.toLowerCase()));
}

async function buildWebsiteRuntimeReplyV2(query, history) {
  const raw = String(query || "").trim();
  const q = raw.toLowerCase();
  const recent = Array.isArray(history) ? history.slice(-4) : [];

  if (!raw) {
    return "질문이 비어 있어요. 한 줄만 적어주시면 바로 답해볼게요.";
  }

  if (/(안녕|하이|hello|hi\b|hey\b)/.test(q)) {
    return "안녕하세요. Purple Bee예요. 궁금한 걸 편하게 물어보세요.";
  }

  if (/(날씨|weather)/.test(q)) {
    const weather = await tryBuildWeatherReply(raw);
    if (weather) return weather;
    return "날씨를 보려면 지역명을 함께 적어주세요. 예: 군산 날씨 어때";
  }

  const definitionTopic = extractDefinitionTopic(raw);
  if (definitionTopic) {
    const summary = await fetchWikipediaSummary(definitionTopic);
    if (summary) return summary;
  }

  if (/(파이썬|python|코드|코딩|error|오류|bug|버그)/.test(q)) {
    return "코드나 에러 로그를 붙여주시면 원인과 수정 방향을 바로 정리해드릴게요.";
  }

  if (/(강아지|dog)/.test(q)) {
    return "강아지는 사람과 오래 함께해 온 대표적인 반려동물이에요. 품종마다 성격과 활동량이 달라서 생활 방식에 맞게 보는 게 중요해요.";
  }

  if (/(사과|apple)/.test(q) && /(뭐|뭔|정의|설명|알아)/.test(q)) {
    return "사과는 장미과에 속하는 대표적인 과일이에요. 생으로 먹기도 하고 주스, 잼, 디저트 재료로도 많이 써요.";
  }

  if (/(아니야|아니|그게 아니|틀렸|다시)/.test(q)) {
    const lastUser = recent.filter((item) => item && item.role === "user").slice(-1)[0];
    if (lastUser && lastUser.content) {
      return `알겠어요. 방금 요청을 다시 볼게요. "${String(lastUser.content).trim()}" 쪽에서 원하는 답 형태를 한 줄 더 적어주시면 바로 맞춰서 답할게요.`;
    }
    return "알겠어요. 원하는 방향을 한 줄만 더 적어주시면 바로 맞춰서 다시 답할게요.";
  }

  return "질문은 이해했어요. 지금 단계에서는 핵심부터 짧고 직접적으로 답하는 방식으로 이어갈게요. 조금만 더 구체적으로 적어주시면 더 정확하게 답할 수 있어요.";
}

function extractDefinitionTopic(query) {
  const raw = String(query || "").trim();
  if (!raw) return "";
  const asksForInfo = /(뭐|뭔|정의|설명|알아|알려|해석|뜻|개념|탐구|분석|조사|who is|what is|tell me about|meaning|explain)/i.test(raw);
  if (!asksForInfo && !isBareInformationPrompt(raw)) {
    return "";
  }
  const cleaned = raw
    .replace(/[?？!！]/g, " ")
    .replace(/(이게|그게|저게|이건|그건|저건|이거|그거|저거|좀|간단히|자세히|쉽게|친근하게|전문적으로|핵심만)/g, " ")
    .replace(/(뭐야|뭔가요|뭔지|무엇인지|정의|설명해줘|설명|알아|알려줘|알려\s*줘|해석해줘|해석|뜻|개념|탐구해줘|탐구해|탐구|분석해줘|분석해|조사해줘|조사해)/g, " ")
    .replace(/(에\s*대해|에\s*대한|에\s*관해|에\s*관한)/g, " ")
    .replace(/\b(what is|who is|tell me about|meaning of|explain|concise|briefly|simply|easy|detailed)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);
  if (!parts.length) return "";
  return cleanKoreanTopic(parts.join(" ").slice(0, 80));
}

function normalizeKnowledgeTopic(topic) {
  const raw = cleanKoreanTopic(topic).replace(/\s+/g, " ").trim();
  if (/윤리|도덕|ethic/i.test(raw)) return "윤리";
  if (/문학|literature/i.test(raw)) return "문학";
  if (/역사|history/i.test(raw)) return "역사";
  if (/철학|philosophy/i.test(raw)) return "철학";
  if (/인공지능|AI|artificial intelligence/i.test(raw)) return "인공지능";
  return raw;
}

function isBareInformationPrompt(query) {
  const raw = String(query || "").trim();
  if (!raw || raw.length > 48) return false;
  if (/^(안녕+|하이+|hello|hi|hey|응|어|아니|ㅇㅇ|ㄴㄴ)[!?.…\s]*$/i.test(raw)) return false;
  if (/(우리|너|나|뭐\s*할|왜|어떻게|해줘|하자|하래|하지|말해|써줘|만들|고쳐|보여|찾아|검색|날씨|시간|오늘|내일)/i.test(raw)) {
    return false;
  }
  if (!/^[A-Za-z0-9가-힣\s._:+#-]+$/.test(raw)) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  return tokens.length <= 5 && tokens.some((token) => /[A-Za-z가-힣]{2,}/.test(token));
}

async function fetchWikipediaSummary(topic) {
  const subject = encodeURIComponent(String(topic || "").trim());
  if (!subject) return "";
  const candidates = [
    `https://ko.wikipedia.org/api/rest_v1/page/summary/${subject}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${subject}`,
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "PurpleBeeWorker/1.0",
        },
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const extract = String(payload.extract || "").trim();
      if (!extract) continue;
      return extract.split("\n")[0].trim();
    } catch {
      // Try next source.
    }
  }
  return "";
}

async function tryBuildWeatherReply(query) {
  const place = extractWeatherPlace(query);
  if (!place) return "";
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=ko&format=json`;
    const geoResponse = await fetch(geoUrl, { headers: { "accept": "application/json" } });
    if (!geoResponse.ok) return "";
    const geo = await geoResponse.json();
    const first = Array.isArray(geo.results) ? geo.results[0] : null;
    if (!first) return "";

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=1`;
    const weatherResponse = await fetch(weatherUrl, { headers: { "accept": "application/json" } });
    if (!weatherResponse.ok) return "";
    const weather = await weatherResponse.json();
    const current = weather.current || {};
    const daily = weather.daily || {};
    const max = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
    const min = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
    const rain = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : null;
    return `${place} 기준 현재 ${formatNumber(current.temperature_2m)}°C, 체감 ${formatNumber(current.apparent_temperature)}°C예요. 바람은 ${formatNumber(current.wind_speed_10m)}km/h 정도이고, 오늘 예상 기온은 최저 ${formatNumber(min)}°C / 최고 ${formatNumber(max)}°C예요.${rain !== null ? ` 강수확률은 최대 ${formatNumber(rain)}%예요.` : ""}`;
  } catch {
    return "";
  }
}

function extractWeatherPlace(query) {
  const raw = String(query || "").trim();
  const match = raw.match(/([가-힣A-Za-z]{2,20})\s*(날씨|weather)/i);
  if (match) return match[1];
  return "";
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "?";
  return Math.round(number * 10) / 10;
}

function shouldServeIndex(pathname) {
  return pathname === "/" || pathname === "/index.html";
}

function isMarketingProxyPath(pathname) {
  if (!pathname) return false;
  if (/^\/index\/purple-bee(\/.*)?$/.test(pathname)) return true;
  if (/^\/(ko-KR|en-US|ja-JP)\/index\/purple-bee(\/.*)?$/.test(pathname)) return true;
  return false;
}

function normalizeMarketingAssetPath(pathname) {
  let path = String(pathname || "/").replace(/\/+$/, "");
  if (!path) path = "/";
  if (path === "/index/purple-bee") return "/ko-KR/index/purple-bee/index.html";
  if (path.startsWith("/index/purple-bee/")) {
    const suffix = path.replace(/^\/index\/purple-bee\/?/, "");
    return suffix ? `/ko-KR/index/purple-bee/${suffix}/index.html` : "/ko-KR/index/purple-bee/index.html";
  }
  if (/^\/(ko-KR|en-US|ja-JP)\/index\/purple-bee$/.test(path)) {
    return `${path}/index.html`;
  }
  if (/^\/(ko-KR|en-US|ja-JP)\/index\/purple-bee\//.test(path)) {
    return `${path}/index.html`;
  }
  return `${path}/index.html`;
}

function jsonResponse(payload, status, request) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

async function resolveRuntimeConfig(request, env) {
  const fromAssets = await loadRuntimeConfigFromAssets(request, env);
  if (fromAssets) return fromAssets;
  return buildRuntimeConfigFromEnv(env);
}

async function loadRuntimeConfigFromAssets(request, env) {
  if (!env.ASSETS) return null;
  const requestedModelId = sanitizeModelId(new URL(request.url).searchParams.get("model_id"));
  const manifestPath = requestedModelId
    ? `/static/manifests/${requestedModelId}.json`
    : "/static/browser-manifest.json";
  let manifestRequest = new Request(new URL(manifestPath, request.url), {
    method: "GET",
    headers: request.headers,
  });
  const assetResponse = await env.ASSETS.fetch(manifestRequest);
  if (!assetResponse.ok && requestedModelId) {
    manifestRequest = new Request(new URL("/static/browser-manifest.json", request.url), {
      method: "GET",
      headers: request.headers,
    });
  }
  const resolvedResponse = assetResponse.ok || !requestedModelId
    ? assetResponse
    : await env.ASSETS.fetch(manifestRequest);
  if (!resolvedResponse.ok) return null;

  const payload = await resolvedResponse.json();
  const runtime = payload?.runtime || {};
  if (String(runtime.engine || "").trim().toLowerCase() === "aether-nexus") {
    return {
      mode: "aether-nexus",
      familyName: String(payload.family_name || "Purple Bee"),
      modelId: String(payload.model_id || "purple-bee-1-0"),
      displayName: String(payload.display_name || "Purple Bee 1.0"),
      baseModel: String(payload.base_model || "Aether-Nexus structural runtime"),
      onnxUrl: "",
      tokenizerUrl: "",
      onnxDataUrl: "",
      assetVersion: String(payload.asset_version || payload.version || "1.0").trim(),
      metadataAssets: {},
      providerPreference: [],
      maxContext: Number(runtime.max_context || 4096),
      storage: "server-aether-adapter",
      publicBaseUrl: "",
      runtimeOptions: {
        ...runtime,
        engine: "aether-nexus",
        preparation_required: false,
        download_required: false,
        max_context: Number(runtime.max_context || 4096),
      },
      assetMap: {},
    };
  }
  if (String(runtime.engine || "").trim().toLowerCase() === "transformers-js") {
    const modelRepo = String(runtime.model_repo || "").trim();
    const revision = String(runtime.revision || "main").trim() || "main";
    const onnxName = basenameFromUrl(String(payload?.browser_assets?.onnx || "").trim()) || "model_q4.onnx";
    const tokenizerName = basenameFromUrl(String(payload?.browser_assets?.tokenizer || "").trim()) || "tokenizer.json";
    const onnxDataName = basenameFromUrl(String(payload?.browser_assets?.onnx_data || "").trim()) || "";
    return {
      mode: "transformers-js",
      familyName: String(payload.family_name || "Purple Bee"),
      modelId: String(payload.model_id || "purple-bee-1-3"),
      displayName: String(payload.display_name || "Purple Bee 1.3"),
      baseModel: String(payload.base_model || "Qwen2.5-0.5B-Instruct-ONNX"),
      onnxUrl: String(payload?.browser_assets?.onnx || "").trim(),
      tokenizerUrl: String(payload?.browser_assets?.tokenizer || "").trim(),
      onnxDataUrl: String(payload?.browser_assets?.onnx_data || "").trim(),
      assetVersion: String(payload.asset_version || "").trim(),
      metadataAssets: payload?.metadata_assets || {},
      providerPreference: normalizeProviderPreference(runtime.provider_preference),
      maxContext: Number(runtime.max_context || 2048),
      storage: "remote-model-repo",
      publicBaseUrl: "",
      runtimeOptions: {
        ...runtime,
        provider_preference: normalizeProviderPreference(runtime.provider_preference),
        max_context: Number(runtime.max_context || 2048),
        engine: "transformers-js",
      },
      assetMap: buildTransformersRepoAssetMap(modelRepo, revision, {
        onnxName,
        tokenizerName,
        onnxDataName,
      }),
    };
  }

  const browserAssets = payload?.browser_assets || {};
  const metadataAssets = payload?.metadata_assets || {};
  const onnxUrl = String(browserAssets.onnx || "").trim();
  const tokenizerUrl = String(browserAssets.tokenizer || "").trim();
  const onnxDataUrl = String(browserAssets.onnx_data || "").trim();
  if (!onnxUrl || !tokenizerUrl) return null;

  return {
    familyName: String(payload.family_name || "Purple Bee"),
    modelId: String(payload.model_id || "purple-bee-1-3"),
    displayName: String(payload.display_name || "Purple Bee 1.3"),
    baseModel: String(payload.base_model || "Qwen2.5-0.5B-Instruct-ONNX"),
    onnxUrl,
    tokenizerUrl,
    onnxDataUrl,
    metadataAssets,
    assetVersion: String(payload.asset_version || "").trim(),
    maxContext: Number(runtime.max_context || 2048),
    providerPreference: normalizeProviderPreference(runtime.provider_preference),
    storage: "public-object-storage",
    publicBaseUrl: deriveBaseUrl(onnxUrl),
    runtimeOptions: {
      ...runtime,
      provider_preference: normalizeProviderPreference(runtime.provider_preference),
      max_context: Number(runtime.max_context || 2048),
      engine: String(runtime.engine || "purple-bee-onnx").trim().toLowerCase() || "purple-bee-onnx",
    },
    assetMap: buildAssetMap(onnxUrl, tokenizerUrl, onnxDataUrl, metadataAssets),
  };
}

function buildTransformersRepoAssetMap(modelRepo, revision, filenames = {}) {
  const repo = String(modelRepo || "").trim();
  const rev = String(revision || "main").trim() || "main";
  const onnxName = String(filenames.onnxName || "model_q4.onnx").trim() || "model_q4.onnx";
  const tokenizerName = String(filenames.tokenizerName || "tokenizer.json").trim() || "tokenizer.json";
  const onnxDataName = String(filenames.onnxDataName || "").trim();
  const map = {};
  if (!repo) return map;

  const base = `https://huggingface.co/${repo}/resolve/${rev}`;
  const register = (key, value) => {
    if (!key || !value) return;
    map[key] = value;
  };

  register(onnxName, `${base}/onnx/${onnxName}`);
  register(`onnx/${onnxName}`, `${base}/onnx/${onnxName}`);
  register(tokenizerName, `${base}/${tokenizerName}`);
  register("tokenizer.json", `${base}/tokenizer.json`);

  if (onnxDataName) {
    register(onnxDataName, `${base}/onnx/${onnxDataName}`);
    register(`onnx/${onnxDataName}`, `${base}/onnx/${onnxDataName}`);
  }

  for (const metadataName of [
    "config.json",
    "generation_config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
    "quantize_config.json",
    "merges.txt",
    "vocab.json",
    "added_tokens.json",
  ]) {
    register(metadataName, `${base}/${metadataName}`);
  }

  return map;
}

function buildRuntimeConfigFromEnv(env) {
  const publicBaseUrl = String(env.PURPLE_BEE_MODEL_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!publicBaseUrl) return null;

  const modelId = String(env.PURPLE_BEE_MODEL_ID || "purple-bee-1-3");
  const displayName = String(env.PURPLE_BEE_MODEL_DISPLAY_NAME || "Purple Bee 1.3");
  const onnxName = String(env.PURPLE_BEE_MODEL_ONNX || "purple-bee-1-3-int8.onnx");
  const tokenizerName = String(env.PURPLE_BEE_MODEL_TOKENIZER || "tokenizer.json");
  const onnxDataName = String(env.PURPLE_BEE_MODEL_ONNX_DATA || "");
  const onnxUrl = `${publicBaseUrl}/${onnxName}`;
  const tokenizerUrl = `${publicBaseUrl}/${tokenizerName}`;
  const onnxDataUrl = onnxDataName ? `${publicBaseUrl}/${onnxDataName}` : "";
  const metadataAssets = {
    config: `${publicBaseUrl}/config.json`,
    generation_config: `${publicBaseUrl}/generation_config.json`,
    special_tokens_map: `${publicBaseUrl}/special_tokens_map.json`,
    tokenizer_config: `${publicBaseUrl}/tokenizer_config.json`,
  };

  return {
    familyName: "Purple Bee",
    modelId,
    displayName,
    baseModel: "Qwen2.5-0.5B-Instruct-ONNX",
    onnxUrl,
    tokenizerUrl,
    onnxDataUrl,
    metadataAssets,
    assetVersion: String(env.PURPLE_BEE_MODEL_ASSET_VERSION || "").trim(),
    maxContext: 2048,
    providerPreference: normalizeProviderPreference(env.PURPLE_BEE_PROVIDER_PREFERENCE),
    storage: "public-object-storage",
    publicBaseUrl,
    runtimeOptions: {
      provider_preference: normalizeProviderPreference(env.PURPLE_BEE_PROVIDER_PREFERENCE),
      max_context: 2048,
    },
    assetMap: buildAssetMap(onnxUrl, tokenizerUrl, onnxDataUrl, metadataAssets),
  };
}

function buildAssetMap(onnxUrl, tokenizerUrl, onnxDataUrl, metadataAssets = {}) {
  const assetMap = {};
  const onnxName = basenameFromUrl(onnxUrl);
  const tokenizerName = basenameFromUrl(tokenizerUrl);
  const onnxDataName = basenameFromUrl(onnxDataUrl);
  if (onnxName) assetMap[onnxName] = onnxUrl;
  if (tokenizerName) assetMap[tokenizerName] = tokenizerUrl;
  if (onnxDataName) assetMap[onnxDataName] = onnxDataUrl;
  if (onnxName) assetMap[`onnx/${onnxName}`] = onnxUrl;
  if (onnxDataName) assetMap[`onnx/${onnxDataName}`] = onnxDataUrl;
  const onnxRelativePath = relativeResolvePathFromUrl(onnxUrl);
  const tokenizerRelativePath = relativeResolvePathFromUrl(tokenizerUrl);
  const onnxDataRelativePath = relativeResolvePathFromUrl(onnxDataUrl);
  if (onnxRelativePath) assetMap[onnxRelativePath] = onnxUrl;
  if (tokenizerRelativePath) assetMap[tokenizerRelativePath] = tokenizerUrl;
  if (onnxDataRelativePath) assetMap[onnxDataRelativePath] = onnxDataUrl;
  if (onnxRelativePath && !assetMap[`onnx/${onnxName}`] && onnxName) {
    assetMap[`onnx/${onnxName}`] = onnxUrl;
  }
  if (onnxDataRelativePath && !assetMap[`onnx/${onnxDataName}`] && onnxDataName) {
    assetMap[`onnx/${onnxDataName}`] = onnxDataUrl;
  }
  for (const value of Object.values(metadataAssets || {})) {
    const filename = basenameFromUrl(value);
    if (filename && value) assetMap[filename] = value;
    const relativePath = relativeResolvePathFromUrl(value);
    if (relativePath && value) assetMap[relativePath] = value;
  }
  return assetMap;
}

function relativeResolvePathFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const marker = "/resolve/main/";
    const pathname = String(parsed.pathname || "");
    const index = pathname.indexOf(marker);
    if (index >= 0) {
      return decodeURIComponent(pathname.slice(index + marker.length));
    }
    return decodeURIComponent(pathname.split("/").filter(Boolean).slice(-2).join("/"));
  } catch {
    return "";
  }
}

function buildBrowserManifest(request, runtimeConfig) {
  if (String(runtimeConfig?.runtimeOptions?.engine || "").trim().toLowerCase() === "aether-nexus") {
    return {
      family_name: runtimeConfig.familyName || "Purple Bee",
      model_id: runtimeConfig.modelId || "purple-bee-1-0",
      display_name: runtimeConfig.displayName || "Purple Bee 1.0",
      version: runtimeConfig.assetVersion || "1.0",
      architecture_name: "Aether-Nexus Structural Intelligence Kernel",
      base_model: runtimeConfig.baseModel || "Aether-Nexus structural runtime",
      browser_assets: {},
      metadata_assets: {},
      runtime: {
        ...(runtimeConfig.runtimeOptions || {}),
        engine: "aether-nexus",
        preparation_required: false,
        download_required: false,
        max_context: runtimeConfig.maxContext || 4096,
      },
      deployment: {
        storage: runtimeConfig.storage || "server-aether-adapter",
        public_base_url: "",
        proxied: false,
      },
    };
  }
  const origin = new URL(request.url).origin;
  const onnxName = basenameFromUrl(runtimeConfig.onnxUrl);
  const tokenizerName = basenameFromUrl(runtimeConfig.tokenizerUrl);
  const onnxDataName = basenameFromUrl(runtimeConfig.onnxDataUrl);
  const metadataAssets = runtimeConfig.metadataAssets || {};
  const search = new URLSearchParams();
  if (runtimeConfig.modelId) search.set("model_id", runtimeConfig.modelId);
  if (runtimeConfig.assetVersion) search.set("v", runtimeConfig.assetVersion);
  const modelQuery = search.toString() ? `?${search.toString()}` : "";
  const proxiedMetadataAssets = {};
  for (const [key, value] of Object.entries(metadataAssets)) {
    const filename = basenameFromUrl(value);
    proxiedMetadataAssets[key] = filename
      ? `${origin}/api/runtime/assets/${encodeURIComponent(filename)}${modelQuery}`
      : null;
  }

  return {
    family_name: runtimeConfig.familyName,
    model_id: runtimeConfig.modelId,
    display_name: runtimeConfig.displayName,
    base_model: runtimeConfig.baseModel || "Qwen2.5-0.5B-Instruct-ONNX",
    asset_version: runtimeConfig.assetVersion || "",
    browser_assets: {
      onnx: `${origin}/api/runtime/assets/${encodeURIComponent(onnxName)}${modelQuery}`,
      tokenizer: `${origin}/api/runtime/assets/${encodeURIComponent(tokenizerName)}${modelQuery}`,
      onnx_data: onnxDataName
        ? `${origin}/api/runtime/assets/${encodeURIComponent(onnxDataName)}${modelQuery}`
        : null,
      onnx_filename: onnxName || null,
      tokenizer_filename: tokenizerName || null,
      onnx_data_filename: onnxDataName || null,
    },
    metadata_assets: proxiedMetadataAssets,
    runtime: {
      ...(runtimeConfig.runtimeOptions || {}),
      provider_preference: runtimeConfig.providerPreference,
      max_context: runtimeConfig.maxContext,
    },
    deployment: {
      storage: runtimeConfig.storage,
      public_base_url: runtimeConfig.publicBaseUrl,
      proxied: true,
    },
  };
}

async function proxyExternalAsset(request, upstreamUrl, proxyKind = "asset-proxy") {
  if (request.method === "HEAD") {
    const headers = new Headers({
      ...corsHeaders(request),
      "Cache-Control": "public, max-age=3600",
      "X-Purple-Bee-Asset-Proxy": proxyKind,
      "Accept-Ranges": "bytes",
      "Content-Type": guessContentType(upstreamUrl),
    });
    return new Response(null, { status: 200, headers });
  }

  const forwardHeaders = new Headers();
  copyHeader(request, forwardHeaders, "Range");
  copyHeader(request, forwardHeaders, "If-None-Match");
  copyHeader(request, forwardHeaders, "If-Modified-Since");
  copyHeader(request, forwardHeaders, "Accept");

  const upstreamResponse = await fetch(upstreamUrl, {
    method: "GET",
    headers: forwardHeaders,
    redirect: "follow",
  });

  const headers = new Headers(upstreamResponse.headers);
  Object.entries(corsHeaders(request)).forEach(([key, value]) => headers.set(key, value));
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Purple-Bee-Asset-Proxy", proxyKind);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
}

async function proxyHtmlPage(request, upstreamUrl) {
  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      "User-Agent": "Purple-Bee-Cloudflare-Worker/1.0",
      Accept: request.headers.get("Accept") || "text/html,application/xhtml+xml",
      "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Content-Type", headers.get("Content-Type") || "text/html; charset=UTF-8");

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function proxyJsonApi(request, upstreamUrl) {
  const upstreamHeaders = new Headers({
    Accept: "application/json",
  });
  const contentType = request.headers.get("Content-Type");
  if (contentType) upstreamHeaders.set("Content-Type", contentType);

  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    redirect: "follow",
  });

  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(request)).forEach(([key, value]) => headers.set(key, value));
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", headers.get("Content-Type") || "application/json; charset=UTF-8");

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function copyHeader(sourceRequest, targetHeaders, name) {
  const value = sourceRequest.headers.get(name);
  if (value) targetHeaders.set(name, value);
}

function basenameFromUrl(value) {
  if (!value) return "";
  try {
    const pathname = new URL(value).pathname;
    return decodeURIComponent(pathname.split("/").pop() || "");
  } catch {
    const clean = String(value).split("?")[0];
    return decodeURIComponent(clean.split("/").pop() || "");
  }
}

function deriveBaseUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const pathname = url.pathname.split("/");
    pathname.pop();
    url.pathname = pathname.join("/");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function guessContentType(value) {
  const lower = String(value || "").toLowerCase();
  if (lower.endsWith(".onnx")) return "application/octet-stream";
  if (lower.endsWith(".onnx.data")) return "application/octet-stream";
  if (lower.endsWith(".json")) return "application/json; charset=UTF-8";
  return "application/octet-stream";
}

function normalizeProviderPreference(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const normalized = raw
    .map((item) => String(item || "").toLowerCase())
    .filter((item) => item === "wasm" || item === "webgpu");
  return normalized.length ? normalized : ["wasm"];
}

function sanitizeModelId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /^[a-z0-9][a-z0-9-]*$/i.test(trimmed) ? trimmed : "";
}

let PBX_DIALOGUE_PACK_CACHE = null;

async function buildWebsiteRuntimeReplyV3(query, history, env) {
  const raw = String(query || "").trim();
  const lowered = raw.toLowerCase();

  if (!raw) {
    return "질문이 비어 있어요. 한 줄만 적어 주시면 바로 이어서 도와드릴게요.";
  }

  if (/(안녕|안녕하세요|하이|반가워|hello|hi\b|hey\b)/i.test(raw)) {
    return "안녕하세요, 저는 Purple Bee예요. 궁금한 것을 편하게 말해 주세요.";
  }

  if (/(날씨|weather)/i.test(raw)) {
    const weather = await tryBuildWeatherReply(raw);
    if (weather) return weather;
    return "날씨를 보려면 지역명을 같이 적어 주세요. 예를 들면 '군산 날씨 어때'처럼 말해 주시면 바로 볼게요.";
  }

  if (/(사과를 만드는 방법|사과 만드는 법|사과 하는 방법)/.test(raw)) {
    return "여기서 '사과'는 두 가지로 들려요. 과일 사과를 재배하거나 만드는 이야기인지, 아니면 누군가에게 사과하는 방법인지 알려주시면 바로 맞춰서 설명할게요.";
  }

  const dialoguePackReply = await buildDialoguePackReplyV3(raw, history, env);
  if (dialoguePackReply) {
    return dialoguePackReply;
  }

  const definitionTopic = extractDefinitionTopic(raw);
  if (definitionTopic) {
    const summary = await fetchWikipediaSummary(definitionTopic);
    if (summary) return summary;
  }

  if (/(강아지|dog)/i.test(raw)) {
    return "강아지는 사람과 오래 함께해 온 대표적인 반려동물이에요. 품종마다 성격과 활동량이 달라서 생활 방식에 맞는 아이를 고르는 게 중요해요.";
  }

  if (/(코드|코딩|파이썬|python|오류|error|bug|버그)/i.test(raw)) {
    return "코드나 에러 로그를 붙여 주시면 원인과 수정 방향을 바로 정리해 드릴게요.";
  }

  if (/(뭐 할 수 있어|무엇을 할 수|할 수 있어|can you do)/i.test(raw)) {
    return "저는 질문 답변, 자료 요약, 코드 설명, 오류 원인 정리, 파일 내용 읽기, 비교와 정리를 도와드릴 수 있어요. 하고 싶은 작업을 한 줄로 말해 주세요.";
  }

  if (/(누구야|정체가 뭐야|자기소개|who are you)/i.test(raw)) {
    return "저는 Purple Bee예요. 이 사이트에서 질문을 읽고 설명, 요약, 정리, 문제 해결을 돕는 AI예요.";
  }

  if (/(아니야|그게 아니|다시|아닌데)/i.test(raw)) {
    return "알겠어요. 제가 방금 이해한 방향이 어긋난 것 같아요. 원하던 뜻을 한 줄만 다시 말해 주시면 그 기준으로 바로 다시 답할게요.";
  }

  if (/(방법|하는 법|만드는 법|어떻게)/i.test(raw)) {
    return "좋아요. 방법을 묻는 질문으로 이해했어요. 대상이 무엇인지 한 줄만 더 붙여 주시면 순서대로 정리해서 설명할게요.";
  }

  if (/(사과|apple)/i.test(raw) && /(뭐야|뭔지|설명|정의|알아)/i.test(raw)) {
    return "사과는 전 세계에서 널리 먹는 대표적인 과일이에요. 생으로 먹기도 하고 주스, 잼, 파이 같은 재료로도 많이 써요.";
  }

  if (/(강아지가 뭔지 알아|강아지가 뭐야|강아지)/i.test(raw)) {
    return "강아지는 개를 친근하게 부르는 말이에요. 사람과 오래 함께 지내 온 대표적인 반려동물이기도 해요.";
  }

  return "질문은 이해했어요. 지금은 핵심부터 짧고 직접적으로 답하는 방식으로 맞추고 있어요. 조금만 더 구체적으로 적어 주시면 더 정확하게 도와드릴게요.";
}

async function buildDialoguePackReplyV3(query, history, env) {
  const pack = await loadDialoguePackV3(env);
  const items = Array.isArray(pack?.items) ? pack.items : [];
  if (!items.length) return "";
  const normalizedQuery = normalizeDialogueLookupTextV3(query);
  if (!normalizedQuery) return "";
  const recentText = Array.isArray(history)
    ? history.slice(-4).map((item) => String(item?.content || "")).join(" ")
    : "";

  let best = null;
  for (const item of items) {
    const score = scoreDialogueCandidateV3(normalizedQuery, recentText, item);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { score, response: String(item.response || "").trim() };
    }
  }
  if (!best || best.score < 4) return "";
  return best.response;
}

async function loadDialoguePackV3(env) {
  if (PBX_DIALOGUE_PACK_CACHE) return PBX_DIALOGUE_PACK_CACHE;
  if (!env?.ASSETS) return null;
  try {
    const response = await env.ASSETS.fetch("https://assets.local/static/purple-bee-dialogues.json");
    if (!response.ok) return null;
    PBX_DIALOGUE_PACK_CACHE = await response.json();
    return PBX_DIALOGUE_PACK_CACHE;
  } catch {
    return null;
  }
}

function normalizeDialogueLookupTextV3(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreDialogueCandidateV3(normalizedQuery, recentText, item) {
  const candidateInput = normalizeDialogueLookupTextV3(item?.input || "");
  if (!candidateInput) return 0;
  if (candidateInput === normalizedQuery) return 100 + Number(item?.reward_weight || 0);

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const candidateTokens = candidateInput.split(" ").filter(Boolean);
  if (!queryTokens.length || !candidateTokens.length) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.includes(token)) overlap += 1;
  }
  let score = overlap * 2 + Number(item?.reward_weight || 0) * 0.1;

  if (/아니|다시|말고|이상해|그게 아니/.test(normalizedQuery) && Array.isArray(item?.tags) && item.tags.includes("repair")) {
    score += 3;
  }
  if (recentText && Array.isArray(item?.tags) && item.tags.includes("followup")) {
    score += 1;
  }
  if (normalizedQuery.includes(candidateInput) || candidateInput.includes(normalizedQuery)) {
    score += 2;
  }
  return score;
}

function buildPackagePlan(request, env, runtimeConfig, publicBackend = null) {
  const origin = new URL(request.url).origin;
  const modelId = runtimeConfig?.modelId || "purple-bee-1-3";
  const displayName = runtimeConfig?.displayName || "Purple Bee 1.3";
  const assetVersion = runtimeConfig?.assetVersion || "";
  const backendBase = String(publicBackend?.publicApiBaseUrl || env.PURPLE_BEE_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
  const metadataAssets = runtimeConfig?.metadataAssets || {};
  const query = new URLSearchParams();
  if (modelId) query.set("model_id", modelId);
  if (assetVersion) query.set("v", assetVersion);
  const manifestUrl = `${origin}/api/runtime/browser-manifest${query.toString() ? `?${query.toString()}` : ""}`;
  const healthUrl = `${origin}/api/health`;
  const registryUrl = `${origin}/static/model-registry.json`;
  const metadataDescriptors = [
    ["config", "config.json", "모델 설정 파일"],
    ["generation_config", "generation_config.json", "생성 기본 설정"],
    ["special_tokens_map", "special_tokens_map.json", "특수 토큰 맵"],
    ["tokenizer_config", "tokenizer_config.json", "토크나이저 상세 설정"],
  ]
    .filter(([key]) => String(metadataAssets[key] || "").trim())
    .map(([key, filename, description]) => ({
      filename,
      kind: "download-text",
      required: false,
      description,
      url: `${origin}/api/runtime/assets/${encodeURIComponent(filename)}${query.toString() ? `?${query.toString()}` : ""}`,
    }));

  const extraMetadataDescriptors = [
    ["added_tokens", "added_tokens.json", "Added tokens"],
    ["vocab", "vocab.json", "Vocabulary"],
    ["merges", "merges.txt", "Merge rules"],
    ["quantize_config", "quantize_config.json", "Quantization config"],
  ]
    .filter(([key]) => String(metadataAssets[key] || "").trim())
    .map(([key, filename, description]) => ({
      filename,
      kind: "download-text",
      required: false,
      description,
      url: `${origin}/api/runtime/assets/${encodeURIComponent(filename)}${query.toString() ? `?${query.toString()}` : ""}`,
    }));

  return {
    ok: true,
    install_mode: "browser-runtime",
    runtime_engine: String(runtimeConfig?.runtimeOptions?.engine || "purple-bee-onnx").trim().toLowerCase(),
    family_name: "Purple Bee",
    model_id: modelId,
    display_name: displayName,
    asset_version: assetVersion,
    generated_at: new Date().toISOString(),
    backend: {
      configured: Boolean(backendBase),
      public_api_base_url: backendBase || null,
      website_origin: origin,
    },
    assets: [
      {
        filename: "purple-bee-package.json",
        kind: "generated-json",
        required: true,
        description: "Folder link and install marker",
      },
      {
        filename: "purple-bee-assets-index.json",
        kind: "generated-json",
        required: true,
        description: "Installed asset list and update state",
      },
      {
        filename: "purple-bee-endpoints.json",
        kind: "generated-json",
        required: true,
        description: "Current public runtime/API endpoint guide",
      },
      {
        filename: "purple-bee-release-notes.txt",
        kind: "generated-text",
        required: false,
        description: "Readable install/update notes",
      },
      {
        filename: "purple-bee-health.json",
        kind: "download-text",
        required: false,
        description: "Latest website runtime health snapshot",
        url: healthUrl,
      },
      {
        filename: "purple-bee-browser-manifest.json",
        kind: "download-text",
        required: false,
        description: "Published runtime manifest",
        url: manifestUrl,
      },
      {
        filename: "purple-bee-model-registry.json",
        kind: "download-text",
        required: false,
        description: "Public model registry snapshot",
        url: registryUrl,
      },
      ...metadataDescriptors,
      ...extraMetadataDescriptors,
    ],
    generated_assets: {
      "purple-bee-endpoints.json": {
        family_name: "Purple Bee",
        website_origin: origin,
        active_model_id: modelId,
        active_model_name: displayName,
        runtime_health_url: healthUrl,
        browser_manifest_url: manifestUrl,
        model_registry_url: registryUrl,
        public_chat_api: `${origin}/api/pbx_chat_sync`,
        streaming_chat_api: `${origin}/api/pbx_chat`,
        backend_mode: backendBase ? "public-purple-bee-backend" : "worker-server-runtime",
      },
      "purple-bee-release-notes.txt": [
        "Purple Bee AI 준비물 폴더 안내",
        "",
        `현재 모델: ${displayName}`,
        `모델 ID: ${modelId}`,
        `자산 버전: ${assetVersion || "current"}`,
        "",
        "이 폴더에는 웹사이트가 참고하는 설치 상태 파일과 공개 런타임 안내 파일이 들어 있습니다.",
        "실제 답변은 purple-bee-cloudflare.purplebeeai.workers.dev 사이트에서 실행됩니다.",
        backendBase
          ? `공개 백엔드 연결: ${backendBase}`
          : "공개 백엔드 연결: 아직 Worker 내장 런타임으로 동작 중",
        "",
        "폴더를 다시 연결하거나 '업데이트'를 누르면 최신 상태 파일이 덮어써집니다.",
      ].join("\n"),
    },
  };
}

function pbBuildPbxReplyResponseStable(reply, streaming, corsH, mode = "aether-nexus") {
  const text = String(reply || "").trim() || "답변을 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
  if (!streaming) {
    return new Response(JSON.stringify({ ok: true, reply: text, mode }), {
      status: 200,
      headers: { ...corsH, "Content-Type": "application/json; charset=UTF-8" },
    });
  }
  const enc = new TextEncoder();
  const parts = text.match(/\S+\s*|\n/g) || [text];
  const stream = new ReadableStream({
    start(controller) {
      let chunk = "";
      for (const part of parts) {
        chunk += part;
        if (chunk.length >= 24 || part === "\n") {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          chunk = "";
        }
      }
      if (chunk) controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, full: text, ok: true, mode })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...corsH,
      "Content-Type": "text/event-stream; charset=UTF-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

function pbLooksLikeFixedWebsiteReplyStable(reply) {
  const text = String(reply || "").trim();
  if (!text || /[�]/.test(text)) return true;
  if (text.length < 6 && !/^(응|네|예|아니|좋아)[.!?。！？…]*$/i.test(text)) return true;
  const brokenHangulMarkers = ["吏", "湲", "諛", "援", "蹂", "媛", "먯", "댁", "섏", "쒕"];
  const markerCount = brokenHangulMarkers.reduce((count, marker) => count + (text.includes(marker) ? 1 : 0), 0);
  if (markerCount >= 3) return true;
  return [
    "조금 더 구체적으로",
    "한 줄만 더",
    "답변 생성에 실패",
    "질문은 이해했어요",
    "원하는 기준",
    "그 주제는 지금 단어만 보면",
    "일상적인 의미, 전문적인 의미",
  ].some((marker) => text.includes(marker));
}

function pbLooksLikeIntentMismatchStable(reply, query) {
  const text = String(reply || "").trim();
  const raw = pbStableNormalize(query);
  if (!text || !raw) return false;
  if (/사과.*(만들|만드|재배|키우|기르|요리|레시피|잼|주스|파이)/i.test(raw)) {
    return /(사과는 길게 말하는 것보다|상대가 불편|미안|변명|사과하는)/i.test(text);
  }
  if (/^(강아지|고양이|사과|중력|민주주의|윤리|문학|역사)[?!.…\s]*$/i.test(raw)) {
    return /(그 주제는 지금 단어만 보면|먼저 큰 뜻을 잡고|어떤 식으로 듣고 싶은지)/i.test(text);
  }
  return false;
}

function pbWantsRewrite(raw) {
  return /(자연스럽|친근|편하게|쉽게\s*말|다시\s*말|말투|풀어서|그거\s*말고|그게\s*아니|아니야|아닌데|틀렸|이상|제대로)/i.test(String(raw || ""));
}

function pbLanguageAbilityReply(raw) {
  if (!/(영어|일본어|중국어|한국어|언어|번역|translate|english|japanese|chinese)/i.test(raw)) return "";
  if (!/(할\s*줄|할줄|가능|알아|번역|말해|대화|can|speak)/i.test(raw)) return "";
  return pbPick([
    "네. 영어로도 대화할 수 있고, 한국어 문장을 영어로 자연스럽게 바꾸거나 영어 문장을 한국어로 풀어서 설명할 수 있어요. 원하면 같은 내용을 격식 있는 말투, 편한 말투, 발표용 문장으로도 바꿔드릴게요.",
    "가능해요. 영어 대화, 번역, 문장 다듬기, 의미 해석까지 할 수 있습니다. 짧은 문장 하나만 보내도 자연스러운 표현으로 다시 만들어볼게요.",
    "네, 영어도 다룰 수 있어요. 단순 번역뿐 아니라 문맥에 맞게 더 자연스러운 표현을 골라 설명하는 쪽으로 답하겠습니다.",
  ], `${raw}:${Date.now()}`);
}

function pbBareTopicGuidance(raw) {
  if (!/(뒤에|붙이지|뭐야|알려줘|설명해줘|꼭\s*안|없이도)/i.test(raw)) return "";
  return [
    "알겠습니다. 앞으로는 단어만 던져도 먼저 주제로 보고 답하겠습니다.",
    "",
    "예를 들어 “사과”라고만 말하면 과일인지, 사과하는 행동인지, 이전 대화에서 이어진 말인지 먼저 문맥을 보고 판단한 뒤 답할게요. 꼭 “뭐야”나 “알려줘”를 붙이지 않아도 됩니다.",
  ].join("\n");
}

function pbHistoryMessages(history = [], role = "", limit = 6) {
  if (!Array.isArray(history)) return [];
  const items = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    if (role && item.role !== role) continue;
    const content = String(item.content || item.text || "").trim();
    if (content) items.push(content);
  }
  return items.slice(-limit);
}

function pbIsContextThinMessage(text) {
  const raw = pbNormalize(text);
  if (!raw) return true;
  return /^(응|ㅇㅇ|그래|맞아|좋아|오케이|ok|okay|아니|ㄴㄴ|아닌데|그건\s*아니야|그게\s*아니야|왜|왜\?|왜그래|왜 그래|이유는|원인은|그게\s*뭐야|그게\s*뭔데|뭔데|뭐가|무슨\s*뜻|뜻은|자세히|더\s*자세히|계속|이어줘|더|그래서|그다음|다음|음+|흠+|으음+|글쎄|모르겠어|애매해)[\s?？!！.。…]*$/i.test(raw);
}

function pbLastSubstantiveUserText(history = []) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (!item || item.role !== "user") continue;
    const content = String(item.content || item.text || "").trim();
    if (content && !pbIsContextThinMessage(content)) return content;
  }
  return pbLastUserText(history);
}

function pbShortTopicFromText(text) {
  const raw = pbNormalize(text);
  let topic = pbExtractTopic(raw) || pbExtractAetherTopic(raw);
  topic = String(topic || "").replace(/(대해|대한|관련|쪽|기준|흐름|내용)$/g, "").trim();
  if (!topic || topic === "그 주제") {
    const words = raw.match(/[A-Za-z0-9가-힣+#._-]{2,}/g) || [];
    topic = words.length ? words.slice(0, 3).join(" ") : "방금 이야기";
  }
  if (/(우리\s*뭐|뭐\s*할|뭐할래|뭐할까|대화|잡담)/i.test(raw)) topic = "같이 할 일";
  return topic.slice(0, 40);
}

function pbContextFollowupReply(raw, history = []) {
  const query = pbNormalize(raw);
  if (!Array.isArray(history) || !history.length) return "";
  const lastUser = pbLastSubstantiveUserText(history);
  const lastAssistant = pbLastAssistantText(history);
  const topic = pbShortTopicFromText(lastUser || lastAssistant);

  if (/^(왜|왜\?|왜그래|왜 그래|이유는|원인은)[\s?？!！.]*$/i.test(query)) {
    return pbPick([
      `방금 이야기에서 핵심 이유는, ${topic}${pbParticle(topic, "은", "는")} 겉으로 보이는 말보다 그 뒤의 조건을 봐야 하기 때문이에요. 즉 “무엇을 원했는지”와 “어떤 정보가 부족했는지”가 답의 방향을 갈라요.`,
      `왜냐하면 ${topic}${pbParticle(topic, "은", "는")} 한 가지 뜻으로 고정되기보다, 문맥에 따라 설명·판단·행동 제안으로 달라지기 때문이에요. 그래서 저는 먼저 의도를 잡고 답을 좁히는 쪽으로 봐야 해요.`,
      `이유를 짧게 말하면, 방금 흐름에서 부족한 건 정보량보다 방향성이에요. ${topic}${pbParticle(topic, "을", "를")} 어떤 관점으로 볼지 정하면 답이 훨씬 자연스러워집니다.`,
    ], `${query}:${history.length}`);
  }

  if (/^(그게\s*뭐야|그게\s*뭔데|뭔데|뭐가|무슨\s*뜻|뜻은)[\s?？!！.]*$/i.test(query)) {
    return [
      `방금 말한 ${topic}${pbParticle(topic, "은", "는")} 쉽게 말하면 “지금 대화에서 가장 중요한 중심점”이에요.`,
      "",
      "예를 들어 설명을 원하면 정의와 예시를 붙이고, 해결을 원하면 원인과 다음 행동으로 바꿔야 해요. 그래서 같은 단어라도 사용자가 원하는 결과에 맞춰 말투와 구조가 달라져야 합니다.",
    ].join("\n");
  }

  if (/^(자세히|더\s*자세히|계속|이어줘|더|그래서|그다음|다음)[\s?？!！.]*$/i.test(query)) {
    if (["사과", "강아지", "개", "윤리", "인공지능"].includes(topic)) {
      return [
        `좋아요. ${topic}${pbParticle(topic, "을", "를")} 조금 더 풀어보면, 단순한 정의보다 “특징, 쓰임, 주의할 점”으로 나눠 보는 게 이해하기 쉽습니다.`,
        "",
        `- 특징: ${topic}${pbParticle(topic, "은", "는")} 사람들이 자주 접하는 주제라서 기본 의미와 실제 사용 맥락이 함께 중요합니다.`,
        "- 쓰임: 일상 설명에서는 쉬운 예시를 붙이고, 전문 분석에서는 원인과 기준을 분리해 설명하는 편이 좋습니다.",
        "- 다음으로 볼 점: 왜 중요한지, 어디에 쓰이는지, 비슷한 개념과 뭐가 다른지를 보면 더 선명해집니다.",
        "",
        "원하면 여기서 더 쉽게, 더 전문적으로, 또는 예시 중심으로 다시 바꿔서 이어갈 수 있어요.",
      ].join("\n");
    }
    return [
      `좋아요. ${topic}${pbParticle(topic, "을", "를")} 조금 더 이어서 풀어볼게요.`,
      "",
      `먼저 ${topic}${pbParticle(topic, "은", "는")} 한 문장으로 끝내기보다, 왜 중요한지와 실제로 어디에 쓰이는지를 같이 봐야 자연스럽습니다. 필요하면 정의, 예시, 비교, 다음 행동 순서로 확장해서 설명할 수 있어요.`,
    ].join("\n");
  }

  if (/^(응|ㅇㅇ|그래|맞아|좋아|오케이|ok|okay)[\s.!?。！？…]*$/i.test(query)) {
    return pbPick([
      `좋아요. 그럼 ${topic} 쪽으로 계속 이어가볼게요. 지금은 너무 넓게 벌리기보다, 가장 중요한 한 지점부터 잡는 게 좋아요.`,
      `알겠습니다. 그러면 방금 흐름을 유지해서 ${topic}${pbParticle(topic, "을", "를")} 더 자연스럽게 이어가겠습니다.`,
      `좋아요. 지금 흐름이면 ${topic}${pbParticle(topic, "을", "를")} 예시나 다음 행동으로 바꾸는 게 가장 실용적이에요.`,
    ], `${query}:${history.length}`);
  }

  if (/^(아니|ㄴㄴ|아닌데|그건\s*아니야|그게\s*아니야)[\s.!?。！？…]*$/i.test(query)) {
    return pbPick([
      "알겠어요. 방금 제가 잡은 방향이 빗나갔네요. 이번에는 이전 답을 고집하지 않고, 네가 말하려던 의도를 다시 우선으로 두겠습니다.",
      "맞아요, 그 흐름은 접을게요. 지금 필요한 건 다시 묻는 게 아니라 답변 기준을 바꾸는 거예요. 다음 말에 맞춰 바로 다시 잡겠습니다.",
      "오케이. 그 답은 폐기하고 다시 볼게요. 짧게라도 원하는 쪽을 던지면 그 방향으로 맞춰서 이어가겠습니다.",
    ], `${query}:${history.length}`);
  }

  if (/^(음+|흠+|으음+|글쎄|모르겠어|애매해)[\s.!?。！？…]*$/i.test(query)) {
    return pbPick([
      "천천히 생각해도 괜찮아요. 아직 말로 딱 안 잡힌 상태면, 제가 먼저 가능한 방향을 작게 나눠볼게요. 설명을 원하는지, 선택을 원하는지, 그냥 같이 생각하고 싶은지부터 보면 됩니다.",
      "그 애매한 느낌도 정보예요. 지금은 바로 결론을 내기보다, 머릿속에 걸리는 부분을 하나씩 꺼내는 게 좋아요. 제가 흐름을 놓치지 않고 받아볼게요.",
      "괜찮아요. 아직 정리 안 된 생각이면 제가 같이 정리해볼게요. 단어 하나만 던져도 거기서 출발할 수 있습니다.",
    ], `${query}:${history.length}`);
  }

  return "";
}

function pbEmotionalChatReply(raw) {
  const query = pbNormalize(raw);
  if (/(힘들|지쳤|피곤|우울|불안|짜증|화나|외롭|무서|걱정|스트레스)/i.test(query)) {
    return pbPick([
      "그건 그냥 넘길 감정은 아니에요. 지금 당장 해결책부터 밀어붙이기보다, 뭐가 제일 무겁게 느껴지는지부터 작게 나눠보면 좋겠습니다. 제가 옆에서 같이 정리해볼게요.",
      "많이 버거운 쪽으로 들려요. 지금은 완벽하게 설명하지 않아도 괜찮고, 제일 크게 걸리는 것 하나만 말해줘도 됩니다. 거기서부터 천천히 풀어볼게요.",
      "그 상태면 머리로는 정리하려 해도 몸이 먼저 지칠 수 있어요. 지금 필요한 건 큰 결론보다 부담을 조금 줄이는 첫 단계일 가능성이 큽니다.",
    ], query);
  }
  if (/(기쁘|좋았|좋아졌|신나|행복|다행|성공|해냈)/i.test(query)) {
    return pbPick([
      "좋네요. 그런 흐름은 그냥 지나치지 말고 뭐가 잘됐는지 잡아두면 다음에도 재현하기 쉬워요. 어떤 부분이 제일 만족스러웠어요?",
      "오, 그건 꽤 좋은 신호예요. 결과도 중요하지만, 거기까지 간 방식도 기억해두면 다음 작업이 훨씬 편해집니다.",
      "좋아요. 지금은 그 좋은 흐름을 살려서 다음에 뭘 이어갈지 작게 정하면 딱 좋겠습니다.",
    ], query);
  }
  if (/(고마워|ㄳ|감사|땡큐|thanks)/i.test(query)) {
    return pbPick([
      "언제든요. 다음 것도 편하게 던져주세요.",
      "좋아요. 이어서 더 다듬거나 다음 단계로 넘어가도 됩니다.",
      "천천히 같이 가면 됩니다. 필요한 거 있으면 바로 말해줘요.",
    ], query);
  }
  return "";
}

function pbAvoidRepeatedReply(reply, query, history = []) {
  const text = String(reply || "").trim();
  if (!text) return text;
  const previous = pbHistoryMessages(history, "assistant", 4);
  const normalized = text.replace(/\s+/g, " ");
  for (const old of previous) {
    const oldNorm = String(old || "").replace(/\s+/g, " ");
    if (oldNorm && (normalized === oldNorm || normalized.slice(0, 80) === oldNorm.slice(0, 80))) {
      const topic = pbShortTopicFromText(query);
      return pbPick([
        `이번엔 다르게 말해볼게요. ${topic}${pbParticle(topic, "은", "는")} 핵심부터 보면, 먼저 의미를 잡고 그다음 사용자가 원하는 형태로 다시 바꾸는 게 중요합니다.`,
        `같은 말로 반복하지 않고 다시 정리하면, ${topic}${pbParticle(topic, "은", "는")} 정의보다 맥락이 먼저예요. 지금 상황에서 어떤 답이 필요한지에 맞춰 설명이 달라져야 합니다.`,
        `다른 각도로 보면 ${topic}${pbParticle(topic, "은", "는")} 단순한 정보가 아니라 대화의 방향을 정하는 단서입니다. 그래서 답은 짧게 시작하되, 필요하면 예시와 근거로 확장하는 게 좋아요.`,
      ], `${query}:${history.length}:${Date.now()}`);
    }
  }
  return text;
}

async function pbBuildAetherWorkerReplyStable(query, history = []) {
  const raw = pbNormalize(query);
  if (!raw) return "메시지가 비어 있어요. 한 문장만 적어주면 바로 이어서 볼게요.";
  if (/^(안녕+|하이+|hello|hi|hey)[!?.…\s]*$/i.test(raw)) {
    return pbAvoidRepeatedReply(pbPick([
      "안녕하세요. 지금 떠오른 걸 그대로 말해 주세요. 짧게 던져도 문맥을 잡아서 이어가볼게요.",
      "안녕하세요. 오늘은 어떤 걸 같이 보면 좋을까요?",
      "반가워요. 그냥 대화해도 좋고, 바로 궁금한 걸 물어봐도 좋아요.",
    ], `${raw}:${Array.isArray(history) ? history.length : 0}:${Date.now()}`), raw, history);
  }
  if (/(심장|가슴|흉통|호흡|숨\s*쉬|식은땀|어지럼|통증|아파|아퍼|병원|응급)/i.test(raw)) return pbAvoidRepeatedReply(pbHealthReply(raw), raw, history);
  if (/(날씨|weather)/i.test(raw)) {
    const weather = await pbWeatherReply(raw);
    return pbAvoidRepeatedReply(weather || "날씨는 지역명이 있어야 정확히 볼 수 있어요. 예를 들면 “군산 날씨”처럼 지역과 함께 물어봐 주세요.", raw, history);
  }

  const followup = pbContextFollowupReply(raw, history);
  if (followup) return pbAvoidRepeatedReply(followup, raw, history);

  const emotional = pbEmotionalChatReply(raw);
  if (emotional) return pbAvoidRepeatedReply(emotional, raw, history);

  const rewrite = pbWantsRewrite(raw) ? pbRepairReply(raw, history) : "";
  if (rewrite) return pbAvoidRepeatedReply(rewrite, raw, history);

  const languageAbility = pbLanguageAbilityReply(raw);
  if (languageAbility) return pbAvoidRepeatedReply(languageAbility, raw, history);

  const bareGuidance = pbBareTopicGuidance(raw);
  if (bareGuidance) return pbAvoidRepeatedReply(bareGuidance, raw, history);

  if (/(탐구|쟁점|윤리적\s*문제|사회문제|고찰|토론|관점\s*분석)/i.test(raw)) {
    return pbAvoidRepeatedReply(pbExplorationReply(raw), raw, history);
  }

  // Dynamic knowledge first. Fixed seed facts and broad planning templates
  // must not decide the answer before retrieval has a chance to work.
  const topic = /(강아지|반려견|dog|puppy)/i.test(raw) ? "강아지" : pbExtractTopic(raw);
  if (topic) {
    const summary = await pbWikiSummary(topic);
    if (summary) return pbAvoidRepeatedReply(pbKnowledgeReply(topic, summary, raw), raw, history);
  }

  if (/(검색|찾아|웹사이트|사이트에서|링크)/i.test(raw)) {
    const searchTopic = pbExtractAetherTopic(raw);
    const encoded = encodeURIComponent(searchTopic || raw);
    return pbAvoidRepeatedReply([
      `${searchTopic || raw} 관련해서 바로 확인할 수 있는 경로예요.`,
      "",
      `- Google: https://www.google.com/search?q=${encoded}`,
      `- DuckDuckGo: https://duckduckgo.com/?q=${encoded}`,
      "",
      "공식 사이트, 사용법, 비교, 오류 해결 중 원하는 방향을 말하면 그쪽으로 더 좁혀서 정리할게요.",
    ].join("\n"), raw, history);
  }

  if (/(뭐\s*할\s*수|무엇을\s*할|능력|할줄|할\s*줄|can you do)/i.test(raw)) {
    return pbAvoidRepeatedReply([
      "저는 질문의 의도와 맥락을 먼저 잡고, 필요한 경우 자료나 웹 정보를 연결해서 답하는 Purple Bee입니다.",
      "",
      "지금 할 수 있는 일은 일상 대화, 개념 설명, 코드/오류 분석, 문서 요약, 자료 기반 정리, 최신 정보 확인입니다. 짧게 던져도 먼저 해석해서 답해볼게요.",
    ].join("\n"), raw, history);
  }
  if (/(우리\s*뭐|뭐\s*할까|심심|잡담|대화하자|놀자|뭐해)/i.test(raw)) {
    return pbAvoidRepeatedReply(pbPick([
      "좋아요. 지금은 가볍게 대화해도 되고, 머릿속에 걸린 문제 하나를 같이 풀어도 좋아요. 저는 네가 던지는 쪽으로 자연스럽게 따라갈게요.",
      "우리라면 일단 부담 없는 것부터 시작하면 좋겠어요. 잡담, 아이디어 정리, 프로젝트 점검 중 아무 방향이나 던져도 됩니다.",
      "좋아요. 굳이 거창하게 시작하지 말고, 지금 제일 신경 쓰이는 것 하나만 꺼내봅시다.",
    ], `${raw}:${Array.isArray(history) ? history.length : 0}:${Date.now()}`), raw, history);
  }
  const meta = pbMetaQualityReply(raw);
  if (meta) return pbAvoidRepeatedReply(meta, raw, history);
  if (/(탐구|분석|깊게|논의|쟁점|윤리|철학|문제)/i.test(raw)) {
    return pbAvoidRepeatedReply(pbExplorationReply(raw), raw, history);
  }

  const adaptive = pbAdaptiveAetherReply(raw, history);
  if (adaptive) return pbAvoidRepeatedReply(adaptive, raw, history);
  if (/(코드|코딩|python|파이썬|error|오류|버그|함수|html|css|js)/i.test(raw)) {
    return pbAvoidRepeatedReply("코딩 쪽으로 보면 먼저 증상과 원인을 분리하는 게 좋아요. 코드나 오류 화면을 보내주면 입력값, 실행 흐름, 실패 지점을 나눠서 바로 좁혀볼게요.", raw, history);
  }
  if (/(요약|정리|핵심)/i.test(raw)) {
    return pbAvoidRepeatedReply("좋아요. 자료를 보내주면 핵심 주장, 근거, 놓치면 안 되는 내용, 다음 행동 순서로 짧고 읽기 쉽게 정리해드릴게요.", raw, history);
  }
  return pbAvoidRepeatedReply(pbGeneralReply(raw, history), raw, history);
}

async function buildWebsiteRuntimeReply(query, history) {
  const raw = String(query || "").trim();
  const q = raw.toLowerCase();
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  const lastUser = recent.filter((item) => item && item.role === "user").slice(-1)[0];

  if (!raw) {
    return "질문이 비어 있어요. 한 줄만 적어 주시면 바로 이어서 도와드릴게요.";
  }

  if (/(안녕|하이|반가워|hello|hi\b|hey\b)/i.test(raw)) {
    return "안녕하세요, 저는 Purple Bee예요. 궁금한 것 하나만 편하게 말해 주세요.";
  }

  if (/(날씨|weather)/i.test(raw)) {
    const weather = await tryBuildWeatherReply(raw);
    if (weather) return weather;
    return "날씨를 보려면 지역명을 같이 적어 주세요. 예를 들면 '군산 날씨 어때'처럼 말해 주시면 바로 볼게요.";
  }

  if (/(사과를 만드는 방법|사과 만드는 법|사과 하는 방법)/.test(raw)) {
    return "여기서 '사과'가 두 가지로 들려요. 과일 사과를 재배하거나 만드는 이야기인지, 아니면 누군가에게 사과하는 방법인지 알려주시면 바로 맞춰서 설명할게요.";
  }

  const definitionTopic = extractDefinitionTopic(raw);
  if (definitionTopic) {
    const summary = await fetchWikipediaSummary(definitionTopic);
    if (summary) return summary;
  }

  if (/(강아지|dog)/i.test(raw)) {
    return "강아지는 사람과 오래 함께해 온 대표적인 반려동물이에요. 품종마다 성격과 활동량이 달라서 생활 방식에 맞는 아이를 고르는 게 중요해요.";
  }

  if (/(코드|코딩|python|파이썬|error|오류|bug|버그)/i.test(raw)) {
    return "코드나 에러 로그를 붙여 주시면 원인과 수정 방향을 바로 정리해 드릴게요.";
  }

  if (/(할 수 있어|뭐 할 수 있어|무엇을 할 수|can you do)/i.test(raw)) {
    return "저는 질문 답변, 자료 요약, 코드 설명, 오류 원인 정리, 파일 내용 읽기, 비교와 정리를 도와드릴 수 있어요. 하고 싶은 작업을 한 줄로 말해 주세요.";
  }

  if (/(누구야|정체가 뭐야|자기소개|who are you)/i.test(raw)) {
    return "저는 Purple Bee예요. 이 사이트에서 질문을 읽고 설명, 요약, 정리, 문제 해결을 돕는 AI예요.";
  }

  if (/(아니야|그게 아니|다시|아닌데)/i.test(raw)) {
    if (lastUser && lastUser.content) {
      return "알겠어요. 방금 이해한 방향이 어긋난 것 같아요. 원하던 뜻을 한 줄만 다시 말해 주시면 그 기준으로 바로 다시 답할게요.";
    }
    return "알겠어요. 원하던 방향을 짧게 다시 적어 주시면 그 기준으로 바로 이어서 답할게요.";
  }

  if (/(방법|하는 법|만드는 법|어떻게)/i.test(raw)) {
    return "좋아요. 방법을 묻는 질문으로 이해했어요. 대상이 무엇인지 한 줄만 더 붙여 주시면 순서대로 정리해서 설명할게요.";
  }

  if (/(사과|apple)/i.test(raw) && /(뭐야|뭔지|설명|정의|알아)/i.test(raw)) {
    return "사과는 전 세계에서 널리 먹는 대표적인 과일이에요. 생으로 먹기도 하고 주스, 잼, 파이 같은 재료로도 많이 써요.";
  }

  return "질문은 이해했어요. 지금은 핵심부터 짧고 직접적으로 답하는 방식으로 맞추고 있어요. 원하시면 제가 바로 설명하거나, 비교하거나, 단계별로 정리해 드릴게요.";
}
