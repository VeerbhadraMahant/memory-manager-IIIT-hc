# Evaluation harnesses

Scripts that turn published benchmarks and synthetic fixtures into the tables the paper
reports. See `docs/RESEARCH_CONTRACT.md` for which feature each one serves.

- Benchmark data is downloaded into `backend/eval/data/`, which is gitignored. Licences
  vary, so the data is never committed; each loader prints the source and licence it
  expects.
- Harnesses that need no model run anywhere. Harnesses that call a model say so in
  their `--help`, never run in CI, and report which provider and model produced each
  number.
