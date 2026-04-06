#include "TextModel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <numeric>
#include <random>
#include <sstream>

namespace {

constexpr uint32_t kModelMagic = 0x31494150;

template <typename T>
bool WriteValue(std::ofstream& stream, const T& value) {
    stream.write(reinterpret_cast<const char*>(&value), sizeof(T));
    return static_cast<bool>(stream);
}

template <typename T>
bool ReadValue(std::ifstream& stream, T& value) {
    stream.read(reinterpret_cast<char*>(&value), sizeof(T));
    return static_cast<bool>(stream);
}

std::wstring Trim(const std::wstring& text) {
    const auto begin = text.find_first_not_of(L" \t\r\n");
    if (begin == std::wstring::npos) {
        return L"";
    }
    const auto end = text.find_last_not_of(L" \t\r\n");
    return text.substr(begin, end - begin + 1);
}

} // namespace

NeuralTextModel::NeuralTextModel() = default;

void NeuralTextModel::Reset() {
    corpus_.clear();
    tokens_.clear();
    charToId_.clear();
    idToChar_.clear();
    embeddings_.clear();
    weights1_.clear();
    bias1_.clear();
    weights2_.clear();
    bias2_.clear();
    weights3_.clear();
    bias3_.clear();
    ready_ = false;
    vocabularySize_ = 0;
    corpusLength_ = 0;
    epochsCompleted_ = 0;
    lastLoss_ = 0.0f;
}

std::wstring NeuralTextModel::NormalizeCorpus(const std::wstring& corpus) const {
    std::wstring normalized;
    normalized.reserve(corpus.size());

    for (wchar_t ch : corpus) {
        if (ch != L'\r') {
            normalized.push_back(ch);
        }
    }

    return normalized;
}

bool NeuralTextModel::PrepareCorpus(const std::wstring& corpus, std::wstring& error) {
    Reset();

    corpus_ = NormalizeCorpus(corpus);
    corpusLength_ = corpus_.size();

    if (Trim(corpus_).size() < 300) {
        error = L"학습 데이터가 너무 짧습니다. 최소 300자 이상은 넣어 주세요.";
        return false;
    }

    if (corpus_.size() > 50000) {
        error = L"현재 버전은 5만자 이하의 학습 데이터를 권장합니다.";
        return false;
    }

    idToChar_.push_back(L'\0');
    idToChar_.push_back(L'?');

    for (wchar_t ch : corpus_) {
        if (charToId_.find(ch) == charToId_.end()) {
            const int nextId = static_cast<int>(idToChar_.size());
            charToId_[ch] = nextId;
            idToChar_.push_back(ch);
        }
        tokens_.push_back(charToId_[ch]);
    }

    vocabularySize_ = idToChar_.size();

    if (tokens_.size() <= static_cast<size_t>(kContextSize)) {
        error = L"학습 데이터가 문맥 창보다 짧습니다. 데이터를 더 추가해 주세요.";
        return false;
    }

    InitializeParameters();
    return true;
}

void NeuralTextModel::InitializeParameters() {
    const int inputSize = kContextSize * kEmbeddingSize;
    const size_t embeddingCount = vocabularySize_ * kEmbeddingSize;
    const size_t weight1Count = inputSize * kHidden1Size;
    const size_t weight2Count = kHidden1Size * kHidden2Size;
    const size_t weight3Count = kHidden2Size * static_cast<int>(vocabularySize_);

    embeddings_.assign(embeddingCount, 0.0f);
    weights1_.assign(weight1Count, 0.0f);
    bias1_.assign(kHidden1Size, 0.0f);
    weights2_.assign(weight2Count, 0.0f);
    bias2_.assign(kHidden2Size, 0.0f);
    weights3_.assign(weight3Count, 0.0f);
    bias3_.assign(vocabularySize_, 0.0f);

    std::mt19937 rng(static_cast<uint32_t>(
        std::chrono::high_resolution_clock::now().time_since_epoch().count()));
    std::uniform_real_distribution<float> dist(-0.08f, 0.08f);

    for (float& value : embeddings_) {
        value = dist(rng);
    }
    for (float& value : weights1_) {
        value = dist(rng);
    }
    for (float& value : weights2_) {
        value = dist(rng);
    }
    for (float& value : weights3_) {
        value = dist(rng);
    }
}

