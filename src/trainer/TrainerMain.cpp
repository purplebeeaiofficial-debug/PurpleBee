#include "AppPaths.h"
#include "KnowledgeBase.h"
#include "TextModel.h"
#include "TextUtils.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <atomic>
#include <ctime>
#include <filesystem>
#include <sstream>
#include <string>

namespace {

constexpr wchar_t kTrainerMutexName[] = L"Local\\PurpleBeeTrainerProcess";

struct TrainerConfig {
    bool autoLearning = true;
    bool includeVerified = true;
    bool includeGeneral = true;
    bool includeTrend = false;
    int epochs = 10;
    int intervalMinutes = 20;
};

struct StatusPayload {
    bool success = false;
    std::wstring state = L"준비 중";
    std::wstring message = L"학습기를 초기화하는 중입니다.";
    int documents = 0;
    int verified = 0;
    int general = 0;
    int trend = 0;
    ModelSnapshot snapshot;
    long long lastCompletedEpoch = 0;
};

std::wstring PathString(const std::filesystem::path& path) {
    return path.wstring();
}

long long NowEpoch() {
    return static_cast<long long>(std::time(nullptr));
}

std::wstring FormatEpoch(long long epoch) {
    if (epoch <= 0) {
        return L"-";
    }

    std::time_t value = static_cast<std::time_t>(epoch);
    std::tm localTime = {};
    localtime_s(&localTime, &value);

    wchar_t buffer[64] = {};
    if (wcsftime(buffer, std::size(buffer), L"%Y-%m-%d %H:%M:%S", &localTime) == 0) {
        return L"-";
    }
    return buffer;
}

void MergeRecommendedSources(KnowledgeBase& knowledge) {
    KnowledgeBase recommended;
    recommended.EnsureDefaultSources();

    std::wstring merged = knowledge.SourcesToText();
    const std::wstring recommendedText = recommended.SourcesToText();
    std::wstring loweredMerged = Lower(merged);

    std::wstringstream stream(recommendedText);
    std::wstring line;
    while (std::getline(stream, line)) {
        line = Trim(line);
        if (line.empty()) {
            continue;
        }

        const std::wstring loweredLine = Lower(line);
        if (loweredMerged.find(loweredLine) != std::wstring::npos) {
            continue;
        }

        if (!merged.empty()) {
            merged += L"\r\n";
        }
        merged += line;
        loweredMerged += L"\n" + loweredLine;
    }

    knowledge.SetSourcesFromText(merged);
}

void WriteStringValue(const std::wstring& section, const std::wstring& key, const std::wstring& value) {
    WritePrivateProfileStringW(section.c_str(), key.c_str(), value.c_str(), PathString(PurpleBee::TrainerStatusPath()).c_str());
}

void WriteBoolValue(const std::wstring& section, const std::wstring& key, bool value) {
    WriteStringValue(section, key, value ? L"1" : L"0");
}

void WriteIntValue(const std::wstring& section, const std::wstring& key, int value) {
    WriteStringValue(section, key, std::to_wstring(value));
}

void WriteLongLongValue(const std::wstring& section, const std::wstring& key, long long value) {
    WriteStringValue(section, key, std::to_wstring(value));
}

void WriteFloatValue(const std::wstring& section, const std::wstring& key, float value) {
    wchar_t buffer[64] = {};
    swprintf_s(buffer, L"%.4f", value);
    WriteStringValue(section, key, buffer);
}

void SaveStatus(const StatusPayload& status, bool running, bool autoLearning) {
    std::wostringstream stream;
    stream << L"[trainer]\n";
    stream << L"running=" << (running ? 1 : 0) << L"\n";
    stream << L"auto_learning=" << (autoLearning ? 1 : 0) << L"\n";
    stream << L"last_success=" << (status.success ? 1 : 0) << L"\n";
    stream << L"state=" << NormalizeWhitespace(status.state) << L"\n";
    stream << L"message=" << NormalizeWhitespace(status.message) << L"\n";
    stream << L"documents=" << status.documents << L"\n";
    stream << L"verified=" << status.verified << L"\n";
    stream << L"general=" << status.general << L"\n";
    stream << L"trend=" << status.trend << L"\n";
    stream << L"model_ready=" << (status.snapshot.ready ? 1 : 0) << L"\n";
    stream << L"epochs_completed=" << status.snapshot.epochsCompleted << L"\n";
    stream << L"vocabulary=" << static_cast<int>(status.snapshot.vocabularySize) << L"\n";
    stream << L"corpus_length=" << static_cast<int>(status.snapshot.corpusLength) << L"\n";
    stream << L"loss=" << status.snapshot.lastLoss << L"\n";
    stream << L"heartbeat=" << NowEpoch() << L"\n";
    stream << L"last_completed_epoch=" << status.lastCompletedEpoch << L"\n";
    stream << L"last_completed_text=" << FormatEpoch(status.lastCompletedEpoch) << L"\n";
    SaveUtf8TextFile(PurpleBee::TrainerStatusPath(), stream.str());
}

TrainerConfig LoadConfig() {
    const std::wstring path = PathString(PurpleBee::SettingsPath());

    TrainerConfig config;
    config.autoLearning = GetPrivateProfileIntW(L"chat", L"auto_learning", 1, path.c_str()) != 0;
    config.includeVerified = GetPrivateProfileIntW(L"chat", L"include_verified", 1, path.c_str()) != 0;
    config.includeGeneral = GetPrivateProfileIntW(L"chat", L"include_general", 1, path.c_str()) != 0;
    config.includeTrend = GetPrivateProfileIntW(L"chat", L"include_trend", 0, path.c_str()) != 0;
    config.epochs = std::clamp(static_cast<int>(GetPrivateProfileIntW(L"trainer", L"epochs", 10, path.c_str())), 1, 24);
    config.intervalMinutes = std::clamp(static_cast<int>(GetPrivateProfileIntW(L"trainer", L"interval_minutes", 20, path.c_str())), 5, 240);
    return config;
}

void EnsureSeedFiles(KnowledgeBase& knowledge) {
    if (!std::filesystem::exists(PurpleBee::SeedCorpusPath())) {
        SaveUtf8TextFile(PurpleBee::SeedCorpusPath(), DefaultKoreanCorpus());
    }

    std::wstring error;
    if (std::filesystem::exists(PurpleBee::SourcesPath())) {
        knowledge.LoadSources(PathString(PurpleBee::SourcesPath()), error);
    } else {
        knowledge.EnsureDefaultSources();
    }

    MergeRecommendedSources(knowledge);
    knowledge.SaveSources(PathString(PurpleBee::SourcesPath()), error);
}

void UpdateDocumentCounts(StatusPayload& status, const KnowledgeBase& knowledge) {
    status.documents = static_cast<int>(knowledge.DocumentCount());
    status.verified = static_cast<int>(knowledge.DocumentCount(SourceCategory::Verified));
    status.general = static_cast<int>(knowledge.DocumentCount(SourceCategory::General));
    status.trend = static_cast<int>(knowledge.DocumentCount(SourceCategory::Trend));
}

bool RunCycle(const TrainerConfig& config, StatusPayload& status) {
    KnowledgeBase knowledge;
    EnsureSeedFiles(knowledge);

    std::wstring error;
    knowledge.LoadDocuments(PathString(PurpleBee::KnowledgePath()), error);
    UpdateDocumentCounts(status, knowledge);
    SaveStatus(status, true, config.autoLearning);

    std::atomic<bool> cancelRequested = false;
    std::wstring syncError;
    status.state = L"웹 동기화";
    status.message = L"검증 자료와 일반 자료를 가져오는 중입니다.";
    SaveStatus(status, true, config.autoLearning);

    const bool synced = knowledge.SyncAll(
        cancelRequested,
        [&](const std::wstring& progress) {
            status.state = L"웹 동기화";
            status.message = progress;
            UpdateDocumentCounts(status, knowledge);
            SaveStatus(status, true, config.autoLearning);
        },
        syncError);

    if (synced) {
        knowledge.SaveDocuments(PathString(PurpleBee::KnowledgePath()), error);
    }

    UpdateDocumentCounts(status, knowledge);

    std::wstring seedCorpus;
    if (!LoadUtf8TextFile(PurpleBee::SeedCorpusPath(), seedCorpus) || Trim(seedCorpus).empty()) {
        seedCorpus = DefaultKoreanCorpus();
        SaveUtf8TextFile(PurpleBee::SeedCorpusPath(), seedCorpus);
    }

    std::wstring trainingCorpus = seedCorpus;
    const std::wstring webCorpus = knowledge.ExportTrainingCorpus(
        config.includeVerified,
        config.includeGeneral,
        config.includeTrend,
        900);

    if (!Trim(webCorpus).empty()) {
        trainingCorpus += L"\n\n";
        trainingCorpus += webCorpus;
    }

    NeuralTextModel model;
    if (!model.PrepareCorpus(trainingCorpus, error)) {
        status.success = false;
        status.state = L"학습 실패";
        status.message = error;
        status.snapshot = {};
        SaveStatus(status, true, config.autoLearning);
        return false;
    }

    status.state = L"딥러닝 학습";
    status.message = L"모델을 새 자료로 다시 학습하는 중입니다.";
    SaveStatus(status, true, config.autoLearning);

    const bool trained = model.Train(
        config.epochs,
        cancelRequested,
        [&](const ModelSnapshot& snapshot) {
            status.snapshot = snapshot;
            wchar_t buffer[128] = {};
            swprintf_s(buffer, L"에폭 %d 진행 중, 손실 %.4f", snapshot.epochsCompleted, snapshot.lastLoss);
            status.state = L"딥러닝 학습";
            status.message = buffer;
            SaveStatus(status, true, config.autoLearning);
        },
        error);

    if (!trained) {
        status.success = false;
        status.state = L"학습 실패";
        status.message = error;
        status.snapshot = model.Snapshot();
        SaveStatus(status, true, config.autoLearning);
        return false;
    }

    if (!model.Save(PathString(PurpleBee::ModelPath()), error)) {
        status.success = false;
        status.state = L"모델 저장 실패";
        status.message = error;
        status.snapshot = model.Snapshot();
        SaveStatus(status, true, config.autoLearning);
        return false;
    }

    status.success = true;
    status.snapshot = model.Snapshot();
    status.lastCompletedEpoch = NowEpoch();
    status.state = L"학습 완료";

    if (synced) {
        status.message = L"웹 자료와 로컬 말뭉치를 반영해 모델을 갱신했습니다.";
    } else if (status.documents > 0) {
        status.message = L"기존 캐시와 로컬 말뭉치로 모델을 갱신했습니다.";
    } else {
        status.message = L"기본 말뭉치만으로 모델을 다시 학습했습니다.";
    }

    SaveStatus(status, true, config.autoLearning);
    return true;
}

} // namespace

