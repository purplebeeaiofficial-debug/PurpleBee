#include "AppPaths.h"
#include "ConversationEngine.h"
#include "KnowledgeBase.h"
#include "TextModel.h"
#include "TextUtils.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <array>
#include <ctime>
#include <filesystem>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kMainClassName[] = L"PurpleBeeChatWindow";
constexpr wchar_t kChatViewClassName[] = L"PurpleBeeChatView";
constexpr wchar_t kWindowTitle[] = L"퍼플비 챗";
constexpr UINT kCueBannerMessage = 0x1501;
constexpr UINT_PTR ID_POLL_TIMER = 2001;

enum ControlId {
    ID_CHAT_VIEW = 1001,
    ID_INPUT_EDIT = 1002,
    ID_SEND_BUTTON = 1003,
    ID_NEW_CHAT_BUTTON = 1004,
    ID_TRAINER_BUTTON = 1005,
    ID_REFRESH_BUTTON = 1006,
    ID_VERIFIED_BUTTON = 1101,
    ID_GENERAL_BUTTON = 1102,
    ID_TREND_BUTTON = 1103,
    ID_AUTO_BUTTON = 1104
};

struct Theme {
    COLORREF window = RGB(255, 255, 255), sidebar = RGB(247, 247, 248), sidebarBorder = RGB(231, 231, 235);
    COLORREF topBorder = RGB(238, 238, 242), text = RGB(28, 28, 30), muted = RGB(110, 112, 118);
    COLORREF soft = RGB(244, 244, 246), softBorder = RGB(228, 229, 234), accent = RGB(16, 16, 16);
    COLORREF accentText = RGB(255, 255, 255), userBubble = RGB(243, 244, 246), assistantCard = RGB(250, 250, 251);
    COLORREF success = RGB(31, 161, 98), warning = RGB(176, 126, 28), input = RGB(255, 255, 255);
};

struct AppSettings { bool includeVerified = true, includeGeneral = true, includeTrend = false, autoLearning = true; };
struct TrainerStatus {
    bool running = false, autoLearning = true, lastSuccess = false, modelReady = false;
    std::wstring state = L"대기 중", message = L"아직 실행 기록이 없습니다.";
    int documents = 0, verified = 0, general = 0, trend = 0, epochsCompleted = 0, vocabulary = 0, corpusLength = 0;
    float loss = 0.0f; long long heartbeat = 0, lastCompletedEpoch = 0;
};
struct MessageLayout { RECT bubble{}, text{}, meta{}; bool user = false, boxed = false, hasMeta = false; };

Theme g_theme; AppSettings g_settings; TrainerStatus g_trainer; ConversationEngine g_engine; KnowledgeBase g_knowledge; NeuralTextModel g_model;
std::vector<ConversationTurn> g_conversation;
HINSTANCE g_instance = nullptr; HWND g_main = nullptr, g_chatView = nullptr, g_input = nullptr, g_send = nullptr, g_newChat = nullptr, g_trainerBtn = nullptr, g_refresh = nullptr, g_verified = nullptr, g_general = nullptr, g_trend = nullptr, g_auto = nullptr;
HFONT g_titleFont = nullptr, g_bodyFont = nullptr, g_smallFont = nullptr, g_homeFont = nullptr, g_uiFont = nullptr;
HBRUSH g_windowBrush = nullptr, g_sidebarBrush = nullptr, g_inputBrush = nullptr;
WNDPROC g_inputProc = nullptr;
RECT g_sidebarRect{}, g_mainRect{}, g_topRect{}, g_chatRect{}, g_composeRect{}, g_recentRect{};
int g_chatScroll = 0, g_chatContentHeight = 0;
std::filesystem::file_time_type g_lastKnowledgeWrite = std::filesystem::file_time_type::min(), g_lastModelWrite = std::filesystem::file_time_type::min();

std::wstring PathString(const std::filesystem::path& p) { return p.wstring(); }
std::wstring GetText(HWND h) { int n = GetWindowTextLengthW(h); std::wstring s(static_cast<size_t>(n), L'\0'); if (n > 0) GetWindowTextW(h, s.data(), n + 1); return s; }
long long NowEpoch() { return static_cast<long long>(std::time(nullptr)); }
std::wstring FormatEpoch(long long t) { if (t <= 0) return L"-"; std::time_t v = static_cast<std::time_t>(t); std::tm tm{}; localtime_s(&tm, &v); wchar_t b[64] = {}; return wcsftime(b, std::size(b), L"%Y-%m-%d %H:%M", &tm) ? b : L"-"; }
COLORREF Blend(COLORREF a, COLORREF b, int aw, int bw) { int tot = std::max(1, aw + bw); return RGB((GetRValue(a) * aw + GetRValue(b) * bw) / tot, (GetGValue(a) * aw + GetGValue(b) * bw) / tot, (GetBValue(a) * aw + GetBValue(b) * bw) / tot); }
std::filesystem::file_time_type SafeWriteTime(const std::filesystem::path& p) { std::error_code ec; return std::filesystem::exists(p, ec) ? std::filesystem::last_write_time(p, ec) : std::filesystem::file_time_type::min(); }
bool HasUserTurns() { return std::any_of(g_conversation.begin(), g_conversation.end(), [](const ConversationTurn& t) { return t.fromUser; }); }
bool IsHome() { return !HasUserTurns(); }
bool TrainerFresh() { return g_trainer.running && (NowEpoch() - g_trainer.heartbeat) <= 45; }