int NeuralTextModel::TokenForChar(wchar_t ch) const {
    const auto it = charToId_.find(ch);
    if (it == charToId_.end()) {
        return kUnknownToken;
    }
    return it->second;
}

std::vector<int> NeuralTextModel::EncodeText(const std::wstring& text) const {
    std::vector<int> encoded;
    encoded.reserve(text.size());

    for (wchar_t ch : text) {
        if (ch != L'\r') {
            encoded.push_back(TokenForChar(ch));
        }
    }

    return encoded;
}

void NeuralTextModel::BuildContextFromPosition(size_t position, std::vector<int>& context) const {
    context.assign(kContextSize, kStartToken);

    size_t offset = 0;
    if (position > static_cast<size_t>(kContextSize)) {
        offset = position - static_cast<size_t>(kContextSize);
    }

    size_t target = 0;
    for (size_t i = offset; i < position && target < context.size(); ++i, ++target) {
        context[target] = tokens_[i];
    }
}

void NeuralTextModel::BuildContextFromSeed(const std::wstring& seedText, std::vector<int>& context) const {
    context.assign(kContextSize, kStartToken);
    const auto encoded = EncodeText(seedText);

    if (encoded.empty()) {
        return;
    }

    const size_t copyCount = std::min(context.size(), encoded.size());
    const size_t startIndex = encoded.size() - copyCount;
    const size_t contextStart = context.size() - copyCount;

    for (size_t i = 0; i < copyCount; ++i) {
        context[contextStart + i] = encoded[startIndex + i];
    }
}

void NeuralTextModel::SoftmaxFromLogits(
    const std::vector<float>& logits,
    std::vector<float>& probabilities,
    float temperature) const {

    probabilities.assign(logits.size(), 0.0f);

    const float safeTemperature = std::max(0.05f, temperature);
    float maxLogit = logits.empty() ? 0.0f : logits[0] / safeTemperature;

    for (float value : logits) {
        maxLogit = std::max(maxLogit, value / safeTemperature);
    }

    float sum = 0.0f;
    for (size_t i = 0; i < logits.size(); ++i) {
        const float shifted = (logits[i] / safeTemperature) - maxLogit;
        probabilities[i] = std::exp(shifted);
        sum += probabilities[i];
    }

    if (sum <= 0.0f) {
        const float uniform = logits.empty() ? 0.0f : 1.0f / static_cast<float>(logits.size());
        std::fill(probabilities.begin(), probabilities.end(), uniform);
        return;
    }

    for (float& value : probabilities) {
        value /= sum;
    }
}

void NeuralTextModel::Forward(
    const std::vector<int>& context,
    std::vector<float>& input,
    std::vector<float>& hidden1,
    std::vector<float>& hidden2,
    std::vector<float>& logits,
    std::vector<float>& probabilities,
    float temperature) const {

    const int inputSize = kContextSize * kEmbeddingSize;

    input.assign(inputSize, 0.0f);
    hidden1.assign(kHidden1Size, 0.0f);
    hidden2.assign(kHidden2Size, 0.0f);
    logits.assign(vocabularySize_, 0.0f);

    for (int slot = 0; slot < kContextSize; ++slot) {
        const int token = context[slot];
        const size_t source = static_cast<size_t>(token) * kEmbeddingSize;
        const size_t target = static_cast<size_t>(slot) * kEmbeddingSize;

        for (int e = 0; e < kEmbeddingSize; ++e) {
            input[target + static_cast<size_t>(e)] = embeddings_[source + static_cast<size_t>(e)];
        }
    }

    for (int h = 0; h < kHidden1Size; ++h) {
        float sum = bias1_[static_cast<size_t>(h)];
        for (int i = 0; i < inputSize; ++i) {
            sum += input[static_cast<size_t>(i)] *
                weights1_[static_cast<size_t>(i) * kHidden1Size + static_cast<size_t>(h)];
        }
        hidden1[static_cast<size_t>(h)] = std::tanh(sum);
    }

    for (int h = 0; h < kHidden2Size; ++h) {
        float sum = bias2_[static_cast<size_t>(h)];
        for (int i = 0; i < kHidden1Size; ++i) {
            sum += hidden1[static_cast<size_t>(i)] *
                weights2_[static_cast<size_t>(i) * kHidden2Size + static_cast<size_t>(h)];
        }
        hidden2[static_cast<size_t>(h)] = std::tanh(sum);
    }

    for (size_t v = 0; v < vocabularySize_; ++v) {
        float sum = bias3_[v];
        for (int i = 0; i < kHidden2Size; ++i) {
            sum += hidden2[static_cast<size_t>(i)] *
                weights3_[static_cast<size_t>(i) * vocabularySize_ + v];
        }
        logits[v] = sum;
    }

    SoftmaxFromLogits(logits, probabilities, temperature);
}

