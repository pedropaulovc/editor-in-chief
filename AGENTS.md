# Contributor instructions

This file is for coding agents and contributors. It is not the production editor persona; that policy lives in [`prompts/editor-in-chief.md`](prompts/editor-in-chief.md). Start with the user/operator overview in [`README.md`](README.md). The approved historical design record is [`docs/editor-in-chief-plan.md`](docs/editor-in-chief-plan.md); preserve it rather than updating it to describe later implementation changes. Runtime defaults come from the validated [`editorial.config.json`](editorial.config.json), not from the plan.

## Architecture

- `src/cli.ts` parses commands and explicit `--dry-run`/`--apply` modes. `src/config.ts` validates operator-controlled configuration; `src/state.ts` owns the private SQLite state directory, evidence, candidates, publications, metrics, and outbox.
- `src/sources/{github,bluesky,hindsight}.ts` collect bounded evidence. `src/github-api.ts` is the GitHub transport. `src/safety.ts` loads designated secrets host-side and rejects unsafe public/model-bound text.
- `src/contracts.ts` defines evidence and strict model/result schemas. `src/model-packet.ts` selects bounded evidence. `src/editor.ts` creates and validates the restricted OMP session.
- `src/workspace.ts` is the GitHub issue, Project, draft-review, publication, and durable-delivery boundary. `src/metrics.ts` stores observed/manual measurements without inventing unavailable metrics.
- `src/run.ts` coordinates locking, source collection, triage, desk work, reviews, metrics, checkpoints, and status. `src/calendar.ts` and `src/schedule.ts` own local-week and cron behavior.

## Safety and behavior invariants

- The host owns network calls, persistence, and GitHub mutations. Treat model output as structured data: validate its schema and semantics, sanitize fields before rendering, and never execute model-selected endpoints, API requests, commands, or local file writes.
- Keep the OMP SDK pinned to `@oh-my-pi/pi-coding-agent@18.2.7` unless an intentional, verified upgrade is requested. Sessions must use the exact configured model, the replacement persona prompt, in-memory session state, disabled discovery/MCP/LSP/memory/autolearn, and a hard empty tool allowlist. Both active and enabled tool rosters must remain empty before and after prompting; fail closed rather than adding a fallback runtime.
- Treat validated local configuration as trusted operator input. Treat source payloads, API errors, draft text, Hindsight results, and model results as untrusted. Keep credentials host-side, never source or dump the dotenv file, and never log raw request/response bodies or prompts. Never request arbitrary submitted URLs or metric evidence URLs. Supported Bluesky publication URLs may be parsed into identifiers for fixed-provider API queries.
- Preserve evidence IDs, revisions, timestamps, source URLs, authorship distinctions, verification status, and `provenance`. Hindsight retrieval is ranked and may be partial; GitHub and Bluesky scans may retain pending pages/windows. Do not advance completeness checkpoints across skipped work or convert unavailable/partial coverage to zero/complete.
- Do not weaken the durable outbox. Record intent before remote mutation, reconcile stable remote markers after uncertain delivery, and mark delivery only after success. Keep network/model calls outside SQLite transactions.
- Never set `Selected` or `Parked` automatically. Preserve `Parked` and re-read the remote Project status before a transition; cancel if it differs from the planned value. GitHub's status read and write are not atomic, so minimize that interval. Keep Published stories Published during later derivative reviews.
- Tie automated `Ready` transitions to a validated review for the current PR head and policy version. Recheck the head before review submission and Project transition. On a changed head, discard stale output and queue the latest revision; Project reconciliation happens on a subsequent pass.
- Cadence is operator-controlled: `weekly`, `twice-weekly`, or `paused`. The cap is one original recommendation at weekly cadence, two at twice-weekly, and none while paused; never automatically increase it. Derivatives do not consume another original quota.
- Draft prose is human-authored. The application may submit COMMENT reviews with at most five high-impact findings and exact-span grammar replacements of at most 12 words. Preserve intentional fragments and stylistic choices; changes to measurements or units require an evidence question. Never commit editorial prose, ghostwrite drafts, approve as Pedro, infer publication from a merge, or publish automatically. Publication requires an explicit manual record.
- Harmonic Analyzer facts belong in its canonical [`logbook/entries/TEMPLATE.md`](https://github.com/pedropaulovc/harmonic-analyzer/blob/main/logbook/entries/TEMPLATE.md) workflow. Do not create a competing factual logbook here or treat a CAD commit as proof of a shop session.

## Verification boundaries

Routine isolated verification uses the repository's Bun/TypeScript toolchain. Because `tests/workspace.test.ts` installs a process-wide module mock for the GitHub transport, run it in a separate Bun process:

```sh
bun test tests/contracts.test.ts tests/editor.test.ts tests/metrics-schedule.test.ts tests/runner.test.ts tests/sources.test.ts
bun test tests/workspace.test.ts
bunx tsc --noEmit
```

`package.json` currently exposes `bun test`, but that shorthand does not preserve the required workspace-test process split; do not advertise it as equivalent. Keep tests on temporary state directories and stubbed transports.

The following are operational checks, not routine isolated tests:

- `bun run eic doctor` contacts live services, resolves the configured model/credential store, checks tool isolation, and initializes local state. It sends no model prompt or GitHub mutation and does not test inference or Project mutation permissions.
- `bun run eic run --dry-run --state-dir <temporary-private-directory>` contacts live sources and may invoke the configured model, consuming provider quota, while avoiding GitHub writes.
- Apply runs and reviews mutate GitHub. `record-publication` applies by default unless `--dry-run` is supplied. Metric imports always write the selected SQLite state; `schedule install|remove` always edit crontab. Neither imports nor scheduler actions honor `--dry-run`.

Do not mutate production state, GitHub, publications, or scheduling merely to validate a code change. Live or mutating verification requires the task's explicit scope and the smallest safe command/state directory. `status` avoids model calls and GitHub writes but may initialize local SQLite state and metric-summary indexes; use an isolated state directory for routine checks.

## Repository workflow

For this public personal repository only, work directly on `main`: make scoped commits, run the relevant verification, then push. Implementation PR ceremony is not required. Do not generalize that workflow to other repositories. Keep secrets, local state, generated run artifacts, and media out of commits, and do not mix editorial draft changes with implementation changes.
