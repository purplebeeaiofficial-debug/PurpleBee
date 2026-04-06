#include "KnowledgeBase.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string_view>
#include <tuple>
#include <unordered_set>

#pragma comment(lib, "winhttp.lib")

namespace {

constexpr uint32_t kKnowledgeMagic = 0x314B4250;

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

std::wstring Lower(std::wstring text) {
    std::transform(text.begin(), text.end(), text.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); });
    return text;
}

std::wstring NormalizeWhitespace(const std::wstring& text) {
    std::wstring output;
    output.reserve(text.size());

    bool lastWasSpace = false;
    for (wchar_t ch : text) {
        if (iswspace(ch)) {
            if (!lastWasSpace) {
                output.push_back(L' ');
                lastWasSpace = true;
            }
            continue;
        }

        output.push_back(ch);
        lastWasSpace = false;
    }

    return Trim(output);
}

bool ContainsInsensitive(const std::wstring& text, const std::wstring& token) {
    return Lower(text).find(Lower(token)) != std::wstring::npos;
}

std::string WideToUtf8(const std::wstring& text) {
    if (text.empty()) {
        return {};
    }

    const int size = WideCharToMultiByte(
        CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);

    std::string utf8(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), utf8.data(), size, nullptr, nullptr);
    return utf8;
}

std::wstring BytesToWide(const std::string& bytes) {
    if (bytes.empty()) {
        return {};
    }

    std::string lowered = bytes;
    std::transform(lowered.begin(), lowered.end(), lowered.begin(),
        [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });

    UINT codePage = CP_UTF8;
    if (lowered.find("charset=euc-kr") != std::string::npos ||
        lowered.find("charset=cp949") != std::string::npos ||
        lowered.find("charset=ks_c_5601-1987") != std::string::npos) {
        codePage = 949;
    }

    if (bytes.size() >= 3 &&
        static_cast<unsigned char>(bytes[0]) == 0xEF &&
        static_cast<unsigned char>(bytes[1]) == 0xBB &&
        static_cast<unsigned char>(bytes[2]) == 0xBF) {
        codePage = CP_UTF8;
    }

    int size = MultiByteToWideChar(codePage, 0, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
    if (size <= 0 && codePage != CP_UTF8) {
        codePage = CP_UTF8;
        size = MultiByteToWideChar(codePage, 0, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
    }

    if (size <= 0) {
        return L"";
    }

    std::wstring wide(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(codePage, 0, bytes.data(), static_cast<int>(bytes.size()), wide.data(), size);
    return wide;
}

std::wstring ReadWideString(std::ifstream& stream, bool& ok) {
    ok = false;
    uint32_t size = 0;
    if (!ReadValue(stream, size)) {
        return L"";
    }
    std::string utf8(size, '\0');
    if (size > 0) {
        stream.read(utf8.data(), static_cast<std::streamsize>(size));
        if (!stream) {
            return L"";
        }
    }
    ok = true;
    return BytesToWide(utf8);
}

bool WriteWideString(std::ofstream& stream, const std::wstring& value) {
    const std::string utf8 = WideToUtf8(value);
    const uint32_t size = static_cast<uint32_t>(utf8.size());
    if (!WriteValue(stream, size)) {
        return false;
    }
    if (size > 0) {
        stream.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
    }
    return static_cast<bool>(stream);
}

bool CrackUrlParts(
    const std::wstring& url,
    std::wstring& scheme,
    std::wstring& host,
    INTERNET_PORT& port,
    std::wstring& path) {

    URL_COMPONENTS components = {};
    components.dwStructSize = sizeof(components);
    components.dwSchemeLength = static_cast<DWORD>(-1);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);

    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &components)) {
        return false;
    }

    if (components.nScheme == INTERNET_SCHEME_HTTPS) {
        scheme = L"https";
    } else if (components.nScheme == INTERNET_SCHEME_HTTP) {
        scheme = L"http";
    } else {
        return false;
    }

    host.assign(components.lpszHostName, components.dwHostNameLength);
    port = components.nPort;
    path.assign(components.lpszUrlPath, components.dwUrlPathLength);
    if (components.dwExtraInfoLength > 0) {
        path += std::wstring(components.lpszExtraInfo, components.dwExtraInfoLength);
    }
    if (path.empty()) {
        path = L"/";
    }

    return true;
}