bool NeuralTextModel::Train(
    int epochs,
    std::atomic<bool>& cancelRequested,
    const std::function<void(const ModelSnapshot&)>& progressCallback,
    std::wstring& error) {

    if (tokens_.size() <= static_cast<size_t>(kContextSize) || vocabularySize_ < 3) {
        error = L"학습 가능한 코퍼스나 어휘가 준비되지 않았습니다.";
        return false;
    }

    if (epochs < 1) {
        epochs = 1;
    }

    std::mt19937 rng(static_cast<uint32_t>(
        std::chrono::high_resolution_clock::now().time_since_epoch().count()));

    const int inputSize = kContextSize * kEmbeddingSize;
    std::vector<size_t> order(tokens_.size());
    std::iota(order.begin(), order.end(), 0);

    std::vector<int> context(kContextSize, kStartToken);
    std::vector<float> input;
    std::vector<float> hidden1;
    std::vector<float> hidden2;
    std::vector<float> logits;
    std::vector<float> probabilities;
    std::vector<float> dLogits(vocabularySize_, 0.0f);
    std::vector<float> dHidden2(kHidden2Size, 0.0f);
    std::vector<float> dZ2(kHidden2Size, 0.0f);
    std::vector<float> dHidden1(kHidden1Size, 0.0f);
    std::vector<float> dZ1(kHidden1Size, 0.0f);
    std::vector<float> dInput(inputSize, 0.0f);
    std::vector<float> gradEmbeddings(embeddings_.size(), 0.0f);
    std::vector<float> gradWeights1(weights1_.size(), 0.0f);
    std::vector<float> gradBias1(bias1_.size(), 0.0f);
    std::vector<float> gradWeights2(weights2_.size(), 0.0f);
    std::vector<float> gradBias2(bias2_.size(), 0.0f);
    std::vector<float> gradWeights3(weights3_.size(), 0.0f);
    std::vector<float> gradBias3(bias3_.size(), 0.0f);

    float learningRate = 0.035f;

    for (int epoch = 1; epoch <= epochs; ++epoch) {
        if (cancelRequested.load()) {
            error = L"학습이 취소되었습니다.";
            return false;
        }

        std::shuffle(order.begin(), order.end(), rng);
        float lossSum = 0.0f;

        for (size_t sampleIndex = 0; sampleIndex < order.size(); ++sampleIndex) {
            const size_t position = order[sampleIndex];
            BuildContextFromPosition(position, context);
            const int target = tokens_[position];

            Forward(context, input, hidden1, hidden2, logits, probabilities, 1.0f);

            const float targetProbability = std::max(probabilities[static_cast<size_t>(target)], 1e-6f);
            lossSum += -std::log(targetProbability);

            std::fill(gradEmbeddings.begin(), gradEmbeddings.end(), 0.0f);
            std::fill(gradWeights1.begin(), gradWeights1.end(), 0.0f);
            std::fill(gradBias1.begin(), gradBias1.end(), 0.0f);
            std::fill(gradWeights2.begin(), gradWeights2.end(), 0.0f);
            std::fill(gradBias2.begin(), gradBias2.end(), 0.0f);
            std::fill(gradWeights3.begin(), gradWeights3.end(), 0.0f);
            std::fill(gradBias3.begin(), gradBias3.end(), 0.0f);
            std::fill(dInput.begin(), dInput.end(), 0.0f);
            std::fill(dHidden1.begin(), dHidden1.end(), 0.0f);
            std::fill(dHidden2.begin(), dHidden2.end(), 0.0f);
            std::fill(dZ1.begin(), dZ1.end(), 0.0f);
            std::fill(dZ2.begin(), dZ2.end(), 0.0f);

            dLogits = probabilities;
            dLogits[static_cast<size_t>(target)] -= 1.0f;

            for (int h = 0; h < kHidden2Size; ++h) {
                for (size_t v = 0; v < vocabularySize_; ++v) {
                    gradWeights3[static_cast<size_t>(h) * vocabularySize_ + v] =
                        hidden2[static_cast<size_t>(h)] * dLogits[v];
                }
            }

            for (size_t v = 0; v < vocabularySize_; ++v) {
                gradBias3[v] = dLogits[v];
            }

            for (int h = 0; h < kHidden2Size; ++h) {
                float sum = 0.0f;
                for (size_t v = 0; v < vocabularySize_; ++v) {
                    sum += weights3_[static_cast<size_t>(h) * vocabularySize_ + v] * dLogits[v];
                }
                dHidden2[static_cast<size_t>(h)] = sum;
                dZ2[static_cast<size_t>(h)] = sum * (1.0f - hidden2[static_cast<size_t>(h)] * hidden2[static_cast<size_t>(h)]);
            }

            for (int h1 = 0; h1 < kHidden1Size; ++h1) {
                for (int h2 = 0; h2 < kHidden2Size; ++h2) {
                    gradWeights2[static_cast<size_t>(h1) * kHidden2Size + static_cast<size_t>(h2)] =
                        hidden1[static_cast<size_t>(h1)] * dZ2[static_cast<size_t>(h2)];
                }
            }

            for (int h = 0; h < kHidden2Size; ++h) {
                gradBias2[static_cast<size_t>(h)] = dZ2[static_cast<size_t>(h)];
            }

            for (int h = 0; h < kHidden1Size; ++h) {
                float sum = 0.0f;
                for (int h2 = 0; h2 < kHidden2Size; ++h2) {
                    sum += weights2_[static_cast<size_t>(h) * kHidden2Size + static_cast<size_t>(h2)] *
                        dZ2[static_cast<size_t>(h2)];
                }
                dHidden1[static_cast<size_t>(h)] = sum;
                dZ1[static_cast<size_t>(h)] = sum * (1.0f - hidden1[static_cast<size_t>(h)] * hidden1[static_cast<size_t>(h)]);
            }

            for (int i = 0; i < inputSize; ++i) {
                for (int h = 0; h < kHidden1Size; ++h) {
                    gradWeights1[static_cast<size_t>(i) * kHidden1Size + static_cast<size_t>(h)] =
                        input[static_cast<size_t>(i)] * dZ1[static_cast<size_t>(h)];
                }
            }

            for (int h = 0; h < kHidden1Size; ++h) {
                gradBias1[static_cast<size_t>(h)] = dZ1[static_cast<size_t>(h)];
            }

            for (int i = 0; i < inputSize; ++i) {
                float sum = 0.0f;
                for (int h = 0; h < kHidden1Size; ++h) {
                    sum += weights1_[static_cast<size_t>(i) * kHidden1Size + static_cast<size_t>(h)] *
                        dZ1[static_cast<size_t>(h)];
                }
                dInput[static_cast<size_t>(i)] = sum;
            }

            for (int slot = 0; slot < kContextSize; ++slot) {
                const int token = context[slot];
                const size_t tokenOffset = static_cast<size_t>(token) * kEmbeddingSize;
                const size_t inputOffset = static_cast<size_t>(slot) * kEmbeddingSize;
                for (int e = 0; e < kEmbeddingSize; ++e) {
                    gradEmbeddings[tokenOffset + static_cast<size_t>(e)] +=
                        dInput[inputOffset + static_cast<size_t>(e)];
                }
            }

            auto applyGradient = [learningRate](std::vector<float>& params, const std::vector<float>& grads) {
                for (size_t i = 0; i < params.size(); ++i) {
                    float gradient = grads[i];
                    gradient = std::clamp(gradient, -5.0f, 5.0f);
                    params[i] -= learningRate * gradient;
                }
            };

            applyGradient(embeddings_, gradEmbeddings);
            applyGradient(weights1_, gradWeights1);
            applyGradient(bias1_, gradBias1);
            applyGradient(weights2_, gradWeights2);
            applyGradient(bias2_, gradBias2);
            applyGradient(weights3_, gradWeights3);
            applyGradient(bias3_, gradBias3);
        }

        lastLoss_ = lossSum / static_cast<float>(order.size());
        epochsCompleted_ = epoch;
        ready_ = true;

        if (progressCallback) {
            progressCallback(Snapshot());
        }

        learningRate *= 0.94f;
    }

    return true;
}

