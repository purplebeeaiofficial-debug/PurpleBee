(function () {
  "use strict";

  const STOPWORDS = new Set([
    "그", "이", "저", "것", "거", "문서", "자료", "내용", "관련", "대한", "설명",
    "정리", "해줘", "해주세요", "있는", "있어", "요약", "무엇", "뭐야", "이거", "저거",
    "please", "about", "with", "from", "that", "this"
  ]);

  const LANGUAGE_PACKS = {
    ko: {
      directLead: "핵심부터 말하면",
      quickView: "짧게 보면",
      keyPoints: "핵심 포인트",
      nextView: "이어서 보면",
      steps: "바로 해보면 좋은 순서",
      compare: "비교 포인트",
      troubleshoot: "가능한 원인과 해결 방향",
      brainstorm: "아이디어로 확장할 만한 포인트",
      sources: "기반 자료",
      followUp: "원하면 이 부분만 더 깊게 파서 다음 단계까지 이어드릴게요.",
      capabilityLead: "할 수 있는 범위를 현실적으로 정리하면 아래에 가깝습니다.",
      imageLead: "지금 첨부만으로는 화면 속 픽셀 내용을 확정해서 읽는 단계까지는 아닙니다.",
      imageHint: "대신 보이는 문구나 오류 코드 한 줄만 같이 적어주면 원인 후보를 훨씬 빨리 좁힐 수 있어요.",
      noEvidence: "자료는 있지만 지금 질문과 바로 이어지는 근거를 충분히 고르지 못했습니다. 표현을 조금만 바꾸거나 관련 파일을 더 붙여주면 정확도가 올라갑니다.",
    },
    en: {
      directLead: "The short version is",
      quickView: "At a glance",
      keyPoints: "Key points",
      nextView: "Looking a bit further",
      steps: "A practical way to proceed",
      compare: "Comparison points",
      troubleshoot: "Likely causes and fixes",
      brainstorm: "Idea seeds worth building on",
      sources: "Sources",
      followUp: "If you want, I can turn this into next steps or a cleaner checklist.",
      capabilityLead: "In practical terms, here is what I can help with.",
      imageLead: "With the current local setup, I cannot fully read the pixel content of the screenshot yet.",
      imageHint: "If you add the visible text or the error code in one line, I can narrow down the issue much more accurately.",
      noEvidence: "I found nearby material, but not enough evidence that cleanly matches this exact question yet. A slightly sharper prompt or one more file should help.",
    },
    ja: {
      directLead: "要点から言うと",
      quickView: "短く言うと",
      keyPoints: "重要ポイント",
      nextView: "続けて見ると",
      steps: "進め方の例",
      compare: "比較ポイント",
      troubleshoot: "考えられる原因と対処",
      brainstorm: "発想を広げるポイント",
      sources: "参照資料",
      followUp: "必要なら、このまま次の手順まで整理できます。",
      capabilityLead: "現実的に整理すると、次のようなことを手伝えます。",
      imageLead: "今のローカル構成では、画像のピクセル内容を完全に読める段階ではありません。",
      imageHint: "見えている文言やエラーコードを一行添えてくれれば、かなり絞って説明できます。",
      noEvidence: "関連しそうな資料はありますが、この質問にそのまま使える根拠をまだ十分には拾えていません。",
    },
    zh: {
      directLead: "先说结论",
      quickView: "简短来看",
      keyPoints: "关键信息",
      nextView: "继续往下看",
      steps: "建议的处理顺序",
      compare: "对比重点",
      troubleshoot: "可能原因和处理方向",
      brainstorm: "可延展的思路",
      sources: "依据资料",
      followUp: "如果你愿意，我可以继续整理成下一步清单。",
      capabilityLead: "更实际地说，我主要可以帮你做这些事。",
      imageLead: "以目前的本地模式来看，我还不能完整读取截图里的像素内容。",
      imageHint: "如果你再补一行可见文字或错误代码，我就能更准确地缩小范围。",
      noEvidence: "我找到了一些相关材料，但还没有足够贴合这个问题的直接依据。",
    },
    es: {
      directLead: "En corto",
      quickView: "Visto rápido",
      keyPoints: "Puntos clave",
      nextView: "Si lo ampliamos un poco",
      steps: "Una forma práctica de seguir",
      compare: "Puntos de comparación",
      troubleshoot: "Posibles causas y soluciones",
      brainstorm: "Ideas que se pueden desarrollar",
      sources: "Fuentes",
      followUp: "Si quieres, lo convierto en pasos siguientes o en una lista más limpia.",
      capabilityLead: "En términos prácticos, esto es lo que puedo hacer.",
      imageLead: "Con la configuración local actual todavía no puedo leer por completo el contenido visual del screenshot.",
      imageHint: "Si añades el texto visible o el código de error en una línea, puedo acotar mucho mejor el problema.",
      noEvidence: "Encontré material cercano, pero todavía no tengo evidencia suficiente que encaje con exactitud en esta pregunta.",
    },
    fr: {
      directLead: "Pour aller droit au but",
      quickView: "En bref",
      keyPoints: "Points clés",
      nextView: "En regardant un peu plus loin",
      steps: "Ordre conseillé",
      compare: "Points de comparaison",
      troubleshoot: "Causes probables et pistes de correction",
      brainstorm: "Pistes d'idées à développer",
      sources: "Sources",
      followUp: "Si tu veux, je peux transformer cela en prochaines étapes concrètes.",
      capabilityLead: "Concrètement, voici ce que je peux faire.",
      imageLead: "Avec la configuration locale actuelle, je ne lis pas encore complètement le contenu visuel du screenshot.",
      imageHint: "Si tu ajoutes le texte visible ou le code d'erreur sur une ligne, je pourrai cibler le problème plus précisément.",
      noEvidence: "J'ai trouvé du contenu proche, mais pas encore assez d'éléments directement exploitables pour cette question précise.",
    },
    de: {
      directLead: "Kurz gesagt",
      quickView: "Auf einen Blick",
      keyPoints: "Wichtige Punkte",
      nextView: "Wenn man weiter schaut",
      steps: "Sinnvolle Reihenfolge",
      compare: "Vergleichspunkte",
      troubleshoot: "Wahrscheinliche Ursachen und Lösungen",
      brainstorm: "Ideen zum Weiterdenken",
      sources: "Quellen",
      followUp: "Wenn du willst, mache ich daraus direkt die nächsten Schritte.",
      capabilityLead: "Praktisch gesehen kann ich dir dabei helfen.",
      imageLead: "Im aktuellen lokalen Modus kann ich den Bildinhalt des Screenshots noch nicht vollständig direkt lesen.",
      imageHint: "Wenn du den sichtbaren Text oder den Fehlercode in einer Zeile ergänzst, kann ich das Problem viel genauer eingrenzen.",
      noEvidence: "Ich habe naheliegendes Material gefunden, aber noch nicht genug direkte Belege für genau diese Frage.",
    },
  };

  function lower(text) { return String(text || "").toLowerCase(); }
  function trim(text) { return String(text || "").trim(); }
  function normalizeWhitespace(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  function containsAny(text, needles) { return needles.some((needle) => text.includes(needle)); }
  function unique(values) { return Array.from(new Set(values.filter(Boolean))); }

  function shorten(text, maxLength) {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxLength) return normalized;
    const cut = normalized.lastIndexOf(" ", maxLength);
    return `${trim(normalized.slice(0, cut > maxLength / 2 ? cut : maxLength))}...`;
  }

  function ensureSentenceEnding(text) {
    const normalized = trim(text);
    if (!normalized) return "";
    return /[.!?。！？]$/.test(normalized) ? normalized : `${normalized}.`;
  }

  function getLanguagePack(language) {
    return LANGUAGE_PACKS[language] || LANGUAGE_PACKS.en;
  }

  function detectLanguage(text) {
    const sample = String(text || "");
    const lowered = lower(sample);
    if (/[가-힣]/.test(sample)) return "ko";
    if (/[\u3040-\u30ff]/.test(sample)) return "ja";
    if (/[\u4e00-\u9fff]/.test(sample)) return "zh";
    if (/[\u0400-\u04ff]/.test(sample)) return "ru";
    if (/[\u0600-\u06ff]/.test(sample)) return "ar";
    if (/[\u0e00-\u0e7f]/.test(sample)) return "th";
    if (containsAny(lowered, ["¿", "¡", "hola", "gracias", "puedes", "necesito", "explica"])) return "es";
    if (containsAny(lowered, ["bonjour", "merci", "peux", "aide", "besoin", "expliquer"])) return "fr";
    if (containsAny(lowered, ["hallo", "danke", "kannst", "bitte", "erkl", "hilfe"])) return "de";
    if (containsAny(lowered, ["olá", "obrigado", "preciso", "ajuda", "explica"])) return "pt";
    if (containsAny(lowered, ["xin chào", "cam on", "giup", "giải thích"])) return "vi";
    if (containsAny(lowered, ["halo", "terima kasih", "bisa", "tolong"])) return "id";
    return "en";
  }

  function resolveReplyLanguage(preferredLanguage, prompt, evidence) {
    if (preferredLanguage && preferredLanguage !== "auto") return preferredLanguage;
    const promptLanguage = detectLanguage(prompt);
    if (promptLanguage && promptLanguage !== "en") return promptLanguage;
    if (evidence && evidence[0] && evidence[0].sentence) return detectLanguage(evidence[0].sentence);
    return "en";
  }

  function resolveReplyStyle(style, mode, prompt) {
    if (style && style !== "adaptive") return style;
    if (mode === "steps" || mode === "compare" || mode === "troubleshoot") return "structured";
    if (mode === "brainstorm") return "coach";
    if (mode === "summary" || trim(prompt).length <= 28) return "casual";
    return "balanced";
  }

  function tokenizeMeaningful(text) {
    return unique(
      normalizeWhitespace(text)
        .split(/[^0-9A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF_]+/)
        .map((token) => lower(token))
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    );
  }

  function splitSentences(text) {
    return normalizeWhitespace(text)
      .split(/(?<=[.!?;。！？\n])\s+/)
      .map((sentence) => trim(sentence))
      .filter((sentence) => sentence.length >= 10);
  }

  class PurpleBeeModel {
    constructor(snapshot) { Object.assign(this, snapshot); }

    static async load(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`모델 파일을 불러오지 못했습니다. (${response.status})`);
      const buffer = await response.arrayBuffer();
      const view = new DataView(buffer);
      let offset = 0;
      const readUint32 = () => { const v = view.getUint32(offset, true); offset += 4; return v; };
      const readInt32 = () => { const v = view.getInt32(offset, true); offset += 4; return v; };
      const readFloat32 = () => { const v = view.getFloat32(offset, true); offset += 4; return v; };
      const readFloatVector = () => { const count = readUint32(); const slice = buffer.slice(offset, offset + count * 4); offset += count * 4; return new Float32Array(slice); };

      const magic = readUint32();
      if (magic !== 0x31494150) throw new Error("Purple Bee 모델 형식이 올바르지 않습니다.");

      const vocabularySize = readUint32();
      const corpusLength = readUint32();
      const epochsCompleted = readInt32();
      const lastLoss = readFloat32();
      const idToChar = ["\0", "?"];
      const charToId = new Map([["?", 1]]);

      for (let index = 2; index < vocabularySize; index += 1) {
        const codePoint = readUint32();
        const char = String.fromCodePoint(codePoint);
        idToChar.push(char);
        charToId.set(char, index);
      }

      return new PurpleBeeModel({
        ready: true, vocabularySize, corpusLength, epochsCompleted, lastLoss,
        idToChar, charToId,
        embeddings: readFloatVector(),
        weights1: readFloatVector(),
        bias1: readFloatVector(),
        weights2: readFloatVector(),
        bias2: readFloatVector(),
        weights3: readFloatVector(),
        bias3: readFloatVector(),
      });
    }

    encodeText(text) { return Array.from(String(text || "")).map((char) => this.charToId.get(char) || 1); }

    buildContext(seedText) {
      const encoded = this.encodeText(seedText);
      const context = new Array(8).fill(0);
      const count = Math.min(context.length, encoded.length);
      const start = encoded.length - count;
      for (let index = 0; index < count; index += 1) context[context.length - count + index] = encoded[start + index];
      return context;
    }

    forward(context, temperature) {
      const input = new Float32Array(96);
      const hidden1 = new Float32Array(32);
      const hidden2 = new Float32Array(32);
      const logits = new Float32Array(this.vocabularySize);
      const probabilities = new Float32Array(this.vocabularySize);

      for (let slot = 0; slot < 8; slot += 1) {
        const token = context[slot];
        const source = token * 12;
        const target = slot * 12;
        for (let embed = 0; embed < 12; embed += 1) input[target + embed] = this.embeddings[source + embed] || 0;
      }

      for (let hidden = 0; hidden < 32; hidden += 1) {
        let sum = this.bias1[hidden] || 0;
        for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) sum += input[inputIndex] * (this.weights1[inputIndex * 32 + hidden] || 0);
        hidden1[hidden] = Math.tanh(sum);
      }

      for (let hidden = 0; hidden < 32; hidden += 1) {
        let sum = this.bias2[hidden] || 0;
        for (let inputIndex = 0; inputIndex < 32; inputIndex += 1) sum += hidden1[inputIndex] * (this.weights2[inputIndex * 32 + hidden] || 0);
        hidden2[hidden] = Math.tanh(sum);
      }

      for (let vocab = 0; vocab < this.vocabularySize; vocab += 1) {
        let sum = this.bias3[vocab] || 0;
        for (let hidden = 0; hidden < 32; hidden += 1) sum += hidden2[hidden] * (this.weights3[hidden * this.vocabularySize + vocab] || 0);
        logits[vocab] = sum;
      }

      const safeTemperature = Math.max(0.05, temperature || 1);
      let maxLogit = -Infinity;
      for (let index = 0; index < logits.length; index += 1) maxLogit = Math.max(maxLogit, logits[index] / safeTemperature);

      let total = 0;
      for (let index = 0; index < logits.length; index += 1) {
        const value = Math.exp(logits[index] / safeTemperature - maxLogit);
        probabilities[index] = value;
        total += value;
      }
      if (total <= 0) return probabilities.fill(1 / Math.max(1, logits.length));
      for (let index = 0; index < probabilities.length; index += 1) probabilities[index] /= total;
      return probabilities;
    }

    sampleToken(probabilities) {
      const candidates = [];
      for (let index = 2; index < this.vocabularySize; index += 1) candidates.push(index);
      candidates.sort((left, right) => probabilities[right] - probabilities[left]);
      const usable = candidates.slice(0, 10);
      let total = 0;
      usable.forEach((token) => { total += probabilities[token]; });
      if (total <= 0) return usable[0] || 1;
      const pick = Math.random() * total;
      let cumulative = 0;
      for (const token of usable) {
        cumulative += probabilities[token];
        if (pick <= cumulative) return token;
      }
      return usable[0] || 1;
    }

    generateReply(prompt, maxCharacters, temperature) {
      if (!this.ready || this.vocabularySize < 3) return "";
      const context = this.buildContext(`사용자: ${prompt}\nAI: `);
      let reply = "";
      for (let step = 0; step < maxCharacters; step += 1) {
        const token = this.sampleToken(this.forward(context, temperature));
        if (token < 2 || token >= this.idToChar.length) continue;
        const char = this.idToChar[token];
        reply += char;
        context.shift();
        context.push(token);
        if (char === "\n" && reply.length > 24) break;
      }
      return normalizeWhitespace(reply.split("\n사용자:")[0].split("\nAI:")[0].split("\n\n")[0]);
    }
  }

  class PurpleBeeKnowledgeBase {
    constructor(documents) { this.documents = documents; }

    static async load(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`지식 캐시를 불러오지 못했습니다. (${response.status})`);
      const buffer = await response.arrayBuffer();
      const view = new DataView(buffer);
      const decoder = new TextDecoder("utf-8");
      let offset = 0;
      const readUint32 = () => { const v = view.getUint32(offset, true); offset += 4; return v; };
      const readUtf8 = () => { const size = readUint32(); const bytes = new Uint8Array(buffer, offset, size); offset += size; return normalizeWhitespace(decoder.decode(bytes)); };

      const magic = readUint32();
      if (magic !== 0x314B4250) throw new Error("Purple Bee 지식 캐시 형식이 올바르지 않습니다.");
      const count = readUint32();
      const documents = [];
      for (let index = 0; index < count; index += 1) {
        const categoryValue = readUint32();
        documents.push({
          category: categoryValue === 0 ? "verified" : categoryValue === 2 ? "trend" : "general",
          title: readUtf8(),
          url: readUtf8(),
          text: readUtf8(),
        });
      }
      return new PurpleBeeKnowledgeBase(documents);
    }

    search(query, topN = 6) {
      const tokens = tokenizeMeaningful(query);
      if (tokens.length === 0) return [];
      const normalizedQuery = lower(normalizeWhitespace(query));
      const scored = [];
      this.documents.forEach((document, index) => {
        let score = scoreDocument(tokens, document);
        if (normalizedQuery && lower(`${document.title} ${document.text}`).includes(normalizedQuery)) score += 20;
        if (score > 0) scored.push({ score, index });
      });
      scored.sort((left, right) => right.score - left.score);
      return scored.slice(0, topN).map((entry) => this.documents[entry.index]);
    }
  }

  function detectMode(loweredPrompt) {
    if (containsAny(loweredPrompt, ["뭐 할 수", "뭘 할 수", "무엇을 할 수", "capability", "capabilities", "what can you do", "help with", "무슨 일을", "어디까지"])) return "capability";
    if (containsAny(loweredPrompt, ["차이", "비교", "vs", "장단점"])) return "compare";
    if (containsAny(loweredPrompt, ["방법", "순서", "절차", "단계", "어떻게"])) return "steps";
    if (containsAny(loweredPrompt, ["오류", "문제", "안돼", "안 됨", "해결", "원인", "에러"])) return "troubleshoot";
    if (containsAny(loweredPrompt, ["아이디어", "브레인스토밍", "발상", "기획"])) return "brainstorm";
    if (containsAny(loweredPrompt, ["요약", "짧게", "한줄", "한 줄", "핵심"])) return "summary";
    if (containsAny(loweredPrompt, ["뭐야", "무엇", "뜻", "정의"])) return "direct";
    return "explain";
  }

  function looksFollowUp(loweredPrompt) {
    if (loweredPrompt.length <= 18) return true;
    return containsAny(loweredPrompt, ["그거", "그건", "이거", "이건", "방금", "이 내용", "그러면", "그럼", "이어서", "자세히", "다시", "계속"]);
  }

  function buildEffectiveQuery(prompt, history) {
    const loweredPrompt = lower(prompt);
    if (!looksFollowUp(loweredPrompt)) return prompt;
    const previousUser = lastUserText(history);
    const previousAssistant = lastAssistantText(history);
    if (!previousUser && !previousAssistant) return prompt;
    return `${previousUser ? `${previousUser} ` : ""}${prompt}${previousAssistant ? ` ${shorten(previousAssistant, 120)}` : ""}`;
  }

  function scoreSentence(sentence, keywords, category) {
    if (!sentence) return 0;
    const loweredSentence = lower(sentence);
    let score = 0;
    keywords.forEach((keyword) => {
      let position = loweredSentence.indexOf(keyword);
      while (position !== -1) {
        score += keyword.length >= 4 ? 5 : 3;
        if (position < 28) score += 2;
        position = loweredSentence.indexOf(keyword, position + keyword.length);
      }
    });
    if (sentence.length >= 24 && sentence.length <= 180) score += 3;
    if (category === "verified") score += 3;
    if (category === "attachment") score += 6;
    return score;
  }

  function scoreDocument(queryTokens, document) {
    const loweredTitle = lower(document.title);
    const loweredUrl = lower(document.url);
    const loweredText = lower(document.text);
    let score = 0;
    let matchedTokens = 0;
    queryTokens.forEach((token) => {
      let matched = false;
      if (loweredTitle.includes(token)) { score += 16; matched = true; }
      if (loweredUrl.includes(token)) { score += 6; matched = true; }
      let position = loweredText.indexOf(token);
      let hits = 0;
      while (position !== -1 && hits < 5) {
        score += hits === 0 ? 8 : 3;
        if (position < 220) score += 3;
        matched = true;
        hits += 1;
        position = loweredText.indexOf(token, position + token.length);
      }
      if (matched) matchedTokens += 1;
    });
    if (matchedTokens >= 2) score += matchedTokens * 6;
    if (document.category === "verified") score += 8;
    else if (document.category === "attachment") score += 10;
    else if (document.category === "general") score += 3;
    else score += 1;
    if (document.text.length >= 300 && document.text.length <= 12000) score += 4;
    return score;
  }

  function collectEvidence(query, documents) {
    const keywords = tokenizeMeaningful(query);
    const evidence = [];
    documents.forEach((document) => {
      splitSentences(document.text).forEach((sentence) => {
        const score = scoreSentence(sentence, keywords, document.category);
        if (score > 0) evidence.push({ sentence: shorten(sentence, 220), source: document.title || "로컬 자료", category: document.category || "general", score });
      });
    });
    evidence.sort((left, right) => right.score - left.score);
    const deduped = [];
    const seen = new Set();
    for (const item of evidence) {
      const key = lower(item.sentence);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
      if (deduped.length >= 5) break;
    }
    return deduped;
  }

  function composeFromEvidence(mode, prompt, evidence, options = {}) {
    const language = resolveReplyLanguage(options.language, prompt, evidence);
    const style = resolveReplyStyle(options.style, mode, prompt);
    const pack = getLanguagePack(language);
    const lines = evidence.map((item) => ensureSentenceEnding(item.sentence));

    if (lines.length === 0) return pack.noEvidence;
    if (mode === "capability") return formatCapabilityResponse(language, style);

    if (mode === "direct") return `${pack.directLead} **${lines[0]}**`;

    if (mode === "summary") {
      if (style === "structured") return `## ${pack.keyPoints}\n- ${lines[0]}${lines[1] ? `\n- ${lines[1]}` : ""}`;
      return `${pack.quickView}, **${lines[0]}**${lines[1] ? ` ${lines[1]}` : ""}`;
    }

    if (mode === "compare") {
      return `## ${pack.compare}\n- ${lines[0]}\n- ${(lines[1] || lines[0])}${lines[2] ? `\n- ${lines[2]}` : ""}`;
    }

    if (mode === "steps") {
      return `## ${pack.steps}\n1. ${lines[0]}\n2. ${(lines[1] || lines[0])}${lines[2] ? `\n3. ${lines[2]}` : ""}`;
    }

    if (mode === "troubleshoot") {
      const ending = style === "coach" ? `\n\n${pack.followUp}` : "";
      return `## ${pack.troubleshoot}\n- ${lines[0]}\n- ${(lines[1] || lines[0])}${lines[2] ? `\n- ${lines[2]}` : ""}${ending}`;
    }

    if (mode === "brainstorm") {
      return `## ${pack.brainstorm}\n- ${lines[0]}${lines[1] ? `\n- ${lines[1]}` : ""}${lines[2] ? `\n- ${lines[2]}` : ""}\n\n${pack.followUp}`;
    }

    if (style === "structured") {
      return `## ${pack.keyPoints}\n- ${lines[0]}${lines[1] ? `\n- ${lines[1]}` : ""}${lines[2] ? `\n- ${lines[2]}` : ""}`;
    }

    if (style === "coach") {
      let text = `${pack.quickView}, **${lines[0]}**`;
      if (lines[1]) text += `\n\n## ${pack.nextView}\n- ${lines[1]}`;
      if (lines[2]) text += `\n- ${lines[2]}`;
      return `${text}\n\n${pack.followUp}`;
    }

    if (style === "casual") {
      let text = `${pack.quickView}, **${lines[0]}**`;
      if (lines[1]) text += ` ${lines[1]}`;
      if (containsAny(lower(prompt), ["자세히", "깊게", "detail", "more"])) text += lines[2] ? ` ${lines[2]}` : "";
      return text;
    }

    let text = `${pack.directLead} **${lines[0]}**`;
    if (lines[1]) text += `\n\n## ${pack.nextView}\n- ${lines[1]}`;
    if (lines[2]) text += `\n- ${lines[2]}`;
    return text;
  }

  function buildSourcesLine(evidence, options = {}) {
    const language = resolveReplyLanguage(options.language, "", evidence);
    const pack = getLanguagePack(language);
    const categoryMap = language === "ko"
      ? { verified: "검증", trend: "동향", attachment: "첨부", general: "일반" }
      : language === "ja"
        ? { verified: "検証", trend: "動向", attachment: "添付", general: "一般" }
        : language === "zh"
          ? { verified: "验证", trend: "趋势", attachment: "附件", general: "一般" }
          : { verified: "verified", trend: "trend", attachment: "attachment", general: "general" };
    const labels = unique(evidence.map((item) => `${item.source}(${categoryMap[item.category] || categoryMap.general})`));
    return labels.length > 0 ? `${pack.sources}: ${labels.join(", ")}` : "";
  }

  function formatCapabilityResponse(language, style) {
    const pack = getLanguagePack(language);
    if (language === "ko") {
      if (style === "casual") {
        return `좋아요. ${pack.capabilityLead}\n\n- 파일, 문서, 로그, 코드, 설정 파일 정리\n- 최근 대화 맥락 이어서 요약하거나 다시 설명\n- 오류 원인 후보 정리와 다음 점검 순서 제안\n- 첨부 자료를 바탕으로 체크리스트나 실행 순서 작성\n\n지금처럼 실제 자료를 붙여주면 훨씬 잘합니다.`;
      }
      return `## 지금 잘하는 일\n- 파일, 문서, 로그, 코드, 설정 파일을 읽고 핵심을 정리합니다.\n- 최근 대화를 이어받아 요약, 재설명, 다음 작업 제안을 합니다.\n- 오류 원인 후보와 점검 순서를 정리합니다.\n- 첨부 자료를 바탕으로 체크리스트, 비교표, 단계별 가이드를 만듭니다.\n\n## 참고\n${pack.capabilityLead}`;
    }
    return `## What I handle well\n- Summarizing files, logs, code snippets, and documents\n- Continuing recent conversation context stored in this browser\n- Suggesting likely causes and next troubleshooting steps\n- Turning attached material into checklists, comparisons, or action plans\n\n${pack.capabilityLead}`;
  }

  function formatImageLimitResponse(language, titles) {
    const pack = getLanguagePack(language);
    const suffix = titles && titles.length ? `\n\n${pack.sources}: ${titles.join(", ")}` : "";
    return `${pack.imageLead}\n\n${pack.imageHint}${suffix}`;
  }

  function pickRepresentativeSentences(text, mode, maxCount) {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return [];
    const frequencies = new Map();
    tokenizeMeaningful(text).forEach((token) => frequencies.set(token, (frequencies.get(token) || 0) + 1));
    return unique(
      sentences
        .map((sentence, index) => {
          const score = tokenizeMeaningful(sentence).reduce((sum, token) => sum + (frequencies.get(token) || 0), 0)
            + (index < 3 ? 5 : 0)
            + (mode === "troubleshoot" && containsAny(lower(sentence), ["error", "exception", "failed", "undefined", "오류", "실패", "경고"]) ? 18 : 0)
            + (mode === "steps" && /(^|\s)(1\.|2\.|3\.|단계|순서|먼저|다음)/.test(sentence) ? 12 : 0);
          return { sentence: shorten(sentence, 220), score };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, maxCount)
        .map((item) => item.sentence)
    );
  }

  function looksNatural(text) {
    const normalized = normalizeWhitespace(text);
    if (normalized.length < 12) return false;
    if (normalized.includes("사용자") || normalized.includes("AI:")) return false;
    let repeated = 1;
    let maxRepeated = 1;
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index] === normalized[index - 1]) { repeated += 1; maxRepeated = Math.max(maxRepeated, repeated); }
      else repeated = 1;
    }
    return maxRepeated < 6;
  }

  function lastAssistantText(history) { for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].role === "assistant") return history[i].content || ""; return ""; }
  function lastAssistantMeta(history) { for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].role === "assistant" && history[i].meta) return history[i].meta; return ""; }
  function lastUserText(history) { for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].role === "user") return history[i].content || ""; return ""; }

  function dedupeDocuments(documents) {
    const seen = new Set();
    return documents.filter((document) => {
      const key = lower(`${document.title}|${document.url}|${document.text.slice(0, 120)}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  window.PurpleBeeCore = {
    PurpleBeeModel,
    PurpleBeeKnowledgeBase,
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
    splitSentences,
    detectMode,
    looksFollowUp,
    buildEffectiveQuery,
    scoreDocument,
    collectEvidence,
    composeFromEvidence,
    buildSourcesLine,
    formatCapabilityResponse,
    formatImageLimitResponse,
    pickRepresentativeSentences,
    looksNatural,
    lastAssistantText,
    lastAssistantMeta,
    lastUserText,
    dedupeDocuments,
  };
})();
