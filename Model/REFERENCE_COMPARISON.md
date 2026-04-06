# Purple Bee Reference Comparison

## Current Purple Bee 1.3 status

- Current checkpoint: `D:\Purple Bee AI\Model\versions\purple-bee-1-3\training\checkpoints\purple_bee_100m_bootstrap.pt`
- Current tokenizer vocab size: `3321`
- Current staged corpus size: `41037` characters
- Current public chat regression: `0 / 7 passed`
- Latest regression report:
  - [D:\Purple Bee AI\Model\status\public_chat_eval_latest.json](D:/Purple%20Bee%20AI/Model/status/public_chat_eval_latest.json)

## What is failing right now

1. The model is still leaking training markup like `<|language|>` and citation fragments.
2. Everyday prompts such as `안녕`, `우리 뭐할래?`, `사과가 뭐야?` are not producing usable natural-language completions.
3. The data mixture is too small and too dirty for a 100M decoder to behave like a chat model.

## Selected external references

### 1. SmolLM2-135M-Instruct

- Role: behavior and training baseline
- Model card: [HuggingFaceTB/SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M)
- Why it matters:
  - same rough scale as Purple Bee target
  - open small-model baseline with public evaluation numbers
  - good reference for instruction-tuning and evaluation setup

### 2. MobileLLM 125M

- Role: architecture baseline
- Paper: [MobileLLM: Optimizing Sub-billion Parameter Language Models for On-Device Use Cases](https://arxiv.org/abs/2402.14905)
- Why it matters:
  - directly focused on on-device sub-billion models
  - useful reference for deep-thin architecture, embedding sharing, and GQA
  - more relevant to Purple Bee runtime constraints than generic large-model recipes

## Hard conclusion

The current blocker is not just the web runtime. The current 100M training pipeline is not producing deployable chat behavior yet.

That means:

- keep the website in model-first plus minimal-fallback mode
- do not push the latest checkpoint to the public browser runtime yet
- fix the training recipe before the next ONNX export

## Next training revision

### Data

- Separate `chat_sft` from `knowledge_text`
- Remove markup-heavy rows from the chat training stage
- Keep the deep research report as language and knowledge text, not as direct chat-answer format
- Expand Korean natural conversation pairs aggressively before the next run

### Tokenizer

- Replace tiny corpus-driven tokenizer growth as the main bottleneck
- Build the next tokenizer on a much larger Korean text pool
- Do not accept a new checkpoint if tokenizer vocab remains in the low-thousands

### Model recipe

- Keep `100M` parameter target for now
- Use SmolLM2 as the behavioral reference baseline
- Use MobileLLM as the architecture reference for Purple Bee `1.4`

### Deployment gate

Do not re-export and redeploy a new ONNX unless:

1. public chat regression passes core prompts
2. markup leakage is gone
3. repetition rate drops sharply
4. natural everyday conversation is usable without JS canned replies