int NeuralTextModel::SampleToken(const std::vector<float>& probabilities) const {
    std::vector<int> candidates;
    candidates.reserve(vocabularySize_ > 2 ? vocabularySize_ - 2 : 0);

    for (size_t id = 2; id < vocabularySize_; ++id) {
        candidates.push_back(static_cast<int>(id));
    }

    if (candidates.empty()) {
        return kUnknownToken;
    }

    constexpr size_t topK = 10;
    const size_t usable = std::min(topK, candidates.size());
    std::partial_sort(
        candidates.begin(),
        candidates.begin() + static_cast<std::ptrdiff_t>(usable),
        candidates.end(),
        [&probabilities](int left, int right) {
            return probabilities[static_cast<size_t>(left)] > probabilities[static_cast<size_t>(right)];
        });

    std::mt19937 rng(static_cast<uint32_t>(
        std::chrono::high_resolution_clock::now().time_since_epoch().count()));

    float total = 0.0f;
    for (size_t i = 0; i < usable; ++i) {
        total += probabilities[static_cast<size_t>(candidates[i])];
    }

    if (total <= 0.0f) {
        return candidates.front();
    }

    std::uniform_real_distribution<float> dist(0.0f, total);
    const float pick = dist(rng);

    float cumulative = 0.0f;
    for (size_t i = 0; i < usable; ++i) {
        cumulative += probabilities[static_cast<size_t>(candidates[i])];
        if (pick <= cumulative) {
            return candidates[i];
        }
    }

    return candidates.front();
}

