(function () {
  "use strict";

  const DEFAULT_MANIFEST_URL = "/api/runtime/browser-manifest";
  const DEFAULT_TRANSFORMERS_JS_MODULE = "https://cdn.jsdelivr.net/npm/@huggingface/transformers/+esm";
  const TOKEN_PATTERN = /\n|[ \t]+|[\uac00-\ud7af]|[\u3040-\u30ff]|[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]+|[^\w\s]/gu;
  const BYTE_LEVEL_TOKEN_PATTERN = / ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
  const SPECIAL_TOKENS = new Set(["<pad>", "<bos>", "<eos>", "<unk>"]);
  const MODULE_CACHE = new Map();
  const TEXT_ENCODER = new TextEncoder();
  const TEXT_DECODER = new TextDecoder("utf-8");
  const BYTE_TO_UNICODE = buildByteToUnicodeMap();
  const UNICODE_TO_BYTE = buildUnicodeToByteMap(BYTE_TO_UNICODE);

  function normalizeText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeProviderPreference(value) {
    const raw = Array.isArray(value)
      ? value
      : String(value || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    const filtered = raw.filter((item) => item === "webgpu" || item === "wasm");
    return filtered.length ? filtered : ["webgpu", "wasm"];
  }

  function isAbsoluteHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || "").trim());
  }

  async function loadEsmModule(moduleUrl) {
    const target = String(moduleUrl || DEFAULT_TRANSFORMERS_JS_MODULE).trim() || DEFAULT_TRANSFORMERS_JS_MODULE;
    if (!MODULE_CACHE.has(target)) {
      MODULE_CACHE.set(target, import(target));
    }
    return MODULE_CACHE.get(target);
  }

  function pretokenize(text) {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    return normalized.match(TOKEN_PATTERN) || [];
  }

  function normalizeByteLevelText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .normalize("NFKC");
  }

  function byteLevelPretokenize(text) {
    const normalized = normalizeByteLevelText(text);
    if (!normalized) return [];
    return normalized.match(BYTE_LEVEL_TOKEN_PATTERN) || [];
  }

  function range(start, end) {
    const values = [];
    for (let index = start; index <= end; index += 1) values.push(index);
    return values;
  }

  function buildByteToUnicodeMap() {
    const bs = [...range(33, 126), ...range(161, 172), ...range(174, 255)];
    const cs = bs.slice();
    const present = new Set(bs);
    let extra = 0;
    for (let byte = 0; byte < 256; byte += 1) {
      if (!present.has(byte)) {
        bs.push(byte);
        cs.push(256 + extra);
        extra += 1;
      }
    }
    const mapping = new Map();
    for (let index = 0; index < bs.length; index += 1) {
      mapping.set(bs[index], String.fromCharCode(cs[index]));
    }
    return mapping;
  }

  function buildUnicodeToByteMap(mapping) {
    const reverse = new Map();
    for (const [byte, symbol] of mapping.entries()) {
      reverse.set(symbol, byte);
    }
    return reverse;
  }

  function pairKey(left, right) {
    return `${left}\u0001${right}`;
  }

  function buildTokenizerState(tokenizerPayload) {
    const specialMap = tokenizerPayload && typeof tokenizerPayload === "object"
      ? (tokenizerPayload.special_tokens || {})
      : {};

    if (
      tokenizerPayload
      && String(tokenizerPayload.type || "").trim().toLowerCase() === "purple-bee-bytelevel-bpe"
      && tokenizerPayload.hf_tokenizer_json
      && tokenizerPayload.hf_tokenizer_json.model
      && tokenizerPayload.hf_tokenizer_json.model.vocab
    ) {
      const vocabObject = tokenizerPayload.hf_tokenizer_json.model.vocab;
      const stoi = new Map();
      const itos = new Map();
      for (const [token, rawId] of Object.entries(vocabObject)) {
        const tokenId = Number(rawId);
        stoi.set(token, tokenId);
        itos.set(tokenId, token);
      }

      const specialIds = new Set();
      for (const rawId of Object.values(specialMap)) {
        const tokenId = Number(rawId);
        if (Number.isFinite(tokenId)) specialIds.add(tokenId);
      }

      const bpeRanks = new Map();
      const merges = Array.isArray(tokenizerPayload.hf_tokenizer_json.model.merges)
        ? tokenizerPayload.hf_tokenizer_json.model.merges
        : [];
      merges.forEach((pair, index) => {
        let left = "";
        let right = "";
        if (Array.isArray(pair) && pair.length >= 2) {
          left = String(pair[0] || "");
          right = String(pair[1] || "");
        } else if (typeof pair === "string") {
          const parts = pair.trim().split(/\s+/);
          if (parts.length >= 2) {
            [left, right] = parts;
          }
        }
        if (left && right) {
          bpeRanks.set(pairKey(left, right), index);
        }
      });

      return {
        mode: "hf-bytelevel-bpe",
        stoi,
        itos,
        specialIds,
        size: stoi.size,
        bpeRanks,
        bpeCache: new Map(),
      };
    }

    const vocabArray = Array.isArray(tokenizerPayload && tokenizerPayload.vocab)
      ? tokenizerPayload.vocab
      : [];
    const stoi = new Map();
    const itos = new Map();
    vocabArray.forEach((token, index) => {
      const value = String(token || "");
      stoi.set(value, index);
      itos.set(index, value);
    });
    const specialIds = new Set();
    for (const name of SPECIAL_TOKENS) {
      if (stoi.has(name)) specialIds.add(stoi.get(name));
    }
    return {
      mode: "legacy",
      stoi,
      itos,
      specialIds,
      size: vocabArray.length,
      bpeRanks: new Map(),
      bpeCache: new Map(),
    };
  }

  function applyBpeMerges(token, tokenizerState) {
    const source = String(token || "");
    if (!source) return [];
    if (!tokenizerState || !tokenizerState.bpeRanks || !tokenizerState.bpeRanks.size) {
      return [source];
    }
    const cached = tokenizerState.bpeCache.get(source);
    if (cached) return cached.slice();

    let pieces = Array.from(source);
    if (pieces.length <= 1) {
      tokenizerState.bpeCache.set(source, pieces.slice());
      return pieces;
    }

    while (pieces.length > 1) {
      let bestRank = Number.POSITIVE_INFINITY;
      let bestPair = "";
      for (let index = 0; index < pieces.length - 1; index += 1) {
        const currentKey = pairKey(pieces[index], pieces[index + 1]);
        const rank = tokenizerState.bpeRanks.get(currentKey);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestPair = currentKey;
        }
      }
      if (!Number.isFinite(bestRank) || !bestPair) break;

      const [left, right] = bestPair.split("\u0001");
      const merged = [];
      for (let index = 0; index < pieces.length; index += 1) {
        if (index < pieces.length - 1 && pieces[index] === left && pieces[index + 1] === right) {
          merged.push(left + right);
          index += 1;
        } else {
          merged.push(pieces[index]);
        }
      }
      pieces = merged;
    }

    tokenizerState.bpeCache.set(source, pieces.slice());
    return pieces;
  }

  function encodeByteLevelText(text, tokenizerState, specialMap = {}, addBos = false, addEos = false) {
    const ids = [];
    const bosId = Number(specialMap["<bos>"]);
    const eosId = Number(specialMap["<eos>"]);
    const unkId = Number.isFinite(Number(specialMap["<unk>"]))
      ? Number(specialMap["<unk>"])
      : (tokenizerState.stoi.get("<unk>") ?? 0);

    if (addBos && Number.isFinite(bosId)) ids.push(bosId);

    for (const piece of byteLevelPretokenize(text)) {
      const encoded = Array.from(TEXT_ENCODER.encode(piece), (value) => BYTE_TO_UNICODE.get(value) || "")
        .join("");
      const mergedPieces = applyBpeMerges(encoded, tokenizerState);
      for (const token of mergedPieces) {
        ids.push(tokenizerState.stoi.get(token) ?? unkId);
      }
    }

    if (addEos && Number.isFinite(eosId)) ids.push(eosId);
    return ids;
  }

  function decodeByteLevelIds(ids, tokenizerState, skipSpecial = true) {
    const chunks = [];
    for (const rawId of ids) {
      const tokenId = Number(rawId);
      if (!Number.isFinite(tokenId)) continue;
      if (skipSpecial && tokenizerState.specialIds.has(tokenId)) continue;
      const token = tokenizerState.itos.get(tokenId);
      if (token) chunks.push(token);
    }

    const bytes = [];
    for (const symbol of Array.from(chunks.join(""))) {
      const byte = UNICODE_TO_BYTE.get(symbol);
      if (byte !== undefined) bytes.push(byte);
    }

    return TEXT_DECODER.decode(Uint8Array.from(bytes)).trim();
  }

  function argmax(values) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  function softmaxSample(logits, temperature, topK, topP) {
    const cappedTopK = Math.max(1, Math.min(topK || logits.length, logits.length));
    const sorted = Array.from(logits, (value, index) => ({
      index,
      value: value / Math.max(temperature || 1, 1e-5),
    }))
      .sort((left, right) => right.value - left.value)
      .slice(0, cappedTopK);
    const maxValue = sorted[0] ? sorted[0].value : 0;
    const withProb = sorted.map((entry) => ({
      ...entry,
      prob: Math.exp(entry.value - maxValue),
    }));
    const rawTotal = withProb.reduce((sum, entry) => sum + entry.prob, 0) || 1;
    let filtered = withProb;
    const nucleus = Math.max(0, Math.min(topP || 1, 1));
    if (nucleus > 0 && nucleus < 1) {
      let running = 0;
      filtered = [];
      for (const entry of withProb) {
        filtered.push(entry);
        running += entry.prob / rawTotal;
        if (running >= nucleus) break;
      }
    }
    const total = filtered.reduce((sum, entry) => sum + entry.prob, 0) || 1;
    let cursor = Math.random();
    for (let index = 0; index < filtered.length; index += 1) {
      cursor -= filtered[index].prob / total;
      if (cursor <= 0) return filtered[index].index;
    }
    return filtered[0] ? filtered[0].index : 0;
  }

  function cleanupReply(text) {
    let value = String(text || "").trim();
    value = value.replace(/^(assistant|purple bee)\s*:\s*/i, "").trim();
    value = value.replace(/\b(user|assistant|purple bee)\s*:/gi, "").trim();
    value = value.replace(/\n{3,}/g, "\n\n").trim();
    return value;
  }

  function extractGeneratedText(output) {
    if (!output) return "";
    if (typeof output === "string") return output;
    if (Array.isArray(output)) {
      for (const item of output) {
        const candidate = extractGeneratedText(item);
        if (candidate) return candidate;
      }
      return "";
    }
    if (typeof output === "object") {
      if (typeof output.generated_text === "string") return output.generated_text;
      if (Array.isArray(output.generated_text)) {
        const tail = output.generated_text[output.generated_text.length - 1];
        if (tail && typeof tail.content === "string") return tail.content;
        const nested = extractGeneratedText(output.generated_text);
        if (nested) return nested;
      }
      if (typeof output.text === "string") return output.text;
      if (typeof output.content === "string") return output.content;
    }
    return "";
  }

  function fileNameFromUrl(value) {
    if (!value) return "";
    try {
      const pathname = new URL(value, window.location.href).pathname;
      return decodeURIComponent(pathname.split("/").pop() || "");
    } catch (_error) {
      const clean = String(value).split("?")[0];
      return decodeURIComponent(clean.split("/").pop() || "");
    }
  }

  class PurpleBeeBrowserRuntime {
    constructor(options = {}) {
      this.manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
      this.initialized = false;
      this.manifest = null;
      this.tokenizer = null;
      this.stoi = null;
      this.itos = null;
      this.tokenizerMode = "legacy";
      this.tokenizerState = null;
      this.session = null;
      this.provider = "unknown";
      this.maxContext = 1024;
      this.lastInitError = null;
      this.modelVocabSize = 0;
      this.effectiveVocabSize = 0;
      this.providerPreference = ["wasm"];
      this.engineType = "purple-bee-onnx";
      this.transformersGenerator = null;
      this.transformersModuleUrl = DEFAULT_TRANSFORMERS_JS_MODULE;
      this.transformersModelRepo = "";
      this.transformersDtype = "";
      this.systemPrompt = "";
    }

    async init() {
      if (this.initialized) return this;

      const manifestResponse = await fetch(this.manifestUrl, { cache: "no-store" });
      if (!manifestResponse.ok) throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
      this.manifest = await manifestResponse.json();

      const runtimeBlock = this.manifest?.runtime || {};
      this.maxContext = Number(runtimeBlock.max_context || runtimeBlock.maxContext || 2048);
      this.providerPreference = normalizeProviderPreference(runtimeBlock.provider_preference);
      this.engineType = String(runtimeBlock.engine || "purple-bee-onnx").trim().toLowerCase();

      if (this.engineType === "transformers-js") {
        return this.initTransformersRuntime(runtimeBlock);
      }

      if (!window.ort) throw new Error("onnxruntime-web is not loaded");
      if (window.ort.env) {
        try {
          window.ort.env.logLevel = "fatal";
        } catch (_error) {
          // Ignore env mutations that older builds do not expose.
        }
      }

      const tokenizerUrl = this.manifest?.browser_assets?.tokenizer;
      const onnxUrl = this.manifest?.browser_assets?.onnx;
      const onnxDataUrl = this.manifest?.browser_assets?.onnx_data;
      if (!tokenizerUrl || !onnxUrl) throw new Error("browser assets are incomplete");

      const tokenizerResponse = await fetch(tokenizerUrl, { cache: "force-cache" });
      if (!tokenizerResponse.ok) throw new Error(`tokenizer fetch failed: ${tokenizerResponse.status}`);
      this.tokenizer = await tokenizerResponse.json();
      this.tokenizerState = buildTokenizerState(this.tokenizer);
      this.tokenizerMode = this.tokenizerState.mode;
      this.stoi = this.tokenizerState.stoi;
      this.itos = this.tokenizerState.itos;
      this.effectiveVocabSize = this.tokenizerState.size;

      if (window.ort.env && window.ort.env.wasm) {
        window.ort.env.wasm.wasmPaths = "/static/vendor/onnxruntime-web/";
        window.ort.env.wasm.proxy = false;
        if (!window.crossOriginIsolated) {
          window.ort.env.wasm.numThreads = 1;
        }
      }

      const providers = [];
      const wantsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
      for (const provider of this.providerPreference) {
        if (provider === "webgpu") {
          if (wantsWebGpu) providers.push("webgpu");
          continue;
        }
        if (provider === "wasm") {
          providers.push("wasm");
        }
      }
      if (!providers.length) {
        providers.push(wantsWebGpu ? "webgpu" : "wasm");
      }
      if (!providers.includes("wasm")) {
        providers.push("wasm");
      }

      let lastError = null;
      for (const provider of providers) {
        try {
          const sessionOptions = {
            executionProviders: [provider],
            graphOptimizationLevel: "all",
            logSeverityLevel: 4,
            logVerbosityLevel: 0,
          };
          const externalDataPath = fileNameFromUrl(onnxDataUrl);
          if (onnxDataUrl && externalDataPath) {
            sessionOptions.externalData = [
              {
                path: externalDataPath,
                data: onnxDataUrl,
              },
            ];
          }

          this.session = await window.ort.InferenceSession.create(onnxUrl, sessionOptions);
          this.provider = provider;
          const outputMeta = this.session.outputMetadata || {};
          const firstOutput = outputMeta[Object.keys(outputMeta)[0]] || {};
          const dims = Array.isArray(firstOutput.dimensions) ? firstOutput.dimensions : [];
          const manifestModelVocab = Number(this.manifest?.runtime?.model_vocab_size || 0);
          this.modelVocabSize = Number(dims[dims.length - 1] || manifestModelVocab || this.effectiveVocabSize || 0);
          this.initialized = true;
          this.lastInitError = null;
          return this;
        } catch (error) {
          lastError = error;
          this.lastInitError = String(error && error.message ? error.message : error || "unknown init error");
        }
      }

      throw lastError || new Error("failed to initialize ONNX runtime");
    }

    async initTransformersRuntime(runtimeBlock) {
      const modelRepo = String(runtimeBlock.model_repo || runtimeBlock.modelRepo || "").trim();
      if (!modelRepo) throw new Error("transformers-js runtime is missing model_repo");

      const moduleUrl = String(runtimeBlock.module_url || runtimeBlock.moduleUrl || DEFAULT_TRANSFORMERS_JS_MODULE).trim()
        || DEFAULT_TRANSFORMERS_JS_MODULE;
      const dtype = String(runtimeBlock.dtype || "").trim();
      const providerPreference = normalizeProviderPreference(runtimeBlock.provider_preference || this.providerPreference);
      const wantsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
      const device = providerPreference.includes("webgpu") && wantsWebGpu ? "webgpu" : "wasm";
      const module = await loadEsmModule(moduleUrl);
      const pipeline = module.pipeline || (module.default && module.default.pipeline);
      if (typeof pipeline !== "function") {
        throw new Error("transformers.js pipeline export is missing");
      }

      if (module.env && typeof module.env === "object") {
        if ("allowRemoteModels" in module.env) module.env.allowRemoteModels = true;
        if ("allowLocalModels" in module.env) module.env.allowLocalModels = false;
        if ("useBrowserCache" in module.env) module.env.useBrowserCache = true;
        if ("remoteHost" in module.env) module.env.remoteHost = window.location.origin;
        if ("remotePathTemplate" in module.env) {
          module.env.remotePathTemplate = "/api/hf-proxy/{model}/resolve/{revision}/{file}";
        }
      }

      const commonOptions = { device };
      if (dtype) commonOptions.dtype = dtype;

      try {
        this.transformersGenerator = await pipeline("text-generation", modelRepo, commonOptions);
      } catch (error) {
        if (!dtype) throw error;
        this.transformersGenerator = await pipeline("text-generation", modelRepo, { device });
      }

      this.transformersModuleUrl = moduleUrl;
      this.transformersModelRepo = modelRepo;
      this.transformersDtype = dtype;
      this.systemPrompt = String(runtimeBlock.system_prompt || "").trim();
      this.provider = device;
      this.initialized = true;
      this.lastInitError = null;
      return this;
    }

    encode(text, addBos = false, addEos = false) {
      if (this.tokenizerMode === "hf-bytelevel-bpe") {
        return encodeByteLevelText(text, this.tokenizerState, this.tokenizer?.special_tokens || {}, addBos, addEos);
      }

      const ids = [];
      const unkId = this.stoi.get("<unk>") ?? 0;
      const bosId = this.stoi.get("<bos>");
      const eosId = this.stoi.get("<eos>");

      if (addBos && bosId !== undefined) ids.push(bosId);
      for (const piece of pretokenize(text)) {
        if (this.stoi.has(piece)) {
          ids.push(this.stoi.get(piece));
          continue;
        }
        for (const char of Array.from(piece)) {
          ids.push(this.stoi.get(char) ?? unkId);
        }
      }
      if (addEos && eosId !== undefined) ids.push(eosId);
      return ids;
    }

    decode(ids) {
      if (this.tokenizerMode === "hf-bytelevel-bpe") {
        return decodeByteLevelIds(ids, this.tokenizerState, true);
      }

      const vocab = this.tokenizer?.vocab || [];
      return ids
        .map((index) => vocab[index])
        .filter((token) => token && !SPECIAL_TOKENS.has(token))
        .join("");
    }

    async nextToken(inputIds, options = {}) {
      const sequence = inputIds.slice(-this.maxContext);
      const tensor = new window.ort.Tensor(
        "int64",
        BigInt64Array.from(sequence, (value) => BigInt(value)),
        [1, sequence.length],
      );
      let outputs = null;
      try {
        outputs = await this.session.run({ input_ids: tensor });
        const outputName = Object.keys(outputs)[0];
        const logitsTensor = outputs[outputName];
        const dims = Array.isArray(logitsTensor.dims) ? logitsTensor.dims : [];
        const modelVocabSize = Number(dims[dims.length - 1] || this.modelVocabSize || this.effectiveVocabSize || 0);
        const effectiveVocabSize = Math.max(1, Math.min(this.effectiveVocabSize || modelVocabSize, modelVocabSize));
        const offset = Math.max(0, (sequence.length - 1) * modelVocabSize);
        const lastLogits = Array.from(logitsTensor.data.slice(offset, offset + modelVocabSize));
        for (let index = effectiveVocabSize; index < lastLogits.length; index += 1) {
          lastLogits[index] = Number.NEGATIVE_INFINITY;
        }
        if ((options.temperature || 0) <= 0) return argmax(lastLogits);
        return softmaxSample(lastLogits, options.temperature || 0.7, options.topK || 24, options.topP || 1);
      } finally {
        if (outputs) {
          for (const value of Object.values(outputs)) {
            if (value && typeof value.dispose === "function") {
              try {
                value.dispose();
              } catch (_disposeError) {
                // Ignore output disposal failures.
              }
            }
          }
        }
        if (tensor && typeof tensor.dispose === "function") {
          try {
            tensor.dispose();
          } catch (_disposeError) {
            // Ignore tensor disposal failures.
          }
        }
      }
    }

    async generateTransformersReply(prompt, options = {}) {
      const maxNewTokens = Math.max(16, Math.min(options.maxNewTokens || 96, 192));
      const temperature = Math.max(0.1, options.temperature ?? 0.7);
      const topP = Math.max(0.1, Math.min(options.topP ?? 0.92, 1));
      const messages = [];
      if (this.systemPrompt) {
        messages.push({ role: "system", content: this.systemPrompt });
      }
      messages.push({ role: "user", content: String(prompt || "") });

      const output = await this.transformersGenerator(messages, {
        max_new_tokens: maxNewTokens,
        do_sample: temperature > 0.05,
        temperature,
        top_p: topP,
      });

      return cleanupReply(extractGeneratedText(output));
    }

    async generateReply(prompt, options = {}) {
      await this.init();
      if (this.engineType === "transformers-js") {
        return this.generateTransformersReply(prompt, options);
      }

      const maxNewTokens = Math.max(8, Math.min(options.maxNewTokens || 64, 160));
      const temperature = Math.max(0, options.temperature ?? 0.55);
      const topK = Math.max(1, Math.min(options.topK || 24, 80));
      const topP = Math.max(0, Math.min(options.topP ?? 1, 1));
      const eosId = this.stoi.get("<eos>");
      const promptIds = this.encode(prompt, true, false);
      const generatedIds = [];
      const working = promptIds.slice();

      for (let step = 0; step < maxNewTokens; step += 1) {
        const nextId = await this.nextToken(working, { temperature, topK, topP });
        if (eosId !== undefined && nextId === eosId) break;
        generatedIds.push(nextId);
        working.push(nextId);
      }

      return cleanupReply(this.decode(generatedIds));
    }

    getStatus() {
      return {
        initialized: this.initialized,
        provider: this.provider,
        providerPreference: this.providerPreference.slice(),
        manifest: this.manifest,
        maxContext: this.maxContext,
        lastInitError: this.lastInitError,
        modelVocabSize: this.modelVocabSize,
        effectiveVocabSize: this.effectiveVocabSize,
        tokenizerMode: this.tokenizerMode,
        engineType: this.engineType,
        transformersModelRepo: this.transformersModelRepo,
        transformersModuleUrl: this.transformersModuleUrl,
      };
    }
  }

  window.PurpleBeeBrowserRuntime = {
    DEFAULT_MANIFEST_URL,
    createRuntime(options) {
      return new PurpleBeeBrowserRuntime(options);
    },
  };
})();
