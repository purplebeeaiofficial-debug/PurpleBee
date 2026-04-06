#include "ConversationEngine.h"

#include "TextUtils.h"

#include <algorithm>
#include <cwctype>
#include <map>
#include <set>
#include <sstream>
#include <unordered_set>

namespace {

enum class ReplyMode {
    Direct,
    Explain,
    Compare,
    Steps,
    Summary,
    Troubleshoot,
    Brainstorm
};

struct EvidenceSnippet {
    std::wstring sentence;
    std::wstring source;
    SourceCategory category = SourceCategory::General;
    int score = 0;
};

bool IsHangul(wchar_t ch) {
    return ch >= 0xAC00 && ch <= 0xD7A3;
}

bool ContainsAny(const std::wstring& lowered, const std::vector<std::wstring>& needles) {
    for (const auto& needle : needles) {
        if (lowered.find(needle) != std::wstring::npos) {
            return true;
        }
    }
    return false;
}

std::wstring Shorten(const std::wstring& text, size_t maxLength) {
    const std::wstring normalized = NormalizeWhitespace(text);
    if (normalized.size() <= maxLength) {
        return normalized;
    }

    size_t cut = normalized.rfind(L' ', maxLength);
    if (cut == std::wstring::npos || cut < maxLength / 2) {
        cut = maxLength;
    }

    return Trim(normalized.substr(0, cut)) + L"...";
}

std::wstring EnsureSentenceEnding(std::wstring text) {
    text = Trim(text);
    if (text.empty()) {
        return text;
    }

    const wchar_t last = text.back();
    if (last != L'.' && last != L'!' && last != L'?' && last != L'다' && last != L'요') {
        text += L".";
    }
    return text;
}

std::vector<std::wstring> TokenizeMeaningful(const std::wstring& text) {
    static const std::unordered_set<std::wstring> kStopwords = {
        L"그", L"이", L"저", L"것", L"거", L"내용", L"자료", L"관련", L"대한", L"정도",
        L"그리고", L"하지만", L"그러면", L"어떻게", L"왜", L"무엇", L"뭐", L"좀", L"조금",
        L"이거", L"그거", L"저거", L"해주세요", L"해줘", L"알려줘", L"설명해줘",
        L"부탁해", L"please", L"about", L"with", L"from", L"that"
    };

    std::vector<std::wstring> tokens;
    std::wstring current;

    auto flush = [&]() {
        std::wstring token = Lower(Trim(current));
        current.clear();
        if (token.size() < 2 || kStopwords.find(token) != kStopwords.end()) {
            return;
        }
        tokens.push_back(std::move(token));
    };

    for (wchar_t ch : text) {
        if (iswalnum(ch) || IsHangul(ch)) {
            current.push_back(static_cast<wchar_t>(towlower(ch)));
        } else {
            flush();
        }
    }
    flush();

    return tokens;
}

std::vector<std::wstring> SplitSentences(const std::wstring& text) {
    std::vector<std::wstring> sentences;
    std::wstring current;

    auto flush = [&]() {
        const std::wstring sentence = NormalizeWhitespace(current);
        current.clear();
        if (sentence.size() >= 18) {
            sentences.push_back(sentence);
        }
    };

    for (wchar_t ch : text) {
        if (ch != L'\r') {
            current.push_back(ch);
        }

        if (ch == L'\n' || ch == L'.' || ch == L'!' || ch == L'?' || ch == L';') {
            flush();
        }
    }
    flush();

    return sentences;
}

std::wstring LastAssistantText(const std::vector<ConversationTurn>& history) {
    for (auto it = history.rbegin(); it != history.rend(); ++it) {
        if (!it->fromUser) {
            return it->text;
        }
    }
    return {};
}

std::wstring LastAssistantMeta(const std::vector<ConversationTurn>& history) {
    for (auto it = history.rbegin(); it != history.rend(); ++it) {
        if (!it->fromUser && !it->meta.empty()) {
            return it->meta;
        }
    }
    return {};
}

std::wstring LastUserText(const std::vector<ConversationTurn>& history) {
    for (auto it = history.rbegin(); it != history.rend(); ++it) {
        if (it->fromUser) {
            return it->text;
        }
    }
    return {};
}

bool LooksFollowUp(const std::wstring& loweredPrompt) {
    if (loweredPrompt.size() <= 18) {
        return true;
    }

    return ContainsAny(loweredPrompt, {
        L"그거", L"그건", L"이거", L"이건", L"방금", L"위 내용", L"그중", L"그러면",
        L"그럼", L"이어서", L"더 자세히", L"예시는", L"왜", L"어째서"
    });
}

ReplyMode DetectMode(const std::wstring& loweredPrompt) {
    if (ContainsAny(loweredPrompt, { L"차이", L"비교", L"vs", L"장단점" })) {
        return ReplyMode::Compare;
    }
    if (ContainsAny(loweredPrompt, { L"방법", L"순서", L"절차", L"단계", L"어떻게" })) {
        return ReplyMode::Steps;
    }
    if (ContainsAny(loweredPrompt, { L"오류", L"문제", L"안돼", L"안 됨", L"해결", L"원인" })) {
        return ReplyMode::Troubleshoot;
    }
    if (ContainsAny(loweredPrompt, { L"아이디어", L"브레인스토밍", L"발상", L"기획" })) {
        return ReplyMode::Brainstorm;
    }
    if (ContainsAny(loweredPrompt, { L"요약", L"짧게", L"한줄", L"한 줄", L"핵심" })) {
        return ReplyMode::Summary;
    }
    if (ContainsAny(loweredPrompt, { L"뭐야", L"무엇", L"뜻", L"정의" })) {
        return ReplyMode::Direct;
    }
    return ReplyMode::Explain;
}

std::wstring BuildEffectiveQuery(const std::wstring& prompt, const std::vector<ConversationTurn>& history) {
    const std::wstring lowered = Lower(prompt);
    if (!LooksFollowUp(lowered)) {
        return prompt;
    }

    std::wstring previousUser = LastUserText(history);
    std::wstring previousAssistant = LastAssistantText(history);
    if (previousUser.empty() && previousAssistant.empty()) {
        return prompt;
    }

    std::wstring query = prompt;
    if (!previousUser.empty()) {
        query = previousUser + L" " + query;
    }
    if (!previousAssistant.empty()) {
        query += L" " + Shorten(previousAssistant, 120);
    }
    return query;
}

int ScoreSentence(
    const std::wstring& sentence,
    const std::vector<std::wstring>& keywords,
    SourceCategory category) {

    if (sentence.empty()) {
        return 0;
    }

    const std::wstring lowered = Lower(sentence);
    int score = 0;
    for (const auto& keyword : keywords) {
        size_t position = lowered.find(keyword);
        while (position != std::wstring::npos) {
            score += keyword.size() >= 4 ? 5 : 3;
            if (position < 28) {
                score += 2;
            }
            position = lowered.find(keyword, position + keyword.size());
        }
    }

    if (sentence.size() >= 24 && sentence.size() <= 180) {
        score += 3;
    }
    if (category == SourceCategory::Verified) {
        score += 3;
    }
    return score;
}

std::vector<EvidenceSnippet> CollectEvidence(
    const std::wstring& query,
    const std::vector<KnowledgeDocument>& documents) {

    std::vector<EvidenceSnippet> evidence;
    const auto keywords = TokenizeMeaningful(query);

    for (const auto& document : documents) {
        for (const auto& sentence : SplitSentences(document.text)) {
            const int score = ScoreSentence(sentence, keywords, document.category);
            if (score <= 0) {
                continue;
            }

            EvidenceSnippet snippet;
            snippet.sentence = Shorten(sentence, 220);
            snippet.source = document.title;
            snippet.category = document.category;
            snippet.score = score;
            evidence.push_back(std::move(snippet));
        }
    }

    std::sort(evidence.begin(), evidence.end(),
        [](const EvidenceSnippet& left, const EvidenceSnippet& right) {
            return left.score > right.score;
        });

    std::vector<EvidenceSnippet> chosen;
    std::set<std::wstring> seenSentences;
    std::set<std::wstring> sourceCap;

    for (const auto& item : evidence) {
        const std::wstring dedupKey = Lower(item.sentence);
        if (!seenSentences.insert(dedupKey).second) {
            continue;
        }

        chosen.push_back(item);
        sourceCap.insert(item.source);
        if (chosen.size() >= 5) {
            break;
        }
    }

    return chosen;
}

std::wstring ComposeFromEvidence(
    ReplyMode mode,
    const std::wstring& prompt,
    const std::vector<EvidenceSnippet>& evidence) {

    if (evidence.empty()) {
        return L"찾아둔 자료는 있지만 질문과 곧바로 이어지는 근거 문장을 충분히 고르지 못했습니다. 표현을 조금만 바꾸면 더 잘 찾을 수 있어요.";
    }

    std::wostringstream stream;
    switch (mode) {
    case ReplyMode::Direct:
        stream << L"핵심만 말하면 " << EnsureSentenceEnding(evidence.front().sentence);
        break;

    case ReplyMode::Summary:
        stream << EnsureSentenceEnding(evidence.front().sentence);
        if (evidence.size() > 1) {
            stream << L" " << EnsureSentenceEnding(evidence[1].sentence);
        }
        break;

    case ReplyMode::Compare:
        stream << L"차이를 기준으로 정리하면:\n";
        for (size_t index = 0; index < std::min<size_t>(3, evidence.size()); ++index) {
            stream << L"- " << EnsureSentenceEnding(evidence[index].sentence) << L"\n";
        }
        break;

    case ReplyMode::Steps:
        stream << L"이렇게 이해하거나 진행하면 됩니다:\n";
        for (size_t index = 0; index < std::min<size_t>(3, evidence.size()); ++index) {
            stream << (index + 1) << L". " << EnsureSentenceEnding(evidence[index].sentence) << L"\n";
        }
        break;

    case ReplyMode::Troubleshoot:
        stream << L"가능한 원인과 해결 방향을 먼저 잡아보면:\n";
        for (size_t index = 0; index < std::min<size_t>(3, evidence.size()); ++index) {
            stream << L"- " << EnsureSentenceEnding(evidence[index].sentence) << L"\n";
        }
        break;

    case ReplyMode::Brainstorm:
        stream << L"아이디어 재료로 쓸 만한 포인트는:\n";
        for (size_t index = 0; index < std::min<size_t>(4, evidence.size()); ++index) {
            stream << L"- " << EnsureSentenceEnding(evidence[index].sentence) << L"\n";
        }
        stream << L"원하면 이걸 바탕으로 기획안 형태로 다시 묶어드릴게요.";
        break;

    case ReplyMode::Explain:
    default:
        stream << L"찾아둔 자료를 바탕으로 정리하면 " << EnsureSentenceEnding(evidence.front().sentence);
        if (evidence.size() > 1) {
            stream << L" 이어서 보면 " << EnsureSentenceEnding(evidence[1].sentence);
        }
        if (ContainsAny(Lower(prompt), { L"자세히", L"깊게", L"구체적" }) && evidence.size() > 2) {
            stream << L" 추가로 " << EnsureSentenceEnding(evidence[2].sentence);
        }
        break;
    }

    return Trim(stream.str());
}

std::wstring BuildSourcesLine(const std::vector<EvidenceSnippet>& evidence) {
    std::vector<std::wstring> labels;
    std::set<std::wstring> seen;

    for (const auto& item : evidence) {
        if (!seen.insert(item.source).second) {
            continue;
        }

        std::wstring label = item.source;
        label += L"(";
        switch (item.category) {
        case SourceCategory::Verified:
            label += L"검증";
            break;
        case SourceCategory::General:
            label += L"일반";
            break;
        case SourceCategory::Trend:
            label += L"유행";
            break;
        }
        label += L")";
        labels.push_back(std::move(label));

        if (labels.size() >= 4) {
            break;
        }
    }

    return labels.empty() ? L"" : L"기반 자료: " + JoinStrings(labels, L", ");
}

bool LooksNatural(const std::wstring& text) {
    const std::wstring normalized = NormalizeWhitespace(text);
    if (normalized.size() < 12) {
        return false;
    }

    if (normalized.find(L"사용자") != std::wstring::npos ||
        normalized.find(L"AI:") != std::wstring::npos) {
        return false;
    }

    int repeated = 1;
    int maxRepeated = 1;
    for (size_t index = 1; index < normalized.size(); ++index) {
        if (normalized[index] == normalized[index - 1]) {
            ++repeated;
            maxRepeated = std::max(maxRepeated, repeated);
        } else {
            repeated = 1;
        }
    }

    return maxRepeated < 6;
}

} // namespace

