import { createHash, randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Context, Coverage, Evidence, Candidate } from "./contracts";
import { collectGithub } from "./sources/github";
import { collectBluesky } from "./sources/bluesky";
import { collectHindsight } from "./sources/hindsight";
import { edit } from "./editor";
import {
  applyDesk,
  syncWorkspace,
  eligibleReviews,
  reviewPullRequest,
  reportBlockers,
} from "./workspace";
import { collectMetrics, metricsSummary } from "./metrics";
import { isoWeek } from "./calendar";
import { sanitizeError } from "./safety";
import { triageRequest, deskRequest } from "./model-packet";
import { ApiError } from "./github-api";

export async function withLock<T>(
  ctx: Context,
  operation: () => Promise<T>,
): Promise<T | { status: "skipped-overlap" }> {
  const file = join(ctx.state.directory, "run.lock");
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    let pid: number;
    try {
      pid = JSON.parse(readFileSync(file, "utf8")).pid;
    } catch {
      throw new Error(
        "Unreadable run lock; inspect state directory before removing it",
      );
    }
    try {
      process.kill(pid, 0);
      return { status: "skipped-overlap" };
    } catch (e: any) {
      if (e.code !== "ESRCH") return { status: "skipped-overlap" };
    }
    unlinkSync(file);
    try {
      fd = openSync(file, "wx", 0o600);
    } catch {
      return { status: "skipped-overlap" };
    }
  }
  writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, startedAt: ctx.now.toISOString() }),
  );
  closeSync(fd);
  try {
    return await operation();
  } finally {
    try {
      const lock = JSON.parse(readFileSync(file, "utf8"));
      if (lock.pid === process.pid) unlinkSync(file);
    } catch {}
  }
}

export function evidencePacket(ctx: Context, limit = 60): Evidence[] {
  const rows = ctx.state.db
    .query(
      `WITH pending AS (
 SELECT e.id,e.data,e.observed_at,
 CASE WHEN (e.source='github' AND json_extract(e.data,'$.sourceUrl') LIKE '%/harmonic-analyzer/%') OR (e.source='hindsight' AND json_extract(e.data,'$.provenance.bank')='omp-harmonic-analyzer') THEN 0
 WHEN e.source='hindsight' THEN 1 WHEN e.source='bluesky' THEN 2 ELSE 3 END AS bucket
 FROM evidence e LEFT JOIN kv k ON k.key='triaged:'||e.id
 WHERE k.value IS NULL OR json_extract(k.value,'$')<>e.revision
 ), ranked AS (SELECT data,bucket,row_number() OVER(PARTITION BY bucket ORDER BY observed_at DESC,id) AS ordinal FROM pending)
 SELECT data FROM ranked ORDER BY ordinal,bucket LIMIT ?`,
    )
    .all(limit) as { data: string }[];
  return rows.map((row) => JSON.parse(row.data));
}