std::wstring ReadMapValue(const std::vector<std::pair<std::wstring, std::wstring>>& e, const std::wstring& k, const std::wstring& f) { for (const auto& x : e) if (x.first == k) return x.second; return f; }
int ReadMapInt(const std::vector<std::pair<std::wstring, std::wstring>>& e, const std::wstring& k, int f) { try { return std::stoi(ReadMapValue(e, k, std::to_wstring(f))); } catch (...) { return f; } }
long long ReadMapLongLong(const std::vector<std::pair<std::wstring, std::wstring>>& e, const std::wstring& k, long long f) { try { return std::stoll(ReadMapValue(e, k, std::to_wstring(f))); } catch (...) { return f; } }
float ReadMapFloat(const std::vector<std::pair<std::wstring, std::wstring>>& e, const std::wstring& k, float f) { try { return std::stof(ReadMapValue(e, k, L"0")); } catch (...) { return f; } }

void DrawRounded(HDC hdc, const RECT& r, COLORREF fill, COLORREF border, int radius) { HPEN pen = CreatePen(PS_SOLID, 1, border); HBRUSH brush = CreateSolidBrush(fill); auto oldP = SelectObject(hdc, pen); auto oldB = SelectObject(hdc, brush); RoundRect(hdc, r.left, r.top, r.right, r.bottom, radius, radius); SelectObject(hdc, oldB); SelectObject(hdc, oldP); DeleteObject(brush); DeleteObject(pen); }

std::vector<std::wstring> RecentPrompts() {
    std::vector<std::wstring> items;
    for (auto it = g_conversation.rbegin(); it != g_conversation.rend(); ++it) if (it->fromUser && !Trim(it->text).empty()) items.push_back(Shorten(NormalizeWhitespace(it->text), 30));
    if (items.size() > 10) items.resize(10);
    return items;
}

void SaveSettings() {
    const std::wstring p = PathString(PurpleBee::SettingsPath());
    WritePrivateProfileStringW(L"chat", L"include_verified", g_settings.includeVerified ? L"1" : L"0", p.c_str());
    WritePrivateProfileStringW(L"chat", L"include_general", g_settings.includeGeneral ? L"1" : L"0", p.c_str());
    WritePrivateProfileStringW(L"chat", L"include_trend", g_settings.includeTrend ? L"1" : L"0", p.c_str());
    WritePrivateProfileStringW(L"chat", L"auto_learning", g_settings.autoLearning ? L"1" : L"0", p.c_str());
    WritePrivateProfileStringW(L"trainer", L"epochs", L"10", p.c_str());
    WritePrivateProfileStringW(L"trainer", L"interval_minutes", L"20", p.c_str());
}

void LoadSettings() {
    const std::wstring p = PathString(PurpleBee::SettingsPath());
    g_settings.includeVerified = GetPrivateProfileIntW(L"chat", L"include_verified", 1, p.c_str()) != 0;
    g_settings.includeGeneral = GetPrivateProfileIntW(L"chat", L"include_general", 1, p.c_str()) != 0;
    g_settings.includeTrend = GetPrivateProfileIntW(L"chat", L"include_trend", 0, p.c_str()) != 0;
    g_settings.autoLearning = GetPrivateProfileIntW(L"chat", L"auto_learning", 1, p.c_str()) != 0;
    SaveSettings();
}

void EnsureRuntimeFiles() {
    if (!std::filesystem::exists(PurpleBee::SeedCorpusPath())) SaveUtf8TextFile(PurpleBee::SeedCorpusPath(), DefaultKoreanCorpus());
    if (!std::filesystem::exists(PurpleBee::SourcesPath())) { KnowledgeBase kb; kb.EnsureDefaultSources(); std::wstring error; kb.SaveSources(PathString(PurpleBee::SourcesPath()), error); }
}