ReplyDraft ConversationEngine::Reply(
    const std::wstring& userInput,
    const std::vector<ConversationTurn>& history,
    const KnowledgeBase& knowledge,
    const NeuralTextModel& model,
    const ChatOptions& options) const {

    const std::wstring prompt = Trim(userInput);
    const std::wstring lowered = Lower(prompt);

    if (prompt.empty()) {
        return { L"보낼 내용을 먼저 적어주세요.", L"", false, false };
    }

    if (ContainsAny(lowered, { L"안녕", L"반가", L"hello", L"hi" })) {
        return {
            L"안녕하세요. 질문을 자연어 그대로 적어주시면 맥락을 이어서 이해하고, 저장된 웹 자료를 먼저 찾아본 뒤 답해볼게요.",
            L"",
            false,
            false
        };
    }

    if (ContainsAny(lowered, { L"고마워", L"감사", L"thanks", L"thank you" })) {
        return {
            L"천만에요. 원하면 방금 답을 더 짧게 줄이거나, 단계별로 다시 풀어드릴 수 있어요.",
            L"",
            false,
            false
        };
    }

    if (ContainsAny(lowered, { L"출처", L"근거", L"어디서", L"무슨 자료" })) {
        const std::wstring lastMeta = LastAssistantMeta(history);
        if (!lastMeta.empty()) {
            return { lastMeta, L"", true, false };
        }
    }

    if (ContainsAny(lowered, { L"더 짧게", L"짧게", L"한 줄", L"한줄", L"요약" })) {
        const std::wstring previous = LastAssistantText(history);
        if (!previous.empty()) {
            return { Shorten(previous, 120), L"", false, false };
        }
    }

    if (ContainsAny(lowered, { L"힘들", L"피곤", L"지쳤", L"불안", L"우울" })) {
        return {
            L"지금 상태가 꽤 지치는 쪽으로 느껴지네요. 당장 하나만 줄이자면 해야 할 일을 한 줄로 적고, 가장 짧게 끝낼 수 있는 것부터 처리하는 방식이 도움이 될 수 있어요.",
            L"",
            false,
            false
        };
    }

    const ReplyMode mode = DetectMode(lowered);
    const std::wstring effectiveQuery = BuildEffectiveQuery(prompt, history);
    const auto documents = knowledge.Search(
        effectiveQuery,
        options.includeVerified,
        options.includeGeneral,
        options.includeTrend,
        6);

    if (!documents.empty()) {
        const auto evidence = CollectEvidence(effectiveQuery, documents);
        if (!evidence.empty()) {
            ReplyDraft draft;
            draft.text = ComposeFromEvidence(mode, prompt, evidence);
            draft.sourcesLine = BuildSourcesLine(evidence);
            draft.usedKnowledge = true;
            return draft;
        }
    }

    const std::wstring previousAssistant = LastAssistantText(history);
    if (!previousAssistant.empty() && LooksFollowUp(lowered)) {
        ReplyDraft draft;
        draft.text = L"방금 대화를 이어서 풀면 " + EnsureSentenceEnding(Shorten(previousAssistant, 180));
        draft.usedKnowledge = false;
        draft.usedModel = false;
        return draft;
    }

    if (model.IsReady()) {
        std::wstring generated = model.GenerateReply(prompt, 160, std::clamp(0.55f + options.creativity, 0.55f, 0.92f));
        generated = NormalizeWhitespace(generated);
        if (LooksNatural(generated)) {
            return {
                L"지금 바로 맞는 근거 문서를 찾지는 못했지만, 현재 로컬 모델 문맥으로 답하면 " + EnsureSentenceEnding(generated),
                L"",
                false,
                true
            };
        }
    }

    return {
        L"아직 이 질문에 바로 연결되는 자료가 충분하지 않습니다. 자동 학습을 켜 두면 웹 문서를 더 모으고, 다음 대화에서 맥락과 답변 품질이 조금씩 나아지게 해둘 수 있어요.",
        L"",
        false,
        false
    };
}