export async function run(ctx: Context) {
  const id = randomUUID(),
    started = Date.now(),
    logs: unknown[] = [],
    proposals: unknown[] = [];
  const log = (phase: string, detail: unknown) =>
    logs.push({ runId: id, at: new Date().toISOString(), phase, detail });
  const coverage: Coverage[] = [];
  let failure: string | null = null;
  const history = ctx.state.get<{ from: string; cadence: string }[]>(
    "cadence-history",
    [],
  );
  if (history.at(-1)?.cadence !== ctx.config.cadence) {
    history.push({ from: ctx.now.toISOString(), cadence: ctx.config.cadence });
    ctx.state.set("cadence-history", history);
  }
  const week = isoWeek(ctx.now, ctx.config.timezone);
  if (ctx.config.cadence === "paused") {
    const paused = ctx.state.get<string[]>("cadence:paused-weeks", []);
    ctx.state.set("cadence:paused-weeks", [...new Set([...paused, week])]);
  }
  try {
    const collectors = [
      ["github", collectGithub],
      ["bluesky", collectBluesky],
      ["hindsight", collectHindsight],
    ] as const;
    await Promise.all(
      collectors.map(async ([source, collect]) => {
        try {
          const result = await collect(ctx);
          const changed = ctx.state.putEvidence(result.evidence);
          coverage.push(result.coverage);
          log("source", { ...result.coverage, changed });
        } catch (error) {
          const detail = sanitizeError(error);
          coverage.push({ source, status: "failed", count: 0, detail });
          log("source", { source, status: "failed", detail });
        }
      }),
    );
    for (const c of coverage)
      ctx.state.set(`coverage:${c.source}`, {
        ...c,
        observedAt: ctx.now.toISOString(),
      });
    await syncWorkspace(ctx);
    const request = triageRequest(ctx, evidencePacket(ctx));
    const packet = request.evidence;
    if (packet.length) {
      const response = await edit(ctx, request);
      log("model", {
        kind: "triage",
        model: response.model,
        usage: response.usage,
        tools: response.tools,
      });
      if (response.result.kind !== "triage")
        throw new Error("Wrong triage result");
      ctx.state.db.transaction(() => {
        for (const item of response.result.kind === "triage"
          ? response.result.candidates
          : []) {
          const existing = item.existingCandidateId
            ? ctx.state
                .candidates()
                .find((c) => c.id === item.existingCandidateId)
            : undefined;
          const candidateId =
            existing?.id ??
            createHash("sha256")
              .update([...item.sourceIds].sort().join("\n"))
              .digest("hex")
              .slice(0, 16);
          const candidate: Candidate = {
            ...existing,
            id: candidateId,
            topic: item.topic,
            sourceIds: [
              ...new Set([...(existing?.sourceIds ?? []), ...item.sourceIds]),
            ],
            pillar: item.pillar,
            readerQuestions: item.readerQuestions,
            missingEvidence: item.missingEvidence,
            createdAt: existing?.createdAt ?? ctx.now.toISOString(),
          };
          ctx.state.putCandidate(candidate);
        }
        for (const e of packet) ctx.state.set(`triaged:${e.id}`, e.revision);
      })();
      log("triage", {
        evidence: packet.length,
        candidates: ctx.state.candidates().length,
      });
      await syncWorkspace(ctx);
    }
    for (const pr of await eligibleReviews(ctx)) {
      if (ctx.signal.aborted) throw new Error("Run deadline exceeded");
      const review = await reviewPullRequest(ctx, pr, edit);
      if (ctx.mode === "dry-run") proposals.push(review);
      log("review", { pr, status: "processed" });
    }
    try {
      log("metrics", await collectMetrics(ctx));
    } catch {
      log("metrics", { status: "unavailable" });
    }
    if (
      ctx.config.cadence !== "paused" &&
      !ctx.state.get(`desk:${week}:delivered`, false)
    ) {
      const request = deskRequest(ctx, metricsSummary(ctx));
      if (request.candidates.length) {
        const response = await edit(ctx, request);
        log("model", {
          kind: "desk",
          model: response.model,
          usage: response.usage,
          tools: response.tools,
        });
        if (response.result.kind !== "desk")
          throw new Error("Wrong desk result");
        const desk = await applyDesk(ctx, response.result);
        if (ctx.mode === "dry-run")
          proposals.push({
            kind: "desk",
            result: response.result,
            changes: desk,
          });
        log("desk", {
          week,
          choices: response.result.choices.map((c) => c.candidateId),
          recommendations: response.result.recommendations,
        });
      }
    }
    await reportBlockers(ctx, coverage);
  } catch (error) {
    failure = sanitizeError(error);
    const fatal =
      (error instanceof ApiError && [401, 403].includes(error.status)) ||
      (error instanceof Error &&
        (/schema|configured-model|isolation|result-must|wrong.*result|validation/i.test(
          error.message,
        ) ||
          error.name === "ZodError"));
    ctx.state.set("last-failure-code", fatal ? 1 : 2);
    log("failure", { detail: failure });
    try {
      await reportBlockers(ctx, coverage, [failure]);
    } catch {
      ctx.state.set("workspace:blockers-pending", {
        fingerprint: "local-failure",
        failures: [
          { source: "editorial-operation", status: "failed", detail: failure },
        ],
      });
    }
  }
  const partial = coverage.some(
    (c) => c.status === "failed" || c.status === "partial",
  );
  const exitCode = failure
    ? ctx.state.get<number>("last-failure-code", 2)
    : partial
      ? 2
      : 0;
  const result = {
    runId: id,
    status: failure
      ? exitCode === 1
        ? "failed"
        : "partial"
      : partial
        ? "partial"
        : ctx.config.cadence === "paused"
          ? "paused"
          : "successful",
    mode: ctx.mode,
    startedAt: ctx.now.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    coverage,
    failure,
    exitCode,
  };
  ctx.state.set("last-run", result);
  const dir = join(ctx.state.directory, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${ctx.now.toISOString().replaceAll(":", "-")}-${id}.jsonl`),
    [...logs, { phase: "complete", ...result }]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const old of files.slice(0, -90)) unlinkSync(join(dir, old));
  return { ...result, ...(ctx.mode === "dry-run" ? { proposals } : {}) };
}

export function status(ctx: Context) {
  const last = ctx.state.get<any>("last-run", null),
    candidates = ctx.state.candidates();
  const pending = ctx.state.db
    .query(
      `SELECT count(*) AS count FROM evidence e LEFT JOIN kv k ON k.key='triaged:'||e.id WHERE k.value IS NULL OR json_extract(k.value,'$')<>e.revision`,
    )
    .get() as { count: number };
  return {
    state: last
      ? Date.now() - Date.parse(last.completedAt) > 36 * 3600e3
        ? "stale"
        : last.status
      : "never-run",
    cadence: ctx.config.cadence,
    lastRun: last,
    coverage: ["github", "bluesky", "hindsight"].map((s) =>
      ctx.state.get(`coverage:${s}`, { source: s, status: "never-run" }),
    ),
    backlog: candidates.filter((c) => !c.issueNumber),
    active: candidates.filter((c) =>
      ["Selected", "Drafting", "Review", "Ready"].includes(c.status ?? ""),
    ),
    pendingEvidence: pending.count,
    pendingReviews: ctx.state.get("pending-reviews", []),
    metrics: metricsSummary(ctx),
  };
}
