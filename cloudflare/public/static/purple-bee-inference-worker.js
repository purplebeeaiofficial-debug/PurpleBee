"use strict";

self.window = self;

let runtime = null;
let manifestUrl = "";
let assetUrls = [];
let currentModelId = "";

function revokeAssetUrls() {
  try {
    if (manifestUrl) URL.revokeObjectURL(manifestUrl);
  } catch (_error) {}
  manifestUrl = "";
  for (const url of assetUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch (_error) {}
  }
  assetUrls = [];
}

function postMessageSafe(type, payload = {}) {
  self.postMessage({ type, payload });
}

function createObjectUrlFromBlob(blob, mimeType = "application/octet-stream") {
  const safeBlob = blob instanceof Blob ? blob : new Blob([blob], { type: mimeType });
  const url = URL.createObjectURL(safeBlob);
  assetUrls.push(url);
  return url;
}

async function ensureRuntimeScriptsLoaded() {
  if (self.PurpleBeeBrowserRuntime && self.ort) return;
  importScripts(
    "/static/vendor/onnxruntime-web/ort.min.js",
    "/static/purple-bee-browser-runtime.js"
  );
}

async function initializeRuntime(payload) {
  await ensureRuntimeScriptsLoaded();
  revokeAssetUrls();

  const manifest = payload && payload.manifest && typeof payload.manifest === "object"
    ? payload.manifest
    : null;
  const assets = payload && payload.assets && typeof payload.assets === "object"
    ? payload.assets
    : null;

  if (!manifest || !assets) {
    throw new Error("worker-init-payload-missing");
  }

  const onnxBlob = assets.onnx;
  const tokenizerBlob = assets.tokenizer;
  const onnxDataBlob = assets.onnx_data || null;

  if (!onnxBlob || !tokenizerBlob) {
    throw new Error("worker-assets-missing");
  }

  const onnxUrl = createObjectUrlFromBlob(onnxBlob);
  const tokenizerUrl = createObjectUrlFromBlob(tokenizerBlob, "application/json");
  const onnxDataUrl = onnxDataBlob ? createObjectUrlFromBlob(onnxDataBlob) : null;

  const manifestPayload = {
    family_name: manifest.family_name || "Purple Bee",
    model_id: manifest.model_id || "purple-bee-1-3",
    display_name: manifest.display_name || "Purple Bee 1.3",
    browser_assets: {
      onnx: onnxUrl,
      tokenizer: tokenizerUrl,
      onnx_data: onnxDataUrl,
    },
    runtime: {
      provider_preference: ["wasm"],
      max_context: Number(manifest.runtime && manifest.runtime.max_context) || 2048,
    },
  };

  manifestUrl = createObjectUrlFromBlob(
    new Blob([JSON.stringify(manifestPayload)], { type: "application/json" }),
    "application/json"
  );

  runtime = self.PurpleBeeBrowserRuntime.createRuntime({
    manifestUrl,
    providerPreference: ["wasm"],
    maxContext: manifestPayload.runtime.max_context,
  });

  await runtime.init();
  currentModelId = manifestPayload.model_id;
  return runtime.getStatus();
}

async function generateReply(payload) {
  if (!runtime) {
    throw new Error("worker-runtime-not-ready");
  }

  const prompt = String(payload && payload.prompt || "").trim();
  const options = payload && payload.options && typeof payload.options === "object"
    ? payload.options
    : {};

  const text = await runtime.generateReply(prompt, options);
  return {
    text: String(text || ""),
    model_id: currentModelId,
  };
}

self.onmessage = async function onMessage(event) {
  const message = event && event.data && typeof event.data === "object" ? event.data : {};
  const type = String(message.type || "").trim();
  const requestId = String(message.requestId || "").trim();

  try {
    if (type === "init") {
      const status = await initializeRuntime(message.payload || {});
      postMessageSafe("ready", { requestId, status, model_id: currentModelId });
      return;
    }

    if (type === "generate") {
      const result = await generateReply(message.payload || {});
      postMessageSafe("reply", { requestId, ...result });
      return;
    }

    if (type === "status") {
      postMessageSafe("status", {
        requestId,
        ready: Boolean(runtime),
        model_id: currentModelId,
      });
      return;
    }

    if (type === "reset") {
      runtime = null;
      currentModelId = "";
      revokeAssetUrls();
      postMessageSafe("reset", { requestId, ok: true });
      return;
    }

    throw new Error(`worker-unknown-message:${type}`);
  } catch (error) {
    postMessageSafe("error", {
      requestId,
      message: String(error && error.message ? error.message : error || "worker-error"),
    });
  }
};
