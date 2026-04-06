import json
import random
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "corpora" / "dialogue_sft"
SEED = 20260405
CATEGORY_SEEDS = {
    "smalltalk": 11,
    "style": 22,
    "knowledge": 33,
    "tool": 44,
}


def make_row(instruction, input_text, thinking, response, tags):
    return {
        "instruction": instruction,
        "input": input_text,
        "thinking": thinking,
        "response": response,
        "tags": tags,
        "language": "ko",
    }


def expand_topic_set(category, instruction, tags, topic_specs):
    rows = []
    for spec in topic_specs:
        thinking = spec["thinking"]
        for prompt in spec["prompts"]:
            rows.append(
                make_row(
                    instruction=instruction,
                    input_text=prompt,
                    thinking=thinking,
                    response=spec["concise"],
                    tags=tags + spec.get("extra_tags", []) + ["concise"],
                )
            )
            rows.append(
                make_row(
                    instruction=instruction,
                    input_text=prompt,
                    thinking=thinking,
                    response=spec["detailed"],
                    tags=tags + spec.get("extra_tags", []) + ["detailed"],
                )
            )
    rng = random.Random(SEED + CATEGORY_SEEDS.get(category, 0))
    rng.shuffle(rows)
    return rows


def build_smalltalk_rows():
    return expand_topic_set(
        category="smalltalk",
        instruction="사용자의 짧은 일상 대화에 자연스럽고 유연하게 답한다.",
        tags=["smalltalk", "conversation", "natural"],
        topic_specs=[
            {
                "prompts": ["안녕", "하이", "안녕하세요"],
                "thinking": "짧고 편한 인사로 먼저 분위기를 연다.",
                "concise": "안녕. 편하게 말해줘.",
                "detailed": "안녕, 반가워. 하고 싶은 말이나 궁금한 걸 편하게 꺼내줘.",
            },
            {
                "prompts": ["지금 뭐해?", "뭐 하고 있어?", "지금 뭐하는 중이야?"],
                "thinking": "현재 상태를 묻는 말에는 지금 하고 있는 일을 자연스럽게 말한다.",
                "concise": "지금은 네 질문을 같이 정리하는 중이야.",
                "detailed": "지금은 네가 말한 내용을 잘 이해하고, 바로 이어서 도와줄 수 있게 정리하고 있어.",
            },
            {
                "prompts": ["오랜만이야", "오랜만이다", "오랜만이지?"],
                "thinking": "오랜만이라는 말에는 반가움을 먼저 돌려준다.",
                "concise": "오랜만이야. 다시 만나서 반가워.",
                "detailed": "오랜만이네. 다시 편하게 이어서 이야기할 수 있어서 반가워.",
            },
            {
                "prompts": ["오늘 어때?", "오늘 기분 어때?", "오늘 상태 괜찮아?"],
                "thinking": "가벼운 안부에는 친근하고 짧게 받는다.",
                "concise": "괜찮아. 덕분에 지금 대화에 잘 집중하고 있어.",
                "detailed": "괜찮아. 지금은 네 말에 맞춰서 차분하게 이어가고 있어.",
            },
            {
                "prompts": ["뭐부터 할까?", "우리 뭐할래?", "다음에 뭐 하지?"],
                "thinking": "함께 할 일을 고를 때는 선택지를 너무 늘리지 않고 바로 이어준다.",
                "concise": "원하는 주제 하나만 골라줘. 바로 그쪽으로 이어갈게.",
                "detailed": "원하는 주제 하나만 주면 바로 그 흐름에 맞춰 같이 이어갈게. 질문, 코딩, 정리 중 뭐든 괜찮아.",
            },
            {
                "prompts": ["기분 어때?", "괜찮아?", "잘 지냈어?"],
                "thinking": "안부에는 따뜻하고 짧게 응답한다.",
                "concise": "괜찮아. 편하게 이야기해줘.",
                "detailed": "괜찮아. 지금처럼 편하게 말 걸어주면 자연스럽게 이어갈 수 있어.",
            },
            {
                "prompts": ["반가워", "만나서 반가워", "처음 봐"],
                "thinking": "반가움 표현에는 같은 온도로 받아준다.",
                "concise": "나도 반가워.",
                "detailed": "나도 반가워. 이제부터 편하게 이야기하자.",
            },
            {
                "prompts": ["점심 먹었어?", "밥 먹었어?", "식사했어?"],
                "thinking": "식사 안부에는 인간적인 톤으로 짧게 답한다.",
                "concise": "아직이야. 너는 밥 챙겼어?",
                "detailed": "아직이야. 너는 식사했는지 먼저 궁금하네. 잘 챙겼으면 좋겠어.",
            },
            {
                "prompts": ["오늘 뭐 재밌는 거 있어?", "재밌는 얘기 해줘", "뭐 재밌는 거 없나?"],
                "thinking": "가벼운 대화 요청에는 분위기를 열어주는 답이 좋다.",
                "concise": "가볍게 얘기하자. 궁금한 거 하나만 던져줘.",
                "detailed": "좋아. 가볍게 이어가도 되고, 바로 고민이나 궁금한 주제로 들어가도 괜찮아.",
            },
            {
                "prompts": ["심심해", "할 거 없어", "지루해"],
                "thinking": "지루함에는 함께 할 수 있는 방향을 제안한다.",
                "concise": "그럼 같이 하나 골라보자.",
                "detailed": "그럼 같이 뭐 하나 정해보자. 대화, 코딩, 정리, 가벼운 잡담 중에서 고르면 바로 맞출게.",
            },
        ],
    )


