# Purple Bee Reference Baseline

## Primary Reference

- Model: `HuggingFaceTB/SmolLM2-135M-Instruct`
- Why:
  - same order of magnitude as Purple Bee target
  - explicitly built for compact/on-device use
  - instruct-tuned, so it is a useful behavioral baseline for natural replies
  - official model card exposes training and evaluation details

Official sources:

- Model card: https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct
- Paper: https://arxiv.org/abs/2502.02737

Key facts from the official model card / paper:

- 135M parameter instruct model
- decoder-only Transformer
- trained from the SmolLM2 family
- 135M base was trained on 2T tokens
- instruct version uses SFT plus DPO with UltraFeedback
- explicitly presented as lightweight enough for on-device scenarios

## Architecture Reference

- Paper: `MobileLLM`
- Source: https://arxiv.org/abs/2402.14905

Why it matters:

- focuses on sub-billion on-device language models
- argues architecture matters heavily at this scale
- recommends deep-and-thin design, embedding sharing, and grouped-query attention

## What Purple Bee should copy first

1. Instruction-first data
   - user -> assistant pairs must dominate public chat behavior
   - stop relying on generic dialogue bank patterns as primary runtime behavior

2. Small-model architecture discipline
   - compare Purple Bee config against MobileLLM-style choices
   - prioritize deep/thin tradeoffs and attention efficiency over ad hoc heuristics

3. Behavior tuning after pretraining
   - use SFT for natural replies
   - then add preference-style tuning or teacher distillation

4. Benchmark before trusting
   - keep a fixed eval set for:
     - greeting
     - short follow-up
     - correction
     - definition question
     - coding question
     - search request
     - weather request

## Immediate comparison goal

Purple Bee should be compared against SmolLM2-135M-Instruct on:

- short casual chat quality
- instruction following
- repetition rate
- fallback rate
- Korean robustness after adaptation

SmolLM2 is not the final production model here. It is the external reference point for data shape, instruct behavior, and compact-model training quality.