std::wstring StripFragment(std::wstring url) {
    const size_t hash = url.find(L'#');
    if (hash != std::wstring::npos) {
        url.erase(hash);
    }
    return url;
}

std::wstring NormalizeUrl(std::wstring url) {
    url = Trim(StripFragment(std::move(url)));
    while (url.size() > 1 && url.back() == L'/') {
        url.pop_back();
    }
    return url;
}

std::wstring ResolveUrl(const std::wstring& baseUrl, std::wstring href) {
    href = Trim(href);
    if (href.empty()) {
        return L"";
    }

    href = StripFragment(href);
    if (href.empty() ||
        href.rfind(L"javascript:", 0) == 0 ||
        href.rfind(L"mailto:", 0) == 0 ||
        href.rfind(L"tel:", 0) == 0) {
        return L"";
    }

    std::wstring scheme;
    std::wstring host;
    INTERNET_PORT port = 0;
    std::wstring path;
    if (!CrackUrlParts(baseUrl, scheme, host, port, path)) {
        return L"";
    }

    if (href.rfind(L"http://", 0) == 0 || href.rfind(L"https://", 0) == 0) {
        return NormalizeUrl(href);
    }

    if (href.rfind(L"//", 0) == 0) {
        return NormalizeUrl(scheme + L":" + href);
    }

    const std::wstring origin = scheme + L"://" + host;
    if (href.front() == L'/') {
        return NormalizeUrl(origin + href);
    }

    std::wstring directory = path;
    const size_t query = directory.find(L'?');
    if (query != std::wstring::npos) {
        directory.erase(query);
    }

    const size_t slash = directory.find_last_of(L'/');
    if (slash == std::wstring::npos) {
        directory = L"/";
    } else {
        directory = directory.substr(0, slash + 1);
    }

    return NormalizeUrl(origin + directory + href);
}

bool HasBlockedExtension(const std::wstring& loweredUrl) {
    static const std::vector<std::wstring> kBlockedExtensions = {
        L".jpg", L".jpeg", L".png", L".gif", L".webp", L".svg",
        L".css", L".js", L".ico", L".json", L".xml", L".zip",
        L".rar", L".pdf", L".mp4", L".mp3", L".avi", L".mov"
    };

    for (const auto& extension : kBlockedExtensions) {
        if (loweredUrl.size() >= extension.size() &&
            loweredUrl.rfind(extension) == loweredUrl.size() - extension.size()) {
            return true;
        }
    }

    return false;
}

bool IsLikelyDocumentUrl(const std::wstring& candidateUrl, const std::wstring& sourceUrl) {
    std::wstring candidateScheme;
    std::wstring candidateHost;
    INTERNET_PORT candidatePort = 0;
    std::wstring candidatePath;

    std::wstring sourceScheme;
    std::wstring sourceHost;
    INTERNET_PORT sourcePort = 0;
    std::wstring sourcePath;

    if (!CrackUrlParts(candidateUrl, candidateScheme, candidateHost, candidatePort, candidatePath) ||
        !CrackUrlParts(sourceUrl, sourceScheme, sourceHost, sourcePort, sourcePath)) {
        return false;
    }

    if (Lower(candidateHost) != Lower(sourceHost)) {
        return false;
    }

    const std::wstring lowered = Lower(candidateUrl);
    if (HasBlockedExtension(lowered)) {
        return false;
    }

    if (lowered.find(L"/tag/") != std::wstring::npos ||
        lowered.find(L"/tags/") != std::wstring::npos ||
        lowered.find(L"/search") != std::wstring::npos ||
        lowered.find(L"/login") != std::wstring::npos ||
        lowered.find(L"/signup") != std::wstring::npos ||
        lowered.find(L"/privacy") != std::wstring::npos ||
        lowered.find(L"/terms") != std::wstring::npos) {
        return false;
    }

    return candidatePath != L"/" && candidatePath.size() >= 4;
}