bool LoadTrainerStatus() {
    std::wstring content; if (!LoadUtf8TextFile(PurpleBee::TrainerStatusPath(), content)) return false;
    std::vector<std::pair<std::wstring, std::wstring>> entries; std::wstringstream ss(content); std::wstring line;
    while (std::getline(ss, line)) { line = Trim(line); if (line.empty() || line[0] == L'[') continue; size_t sep = line.find(L'='); if (sep != std::wstring::npos) entries.push_back({ line.substr(0, sep), line.substr(sep + 1) }); }
    TrainerStatus prev = g_trainer;
    g_trainer.running = ReadMapInt(entries, L"running", 0) != 0; g_trainer.autoLearning = ReadMapInt(entries, L"auto_learning", 1) != 0; g_trainer.lastSuccess = ReadMapInt(entries, L"last_success", 0) != 0; g_trainer.modelReady = ReadMapInt(entries, L"model_ready", 0) != 0;
    g_trainer.state = ReadMapValue(entries, L"state", L"대기 중"); g_trainer.message = ReadMapValue(entries, L"message", L"아직 실행 기록이 없습니다."); g_trainer.documents = ReadMapInt(entries, L"documents", 0); g_trainer.verified = ReadMapInt(entries, L"verified", 0); g_trainer.general = ReadMapInt(entries, L"general", 0); g_trainer.trend = ReadMapInt(entries, L"trend", 0); g_trainer.epochsCompleted = ReadMapInt(entries, L"epochs_completed", 0); g_trainer.vocabulary = ReadMapInt(entries, L"vocabulary", 0); g_trainer.corpusLength = ReadMapInt(entries, L"corpus_length", 0); g_trainer.loss = ReadMapFloat(entries, L"loss", 0.0f); g_trainer.heartbeat = ReadMapLongLong(entries, L"heartbeat", 0); g_trainer.lastCompletedEpoch = ReadMapLongLong(entries, L"last_completed_epoch", 0);
    return prev.state != g_trainer.state || prev.heartbeat != g_trainer.heartbeat || prev.documents != g_trainer.documents || prev.modelReady != g_trainer.modelReady;
}

bool ReloadRuntimeAssets(bool force) {
    bool changed = false;
    auto kt = SafeWriteTime(PurpleBee::KnowledgePath()); if (force || kt != g_lastKnowledgeWrite) { KnowledgeBase kb; std::wstring error; if (std::filesystem::exists(PurpleBee::SourcesPath())) kb.LoadSources(PathString(PurpleBee::SourcesPath()), error); else kb.EnsureDefaultSources(); if (std::filesystem::exists(PurpleBee::KnowledgePath())) kb.LoadDocuments(PathString(PurpleBee::KnowledgePath()), error); g_knowledge = std::move(kb); g_lastKnowledgeWrite = kt; changed = true; }
    auto mt = SafeWriteTime(PurpleBee::ModelPath()); if (force || mt != g_lastModelWrite) { if (std::filesystem::exists(PurpleBee::ModelPath())) { NeuralTextModel m; std::wstring error; if (m.Load(PathString(PurpleBee::ModelPath()), error)) g_model = std::move(m); } g_lastModelWrite = mt; changed = true; }
    return changed;
}

void LaunchTrainer() {
    if (!std::filesystem::exists(PurpleBee::TrainerExePath())) return;
    std::wstring cmd = L"\"" + PathString(PurpleBee::TrainerExePath()) + L"\" --daemon"; STARTUPINFOW si{}; si.cb = sizeof(si); PROCESS_INFORMATION pi{}; std::wstring wd = PathString(PurpleBee::ProjectRoot());
    if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, wd.c_str(), &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
}

ChatOptions CurrentOptions() { ChatOptions o; o.includeVerified = g_settings.includeVerified; o.includeGeneral = g_settings.includeGeneral; o.includeTrend = g_settings.includeTrend; o.creativity = 0.26f; return o; }
void AppendTurn(bool user, const std::wstring& text, const std::wstring& meta = L"") { g_conversation.push_back({ user, text, meta }); }
void ResetConversation() { g_conversation.clear(); }

