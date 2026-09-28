# gjc ralplan fixtures

Shape fixtures for `tests/ralplan-gjc-compat.test.ts` (key sets, value types, naming). Stage bodies are not copied.

- Source: gajae-code (gjc) 5c5231418930673e42cc5d08ebe4376e03187533, MIT.
- `ledger/*.index.jsonl` and `filenames.json`: two real gjc ralplan runs (`.gjc/_session-01a0ba1a-c9c1-7188-8020-24474005f3f9/plans/ralplan/<run>/`).
- `receipts/*.json`: `gjc ralplan --write --json` receipts captured in gjc session logs (planner, architect, final, deduplicated final).
- `disposition.json`: the closed `ralplan.review_conflicts.v1` document from gjc `test/gjc-runtime/ralplan-runtime.test.ts:714-757`; receipt paths and hashes are placeholders.
- Every absolute path prefix was replaced with `/fixture-root`.