std::vector<std::wstring> ExtractLinksFromHtml(
    const std::wstring& html,
    const std::wstring& baseUrl,
    size_t maxLinks) {

    std::vector<std::wstring> links;
    std::set<std::wstring> seen;
    const std::wstring lowered = Lower(html);

    size_t searchFrom = 0;
    while (searchFrom < lowered.size() && links.size() < maxLinks) {
        const size_t anchor = lowered.find(L"<a", searchFrom);
        if (anchor == std::wstring::npos) {
            break;
        }

        const size_t href = lowered.find(L"href", anchor);
        const size_t tagEnd = lowered.find(L'>', anchor);
        if (href == std::wstring::npos || tagEnd == std::wstring::npos || href > tagEnd) {
            searchFrom = anchor + 2;
            continue;
        }

        size_t equals = lowered.find(L'=', href);
        if (equals == std::wstring::npos || equals > tagEnd) {
            searchFrom = tagEnd + 1;
            continue;
        }

        size_t begin = equals + 1;
        while (begin < tagEnd && iswspace(lowered[begin])) {
            ++begin;
        }

        if (begin >= tagEnd) {
            searchFrom = tagEnd + 1;
            continue;
        }

        wchar_t quote = lowered[begin];
        size_t end = std::wstring::npos;
        if (quote == L'\'' || quote == L'"') {
            ++begin;
            end = lowered.find(quote, begin);
        } else {
            end = lowered.find_first_of(L" >\t\r\n", begin);
        }

        if (end == std::wstring::npos) {
            searchFrom = tagEnd + 1;
            continue;
        }

        const std::wstring hrefValue = html.substr(begin, end - begin);
        const std::wstring resolved = ResolveUrl(baseUrl, hrefValue);
        if (!resolved.empty() && IsLikelyDocumentUrl(resolved, baseUrl)) {
            const std::wstring loweredResolved = Lower(resolved);
            if (seen.insert(loweredResolved).second) {
                links.push_back(resolved);
            }
        }

        searchFrom = tagEnd + 1;
    }

    return links;
}

} // namespace

KnowledgeBase::KnowledgeBase() = default;

void KnowledgeBase::EnsureDefaultSources() {
    if (!sources_.empty()) {
        return;
    }

    sources_ = {
        { true, SourceCategory::Verified, L"OpenAI", L"https://openai.com/news/" },
        { true, SourceCategory::Verified, L"Anthropic", L"https://www.anthropic.com/news" },
        { true, SourceCategory::Verified, L"Google DeepMind", L"https://deepmind.google/discover/blog/" },
        { true, SourceCategory::Verified, L"Microsoft AI", L"https://blogs.microsoft.com/ai/" },
        { true, SourceCategory::Verified, L"Hugging Face Blog", L"https://huggingface.co/blog" },
        { true, SourceCategory::Verified, L"Wikipedia AI", L"https://en.wikipedia.org/wiki/Artificial_intelligence" },
        { true, SourceCategory::Verified, L"arXiv cs.AI", L"https://arxiv.org/list/cs.AI/recent" },
        { true, SourceCategory::General, L"Naver D2", L"https://d2.naver.com/home" },
        { true, SourceCategory::General, L"Hacker News", L"https://news.ycombinator.com/" },
        { true, SourceCategory::General, L"MIT News AI", L"https://news.mit.edu/topic/artificial-intelligence2" },
        { true, SourceCategory::Trend, L"Product Hunt AI", L"https://www.producthunt.com/topics/artificial-intelligence" },
        { true, SourceCategory::Trend, L"Reddit ML", L"https://www.reddit.com/r/MachineLearning/" }
    };
}

void KnowledgeBase::SetSourcesFromText(const std::wstring& text) {
    sources_.clear();

    std::wstringstream stream(text);
    std::wstring line;
    while (std::getline(stream, line)) {
        line = Trim(line);
        if (line.empty()) {
            continue;
        }

        WebSource source;
        source.enabled = true;

        const size_t separator = line.find(L'|');
        if (separator == std::wstring::npos) {
            source.url = Trim(line);
            source.title = source.url;
        } else {
            source.title = Trim(line.substr(0, separator));
            source.url = Trim(line.substr(separator + 1));
            if (source.title.empty()) {
                source.title = source.url;
            }
        }

        if (source.url.empty()) {
            continue;
        }

        source.category = ClassifyUrl(source.url);
        sources_.push_back(source);
    }

    if (sources_.empty()) {
        EnsureDefaultSources();
    }
}