std::wstring NeuralTextModel::GenerateReply(const std::wstring& userPrompt, int maxCharacters, float temperature) const {
    if (!ready_ || vocabularySize_ < 3) {
        return L"";
    }

    const std::wstring seed = L"사용자: " + userPrompt + L"\nAI: ";
    std::vector<int> context(kContextSize, kStartToken);
    BuildContextFromSeed(seed, context);

    std::vector<float> input;
    std::vector<float> hidden1;
    std::vector<float> hidden2;
    std::vector<float> logits;
    std::vector<float> probabilities;
    std::wstring reply;
    reply.reserve(static_cast<size_t>(maxCharacters));

    for (int step = 0; step < maxCharacters; ++step) {
        Forward(context, input, hidden1, hidden2, logits, probabilities, temperature);
        const int token = SampleToken(probabilities);
        if (token < 2 || static_cast<size_t>(token) >= idToChar_.size()) {
            continue;
        }

        const wchar_t ch = idToChar_[static_cast<size_t>(token)];
        reply.push_back(ch);

        for (size_t i = 1; i < context.size(); ++i) {
            context[i - 1] = context[i];
        }
        context.back() = token;

        if (ch == L'\n' && reply.size() > 24) {
            break;
        }
    }

    auto cutAt = [&reply](const std::wstring& needle) {
        const size_t pos = reply.find(needle);
        if (pos != std::wstring::npos) {
            reply = reply.substr(0, pos);
        }
    };

    cutAt(L"\n사용자:");
    cutAt(L"\nAI:");
    cutAt(L"\n\n");

    return Trim(reply);
}

