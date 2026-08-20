# SQZ — Citations

Sources backing the SQZ prompt-compression idea (epic `math-dbr`). Verification status:
**verified** = fetched and reviewed this session; **inherited** = cited from a third-party README (re-verify before publishing).

## Prompt compression

- LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression — Pan et al., Findings of ACL 2024 — **verified**
  - arXiv: https://arxiv.org/abs/2403.12968
  - Code: https://github.com/microsoft/LLMLingua
  - Relevance: task-agnostic compression via small models; token-classification formulation (compress-as-classification — same bet as SQZ's compress step). 2–5x ratios, 1.6–2.9x end-to-end latency cut.
- LLMLingua (v1): Jiang et al., 2023 — **inherited**
  - arXiv: https://arxiv.org/abs/2310.05736
- Learning to Compress Prompts with Gist Tokens — Mu, Li, Goodman, NeurIPS 2023 — **verified**
  - arXiv: https://arxiv.org/abs/2304.08467
  - Code: https://github.com/jayelm/gisting
  - Relevance: repeated prompts compress hard; 26x compression, 40% FLOPs cut, minimal quality loss.
- In-context Autoencoder / AutoCompressors (ICAE): Ge et al., 2023 — **inherited**
  - arXiv: https://arxiv.org/abs/2301.13103

## Small-model translation / specialization

- Distilling Step-by-Step: Outperforming Larger LLMs with Less Training Data and Smaller Model Sizes — Hsieh et al., Findings of ACL 2023 — **verified**
  - arXiv: https://arxiv.org/abs/2305.02301
  - Code: https://github.com/google-research/distilling-step-by-step
  - Relevance: 770M T5 beats few-shot 540B PaLM with 80% data. Small models win at narrow, well-specified tasks — the case for a 1.5–3B translation layer.
- Qwen3 Technical Report — Yang et al., 2025 — **verified**
  - arXiv: https://arxiv.org/abs/2505.09388
  - Model: https://ollama.com/library/qwen3
  - Relevance: 0.6–235B family; Qwen3-4B rivals Qwen2.5-72B-Instruct; Apache 2.0; strong instruction following (fidelity proxy).

## Apple on-device foundation models

- Introducing Apple's On-Device and Server Foundation Models — Apple ML Research — **verified**
  - https://machinelearning.apple.com/research/introducing-apple-foundation-models
- Apple Intelligence Foundation Language Models — Apple, 2024 — **inherited**
  - arXiv: https://arxiv.org/abs/2407.21075
  - Relevance: ~3B on-device model, 30 tok/s (iPhone 15 Pro), strong IFEval instruction-following.

## Mechanism: in-context learning / attention priming

- Why Can GPT Learn In-Context? — Xie et al., 2022 — **inherited**
  - arXiv: https://arxiv.org/abs/2212.10559
- What learning algorithm is in-context learning? — Akyürek et al., 2022 — **inherited**
  - arXiv: https://arxiv.org/abs/2211.15661
- Transformers learn in-context by gradient descent — von Oswald et al., 2022 — **inherited**
  - arXiv: https://arxiv.org/abs/2212.07677

## Structured output / constrained decoding

- Outlines — Willard & Louf, 2023 — **inherited**
  - arXiv: https://arxiv.org/abs/2307.09702
  - Code: https://github.com/dottxt-ai/outlines
  - Relevance: grammar-safe structured generation — basis for SQZ's schema-constrained compressor.

## Evaluation

- MT-Bench / LLM-as-judge: Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena — Zheng et al., 2023 — **inherited**
  - arXiv: https://arxiv.org/abs/2306.05685
  - Relevance: LLM-judged roundtrip fidelity in SQZ bake-off.