std::wstring KnowledgeBase::SourcesToText() const {
    std::wstring output;
    for (size_t i = 0; i < sources_.size(); ++i) {
        if (!output.empty()) {
            output += L"\r\n";
        }
        output += sources_[i].title + L" | " + sources_[i].url;
    }
    return output;
}

bool KnowledgeBase::SaveSources(const std::wstring& path, std::wstring& error) const {
    const auto parent = std::filesystem::path(path).parent_path();
    if (!parent.empty()) {
        std::filesystem::create_directories(parent);
    }

    std::ofstream file(std::filesystem::path(path), std::ios::binary);
    if (!file) {
        error = L"소스 목록 파일을 저장할 수 없습니다.";
        return false;
    }

    const unsigned char bom[] = { 0xEF, 0xBB, 0xBF };
    file.write(reinterpret_cast<const char*>(bom), sizeof(bom));
    const std::string utf8 = WideToUtf8(SourcesToText());
    file.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
    return static_cast<bool>(file);
}

bool KnowledgeBase::LoadSources(const std::wstring& path, std::wstring& error) {
    std::ifstream file(std::filesystem::path(path), std::ios::binary);
    if (!file) {
        EnsureDefaultSources();
        error = L"저장된 소스 목록이 없어 기본 소스를 사용합니다.";
        return false;
    }

    std::string bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (bytes.size() >= 3 &&
        static_cast<unsigned char>(bytes[0]) == 0xEF &&
        static_cast<unsigned char>(bytes[1]) == 0xBB &&
        static_cast<unsigned char>(bytes[2]) == 0xBF) {
        bytes.erase(0, 3);
    }

    SetSourcesFromText(BytesToWide(bytes));
    return true;
}

bool KnowledgeBase::SaveDocuments(const std::wstring& path, std::wstring& error) const {
    const auto parent = std::filesystem::path(path).parent_path();
    if (!parent.empty()) {
        std::filesystem::create_directories(parent);
    }

    std::ofstream file(std::filesystem::path(path), std::ios::binary);
    if (!file) {
        error = L"지식 캐시 파일을 저장할 수 없습니다.";
        return false;
    }

    if (!WriteValue(file, kKnowledgeMagic)) {
        error = L"지식 캐시 헤더를 저장할 수 없습니다.";
        return false;
    }

    const uint32_t count = static_cast<uint32_t>(documents_.size());
    if (!WriteValue(file, count)) {
        error = L"지식 캐시 개수를 저장할 수 없습니다.";
        return false;
    }

    for (const auto& document : documents_) {
        const uint32_t category = static_cast<uint32_t>(document.category);
        if (!WriteValue(file, category) ||
            !WriteWideString(file, document.title) ||
            !WriteWideString(file, document.url) ||
            !WriteWideString(file, document.text)) {
            error = L"지식 캐시 본문을 저장하는 중 오류가 발생했습니다.";
            return false;
        }
    }

    return true;
}

bool KnowledgeBase::LoadDocuments(const std::wstring& path, std::wstring& error) {
    std::ifstream file(std::filesystem::path(path), std::ios::binary);
    if (!file) {
        error = L"저장된 지식 캐시가 없습니다.";
        return false;
    }

    uint32_t magic = 0;
    uint32_t count = 0;
    if (!ReadValue(file, magic) || magic != kKnowledgeMagic || !ReadValue(file, count)) {
        error = L"지식 캐시 형식이 올바르지 않습니다.";
        return false;
    }

    documents_.clear();
    documents_.reserve(count);

    for (uint32_t i = 0; i < count; ++i) {
        uint32_t categoryValue = 0;
        if (!ReadValue(file, categoryValue)) {
            error = L"지식 캐시 문서를 읽는 중 오류가 발생했습니다.";
            documents_.clear();
            return false;
        }

        bool ok = false;
        KnowledgeDocument document;
        document.category = static_cast<SourceCategory>(categoryValue);
        document.title = ReadWideString(file, ok);
        if (!ok) {
            error = L"지식 캐시 제목을 읽는 중 오류가 발생했습니다.";
            documents_.clear();
            return false;
        }
        document.url = ReadWideString(file, ok);
        if (!ok) {
            error = L"지식 캐시 주소를 읽는 중 오류가 발생했습니다.";
            documents_.clear();
            return false;
        }
        document.text = ReadWideString(file, ok);
        if (!ok) {
            error = L"지식 캐시 본문을 읽는 중 오류가 발생했습니다.";
            documents_.clear();
            return false;
        }

        documents_.push_back(std::move(document));
    }

    return true;
}

