# Purple Bee Reference Comparison

Primary chat baseline:
- SmolLM2 135M Instruct
- Official model card: https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct
- Official paper: https://arxiv.org/abs/2502.02737

Architecture reference:
- MobileLLM 125M
- Official paper: https://arxiv.org/abs/2402.14905

## Why these were chosen

SmolLM2 135M Instruct is close enough to Purple Bee 100M to be a practical comparison point for:
- casual chat quality
- instruction following
- short follow-up handling
- tokenizer behavior

MobileLLM 125M is a useful second reference because its paper focuses on what matters at sub-billion scale for on-device models:
- architecture shape
- grouped-query attention
- embedding sharing
- small-model training discipline

## Current Purple Bee gaps

What the current public failures suggest:
- the tokenizer path was damaged by broken multilingual regexes
- training text still contained too much structural markup
- the runtime leaned on fallback because the model output was often empty or malformed
- small-talk quality is far below a real instruct-tuned baseline

## Immediate action order

1. Fix tokenizer and browser pretokenization so Korean, Japanese, Chinese, and English split consistently.
2. Stop training on internal tags like `<|assistant|>` for the public chat path.
3. Rebuild the SFT dataset as plain `User:` / `Assistant:` conversational text.
4. Retrain Purple Bee 100M on the cleaner chat corpus.
5. Compare the exact same prompts against SmolLM2 135M Instruct with `run_reference_compare.py`.
6. Only then re-export ONNX and redeploy the public website.

## What to compare

- greeting: `안녕`
- casual planning: `우리 뭐할래?`
- repair follow-up: `아니 그거말고`
- simple definition: `사과가 뭐야?`
- tone repair: `왜그래`
- coding ability: `파이썬 알아?`
- direct link request: `gpt 링크 달라고`

## Success criteria

- Purple Bee should stop emitting tag markers or citation debris
- fallback rate on casual chat should drop sharply
- follow-up corrections should change direction instead of repeating a canned line
- open-ended chat should sound like a person, not a menu