int APIENTRY wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);

    bool daemonMode = false;
    for (int index = 1; index < argc; ++index) {
        if (std::wstring(argv[index]) == L"--daemon") {
            daemonMode = true;
        }
    }
    if (argv != nullptr) {
        LocalFree(argv);
    }

    HANDLE mutex = CreateMutexW(nullptr, TRUE, kTrainerMutexName);
    if (mutex == nullptr) {
        return 1;
    }

    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(mutex);
        return 0;
    }

    TrainerConfig config = LoadConfig();
    StatusPayload status;
    SaveStatus(status, true, config.autoLearning);

    if (!daemonMode) {
        RunCycle(config, status);
        SaveStatus(status, false, config.autoLearning);
        CloseHandle(mutex);
        return status.success ? 0 : 1;
    }

    while (true) {
        config = LoadConfig();
        if (config.autoLearning) {
            RunCycle(config, status);
            status.state = L"대기 중";
            if (status.success) {
                status.message = L"다음 자동 학습 주기를 기다리는 중입니다.";
            }
        } else {
            status.state = L"일시 정지";
            status.message = L"자동 학습이 꺼져 있습니다.";
        }

        const int waitSeconds = std::max(60, config.intervalMinutes * 60);
        for (int elapsed = 0; elapsed < waitSeconds; elapsed += 15) {
            SaveStatus(status, true, config.autoLearning);
            Sleep(15000);
        }
    }
}