bool KnowledgeBase::FetchUrl(const std::wstring& url, std::wstring& html, std::wstring& error) const {
    URL_COMPONENTS components = {};
    components.dwStructSize = sizeof(components);
    components.dwSchemeLength = static_cast<DWORD>(-1);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);

    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &components)) {
        error = L"URL을 해석할 수 없습니다.";
        return false;
    }

    std::wstring host(components.lpszHostName, components.dwHostNameLength);
    std::wstring path(components.lpszUrlPath, components.dwUrlPathLength);
    if (components.dwExtraInfoLength > 0) {
        path += std::wstring(components.lpszExtraInfo, components.dwExtraInfoLength);
    }
    if (path.empty()) {
        path = L"/";
    }

    const bool secure = components.nScheme == INTERNET_SCHEME_HTTPS;

    HINTERNET session = WinHttpOpen(
        L"PurpleBeeNaturalAI/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (!session) {
        error = L"WinHTTP 세션을 열 수 없습니다.";
        return false;
    }

    HINTERNET connection = WinHttpConnect(session, host.c_str(), components.nPort, 0);
    if (!connection) {
        WinHttpCloseHandle(session);
        error = L"서버에 연결할 수 없습니다.";
        return false;
    }

    HINTERNET request = WinHttpOpenRequest(
        connection,
        L"GET",
        path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        secure ? WINHTTP_FLAG_SECURE : 0);

    if (!request) {
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        error = L"요청 객체를 만들 수 없습니다.";
        return false;
    }

    DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));
    WinHttpSetTimeouts(request, 5000, 5000, 10000, 10000);

    const wchar_t* headers =
        L"User-Agent: PurpleBeeNaturalAI/1.0\r\n"
        L"Accept: text/html,application/xhtml+xml\r\n";

    bool ok = WinHttpSendRequest(
        request,
        headers,
        static_cast<DWORD>(-1),
        WINHTTP_NO_REQUEST_DATA,
        0,
        0,
        0) &&
        WinHttpReceiveResponse(request, nullptr);

    if (!ok) {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        error = L"웹 페이지를 가져오지 못했습니다.";
        return false;
    }

    DWORD statusCode = 0;
    DWORD statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(
        request,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &statusCode,
        &statusSize,
        WINHTTP_NO_HEADER_INDEX);

    if (statusCode < 200 || statusCode >= 300) {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        error = L"웹 페이지가 정상 상태 코드를 반환하지 않았습니다.";
        return false;
    }

    std::string bytes;
    while (true) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available)) {
            error = L"웹 응답 크기를 읽는 중 오류가 발생했습니다.";
            ok = false;
            break;
        }
        if (available == 0) {
            break;
        }

        std::string buffer(available, '\0');
        DWORD downloaded = 0;
        if (!WinHttpReadData(request, buffer.data(), available, &downloaded)) {
            error = L"웹 응답 본문을 읽는 중 오류가 발생했습니다.";
            ok = false;
            break;
        }

        buffer.resize(downloaded);
        bytes += buffer;
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);

    if (!ok || bytes.empty()) {
        if (error.empty()) {
            error = L"웹 페이지 본문이 비어 있습니다.";
        }
        return false;
    }

    html = BytesToWide(bytes);
    return true;
}

std::wstring KnowledgeBase::DecodeHtmlEntities(const std::wstring& text) const {
    std::wstring output = text;

    const std::vector<std::pair<std::wstring, std::wstring>> replacements = {
        { L"&nbsp;", L" " },
        { L"&amp;", L"&" },
        { L"&lt;", L"<" },
        { L"&gt;", L">" },
        { L"&quot;", L"\"" },
        { L"&#39;", L"'" },
        { L"&apos;", L"'" }
    };

    for (const auto& [from, to] : replacements) {
        size_t position = 0;
        while ((position = output.find(from, position)) != std::wstring::npos) {
            output.replace(position, from.size(), to);
            position += to.size();
        }
    }

    return output;
}

