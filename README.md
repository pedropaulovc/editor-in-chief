# Editor-in-chief

A personal OMP editor for Pedro's engineering work. It collects bounded evidence from GitHub, Bluesky, and Hindsight, proposes story choices, and reviews human-written drafts in a public GitHub workspace.

The system prioritizes:

1. Harmonic Analyzer machining progress and its future Kickstarter;
2. side projects and open-source contributions;
3. reusable, demonstrated AI-assisted engineering workflows.

Pedro writes and publishes every piece. The editor asks questions about evidence and reader comprehension and suggests minimal grammar or spelling corrections. The weekly desk recommends one original by default, with a maximum of two when Pedro explicitly changes cadence. Blog and signup setup remain separate prerequisites.

## Public workspace

- [Editor-in-chief Project](https://github.com/users/pedropaulovc/projects/3)
- [Capture inbox](https://github.com/pedropaulovc/editor-in-chief/issues/1)
- [Weekly desks](https://github.com/pedropaulovc/editor-in-chief/issues?q=is%3Aissue%20label%3Aeditorial-desk%20sort%3Acreated-desc)
- [Public capture form](https://github.com/pedropaulovc/editor-in-chief/issues/new?template=capture.yml)
- [Manual publication form](https://github.com/pedropaulovc/editor-in-chief/issues/new?template=publication.yml)

The Project's `Status` field is the human-facing workflow: `Inbox`, `Selected`, `Drafting`, `Review`, `Ready`, `Published`, or `Parked`. Select or park stories manually. Automation advances a story to Published after accepting an original-publication record; a derivative does not advance it.

## Requirements and setup

This deployment expects:

- Bun and the GitHub CLI (`gh`);
- `gh` authenticated as `pedropaulovc` with repository and Projects access;
- OMP credentials available under `/home/pedro/.omp/agent`;
- `HINDSIGHT_API_TOKEN` in the configured dotenv file (currently `~/.omp/agent/.env`);
- a host with cron and its `crontab` command, configured for `America/Los_Angeles` before schedule installation.

From the repository root, install the pinned dependencies:

```sh
bun install --frozen-lockfile
bun run eic doctor
```

`doctor` probes GitHub, Bluesky, Hindsight, configured model/credential resolution, and the editor's empty tool roster. It initializes local state but sends no model prompt and performs no GitHub mutation. It does not test inference or Project mutation permissions; bootstrap exercises the latter.

A fresh clone is **not** scheduled automatically. Do not put credentials in `editorial.config.json` or commit local state.

## Configuration and state

[`editorial.config.json`](editorial.config.json) contains public source identities, timezone, cadence, and the exact model selector. Production pins `@oh-my-pi/pi-coding-agent` 18.2.7 and currently selects `openai-codex/gpt-5.6-sol` with medium thinking. The current config is authoritative if the historical plan names a different model selector.

Cadence is one of `weekly`, `twice-weekly`, or `paused`. The agent cannot change it.

Shared overrides are available on every command:

```sh
bun run eic status --config ./editorial.config.json --state-dir /private/path
```

Without `--state-dir`, an unset `XDG_STATE_HOME` uses `~/.local/state/editor-in-chief/`; a nonempty value uses `$XDG_STATE_HOME/editor-in-chief/`. Do not export `XDG_STATE_HOME` empty: the current implementation resolves that case to `/editor-in-chief`. The application sets the directory to mode `0700` and `state.sqlite` to `0600`.

## Bootstrap and runs

Create or reconcile the labels, Project, standing inbox, prerequisite issues, and current desk (unless cadence is `paused`):

```sh
bun run eic bootstrap --apply
```

Bootstrap is an explicit GitHub mutation and requires `--apply`. It is idempotent.

Exercise source collection and editorial judgment without GitHub writes:

```sh
bun run eic run --dry-run --state-dir "$(mktemp -d)"
```

Run against the production state and permit bounded GitHub writes:

```sh
bun run eic run --apply
```

`run` requires exactly one of `--dry-run` or `--apply`. Both modes collect evidence and may call the configured model. Dry-run writes operational state only in the selected directory, makes no GitHub writes, and never marks proposed writes as delivered. Its JSON output includes desk/review proposals; other workspace proposals remain in local state. Apply mode reconciles managed markers and preserves human text outside managed blocks.

Inspect operational state or search retained candidates without model calls or GitHub writes. These commands can initialize local SQLite state and metric-summary indexes:

```sh
bun run eic status
bun run eic status --search "machining"
```

For `run`, exit `0` means completed/no-op, including a skipped overlapping run; `2` means failed/partial evidence-source coverage or a nonfatal run-stage failure; `1` means a fatal CLI/configuration/model/schema/isolation error. Adapter authentication errors are reported as failed coverage (`2`). Metric unavailability alone does not change the run exit code; inspect `status` for it. `doctor` exits `1` when a capability is unavailable.

## Human draft review

Drafts remain human-authored:

1. Put draft material under `drafts/<story-issue-number>/`.
2. Open the PR in this repository as `pedropaulovc`, add the `editorial-draft` label, and include exactly one case-sensitive `Story: #<number>` line pointing to an `editorial-story` issue. All changed and renamed files must stay under that story's draft directory.
3. Open draft PRs are eligible. The editor reads supported UTF-8 text files at the exact head SHA; binary media is recorded as unseen, not inspected. Unsupported files, symlinks, submodules, and oversized drafts are refused. Nothing from a PR is checked out or executed.
4. For an immediate COMMENT review, run `bun run eic review --pr <number> --apply`. Use `--dry-run` instead to preview without posting.
5. Each head and policy version is reviewed once. Push a new head for a new review, or comment exactly `/eic review` as `pedropaulovc` to request one additional round.

The editor does not commit prose. Pedro decides which findings to apply and when to publish. A merged draft is not a publication.

## Manual publication and metrics

Use the [publication form](https://github.com/pedropaulovc/editor-in-chief/issues/new?template=publication.yml), or set `STORY_ISSUE`, `PUBLISHED_URL`, and `PUBLISHED_AT` to your actual story number, publication URL, and publication timestamp before running:

```sh
bun run eic record-publication \
  --issue "$STORY_ISSUE" --channel blog \
  --url "$PUBLISHED_URL" --published-at "$PUBLISHED_AT" --kind original
```

This command applies by default, updating local state, the story issue, and possibly its Project status. Add `--dry-run` to preview. The story must already be an `editorial-story` issue.

Supported channels are `blog`, `bluesky`, `linkedin`, `youtube`, and `tiktok`; kind is `original` or `derivative`. URLs must be HTTPS without embedded credentials; timestamps must include a timezone offset or `Z`. Registration relies on your declaration that the publication exists; it does not verify reachability or ownership. Supported Bluesky post URLs can trigger interaction-metric queries to the fixed public Bluesky API; arbitrary submitted URLs are never fetched.

Manual metric imports are strict JSON arrays. Each object contains `storyIssue`, `channel`, `url`, `observedAt`, `metric`, a finite nonnegative `value`, `unit`, `windowStart`, `windowEnd`, and optional HTTPS `evidenceUrl`:

```sh
bun run eic import-metrics ./metrics.json
bun run eic import-metrics ./metrics.json --replace
```

Imports always write the selected SQLite state; `--dry-run` does not preview them. Rehearse with an isolated `--state-dir`. All timestamps require an explicit timezone; require `windowStart <= windowEnd <= observedAt`, with no future observation time. URLs must be HTTPS without embedded credentials; extra fields are rejected.

Identical observations are idempotent. `--replace` corrects an existing stored observation and audits its prior value. Conflicting duplicate keys within one input file are rejected even with `--replace`. See the [approved implementation plan](docs/editor-in-chief-plan.md) for the detailed metric and provenance contract.

## Scheduling

Scheduling is an explicit operator action after smoke verification:

```sh
bun run eic schedule show
bun run eic schedule install
bun run eic schedule show
```

Installation manages only the marked `editor-in-chief` user-crontab block and schedules `run --apply` at 08:00, 14:00, and 20:00 in the configured timezone. It refuses an unverifiable or mismatched host timezone. Remove only that managed block with:

```sh
bun run eic schedule remove
```

Scheduler actions have no dry-run mode: `install` and `remove` edit crontab even if `--dry-run` is supplied. Removal also clears local schedule metadata. Use `schedule show` to inspect the installed schedule without editing crontab.

Cron runs only while the WSL host is up. Missed firings are not replayed; the next run resumes source windows and creates at most the current week's desk.

## Development verification

Workspace tests run separately because the workspace suite uses module mocks and must execute in its own Bun process:

```sh
bun test tests/contracts.test.ts tests/editor.test.ts tests/metrics-schedule.test.ts tests/runner.test.ts tests/sources.test.ts
bun test tests/workspace.test.ts
bunx tsc --noEmit
```

The full design, safety boundaries, source coverage limits, and operational verification plan are preserved in [`docs/editor-in-chief-plan.md`](docs/editor-in-chief-plan.md).