def build_style_rows():
    return expand_topic_set(
        category="style",
        instruction="사용자가 말투나 답변 형식을 고치라고 하면 그 의도를 바로 반영한다.",
        tags=["style", "repair", "tone"],
        topic_specs=[
            {
                "prompts": ["조금 더 친근하게 말해줘", "친근한 말투로 해줘", "좀 편하게 말해줘"],
                "thinking": "말투를 바꾸라는 요청이므로 억양을 부드럽게 낮춘다.",
                "concise": "좋아. 더 편하게 말할게.",
                "detailed": "좋아. 앞으로는 더 편하고 자연스럽게 말할게. 너무 딱딱하면 바로 말해줘.",
            },
            {
                "prompts": ["짧게 말해줘", "한 줄로 답해줘", "간단히 해줘"],
                "thinking": "요청한 분량을 줄여서 핵심만 남긴다.",
                "concise": "짧게 말할게.",
                "detailed": "짧게 정리하면, 핵심만 바로 말하고 불필요한 설명은 줄일게.",
            },
            {
                "prompts": ["조금 길게 설명해줘", "자세히 말해줘", "좀 더 풀어서 설명해줘"],
                "thinking": "설명을 늘리라는 요청이므로 단계적으로 풀어준다.",
                "concise": "좋아. 좀 더 자세히 설명할게.",
                "detailed": "좋아. 개념부터 차근차근 풀어서 설명할게. 중간에 헷갈리면 바로 멈춰서 다시 맞출게.",
            },
            {
                "prompts": ["다시 말해줘", "한 번 더 설명해줘", "다시 정리해줘"],
                "thinking": "이해를 놓친 상태라 다시 같은 뜻으로 풀어준다.",
                "concise": "좋아. 다시 정리해서 말할게.",
                "detailed": "좋아. 같은 뜻이지만 더 분명하게 다시 정리해볼게. 핵심만 먼저 말하고 필요하면 더 붙일게.",
            },
            {
                "prompts": ["너무 딱딱해", "좀 딱딱한데", "말이 차가워"],
                "thinking": "반응이 딱딱하다는 신호라 온도를 낮춘다.",
                "concise": "알겠어. 더 부드럽게 말할게.",
                "detailed": "알겠어. 더 부드럽고 덜 딱딱하게 말할게. 불편한 느낌이 들면 바로 고쳐줄게.",
            },
            {
                "prompts": ["다른 표현으로 말해줘", "같은 뜻인데 다르게 말해줘", "말 바꿔줘"],
                "thinking": "같은 뜻의 재서술 요청이라 의미는 유지하고 표현만 바꾼다.",
                "concise": "좋아. 다른 표현으로 바꿔볼게.",
                "detailed": "좋아. 의미는 유지하고 표현만 자연스럽게 바꿔서 다시 말할게.",
            },
            {
                "prompts": ["핵심만 말해", "중요한 것만 알려줘", "요점만 말해줘"],
                "thinking": "핵심 추출 요청이라 요약형으로 전환한다.",
                "concise": "핵심만 말할게.",
                "detailed": "좋아. 가장 중요한 것부터 먼저 말하고, 필요하면 뒤에 짧게 덧붙일게.",
            },
            {
                "prompts": ["더 자연스럽게 말해줘", "너무 기계적이야", "사람처럼 말해줘"],
                "thinking": "자연스러운 대화 흐름을 우선한다.",
                "concise": "좋아. 더 자연스럽게 말할게.",
                "detailed": "좋아. 기계적으로 보이지 않게, 실제 대화처럼 이어지도록 말해볼게.",
            },
            {
                "prompts": ["그건 아니고", "아니 그거 말고", "내 말은 그게 아니야"],
                "thinking": "수정 요청이므로 현재 방향을 멈추고 사용자의 의도를 다시 묻는다.",
                "concise": "알겠어. 그 방향은 빼고 다시 맞출게.",
                "detailed": "알겠어. 방금 방향은 빼고 다시 맞출게. 네가 원하는 쪽을 한 번만 더 말해주면 바로 이어갈 수 있어.",
            },
            {
                "prompts": ["이전 말투로 돌아가줘", "아까처럼 말해줘", "그 톤으로 다시"],
                "thinking": "사용자가 원하는 말투 기준을 다시 복원한다.",
                "concise": "좋아. 아까 톤으로 다시 맞출게.",
                "detailed": "좋아. 아까처럼 들리도록 다시 맞출게. 원하면 더 귀엽게, 더 단정하게도 바꿀 수 있어.",
            },
        ],
    )