std::wstring KnowledgeBase::StripHtml(const std::wstring& html) const {
    std::wstring lowered = Lower(html);
    std::wstring filtered = html;

    auto eraseBlock = [&](const std::wstring& openTag, const std::wstring& closeTag) {
        size_t searchFrom = 0;
        while (true) {
            const size_t begin = lowered.find(openTag, searchFrom);
            if (begin == std::wstring::npos) {
                break;
            }
            const size_t end = lowered.find(closeTag, begin);
            const size_t finish = (end == std::wstring::npos) ? lowered.size() : end + closeTag.size();
            filtered.erase(begin, finish - begin);
            lowered.erase(begin, finish - begin);
            searchFrom = begin;
        }
    };

    eraseBlock(L"<script", L"</script>");
    eraseBlock(L"<style", L"</style>");

    std::wstring output;
    output.reserve(filtered.size());

    bool insideTag = false;
    for (wchar_t ch : filtered) {
        if (ch == L'<') {
            insideTag = true;
            output.push_back(L' ');
            continue;
        }
        if (ch == L'>') {
            insideTag = false;
            output.push_back(L' ');
            continue;
        }
        if (!insideTag) {
            output.push_back(ch);
        }
    }

    output = DecodeHtmlEntities(output);

    std::wstring collapsed;
    collapsed.reserve(output.size());
    bool lastSpace = false;
    for (wchar_t ch : output) {
        const bool isSpace = ch == L' ' || ch == L'\n' || ch == L'\t' || ch == L'\r';
        if (isSpace) {
            if (!lastSpace) {
                collapsed.push_back(L' ');
            }
        } else {
            collapsed.push_back(ch);
        }
        lastSpace = isSpace;
    }

    return Trim(collapsed);
}

std::wstring KnowledgeBase::GuessTitle(const std::wstring& html, const WebSource& source) const {
    const std::wstring lowered = Lower(html);
    const size_t begin = lowered.find(L"<title");
    if (begin == std::wstring::npos) {
        return source.title;
    }
    const size_t close = lowered.find(L">", begin);
    const size_t end = lowered.find(L"</title>", close == std::wstring::npos ? begin : close);
    if (close == std::wstring::npos || end == std::wstring::npos || end <= close) {
        return source.title;
    }

    return Trim(DecodeHtmlEntities(html.substr(close + 1, end - close - 1)));
}

std::vector<std::wstring> KnowledgeBase::Tokenize(const std::wstring& text) const {
    static const std::unordered_set<std::wstring> kStopwords = {
        L"그", L"이", L"저", L"것", L"거", L"문서", L"자료", L"내용", L"관련", L"대한",
        L"설명", L"정리", L"해줘", L"해주세요", L"있어", L"있는", L"있는지",
        L"what", L"with", L"from", L"that", L"this"
    };

    std::vector<std::wstring> tokens;
    std::wstring current;

    auto flush = [&]() {
        current = Lower(Trim(current));
        if (current.size() >= 2 && kStopwords.find(current) == kStopwords.end()) {
            tokens.push_back(current);
        }
        current.clear();
    };

    for (wchar_t ch : text) {
        if (iswalnum(static_cast<unsigned short>(ch)) || ch >= 0xAC00) {
            current.push_back(ch);
        } else {
            flush();
        }
    }
    flush();

    return tokens;
}

int KnowledgeBase::ScoreDocument(const std::vector<std::wstring>& queryTokens, const KnowledgeDocument& document) const {
    const std::wstring loweredTitle = Lower(document.title);
    const std::wstring loweredUrl = Lower(document.url);
    const std::wstring loweredText = Lower(document.text);
    int score = 0;
    int matchedTokens = 0;

    for (const auto& token : queryTokens) {
        if (token.size() < 2) {
            continue;
        }

        bool matched = false;
        if (loweredTitle.find(token) != std::wstring::npos) {
            score += 16;
            matched = true;
        }

        if (loweredUrl.find(token) != std::wstring::npos) {
            score += 6;
            matched = true;
        }

        size_t position = loweredText.find(token);
        int hits = 0;
        while (position != std::wstring::npos && hits < 5) {
            score += (hits == 0) ? 8 : 3;
            if (position < 220) {
                score += 3;
            }
            matched = true;
            ++hits;
            position = loweredText.find(token, position + token.size());
        }

        if (matched) {
            ++matchedTokens;
        }
    }

    if (matchedTokens >= 2) {
        score += matchedTokens * 6;
    }

    if (document.category == SourceCategory::Verified) {
        score += 8;
    } else if (document.category == SourceCategory::General) {
        score += 3;
    } else {
        score += 1;
    }

    if (document.text.size() >= 300 && document.text.size() <= 12000) {
        score += 4;
    }

    return score;
}