bool NeuralTextModel::Save(const std::wstring& path, std::wstring& error) const {
    if (!ready_) {
        error = L"저장할 학습 모델이 아직 없습니다.";
        return false;
    }

    std::filesystem::create_directories(std::filesystem::path(path).parent_path());
    std::ofstream file(std::filesystem::path(path), std::ios::binary);
    if (!file) {
        error = L"모델 파일을 저장할 수 없습니다.";
        return false;
    }

    if (!WriteValue(file, kModelMagic)) {
        error = L"모델 매직 값을 쓰지 못했습니다.";
        return false;
    }

    const uint32_t vocabulary = static_cast<uint32_t>(vocabularySize_);
    const uint32_t corpusLength = static_cast<uint32_t>(corpusLength_);
    const int32_t epochs = static_cast<int32_t>(epochsCompleted_);

    WriteValue(file, vocabulary);
    WriteValue(file, corpusLength);
    WriteValue(file, epochs);
    WriteValue(file, lastLoss_);

    for (size_t i = 2; i < idToChar_.size(); ++i) {
        const uint32_t value = static_cast<uint32_t>(idToChar_[i]);
        WriteValue(file, value);
    }

    auto writeVector = [&file](const std::vector<float>& values) {
        const uint32_t count = static_cast<uint32_t>(values.size());
        WriteValue(file, count);
        if (count > 0) {
            file.write(reinterpret_cast<const char*>(values.data()), static_cast<std::streamsize>(count * sizeof(float)));
        }
        return static_cast<bool>(file);
    };

    if (!writeVector(embeddings_) || !writeVector(weights1_) || !writeVector(bias1_) ||
        !writeVector(weights2_) || !writeVector(bias2_) || !writeVector(weights3_) || !writeVector(bias3_)) {
        error = L"모델 파라미터를 저장하는 중 오류가 발생했습니다.";
        return false;
    }

    return true;
}

bool NeuralTextModel::Load(const std::wstring& path, std::wstring& error) {
    std::ifstream file(std::filesystem::path(path), std::ios::binary);
    if (!file) {
        error = L"저장된 모델 파일을 찾지 못했습니다.";
        return false;
    }

    uint32_t magic = 0;
    if (!ReadValue(file, magic) || magic != kModelMagic) {
        error = L"모델 파일 형식이 맞지 않습니다.";
        return false;
    }

    Reset();

    uint32_t vocabulary = 0;
    uint32_t corpusLength = 0;
    int32_t epochs = 0;
    float loss = 0.0f;

    if (!ReadValue(file, vocabulary) || !ReadValue(file, corpusLength) ||
        !ReadValue(file, epochs) || !ReadValue(file, loss)) {
        error = L"모델 헤더를 읽는 중 오류가 발생했습니다.";
        return false;
    }

    if (vocabulary < 3) {
        error = L"모델 어휘 크기가 너무 작습니다.";
        return false;
    }

    vocabularySize_ = vocabulary;
    corpusLength_ = corpusLength;
    epochsCompleted_ = epochs;
    lastLoss_ = loss;

    idToChar_.push_back(L'\0');
    idToChar_.push_back(L'?');

    for (uint32_t i = 2; i < vocabulary; ++i) {
        uint32_t value = 0;
        if (!ReadValue(file, value)) {
            error = L"문자 어휘를 읽는 중 오류가 발생했습니다.";
            Reset();
            return false;
        }
        const wchar_t ch = static_cast<wchar_t>(value);
        idToChar_.push_back(ch);
        charToId_[ch] = static_cast<int>(i);
    }

    auto readVector = [&file](std::vector<float>& values) -> bool {
        uint32_t count = 0;
        if (!ReadValue(file, count)) {
            return false;
        }
        values.assign(count, 0.0f);
        if (count > 0) {
            file.read(reinterpret_cast<char*>(values.data()), static_cast<std::streamsize>(count * sizeof(float)));
        }
        return static_cast<bool>(file);
    };

    if (!readVector(embeddings_) || !readVector(weights1_) || !readVector(bias1_) ||
        !readVector(weights2_) || !readVector(bias2_) || !readVector(weights3_) || !readVector(bias3_)) {
        error = L"모델 파라미터를 읽는 중 오류가 발생했습니다.";
        Reset();
        return false;
    }

    ready_ = true;
    return true;
}

bool NeuralTextModel::IsReady() const {
    return ready_;
}

