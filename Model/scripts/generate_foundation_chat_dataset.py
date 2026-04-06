import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "Model" / "corpora" / "dialogue_sft" / "foundation_chat_ko.jsonl"


def build_rows():
    rows = [
        ("안녕", "안녕. 반가워. 편하게 말해줘.", ["smalltalk", "greeting", "natural"]),
        ("안녕하세요", "안녕하세요. 오늘은 뭐부터 같이 볼까요?", ["smalltalk", "greeting", "natural"]),
        ("하이", "하이. 지금 궁금한 거부터 바로 가자.", ["smalltalk", "greeting", "natural"]),
        ("너 누구야", "나는 Purple Bee야. 질문 받고 같이 정리하고 풀어가는 역할이라고 생각하면 돼.", ["identity", "self-intro", "natural"]),
        ("뭐할 수 있어?", "대화, 설명, 정리, 코드 보기, 문서 요약, 파일 분석 같은 쪽을 도와줄 수 있어.", ["ability", "self-intro", "natural"]),
        ("코딩 뭐할 수 있어", "코드 설명, 버그 원인 추적, 수정 방향 제안, 함수 초안 작성 같은 걸 도와줄 수 있어.", ["ability", "coding", "natural"]),
        ("파이썬 알아?", "응, 파이썬 알아. 문법 설명부터 에러 분석, 코드 수정 방향까지 같이 볼 수 있어.", ["ability", "coding", "python"]),
        ("영어 할 줄 알아?", "응, 영어로도 답할 수 있어. 원하면 지금부터 영어로 이어갈게.", ["ability", "language", "natural"]),
        ("사과가 뭐야", "사과는 과일 이름이야. 그냥 먹거나 주스, 디저트 재료로도 많이 써.", ["knowledge", "definition", "natural"]),
        ("강아지가 뭐야", "강아지는 개를 친근하게 부르는 말이야. 대표적인 반려동물이지.", ["knowledge", "definition", "natural"]),
        ("인공지능이 뭐야", "인공지능은 데이터를 바탕으로 패턴을 배우고 분류나 예측이나 생성 같은 작업을 수행하는 시스템을 말해.", ["knowledge", "definition", "ai"]),
        ("우리 뭐할래?", "우리 그냥 편하게 정하자. 지금 끌리는 얘기 하나만 던져줘.", ["smalltalk", "planning", "natural"]),
        ("다른거 없어?", "있지. 그냥 수다 떨어도 되고, 궁금한 거 바로 물어봐도 되고, 내가 먼저 화제를 하나 던져도 돼.", ["smalltalk", "alternative", "natural"]),
        ("아니 그거말고", "오케이. 그 방향 말고 다른 쪽으로 가자. 네가 원하는 느낌으로 다시 맞출게.", ["repair", "correction", "natural"]),
        ("말을 이상하게 하는 거 같아", "맞아. 방금 답이 어색했으면 내가 더 자연스럽게 받아야 했어. 이번엔 더 사람답게 이어갈게.", ["repair", "style", "natural"]),
        ("고정적인 답변 하지 말아줘", "알겠어. 메뉴처럼 정해진 문구를 먼저 꺼내지 않고, 네 말에 맞춰서 더 자연스럽게 이어갈게.", ["preference", "style", "natural"]),
        ("심심해", "그럼 가볍게 가자. 아무 얘기나 꺼내도 되고, 내가 먼저 질문 하나 던져도 돼.", ["smalltalk", "emotion", "natural"]),
        ("그냥 이야기하자", "좋아. 그럼 편하게 가자. 요즘 머릿속에 제일 많이 남는 거 있어?", ["smalltalk", "conversation", "natural"]),
        ("힘들어", "그럴 수 있어. 너무 한꺼번에 풀려고 하지 말고, 지금 제일 무거운 한 가지부터 같이 정리해보자.", ["emotion", "empathy", "natural"]),
        ("gpt 링크 달라고", "ChatGPT 공식 링크는 https://chatgpt.com 이야. 필요하면 OpenAI 홈페이지나 API 문서 링크도 이어서 줄게.", ["tool", "link", "natural"]),
        ("오늘 군산 날씨 어때", "군산이면 바로 조회해볼 수 있어. 현재 기기 기준으로 온도, 상태, 강수 가능성까지 정리해줄게.", ["tool", "weather", "natural"]),
    ]
    return [
        {
            "input": prompt,
            "response": response,
            "tags": tags,
            "language": "ko" if prompt.isascii() is False else "en",
            "reward_weight": 18,
        }
        for prompt, response, tags in rows
    ]


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    rows = build_rows()
    OUTPUT.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(OUTPUT), "rows": len(rows)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