bool KnowledgeBase::ShouldInclude(SourceCategory category, bool includeVerified, bool includeGeneral, bool includeTrend) const {
    switch (category) {
    case SourceCategory::Verified:
        return includeVerified;
    case SourceCategory::General:
        return includeGeneral;
    case SourceCategory::Trend:
        return includeTrend;
    }
    return true;
}

bool KnowledgeBase::SyncAll(
    std::atomic<bool>& cancelRequested,
    const std::function<void(const std::wstring&)>& progressCallback,
    std::wstring& error) {

    if (sources_.empty()) {
        EnsureDefaultSources();
    }

    std::vector<KnowledgeDocument> fetched;
    fetched.reserve(sources_.size() * 5);
    std::set<std::wstring> visitedUrls;

    for (size_t i = 0; i < sources_.size(); ++i) {
        if (cancelRequested.load()) {
            error = L"웹 동기화가 취소되었습니다.";
            return false;
        }

        const auto& source = sources_[i];
        if (!source.enabled) {
            continue;
        }

        if (progressCallback) {
            std::wstringstream status;
            status << L"웹 자료 수집 " << (i + 1) << L"/" << sources_.size() << L" : " << source.title;
            progressCallback(status.str());
        }

        std::wstring html;
        std::wstring fetchError;
        if (!FetchUrl(source.url, html, fetchError)) {
            continue;
        }

        const std::wstring normalizedSourceUrl = Lower(NormalizeUrl(source.url));
        if (visitedUrls.insert(normalizedSourceUrl).second) {
            KnowledgeDocument document;
            document.category = source.category;
            document.title = GuessTitle(html, source);
            document.url = source.url;
            document.text = StripHtml(html);

            if (!Trim(document.text).empty()) {
                fetched.push_back(std::move(document));
            }
        }

        const auto childLinks = ExtractLinksFromHtml(html, source.url, 4);
        for (size_t childIndex = 0; childIndex < childLinks.size(); ++childIndex) {
            if (cancelRequested.load()) {
                error = L"웹 동기화가 취소되었습니다.";
                return false;
            }

            const std::wstring normalizedChildUrl = Lower(NormalizeUrl(childLinks[childIndex]));
            if (!visitedUrls.insert(normalizedChildUrl).second) {
                continue;
            }

            if (progressCallback) {
                std::wstringstream status;
                status << L"연결 문서 수집 " << source.title << L" (" << (childIndex + 1) << L"/" << childLinks.size() << L")";
                progressCallback(status.str());
            }

            std::wstring childHtml;
            std::wstring childError;
            if (!FetchUrl(childLinks[childIndex], childHtml, childError)) {
                continue;
            }

            WebSource childSource = source;
            childSource.url = childLinks[childIndex];

            KnowledgeDocument childDocument;
            childDocument.category = source.category;
            childDocument.title = GuessTitle(childHtml, childSource);
            childDocument.url = childLinks[childIndex];
            childDocument.text = StripHtml(childHtml);

            if (!Trim(childDocument.text).empty()) {
                fetched.push_back(std::move(childDocument));
            }
        }
    }

    if (fetched.empty()) {
        error = L"웹 동기화에 성공한 문서가 없습니다. 주소를 바꾸거나 네트워크를 확인해 주세요.";
        return false;
    }

    documents_ = std::move(fetched);
    return true;
}