ModelSnapshot NeuralTextModel::Snapshot() const {
    ModelSnapshot snapshot;
    snapshot.ready = ready_;
    snapshot.vocabularySize = vocabularySize_;
    snapshot.corpusLength = corpusLength_;
    snapshot.epochsCompleted = epochsCompleted_;
    snapshot.lastLoss = lastLoss_;
    return snapshot;
}

std::wstring DefaultKoreanCorpus() {
    return
        LR"(사용자: 안녕하세요
AI: 안녕하세요. 저는 퍼플비 자연어 AI입니다. 이 앱 안에서 직접 학습하는 작은 한국어 모델입니다.

사용자: 너는 누구야
AI: 저는 순수 C++ 코드로 만든 실험용 자연어 모델입니다. 외부 API 없이 로컬에서 학습과 생성이 이루어집니다.

사용자: 자연어 AI가 뭐야
AI: 사람이 쓰는 문장의 흐름을 보고 다음 문자나 다음 단어를 예측하는 모델을 뜻합니다.

사용자: 너는 거대 언어 모델이야
AI: 아니요. 저는 이 앱 안에서 직접 학습하는 소형 문자 기반 딥러닝 모델입니다.

사용자: 딥러닝이 뭐야
AI: 딥러닝은 여러 층의 가중치를 가진 신경망이 데이터를 보며 패턴을 학습하는 방식입니다.

사용자: 너는 어떻게 대답해
AI: 저는 사용자의 질문을 문맥으로 보고 다음 문자를 하나씩 생성해 응답 문장을 만듭니다.

사용자: 너는 인터넷을 사용하니
AI: 아니요. 현재 앱 안의 모델은 인터넷 연결 없이 동작하도록 설계되었습니다.

사용자: 외부 AI를 불러와
AI: 아니요. 학습과 생성 모두 앱 내부의 C++ 코드에서 직접 수행됩니다.

사용자: 한국어도 가능해
AI: 네. 기본 학습 데이터가 한국어 중심이라 간단한 한국어 응답을 만들 수 있습니다.

사용자: 영어도 할 수 있어
AI: 제한적으로는 가능하지만 지금 버전은 한국어 쪽이 더 자연스럽습니다.

사용자: 너의 장점은 뭐야
AI: 구조가 단순해서 내부 동작을 직접 추적하기 쉽고, 외부 서비스 없이 실험할 수 있다는 점이 장점입니다.

사용자: 너의 한계는 뭐야
AI: 모델 규모와 데이터가 작아서 긴 추론, 높은 정확도, 넓은 지식은 기대하기 어렵습니다.

사용자: 문자 기반 모델은 왜 써
AI: 외부 토크나이저 없이도 시작할 수 있고, 구조를 직접 구현하기 쉬워서 교육용으로 좋기 때문입니다.

사용자: 손실 값은 뭘 의미해
AI: 손실 값은 모델의 예측이 얼마나 틀렸는지 보여 주는 수치이며, 보통 학습이 진행되면 조금씩 낮아집니다.

사용자: 파라미터는 뭐야
AI: 파라미터는 신경망이 학습하면서 조정하는 숫자이며, 문장 패턴을 기억하는 핵심 요소입니다.

사용자: 에폭은 뭐야
AI: 전체 학습 데이터를 한 번 끝까지 보는 과정을 한 에폭이라고 합니다.

사용자: 학습 데이터는 어떤 형식이 좋아
AI: 짧고 선명한 질문과 대답이 반복되는 대화 형식이 지금 구조에는 잘 맞습니다.

사용자: 좋은 학습 데이터의 특징은 뭐야
AI: 문체가 일관되고, 너무 길지 않으며, 자주 쓰고 싶은 표현이 반복되는 데이터가 좋습니다.

사용자: 데이터가 너무 적으면 어떻게 돼
AI: 문장이 쉽게 반복되고 응답이 짧거나 이상하게 끊길 수 있습니다.

사용자: 데이터가 너무 많으면 어떻게 돼
AI: 지금 같은 소형 모델은 학습 시간이 늘어나고 품질이 꼭 비례해서 좋아지지는 않을 수 있습니다.

사용자: C++은 어떤 언어야
AI: C++은 성능 중심의 시스템 프로그래밍과 데스크톱 앱 개발에 자주 쓰이는 언어입니다.

사용자: Win32는 뭐야
AI: Win32는 Windows 데스크톱 프로그램을 만들 때 사용하는 기본 API 계층입니다.

사용자: 이 앱은 어떤 구조야
AI: Win32 GUI, 로컬 학습 엔진, 한국어 UI, 저장 가능한 모델 파일로 구성된 자연어 실험 앱입니다.

사용자: 모델을 저장할 수 있어
AI: 네. 학습한 가중치와 문자 어휘를 파일로 저장하고 다음 실행에서 다시 불러올 수 있습니다.

사용자: 학습이 필요한 이유는 뭐야
AI: 모델은 처음에 무작위 값으로 시작하므로 데이터를 보면서 점점 문장 패턴을 배우게 됩니다.

사용자: 스스로 배우는 거야
AI: 네. 입력된 학습 데이터에서 다음 문자를 맞히는 방향으로 가중치를 업데이트합니다.

사용자: 대화체로 말해줘
AI: 좋아요. 저는 짧고 또렷하게 말하는 편이 잘 맞습니다.

사용자: 차분하게 설명해줘
AI: 네. 필요한 핵심부터 천천히 설명드리겠습니다.

사용자: 친절하게 말해줘
AI: 알겠습니다. 어렵지 않게 차근차근 말씀드리겠습니다.

사용자: 자신을 소개해줘
AI: 저는 퍼플비 자연어 AI입니다. 작지만 구조를 직접 이해할 수 있는 순수 C++ 기반 모델입니다.

사용자: 나는 개발자야
AI: 반갑습니다. 이 앱은 개발자가 모델 구조와 학습 흐름을 직접 만져 보기 좋게 설계되었습니다.

사용자: 좋은 UI란 뭐야
AI: 사용자가 다음 행동을 쉽게 이해하고, 상태 변화가 분명하게 보이며, 불필요한 혼란이 적은 UI입니다.

사용자: 한국어 UI가 왜 중요해
AI: 사용자가 더 빠르게 이해하고, 모델의 목적과 상태를 자연스럽게 파악할 수 있기 때문입니다.

사용자: 로고는 왜 필요해
AI: 도구의 정체성을 보여 주고, 제품처럼 느껴지게 만드는 시각적 기준점이 되기 때문입니다.

사용자: 모델이 답을 이상하게 하면 어떻게 해
AI: 학습 데이터를 더 다듬고, 문체를 통일하고, 에폭을 조금 늘리며 손실 변화를 확인하는 것이 좋습니다.

사용자: 온도는 뭐야
AI: 생성 시 확률을 얼마나 보수적으로 따를지 정하는 값입니다. 낮으면 안정적이고 높으면 더 다양해집니다.

사용자: 어떤 학습 방식을 쓰고 있어
AI: 문맥 창 안의 문자를 보고 다음 문자를 맞히는 다층 퍼셉트론 기반의 소형 언어 모델 방식을 씁니다.

사용자: 트랜스포머야
AI: 아니요. 지금 버전은 구조를 단순하게 유지한 작은 다층 신경망입니다.

사용자: 왜 더 큰 모델을 안 써
AI: 외부 프레임워크 없이 직접 구현하고 빠르게 실험할 수 있도록 단순한 구조를 선택했기 때문입니다.

사용자: 그래도 자연어처럼 보일 수 있어
AI: 데이터가 잘 정리되어 있으면 짧은 구간에서는 꽤 자연스러운 문장을 만들 수 있습니다.

사용자: 네 장점을 한 문장으로 말해줘
AI: 저는 외부 의존 없이 직접 구조를 이해하고 실험할 수 있는 순수 C++ 자연어 AI입니다.

사용자: 네 한계를 한 문장으로 말해줘
AI: 저는 소형 모델이라 긴 추론과 넓은 지식을 기대하기보다 구조 학습과 실험에 더 적합합니다.

사용자: 사용자를 환영해줘
AI: 환영합니다. 퍼플비 자연어 AI에서 직접 학습한 모델과 대화를 시작해 보세요.
)";
}
