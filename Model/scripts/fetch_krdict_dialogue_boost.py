import argparse
import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


DEFAULT_TERMS = [
    "사과",
    "강아지",
    "고양이",
    "인공지능",
    "파일",
    "코딩",
    "오류",
    "문서",
    "요약",
    "분석",
]

SEARCH_URL = "https://krdict.korean.go.kr/api/search"


def fetch_xml(url: str) -> ET.Element:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Purple-Bee-KRDict-Builder/1.0",
            "Accept": "application/xml,text/xml,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read()
    return ET.fromstring(payload)


def request_search(key: str, query: str, limit: int = 3) -> list[dict]:
    params = {
        "key": key,
        "q": query,
        "num": str(max(1, min(limit, 10))),
        "part": "word",
        "sort": "dict",
        "advanced": "y",
        "target": "2",
    }
    url = f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"
    root = fetch_xml(url)
    if root.tag == "error":
        code = (root.findtext("error_code") or "").strip()
        message = (root.findtext("message") or "").strip()
        raise RuntimeError(f"KRDict API error {code}: {message}")

    rows = []
    for item in root.findall("./item"):
        word = (item.findtext("word") or "").strip()
        pos = (item.findtext("pos") or "").strip()
        link = (item.findtext("link") or "").strip()
        examples = [(node.text or "").strip() for node in item.findall("example") if (node.text or "").strip()]
        senses = []
        for sense in item.findall("sense"):
            definition = (sense.findtext("definition") or "").strip()
            if definition:
                senses.append(definition)
        rows.append(
            {
                "word": word or query,
                "pos": pos,
                "definition": senses[0] if senses else "",
                "example": examples[0] if examples else "",
                "link": link,
            }
        )
    return rows


def render_row(entry: dict) -> dict:
    word = (entry.get("word") or "").strip()
    definition = (entry.get("definition") or "").strip()
    example = (entry.get("example") or "").strip()
    if definition:
        response = f"{word}는 {definition}"
    else:
        response = f"{word}는 국어사전에서 정의를 아직 찾지 못한 단어예요."
    if example:
        response += f" 예문으로는 '{example}' 같은 표현이 있어요."
    return {
        "instruction": "국어사전 정의를 바탕으로 짧고 자연스럽게 설명한다.",
        "input": f"{word}가 뭐야",
        "response": response,
        "tags": ["knowledge", "definition", "krdict"],
        "language": "ko",
        "reward_weight": 18,
        "source_file": "krdict_augmented_ko.jsonl",
    }


def main():
    parser = argparse.ArgumentParser(description="Build Korean dictionary grounded dialogue boosts from KRDict Open API.")
    parser.add_argument("--key", required=True, help="KRDict Open API key")
    parser.add_argument("--output", required=True, help="Output JSONL path")
    parser.add_argument("--terms", default="", help="Comma separated Korean terms")
    parser.add_argument("--terms-file", default="", help="Optional file containing one term per line")
    parser.add_argument("--limit", type=int, default=2, help="How many dictionary hits per term to use")
    args = parser.parse_args()

    terms = []
    if args.terms:
        terms.extend([item.strip() for item in args.terms.split(",") if item.strip()])
    if args.terms_file:
        term_file = Path(args.terms_file)
        if term_file.exists():
            terms.extend(
                [line.strip() for line in term_file.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
            )
    if not terms:
        terms = list(DEFAULT_TERMS)

    seen = set()
    rows = []
    errors = []
    for term in terms:
        try:
            for item in request_search(args.key, term, limit=args.limit):
                rendered = render_row(item)
                dedupe_key = (rendered["input"], rendered["response"])
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                rows.append(rendered)
        except Exception as exc:
            errors.append({"term": term, "error": str(exc)})

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(
        json.dumps(
            {
                "output": str(output_path),
                "rows": len(rows),
                "terms": len(terms),
                "errors": errors,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
