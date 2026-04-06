# Purple Bee 100M Research Integration

This note translates the ideas from `C:/Users/Phwnx/Downloads/deep-research-report.md`
into concrete next steps for this repository.

## Current reality

- The browser runtime is now wired to the public website through:
  - `app/static/purple-bee-browser-runtime.js`
  - `app/static/purple-bee-local.js`
  - `cloudflare/workers/weight-server.js`
  - `cloudflare/model-deploy.local.json`
- The current public browser model is hosted at:
  - `https://huggingface.co/ae13341/purple-bee-1-3/resolve/main/purple-bee-1-3-int8.onnx`
- The current 100M pipeline is still bootstrap-grade.
- The main quality bottleneck is not deployment anymore. It is data quality, tokenizer quality, and training stages.

## Highest-priority changes

### 1. Split training data by purpose

Do not keep mixing every source into one flat blob.

Create and maintain:

- `Model/corpora/dialogue_sft/`
- `Model/corpora/knowledge_text/`
- `Model/corpora/teacher_distilled/`
- `Model/corpora/eval_holdout/`
- `Model/corpora/manifest.jsonl`

Each record in `manifest.jsonl` should track:

- `source_path`
- `source_type`
- `language`
- `quality_score`
- `synthetic`
- `approved_for_training`
- `approved_for_eval`

### 2. Replace the current tokenizer

The report strongly supports a real multilingual subword tokenizer.

Replace the current regex-driven tokenizer path in:

- `Model/scripts/purple_bee_tokenizer.py`
- `Model/scripts/build_tokenizer.py`

Target:

- SentencePiece unigram or BPE
- Korean-first multilingual vocabulary
- English second
- Measured coverage by language

Add a tokenizer report file:

- `Model/versions/<id>/training/tokenizer_report.json`

Track at least:

- Korean coverage
- English coverage
- Japanese coverage
- Chinese coverage
- average tokens per sentence

### 3. Move to staged training

The current model should not rely on a single flat LM objective.

Use three stages:

1. clean text / domain-adaptive pretraining
2. supervised chat tuning
3. small preference or distillation pass

Suggested new dataset builder:

- `Model/scripts/build_sft_dataset.py`

Suggested sample format:

- `instruction`
- `context_summary`
- `emotion_tag`
- `topic_tag`
- `response`

### 4. Improve alignment through distillation

Use teacher outputs as filtered guidance, not as the whole corpus.

Extend:

- `Model/scripts/teacher_distill.py`

to emit:

- `instruction`
- `response`
- `language`
- `tags`
- `safety`
- `source_type`

Add preference pairs for small DPO-style alignment:

- `Model/scripts/build_preference_pairs.py`
- `Model/versions/<id>/training/preference_pairs.jsonl`

### 5. Add a real evaluation harness

Before pushing more data into the model, add stable regression evaluation.

Create:

- `Model/scripts/eval_100m.py`
- `Model/versions/<id>/training/evals/`

Start with a fixed prompt suite for:

- greetings / small talk
- multilingual language following
- weather / live-info refusal behavior
- coding help
- safety refusal
- correction handling
- memory carry-over
- repetition detection

## Concrete next implementation order

1. Replace tokenizer with SentencePiece or equivalent subword tokenizer.
2. Introduce corpus manifest and source-type separation.
3. Build a clean SFT dataset builder.
4. Add eval harness and regression prompt suite.
5. Retrain Purple Bee 1.3 with staged objectives.
6. Re-export ONNX and redeploy the browser package.

## What not to over-invest in yet

Defer these until the above is stable:

- MoE
- PPO / full RLHF
- multimodal pretraining
- very long context training
- large benchmark integrations

## Why this matters

The research document and the current training reports both point to the same truth:

- parameter count alone is not enough
- deployment alone is not enough
- the fastest quality gains now come from better tokenizer, cleaner data, staged tuning, and repeatable evals