std::vector<KnowledgeDocument> KnowledgeBase::Search(
    const std::wstring& query,
    bool includeVerified,
    bool includeGeneral,
    bool includeTrend,
    size_t topN) const {

    std::vector<KnowledgeDocument> results;
    const auto queryTokens = Tokenize(query);
    if (queryTokens.empty()) {
        return results;
    }

    const std::wstring normalizedQuery = Lower(NormalizeWhitespace(query));
    std::vector<std::tuple<int, size_t>> scored;
    scored.reserve(documents_.size());

    for (size_t i = 0; i < documents_.size(); ++i) {
        if (!ShouldInclude(documents_[i].category, includeVerified, includeGeneral, includeTrend)) {
            continue;
        }

        int score = ScoreDocument(queryTokens, documents_[i]);
        if (!normalizedQuery.empty()) {
            const std::wstring combined = Lower(documents_[i].title + L" " + documents_[i].text);
            if (combined.find(normalizedQuery) != std::wstring::npos) {
                score += 20;
            }
        }

        if (score > 0) {
            scored.emplace_back(score, i);
        }
    }

    std::sort(scored.begin(), scored.end(),
        [](const auto& left, const auto& right) {
            return std::get<0>(left) > std::get<0>(right);
        });

    const size_t count = std::min(topN, scored.size());
    results.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        results.push_back(documents_[std::get<1>(scored[i])]);
    }

    return results;
}

std::wstring KnowledgeBase::ExportTrainingCorpus(
    bool includeVerified,
    bool includeGeneral,
    bool includeTrend,
    size_t maxCharsPerDocument) const {

    std::wstring corpus;
    for (const auto& document : documents_) {
        if (!ShouldInclude(document.category, includeVerified, includeGeneral, includeTrend)) {
            continue;
        }

        std::wstring text = document.text;
        if (text.size() > maxCharsPerDocument) {
            text = text.substr(0, maxCharsPerDocument);
        }

        corpus += L"\n출처 유형: ";
        corpus += CategoryLabel(document.category);
        corpus += L"\n제목: ";
        corpus += document.title;
        corpus += L"\n내용: ";
        corpus += text;
        corpus += L"\n";

        corpus += L"\n사용자: ";
        corpus += document.title;
        corpus += L"이 뭐야?\nAI: ";
        corpus += text;
        corpus += L"\n";

        corpus += L"\n사용자: ";
        corpus += document.title;
        corpus += L" 핵심만 설명해줘.\nAI: ";
        corpus += text;
        corpus += L"\n";
    }

    return corpus;
}

size_t KnowledgeBase::SourceCount() const {
    return sources_.size();
}

size_t KnowledgeBase::DocumentCount() const {
    return documents_.size();
}

size_t KnowledgeBase::DocumentCount(SourceCategory category) const {
    size_t count = 0;
    for (const auto& document : documents_) {
        if (document.category == category) {
            ++count;
        }
    }
    return count;
}

SourceCategory KnowledgeBase::ClassifyUrl(const std::wstring& url) {
    const std::wstring lowered = Lower(url);

    const std::vector<std::wstring> verifiedPatterns = {
        L".gov", L".edu", L".ac.kr", L".go.kr", L"korea.kr", L"wikipedia.org",
        L"openai.com", L"anthropic.com", L"google.com", L"deepmind.google",
        L"microsoft.com", L"mozilla.org", L"huggingface.co", L"nasa.gov",
        L"nih.gov", L"who.int", L"un.org", L"arxiv.org", L"developer.", L"developers."
    };

    const std::vector<std::wstring> trendPatterns = {
        L"reddit.com", L"x.com", L"twitter.com", L"youtube.com", L"tiktok.com",
        L"instagram.com", L"dcinside.com", L"theqoo.net", L"fmkorea.com", L"tumblr.com",
        L"producthunt.com"
    };

    for (const auto& pattern : verifiedPatterns) {
        if (lowered.find(pattern) != std::wstring::npos) {
            return SourceCategory::Verified;
        }
    }

    for (const auto& pattern : trendPatterns) {
        if (lowered.find(pattern) != std::wstring::npos) {
            return SourceCategory::Trend;
        }
    }

    return SourceCategory::General;
}

const wchar_t* KnowledgeBase::CategoryLabel(SourceCategory category) {
    switch (category) {
    case SourceCategory::Verified:
        return L"검증됨";
    case SourceCategory::General:
        return L"일반";
    case SourceCategory::Trend:
        return L"유행·재미";
    }
    return L"일반";
}
