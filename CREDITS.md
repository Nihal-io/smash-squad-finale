# Credits

Third-party data and code used in this project, with licenses.

| What | Source | License | Use |
|---|---|---|---|
| Candidate-Job Matching Synthetic Dataset (10,000 resumes, 2,500 jobs, 2,500 match records) | https://huggingface.co/datasets/michaelozon/candidate-matching-synthetic (Michael Ozon, 2026) | MIT | 2,000 tech/data resumes form the public candidate pool, deterministically enriched with synthetic names, genders, colleges and project lines; 100 jobs with their matches drive the public retrieval eval |
| bge-small-en-v1.5 (ONNX, Xenova conversion) | https://huggingface.co/Xenova/bge-small-en-v1.5 | MIT (model, BAAI) | local 384-d embeddings |
| @huggingface/transformers | https://github.com/huggingface/transformers.js | Apache-2.0 | runs the embedding model in Node |
| hyparquet | https://github.com/hyparam/hyparquet | MIT | reads the dataset's parquet files |
| LangGraph.js | https://github.com/langchain-ai/langgraphjs | MIT | agent loop and checkpointing |
| quickjs-emscripten | https://github.com/justjake/quickjs-emscripten | MIT | sandboxed code execution for grading |
| pgvector | https://github.com/pgvector/pgvector | PostgreSQL License | vector search in Postgres |

All names, colleges, companies and people in the data are synthetic. No real individuals are represented.