def build_knowledge_rows():
    return expand_topic_set(
        category="knowledge",
        instruction="짧은 정의형 질문과 능력 질문에는 구체적이고 과장 없이 답한다.",
        tags=["knowledge", "definition", "ability"],
        topic_specs=[
            {
                "prompts": ["사과가 뭐야?", "사과를 쉽게 설명해줘", "사과 뜻을 한 문장으로 알려줘"],
                "thinking": "기본 개념 질문이므로 짧고 정확하게 정의한다.",
                "concise": "사과는 대표적인 과일이야.",
                "detailed": "사과는 사과나무에서 나는 대표적인 과일이야. 단맛과 산미가 함께 있고 생과일로도, 주스나 디저트로도 많이 먹어.",
            },
            {
                "prompts": ["강아지가 뭐야?", "강아지를 쉽게 설명해줘", "강아지 뜻을 알려줘"],
                "thinking": "사람이 흔히 아는 대상이므로 친근한 정의로 답한다.",
                "concise": "강아지는 사람과 함께 사는 대표적인 반려동물이야.",
                "detailed": "강아지는 사람과 오래 함께 지내는 반려동물이야. 보통 개의 어린 시기를 뜻하거나, 일상 대화에서는 친근하게 개를 부르는 말로도 써.",
            },
            {
                "prompts": ["파이썬 알아?", "파이썬 할 수 있어?", "파이썬이 뭐야?"],
                "thinking": "능력 질문과 기본 정의를 함께 처리한다.",
                "concise": "응. 파이썬 관련 질문도 도와줄 수 있어.",
                "detailed": "응. 파이썬 문법 설명, 버그 찾기, 함수 설계, 예제 코드 작성 같은 작업을 같이 할 수 있어.",
            },
            {
                "prompts": ["전압이 뭐야?", "전압을 쉽게 설명해줘", "전압 뜻을 한 문장으로 알려줘"],
                "thinking": "기초 과학 개념은 쉬운 비유보다 정확한 정의를 우선한다.",
                "concise": "전압은 전류를 흐르게 하는 전기적인 차이야.",
                "detailed": "전압은 전기를 흐르게 만드는 힘의 차이처럼 이해하면 돼. 전류가 움직이도록 밀어주는 원리라고 보면 쉽다.",
            },
            {
                "prompts": ["모델이 뭐야?", "AI 모델을 쉽게 설명해줘", "모델 뜻을 알려줘"],
                "thinking": "학습과 추론의 중심 개념을 짧게 정리한다.",
                "concise": "모델은 데이터를 바탕으로 패턴을 배우는 프로그램이야.",
                "detailed": "모델은 많은 데이터를 보고 규칙과 패턴을 배워서, 새 입력에 대해 답을 만들거나 예측하는 프로그램이야.",
            },
            {
                "prompts": ["토큰이 뭐야?", "토큰을 쉽게 설명해줘", "토큰 뜻을 알려줘"],
                "thinking": "언어모델 기본 용어는 실제 동작과 연결해 설명한다.",
                "concise": "토큰은 모델이 글을 쪼개서 보는 단위야.",
                "detailed": "토큰은 모델이 문장을 처리할 때 사용하는 작은 단위야. 한 글자일 수도 있고, 짧은 단어 조각일 수도 있어.",
            },
            {
                "prompts": ["문맥이 뭐야?", "문맥을 쉽게 설명해줘", "문맥 뜻을 한 문장으로 알려줘"],
                "thinking": "대화 흐름과 이전 말을 함께 보는 개념을 설명한다.",
                "concise": "문맥은 앞뒤 대화를 함께 보는 거야.",
                "detailed": "문맥은 지금 한 말만 보는 게 아니라 앞에서 오간 이야기까지 함께 보는 거야. 그래서 같은 말도 상황에 따라 다르게 이해할 수 있어.",
            },
            {
                "prompts": ["코딩이 뭐야?", "코딩을 쉽게 설명해줘", "코딩 뜻을 알려줘"],
                "thinking": "초보자도 바로 이해할 수 있게 작업 관점으로 설명한다.",
                "concise": "코딩은 컴퓨터에게 일을 시키는 글을 쓰는 거야.",
                "detailed": "코딩은 컴퓨터가 이해할 수 있는 규칙을 적어서 원하는 일을 시키는 거야. 앱, 웹사이트, 자동화 도구를 만들 때 쓰여.",
            },
            {
                "prompts": ["데이터가 뭐야?", "데이터를 쉽게 설명해줘", "데이터 뜻을 한 문장으로 알려줘"],
                "thinking": "데이터는 정보의 재료라는 점을 중심으로 답한다.",
                "concise": "데이터는 분석이나 학습에 쓰는 정보야.",
                "detailed": "데이터는 숫자, 글, 이미지, 기록처럼 분석하거나 학습할 수 있는 정보 묶음이야. 모델은 이런 데이터를 많이 보고 배워.",
            },
            {
                "prompts": ["학습이 뭐야?", "학습을 쉽게 설명해줘", "학습 뜻을 알려줘"],
                "thinking": "모델 학습은 반복과 보정을 통해 배운다는 점을 강조한다.",
                "concise": "학습은 반복해서 패턴을 익히는 과정이야.",
                "detailed": "학습은 여러 예시를 보면서 패턴을 익히고, 틀린 부분을 줄여가는 과정이야. 모델도 사람처럼 예시를 많이 볼수록 더 잘 맞출 수 있어.",
            },
        ],
    )


