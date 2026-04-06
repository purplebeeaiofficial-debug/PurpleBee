# Purple Bee Corpora Layout

This layout is the first concrete step toward the research-guided training structure.

## Core directories

- `dialogue_sft/`
  - everyday conversation
  - coding help
  - correction handling
  - multilingual instruction tuning
- `knowledge_text/`
  - clean knowledge text
  - product docs
  - troubleshooting references
- `teacher_distilled/`
  - filtered teacher outputs
  - instruction/response pairs
  - preference seeds
- `eval_holdout/`
  - frozen prompts and held-out evaluation pairs

## Capability-specific directories

- `image_analysis/`
- `image_generation/`
- `audio_analysis/`
- `music_analysis/`
- `music_generation/`

## Manifest

Use `Model/scripts/build_corpus_manifest.py` to create:

- `Model/corpora/manifest.jsonl`

Each row should record:

- source path
- source type
- modality
- language
- quality score
- synthetic or human
- train or eval split

## Rule

Do not keep mixing every source into one flat training blob.
Purple Bee quality will improve faster if each capability keeps its own clean training and eval path.
