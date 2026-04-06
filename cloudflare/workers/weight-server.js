export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (url.pathname === "/api/health" || url.pathname === "/api/status") {
      const publicBackend = await resolvePublicBackendConfig(request, env);
      return jsonResponse(
        {
          ok: true,
          service: "Purple Bee Cloudflare Static Worker",
          mode: "website-runtime",
          computeMode: "worker-server-runtime",
          modelAsset: "/api/runtime/browser-manifest",
          trainingMode: "management-panel-only",
          publicBackendConfigured: Boolean(publicBackend.configured),
          publicBackendBaseUrl: publicBackend.publicApiBaseUrl || null,
          time: new Date().toISOString(),
        },
        200,
        request,
      );
    }

    if (url.pathname === "/api/pbx_chat") {
      return handlePbxChat(request, env, true);
    }
    if (url.pathname === "/api/pbx_chat_sync") {
      return handlePbxChat(request, env, false);
    }

    if (url.pathname === "/api/runtime/browser-manifest") {
      const runtimeConfig = await resolveRuntimeConfig(request, env);
      if (runtimeConfig) {
        if (runtimeConfig.mode === "transformers-js") {
          return jsonResponse(runtimeConfig.manifest, 200, request);
        }
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
      const requestedName = decodeURIComponent(url.pathname.split("/").pop() || "");
      const upstreamUrl = runtimeConfig.assetMap[requestedName];
      if (!upstreamUrl) {
        return jsonResponse(
          { ok: false, message: "Requested runtime asset was not found." },
          404,
          request,
        );
      }
      return proxyExternalAsset(request, upstreamUrl, "runtime-asset");
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

async function handlePbxChat(request, env, streaming) {
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
  const upstreamBase = String(publicBackend.publicApiBaseUrl || env.PURPLE_BEE_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!upstreamBase) {
    const fallback = await buildWebsiteRuntimeReplyV3(userMessage, body.history || [], env);
    if (streaming) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ chunk: fallback })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, full: fallback })}\n\n`));
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
    return new Response(JSON.stringify({
      ok: true,
      reply: fallback,
      mode: "worker-server-runtime",
      note: "Public Purple Bee backend is not configured yet, so the built-in website runtime answered instead.",
    }), {
      status: 200,
      headers: { ...corsH, "Content-Type": "application/json" },
    });
  }

  const upstreamUrl = `${upstreamBase}${streaming ? "/api/pbx_chat" : "/api/pbx_chat_sync"}`;
  const upstreamHeaders = new Headers({ "Content-Type": "application/json" });
  const upstreamApiKey = String(env.PURPLE_BEE_PUBLIC_API_KEY || "").trim();
  if (upstreamApiKey) {
    upstreamHeaders.set("X-Api-Key", upstreamApiKey);
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(body),
  });

  const headers = new Headers({
    ...corsH,
    "Cache-Control": streaming ? "no-cache" : "no-store",
    "Content-Type": upstreamResponse.headers.get("content-type") || (streaming ? "text/event-stream" : "application/json"),
  });
  if (streaming) {
    headers.set("X-Accel-Buffering", "no");
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
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
  if (!/(뭐|뭔|정의|설명|알아|who is|what is|tell me about|meaning)/i.test(raw)) {
    return "";
  }
  const cleaned = raw
    .replace(/[?？!！]/g, " ")
    .replace(/\b(이게|그게|저게|이건|그건|저건)\b/g, " ")
    .replace(/\b(뭐야|뭔지|무엇인지|정의|설명|알아|알려줘|알려\s*줘)\b/g, " ")
    .replace(/\b(what is|who is|tell me about|meaning of)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);
  if (!parts.length) return "";
  return parts[0];
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
  if (String(runtime.engine || "").trim().toLowerCase() === "transformers-js") {
    return {
      mode: "transformers-js",
      manifest: {
        family_name: String(payload.family_name || "Purple Bee"),
        model_id: String(payload.model_id || "purple-bee-1-3"),
        display_name: String(payload.display_name || "Purple Bee 1.3"),
        browser_assets: payload?.browser_assets || {},
        runtime: {
          ...runtime,
          provider_preference: normalizeProviderPreference(runtime.provider_preference),
          max_context: Number(runtime.max_context || 2048),
          engine: "transformers-js",
        },
        deployment: {
          storage: "remote-model-repo",
          proxied: true,
        },
      },
    };
  }

  const browserAssets = payload?.browser_assets || {};
  const onnxUrl = String(browserAssets.onnx || "").trim();
  const tokenizerUrl = String(browserAssets.tokenizer || "").trim();
  const onnxDataUrl = String(browserAssets.onnx_data || "").trim();
  if (!onnxUrl || !tokenizerUrl) return null;

  return {
    familyName: String(payload.family_name || "Purple Bee"),
    modelId: String(payload.model_id || "purple-bee-1-3"),
    displayName: String(payload.display_name || "Purple Bee 1.3"),
    onnxUrl,
    tokenizerUrl,
    onnxDataUrl,
    assetVersion: String(payload.asset_version || "").trim(),
    maxContext: Number(runtime.max_context || 2048),
    providerPreference: normalizeProviderPreference(runtime.provider_preference),
    storage: "public-object-storage",
    publicBaseUrl: deriveBaseUrl(onnxUrl),
    assetMap: buildAssetMap(onnxUrl, tokenizerUrl, onnxDataUrl),
  };
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

  return {
    familyName: "Purple Bee",
    modelId,
    displayName,
    onnxUrl,
    tokenizerUrl,
    onnxDataUrl,
    assetVersion: String(env.PURPLE_BEE_MODEL_ASSET_VERSION || "").trim(),
    maxContext: 2048,
    providerPreference: normalizeProviderPreference(env.PURPLE_BEE_PROVIDER_PREFERENCE),
    storage: "public-object-storage",
    publicBaseUrl,
    assetMap: buildAssetMap(onnxUrl, tokenizerUrl, onnxDataUrl),
  };
}

function buildAssetMap(onnxUrl, tokenizerUrl, onnxDataUrl) {
  const assetMap = {};
  const onnxName = basenameFromUrl(onnxUrl);
  const tokenizerName = basenameFromUrl(tokenizerUrl);
  const onnxDataName = basenameFromUrl(onnxDataUrl);
  if (onnxName) assetMap[onnxName] = onnxUrl;
  if (tokenizerName) assetMap[tokenizerName] = tokenizerUrl;
  if (onnxDataName) assetMap[onnxDataName] = onnxDataUrl;
  return assetMap;
}

function buildBrowserManifest(request, runtimeConfig) {
  const origin = new URL(request.url).origin;
  const onnxName = basenameFromUrl(runtimeConfig.onnxUrl);
  const tokenizerName = basenameFromUrl(runtimeConfig.tokenizerUrl);
  const onnxDataName = basenameFromUrl(runtimeConfig.onnxDataUrl);
  const search = new URLSearchParams();
  if (runtimeConfig.modelId) search.set("model_id", runtimeConfig.modelId);
  if (runtimeConfig.assetVersion) search.set("v", runtimeConfig.assetVersion);
  const modelQuery = search.toString() ? `?${search.toString()}` : "";

  return {
    family_name: runtimeConfig.familyName,
    model_id: runtimeConfig.modelId,
    display_name: runtimeConfig.displayName,
    browser_assets: {
      onnx: `${origin}/api/runtime/assets/${encodeURIComponent(onnxName)}${modelQuery}`,
      tokenizer: `${origin}/api/runtime/assets/${encodeURIComponent(tokenizerName)}${modelQuery}`,
      onnx_data: onnxDataName
        ? `${origin}/api/runtime/assets/${encodeURIComponent(onnxDataName)}${modelQuery}`
        : null,
    },
    runtime: {
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
  const query = new URLSearchParams();
  if (modelId) query.set("model_id", modelId);
  if (assetVersion) query.set("v", assetVersion);
  const manifestUrl = `${origin}/api/runtime/browser-manifest${query.toString() ? `?${query.toString()}` : ""}`;
  const healthUrl = `${origin}/api/health`;
  const registryUrl = `${origin}/static/model-registry.json`;

  return {
    ok: true,
    install_mode: "public-server-runtime",
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