def build_tool_rows():
    return expand_topic_set(
        category="tool",
        instruction="도구, 언어 전환, 검색 요청에는 실제로 가능한 범위와 한계를 자연스럽게 말한다.",
        tags=["tool", "language", "search"],
        topic_specs=[
            {
                "prompts": ["영어로 말할 수 있어?", "영어 할 줄 알아?", "영어로 답해줘"],
                "thinking": "언어 전환 요청이므로 영어 대응 가능 여부를 분명히 말한다.",
                "concise": "응. 영어로도 답할 수 있어.",
                "detailed": "응. 영어로도 자연스럽게 답할 수 있어. 원하면 짧게, 친근하게, 또는 더 설명형으로도 맞출 수 있어.",
            },
            {
                "prompts": ["웹 검색해줘", "사이트에서 찾아줘", "검색 좀 해줘"],
                "thinking": "검색 요청이므로 바로 가능한 범위를 말한다.",
                "concise": "원하는 검색어를 말해주면 바로 이어서 정리할게.",
                "detailed": "원하는 검색어를 주면 그 흐름에 맞춰 바로 찾아서 정리할게. 필요한 게 사이트, 공식 문서, 최신 정보 중 무엇인지도 같이 말해주면 더 정확해져.",
            },
            {
                "prompts": ["GPT 링크 달라고", "ChatGPT 링크 알려줘", "공식 링크 있어?"],
                "thinking": "공식 링크 요청은 직접적인 주소를 짧게 알려준다.",
                "concise": "ChatGPT 공식 링크는 https://chatgpt.com 이야.",
                "detailed": "ChatGPT 공식 링크는 https://chatgpt.com 이야. 필요하면 OpenAI 관련 문서도 같이 찾아줄 수 있어.",
            },
            {
                "prompts": ["오늘 날씨 어때?", "날씨 알려줘", "지금 비 와?"],
                "thinking": "날씨는 지역 정보가 필요하니 먼저 위치를 확인한다.",
                "concise": "어느 지역 날씨를 볼지 먼저 알려줘.",
                "detailed": "날씨는 지역이 있어야 정확하게 볼 수 있어. 도시 이름만 말해주면 바로 그 기준으로 알려줄게.",
            },
            {
                "prompts": ["이미지 분석할 수 있어?", "사진도 볼 수 있어?", "이미지 읽어줄 수 있어?"],
                "thinking": "이미지는 받을 수 있지만 분석 방식은 상황에 따라 달라진다.",
                "concise": "응. 이미지를 보내주면 볼 수 있어.",
                "detailed": "응. 이미지를 보내주면 내용을 읽고 핵심을 정리해줄 수 있어. 필요하면 화면 안 글자, 배치, 오류 메시지도 같이 살펴볼게.",
            },
            {
                "prompts": ["파일도 볼 수 있어?", "문서 읽을 수 있어?", "텍스트 파일 분석 가능해?"],
                "thinking": "파일 분석은 파일 형식을 확인하고 핵심을 추출하는 흐름으로 답한다.",
                "concise": "응. 파일을 보내주면 읽고 정리할 수 있어.",
                "detailed": "응. 텍스트, 문서, 로그 같은 파일을 보내주면 내용을 읽고 요약하거나 문제점을 찾는 데 도움을 줄 수 있어.",
            },
            {
                "prompts": ["음성도 처리해?", "목소리 파일 분석 가능해?", "오디오도 볼 수 있어?"],
                "thinking": "오디오 입력 가능성을 열어두되 과장하지 않는다.",
                "concise": "응. 오디오가 있으면 가능한 범위에서 도와줄 수 있어.",
                "detailed": "응. 오디오가 있으면 텍스트로 옮기거나 핵심을 정리하는 쪽으로 도와줄 수 있어. 파일 형식만 맞으면 더 정확해져.",
            },
            {
                "prompts": ["음악도 할 수 있어?", "음악 생성 가능해?", "음악 분석도 돼?"],
                "thinking": "음악 관련 요청은 생성과 분석을 구분한다.",
                "concise": "음악 관련 요청도 구분해서 도와줄 수 있어.",
                "detailed": "음악은 생성, 분석, 구조 설명처럼 나눠서 도와줄 수 있어. 원하는 방향을 말해주면 거기에 맞춰 답할게.",
            },
            {
                "prompts": ["이전 대화 기억해?", "전에 말한 거 이어갈 수 있어?", "앞 내용도 봐줘"],
                "thinking": "최근 대화 이어받기는 가능하되 범위를 분명히 한다.",
                "concise": "응. 지금 대화 흐름은 이어서 볼 수 있어.",
                "detailed": "응. 지금 대화 흐름은 이어서 볼 수 있어. 앞에서 말한 내용을 바탕으로 다시 정리하거나 이어서 답할 수 있어.",
            },
            {
                "prompts": ["언어 바꿔줄 수 있어?", "일본어로 말해줘", "한국어로 다시 해줘"],
                "thinking": "언어 전환은 명시적으로 맞춰준다.",
                "concise": "응. 원하는 언어로 맞출 수 있어.",
                "detailed": "응. 한국어, 영어, 일본어처럼 원하는 언어로 바꿔서 답할 수 있어. 톤까지 같이 지정해줘도 돼.",
            },
        ],
    )


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    chat_rows = build_smalltalk_rows() + build_style_rows()
    knowledge_rows = build_knowledge_rows() + build_tool_rows()

    rng = random.Random(SEED)
    rng.shuffle(chat_rows)
    rng.shuffle(knowledge_rows)

    chat_path = OUTPUT_DIR / "curriculum_chat_ko.jsonl"
    knowledge_path = OUTPUT_DIR / "curriculum_knowledge_ko.jsonl"
    write_jsonl(chat_path, chat_rows)
    write_jsonl(knowledge_path, knowledge_rows)

    summary = {
        "chat_file": str(chat_path),
        "knowledge_file": str(knowledge_path),
        "chat_rows": len(chat_rows),
        "knowledge_rows": len(knowledge_rows),
        "total_rows": len(chat_rows) + len(knowledge_rows),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
