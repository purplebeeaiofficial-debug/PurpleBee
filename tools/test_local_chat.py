import argparse
import importlib.util
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_PATH = PROJECT_ROOT / "app" / "app.py"


def load_app_module():
    spec = importlib.util.spec_from_file_location("purple_bee_app", APP_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    mod = load_app_module()
    client = mod.app.test_client()

    cases = [
        {"message": "안녕", "history": []},
        {"message": "너 뭐할수있어?", "history": []},
        {"message": "코딩 할수있어?", "history": []},
        {"message": "영어로 말할 수 있어?", "history": []},
        {"message": "오류 원인을 같이 봐줘", "history": []},
        {"message": "지금 주제가 뭐야?", "history": [
            {"role": "user", "content": "로그를 같이 보자"},
            {"role": "assistant", "content": "좋아요. 로그를 보여주세요."},
        ]},
        {"message": "방금 내가 뭐라고 했지?", "history": [
            {"role": "user", "content": "모델 학습 데이터를 늘려야 해"},
            {"role": "assistant", "content": "좋아요. 데이터 정제부터 볼게요."},
        ]},
        {"message": "hello", "history": []},
        {"message": "what can you do?", "history": []},
        {"message": "can you help with coding?", "history": []},
        {"message": "what topic are we discussing?", "history": [
            {"role": "user", "content": "let us inspect the logs"},
            {"role": "assistant", "content": "sure, show me the log file"},
        ]},
        {"message": "what did I just say?", "history": [
            {"role": "user", "content": "we need more training data"},
            {"role": "assistant", "content": "okay, let us start by cleaning the corpus"},
        ]},
    ]

    rows = []
    for case in cases:
        response = client.post("/api/chat_once", json=case)
        payload = response.get_json()
        rows.append({
            "message": case["message"],
            "status": response.status_code,
            "reply": payload.get("reply") if payload else None,
        })

    if args.pretty:
        for row in rows:
            print("=" * 72)
            print(f"message: {row['message']}")
            print(f"status : {row['status']}")
            print(f"reply  : {row['reply']}")
    else:
        print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