void Layout() {
    RECT rc{}; GetClientRect(g_main, &rc); int w = rc.right - rc.left, h = rc.bottom - rc.top, side = 266; g_sidebarRect = { 0, 0, side, h }; g_mainRect = { side, 0, w, h }; g_topRect = { side + 28, 18, w - 28, 68 }; g_recentRect = { 18, 250, side - 18, h - 150 };
    int contentWidth = std::min(860, w - side - 120); int composeWidth = std::min(720, w - side - 120);
    if (IsHome()) { int cx = side + (w - side) / 2; g_chatRect = { side + 20, 80, w - 20, h - 20 }; g_composeRect = { cx - composeWidth / 2, h / 2 + 34, cx + composeWidth / 2, h / 2 + 92 }; }
    else { int cx = side + (w - side) / 2; g_chatRect = { cx - contentWidth / 2 - 20, 86, cx + contentWidth / 2 + 20, h - 124 }; g_composeRect = { cx - composeWidth / 2, h - 84, cx + composeWidth / 2, h - 28 }; }
    MoveWindow(g_chatView, g_chatRect.left, g_chatRect.top, g_chatRect.right - g_chatRect.left, g_chatRect.bottom - g_chatRect.top, TRUE);
    MoveWindow(g_input, g_composeRect.left + 46, g_composeRect.top + 10, g_composeRect.right - g_composeRect.left - 110, g_composeRect.bottom - g_composeRect.top - 20, TRUE);
    MoveWindow(g_send, g_composeRect.right - 48, g_composeRect.top + 8, 34, 34, TRUE);
    MoveWindow(g_newChat, 18, 74, side - 36, 40, TRUE); MoveWindow(g_refresh, 18, 122, side - 36, 40, TRUE); MoveWindow(g_trainerBtn, 18, 170, side - 36, 40, TRUE);
    MoveWindow(g_verified, 18, h - 114, 70, 30, TRUE); MoveWindow(g_general, 94, h - 114, 70, 30, TRUE); MoveWindow(g_trend, 170, h - 114, 70, 30, TRUE); MoveWindow(g_auto, 18, h - 74, 222, 32, TRUE);
}

std::vector<MessageLayout> MeasureMessages(HDC hdc, int width, int& totalHeight) {
    std::vector<MessageLayout> out; int columnWidth = std::max(420, std::min(860, width - 120)), left = (width - columnWidth) / 2, y = 18; out.reserve(g_conversation.size());
    for (const auto& turn : g_conversation) {
        RECT textRect = { 0, 0, turn.fromUser ? 540 : columnWidth - 40, 0 }; SelectObject(hdc, g_bodyFont); DrawTextW(hdc, turn.text.c_str(), -1, &textRect, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
        RECT metaRect = { 0, 0, columnWidth - 40, 0 }; int metaH = 0; if (!turn.meta.empty()) { SelectObject(hdc, g_smallFont); DrawTextW(hdc, turn.meta.c_str(), -1, &metaRect, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX); metaH = metaRect.bottom - metaRect.top; }
        MessageLayout m{}; m.user = turn.fromUser; m.boxed = turn.fromUser || !turn.meta.empty(); int bw = turn.fromUser ? std::min(columnWidth - 20, (textRect.right - textRect.left) + 34) : columnWidth - 12; int bh = turn.fromUser ? (textRect.bottom - textRect.top) + 24 : (textRect.bottom - textRect.top) + (metaH ? metaH + 12 : 0) + 18;
        int x = turn.fromUser ? left + columnWidth - bw : left; m.bubble = { x, y, x + bw, y + bh }; m.text = { x + (turn.fromUser ? 17 : 4), y + (turn.fromUser ? 12 : 8), x + bw - (turn.fromUser ? 17 : 6), y + (turn.fromUser ? 12 : 8) + (textRect.bottom - textRect.top) }; if (metaH) { m.hasMeta = true; m.meta = { x + 4, m.text.bottom + 8, x + bw - 4, m.text.bottom + 8 + metaH }; }
        out.push_back(m); y = m.bubble.bottom + 18;
    }
    totalHeight = y + 18; return out;
}

void UpdateScroll() {
    RECT rc{}; GetClientRect(g_chatView, &rc); HDC hdc = GetDC(g_chatView); int total = 0; MeasureMessages(hdc, rc.right - rc.left, total); ReleaseDC(g_chatView, hdc); g_chatContentHeight = std::max(total, rc.bottom - rc.top); g_chatScroll = std::clamp(g_chatScroll, 0, std::max(0, g_chatContentHeight - (rc.bottom - rc.top))); SCROLLINFO si{}; si.cbSize = sizeof(si); si.fMask = SIF_PAGE | SIF_RANGE | SIF_POS; si.nMin = 0; si.nMax = std::max(0, g_chatContentHeight - 1); si.nPage = std::max(0, rc.bottom - rc.top); si.nPos = g_chatScroll; SetScrollInfo(g_chatView, SB_VERT, &si, TRUE);
}

void ScrollBottom() { RECT rc{}; GetClientRect(g_chatView, &rc); g_chatScroll = std::max(0, g_chatContentHeight - (rc.bottom - rc.top)); SetScrollPos(g_chatView, SB_VERT, g_chatScroll, TRUE); }

void SubmitPrompt() {
    std::wstring prompt = Trim(GetText(g_input)); if (prompt.empty()) return;
    std::vector<ConversationTurn> history = g_conversation; AppendTurn(true, prompt); SetWindowTextW(g_input, L"");
    ReplyDraft draft = g_engine.Reply(prompt, history, g_knowledge, g_model, CurrentOptions()); AppendTurn(false, draft.text, draft.sourcesLine);
    Layout(); UpdateScroll(); ScrollBottom(); InvalidateRect(g_main, nullptr, TRUE);
}

LRESULT CALLBACK InputProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) { if (msg == WM_KEYDOWN && wp == VK_RETURN && (GetKeyState(VK_SHIFT) & 0x8000) == 0) { SubmitPrompt(); return 0; } return CallWindowProcW(g_inputProc, hwnd, msg, wp, lp); }

void PaintSidebar(HDC hdc) {
    FillRect(hdc, &g_sidebarRect, g_sidebarBrush); HPEN sep = CreatePen(PS_SOLID, 1, g_theme.sidebarBorder); auto oldP = SelectObject(hdc, sep); MoveToEx(hdc, g_sidebarRect.right - 1, 0, nullptr); LineTo(hdc, g_sidebarRect.right - 1, g_sidebarRect.bottom); SelectObject(hdc, oldP); DeleteObject(sep);
    RECT logo = { 18, 20, 54, 56 }; HBRUSH b = CreateSolidBrush(g_theme.accent); auto oldB = SelectObject(hdc, b); Ellipse(hdc, logo.left, logo.top, logo.right, logo.bottom); SelectObject(hdc, oldB); DeleteObject(b);
    SelectObject(hdc, g_smallFont); SetBkMode(hdc, TRANSPARENT); SetTextColor(hdc, g_theme.accentText); DrawTextW(hdc, L"PB", -1, &logo, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SetTextColor(hdc, g_theme.muted); RECT nav = { 18, 220, g_sidebarRect.right - 18, 248 }; DrawTextW(hdc, L"GPT", -1, &nav, DT_SINGLELINE | DT_NOPREFIX);
    RECT lab = { 18, 252, g_sidebarRect.right - 18, 280 }; SetTextColor(hdc, g_theme.text); DrawTextW(hdc, L"챗", -1, &lab, DT_SINGLELINE | DT_NOPREFIX);
    RECT recTitle = { 18, 292, g_sidebarRect.right - 18, 320 }; SetTextColor(hdc, g_theme.muted); DrawTextW(hdc, L"최근", -1, &recTitle, DT_SINGLELINE | DT_NOPREFIX);
    SetTextColor(hdc, g_theme.text); int y = 326; for (const auto& item : RecentPrompts()) { RECT rr = { 18, y, g_sidebarRect.right - 18, y + 24 }; DrawTextW(hdc, item.c_str(), -1, &rr, DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX); y += 28; if (y > g_sidebarRect.bottom - 160) break; }
    RECT footer = { 18, g_sidebarRect.bottom - 36, g_sidebarRect.right - 18, g_sidebarRect.bottom - 16 }; SetTextColor(hdc, g_theme.muted); DrawTextW(hdc, L"로컬 학습 + 웹 자료 기반", -1, &footer, DT_SINGLELINE | DT_NOPREFIX);
}

void PaintTopbar(HDC hdc) {
    RECT model = { g_topRect.left, g_topRect.top + 2, g_topRect.left + 104, g_topRect.bottom - 2 }; DrawRounded(hdc, model, RGB(255,255,255), g_theme.softBorder, 18);
    RECT action = { g_topRect.right - 160, g_topRect.top + 2, g_topRect.right, g_topRect.bottom - 2 }; DrawRounded(hdc, action, RGB(248, 247, 255), RGB(235, 229, 250), 18);
    SetBkMode(hdc, TRANSPARENT); SelectObject(hdc, g_bodyFont); SetTextColor(hdc, g_theme.text); DrawTextW(hdc, L"ChatGPT", -1, &model, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SetTextColor(hdc, RGB(110, 88, 216)); std::wstring status = g_settings.autoLearning ? L"+ 자동 학습" : L"+ 학습 꺼짐"; DrawTextW(hdc, status.c_str(), -1, &action, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void PaintHome(HDC hdc) {
    RECT title = { g_mainRect.left + 60, g_mainRect.top + 150, g_mainRect.right - 60, g_mainRect.top + 280 }; SelectObject(hdc, g_homeFont); SetTextColor(hdc, g_theme.text); DrawTextW(hdc, L"무슨 작업을 하고 계세요?", -1, &title, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    RECT hint = { g_mainRect.left + 60, title.bottom - 6, g_mainRect.right - 60, title.bottom + 26 }; SelectObject(hdc, g_smallFont); SetTextColor(hdc, g_theme.muted); DrawTextW(hdc, L"웹 자료를 읽고, 문맥을 이어서 답하도록 계속 학습하는 로컬 챗입니다.", -1, &hint, DT_CENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void PaintComposeShell(HDC hdc) {
    DrawRounded(hdc, g_composeRect, g_theme.input, g_theme.softBorder, 28); SetBkMode(hdc, TRANSPARENT); SelectObject(hdc, g_bodyFont); SetTextColor(hdc, g_theme.muted);
    RECT plus = { g_composeRect.left + 14, g_composeRect.top + 10, g_composeRect.left + 36, g_composeRect.bottom - 10 }; DrawTextW(hdc, L"+", -1, &plus, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void DrawButton(const DRAWITEMSTRUCT* di) {
    HDC hdc = di->hDC; RECT r = di->rcItem; bool down = (di->itemState & ODS_SELECTED) != 0; UINT id = di->CtlID; SetBkMode(hdc, TRANSPARENT); SelectObject(hdc, g_bodyFont);
    if (id == ID_SEND_BUTTON) { HBRUSH b = CreateSolidBrush(Blend(g_theme.accent, RGB(40,40,40), down ? 4 : 5, 1)); auto oldB = SelectObject(hdc, b); HPEN p = CreatePen(PS_SOLID, 1, g_theme.accent); auto oldP = SelectObject(hdc, p); Ellipse(hdc, r.left, r.top, r.right, r.bottom); SelectObject(hdc, oldB); SelectObject(hdc, oldP); DeleteObject(b); DeleteObject(p); SetTextColor(hdc, g_theme.accentText); DrawTextW(hdc, L">", -1, &r, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX); return; }
    bool toggle = id == ID_VERIFIED_BUTTON || id == ID_GENERAL_BUTTON || id == ID_TREND_BUTTON || id == ID_AUTO_BUTTON; bool on = false; if (id == ID_VERIFIED_BUTTON) on = g_settings.includeVerified; if (id == ID_GENERAL_BUTTON) on = g_settings.includeGeneral; if (id == ID_TREND_BUTTON) on = g_settings.includeTrend; if (id == ID_AUTO_BUTTON) on = g_settings.autoLearning;
    COLORREF fill = on ? RGB(236, 240, 255) : g_theme.soft, border = on ? RGB(198, 208, 255) : g_theme.softBorder, text = on ? RGB(41, 76, 180) : g_theme.text; if (!toggle) { fill = down ? Blend(g_theme.soft, RGB(220,220,224), 5, 1) : g_theme.soft; border = g_theme.softBorder; text = g_theme.text; }
    DrawRounded(hdc, r, fill, border, 18); SetTextColor(hdc, text); std::wstring label = GetText(di->hwndItem); DrawTextW(hdc, label.c_str(), -1, &r, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void PaintFrame(HDC hdc, const RECT& client) { FillRect(hdc, &client, g_windowBrush); PaintSidebar(hdc); PaintTopbar(hdc); PaintComposeShell(hdc); if (IsHome()) PaintHome(hdc); }

void DrawChatView(HWND hwnd, HDC target) {
    RECT rc{}; GetClientRect(hwnd, &rc); HDC mem = CreateCompatibleDC(target); HBITMAP bmp = CreateCompatibleBitmap(target, rc.right - rc.left, rc.bottom - rc.top); auto old = SelectObject(mem, bmp); HBRUSH white = CreateSolidBrush(g_theme.window); FillRect(mem, &rc, white); DeleteObject(white); SetBkMode(mem, TRANSPARENT);
    if (!IsHome()) {
        int total = 0; auto boxes = MeasureMessages(mem, rc.right - rc.left, total);
        for (size_t i = 0; i < boxes.size(); ++i) {
            RECT bubble = boxes[i].bubble, text = boxes[i].text, meta = boxes[i].meta; OffsetRect(&bubble, 0, -g_chatScroll); OffsetRect(&text, 0, -g_chatScroll); OffsetRect(&meta, 0, -g_chatScroll); if (bubble.bottom < 0 || bubble.top > rc.bottom) continue;
            if (boxes[i].user) { DrawRounded(mem, bubble, g_theme.userBubble, g_theme.softBorder, 18); SetTextColor(mem, g_theme.text); SelectObject(mem, g_bodyFont); DrawTextW(mem, g_conversation[i].text.c_str(), -1, &text, DT_WORDBREAK | DT_NOPREFIX); }
            else { DrawRounded(mem, bubble, g_theme.assistantCard, Blend(g_theme.softBorder, RGB(255,255,255), 2, 1), 18); SelectObject(mem, g_smallFont); SetTextColor(mem, g_theme.muted); RECT name = { bubble.left + 4, bubble.top - 18, bubble.right, bubble.top }; DrawTextW(mem, L"퍼플비", -1, &name, DT_SINGLELINE | DT_NOPREFIX); SelectObject(mem, g_bodyFont); SetTextColor(mem, g_theme.text); DrawTextW(mem, g_conversation[i].text.c_str(), -1, &text, DT_WORDBREAK | DT_NOPREFIX); if (boxes[i].hasMeta) { SelectObject(mem, g_smallFont); SetTextColor(mem, g_theme.muted); DrawTextW(mem, g_conversation[i].meta.c_str(), -1, &meta, DT_WORDBREAK | DT_NOPREFIX); } }
        }
    }
    BitBlt(target, 0, 0, rc.right - rc.left, rc.bottom - rc.top, mem, 0, 0, SRCCOPY); SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem);
}

LRESULT CALLBACK ChatViewProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_ERASEBKGND: return 1;
    case WM_SIZE: UpdateScroll(); return 0;
    case WM_MOUSEWHEEL: g_chatScroll = std::clamp(g_chatScroll - static_cast<short>(HIWORD(wp)) / 3, 0, std::max(0, g_chatContentHeight - (int)HIWORD(GetClientRect))); InvalidateRect(hwnd, nullptr, TRUE); return 0;
    case WM_VSCROLL: { SCROLLINFO si{}; si.cbSize = sizeof(si); si.fMask = SIF_ALL; GetScrollInfo(hwnd, SB_VERT, &si); int next = g_chatScroll; switch (LOWORD(wp)) { case SB_LINEUP: next -= 36; break; case SB_LINEDOWN: next += 36; break; case SB_PAGEUP: next -= (int)si.nPage; break; case SB_PAGEDOWN: next += (int)si.nPage; break; case SB_THUMBTRACK: case SB_THUMBPOSITION: next = si.nTrackPos; break; } g_chatScroll = std::clamp(next, 0, std::max(0, g_chatContentHeight - (int)si.nPage)); SetScrollPos(hwnd, SB_VERT, g_chatScroll, TRUE); InvalidateRect(hwnd, nullptr, TRUE); return 0; }
    case WM_PAINT: { PAINTSTRUCT ps{}; HDC hdc = BeginPaint(hwnd, &ps); DrawChatView(hwnd, hdc); EndPaint(hwnd, &ps); return 0; }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

LRESULT CALLBACK MainProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        g_main = hwnd;
        g_chatView = CreateWindowExW(0, kChatViewClassName, L"", WS_CHILD | WS_VISIBLE | WS_VSCROLL, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_CHAT_VIEW, g_instance, nullptr);
        g_input = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_INPUT_EDIT, g_instance, nullptr);
        g_send = CreateWindowW(L"BUTTON", L"", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_SEND_BUTTON, g_instance, nullptr);
        g_newChat = CreateWindowW(L"BUTTON", L"새 채팅", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_NEW_CHAT_BUTTON, g_instance, nullptr);
        g_refresh = CreateWindowW(L"BUTTON", L"웹 새로고침", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_REFRESH_BUTTON, g_instance, nullptr);
        g_trainerBtn = CreateWindowW(L"BUTTON", L"학습기 실행", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_TRAINER_BUTTON, g_instance, nullptr);
        g_verified = CreateWindowW(L"BUTTON", L"검증", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_VERIFIED_BUTTON, g_instance, nullptr);
        g_general = CreateWindowW(L"BUTTON", L"일반", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_GENERAL_BUTTON, g_instance, nullptr);
        g_trend = CreateWindowW(L"BUTTON", L"유행", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_TREND_BUTTON, g_instance, nullptr);
        g_auto = CreateWindowW(L"BUTTON", L"자동 학습", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, hwnd, (HMENU)(INT_PTR)ID_AUTO_BUTTON, g_instance, nullptr);
        std::array<HWND, 9> controls{ g_input, g_send, g_newChat, g_refresh, g_trainerBtn, g_verified, g_general, g_trend, g_auto }; for (HWND c : controls) SendMessageW(c, WM_SETFONT, (WPARAM)g_uiFont, TRUE);
        SendMessageW(g_input, WM_SETFONT, (WPARAM)g_bodyFont, TRUE); SendMessageW(g_input, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(6, 6)); SendMessageW(g_input, kCueBannerMessage, FALSE, (LPARAM)L"무엇이든 물어보세요");
        g_inputProc = (WNDPROC)SetWindowLongPtrW(g_input, GWLP_WNDPROC, (LONG_PTR)InputProc);
        EnsureRuntimeFiles(); LoadSettings(); ReloadRuntimeAssets(true); LoadTrainerStatus(); Layout(); UpdateScroll(); if (g_settings.autoLearning) LaunchTrainer(); SetTimer(hwnd, ID_POLL_TIMER, 3000, nullptr); return 0;
    }
    case WM_SIZE: Layout(); UpdateScroll(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
    case WM_TIMER: if (wp == ID_POLL_TIMER) { bool changed = LoadTrainerStatus() | ReloadRuntimeAssets(false); if (changed) InvalidateRect(hwnd, nullptr, TRUE); } return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_SEND_BUTTON: SubmitPrompt(); return 0;
        case ID_NEW_CHAT_BUTTON: ResetConversation(); Layout(); UpdateScroll(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
        case ID_REFRESH_BUTTON: ReloadRuntimeAssets(true); LoadTrainerStatus(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
        case ID_TRAINER_BUTTON: LaunchTrainer(); return 0;
        case ID_VERIFIED_BUTTON: g_settings.includeVerified = !g_settings.includeVerified; SaveSettings(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
        case ID_GENERAL_BUTTON: g_settings.includeGeneral = !g_settings.includeGeneral; SaveSettings(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
        case ID_TREND_BUTTON: g_settings.includeTrend = !g_settings.includeTrend; SaveSettings(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
        case ID_AUTO_BUTTON: g_settings.autoLearning = !g_settings.autoLearning; SaveSettings(); if (g_settings.autoLearning) LaunchTrainer(); InvalidateRect(hwnd, nullptr, TRUE); return 0;
        } break;
    case WM_CTLCOLOREDIT: { HDC hdc = (HDC)wp; SetBkColor(hdc, g_theme.input); SetTextColor(hdc, g_theme.text); return (INT_PTR)g_inputBrush; }
    case WM_CTLCOLORSTATIC: { HDC hdc = (HDC)wp; SetBkMode(hdc, TRANSPARENT); SetTextColor(hdc, g_theme.text); return (INT_PTR)GetStockObject(NULL_BRUSH); }
    case WM_DRAWITEM: DrawButton((const DRAWITEMSTRUCT*)lp); return TRUE;
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: {
        PAINTSTRUCT ps{}; HDC hdc = BeginPaint(hwnd, &ps); RECT rc{}; GetClientRect(hwnd, &rc); HDC mem = CreateCompatibleDC(hdc); HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right - rc.left, rc.bottom - rc.top); auto old = SelectObject(mem, bmp); PaintFrame(mem, rc); BitBlt(hdc, 0, 0, rc.right - rc.left, rc.bottom - rc.top, mem, 0, 0, SRCCOPY); SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); EndPaint(hwnd, &ps); return 0;
    }
    case WM_DESTROY: SaveSettings(); KillTimer(hwnd, ID_POLL_TIMER); PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void CreateFonts() {
    g_titleFont = CreateFontW(-26, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Malgun Gothic");
    g_homeFont = CreateFontW(-36, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Malgun Gothic");
    g_bodyFont = CreateFontW(-17, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Malgun Gothic");
    g_smallFont = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Malgun Gothic");
    g_uiFont = CreateFontW(-15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Malgun Gothic");
}

void DestroyUi() {
    DeleteObject(g_titleFont); DeleteObject(g_homeFont); DeleteObject(g_bodyFont); DeleteObject(g_smallFont); DeleteObject(g_uiFont);
    DeleteObject(g_windowBrush); DeleteObject(g_sidebarBrush); DeleteObject(g_inputBrush);
}

} // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    g_instance = instance; CreateFonts(); g_windowBrush = CreateSolidBrush(g_theme.window); g_sidebarBrush = CreateSolidBrush(g_theme.sidebar); g_inputBrush = CreateSolidBrush(g_theme.input);
    WNDCLASSW chat{}; chat.lpfnWndProc = ChatViewProc; chat.hInstance = instance; chat.lpszClassName = kChatViewClassName; chat.hCursor = LoadCursorW(nullptr, IDC_ARROW); RegisterClassW(&chat);
    WNDCLASSW wc{}; wc.lpfnWndProc = MainProc; wc.hInstance = instance; wc.lpszClassName = kMainClassName; wc.hCursor = LoadCursorW(nullptr, IDC_ARROW); wc.hbrBackground = g_windowBrush; RegisterClassW(&wc);
    HWND hwnd = CreateWindowExW(0, kMainClassName, kWindowTitle, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT, 1440, 900, nullptr, nullptr, instance, nullptr);
    if (!hwnd) { DestroyUi(); return 1; }
    ShowWindow(hwnd, show); UpdateWindow(hwnd); MSG msg{}; while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); } DestroyUi(); return (int)msg.wParam;
}
