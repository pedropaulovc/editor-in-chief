import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state";
import { evidencePacket, status, withLock } from "../src/run";
import type { Context, Evidence } from "../src/contracts";
import { loadConfig } from "../src/config";
import { triageRequest, deskRequest } from "../src/model-packet";

async function fixture(body: (ctx: Context) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "eic-regression-"));
  const state = new State(directory);
  try {
    await body({
      state,
      config: await loadConfig(),
      now: new Date("2026-09-21T16:00:00Z"),
      mode: "dry-run",
      signal: new AbortController().signal,
    });
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
test("overlapping invocation skips while the owner retains the lock", async () =>
  fixture(async (ctx) => {
    let entered = false;
    await withLock(ctx, async () => {
      expect(
        await withLock(ctx, async () => {
          entered = true;
        }),
      ).toEqual({ status: "skipped-overlap" });
    });
    expect(entered).toBe(false);
    await withLock(ctx, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  }));
test("a crowded GitHub feed cannot starve sources or consume unseen revisions", async () =>
  fixture(async (ctx) => {
    const base = {
      observedAt: ctx.now.toISOString(),
      occurredAt: ctx.now.toISOString(),
      revision: "one",
      text: "evidence",
      provenance: {},
    };
    const evidence: Evidence[] = [
      ...Array.from({ length: 200 }, (_, i) => ({
        ...base,
        id: `gh-${i}`,
        source: "github" as const,
        sourceUrl: `https://github.com/pedropaulovc/oh-my-pi/commit/${i}`,
      })),
      {
        ...base,
        id: "ha",
        source: "github",
        sourceUrl:
          "https://github.com/pedropaulovc/harmonic-analyzer/commit/one",
      },
      {
        ...base,
        id: "bsky",
        source: "bluesky",
        sourceUrl: "https://bsky.app/profile/example/post/example",
      },
      { ...base, id: "memory", source: "hindsight", sourceUrl: null },
    ];
    expect(ctx.state.putEvidence(evidence)).toBe(203);
    expect(ctx.state.putEvidence(evidence)).toBe(0);
    const first = evidencePacket(ctx, 8);
    expect(first.map((e) => e.id)).toContain("ha");
    expect(first.map((e) => e.id)).toContain("bsky");
    expect(first.map((e) => e.id)).toContain("memory");
    for (const item of first)
      ctx.state.set(`triaged:${item.id}`, item.revision);
    expect(evidencePacket(ctx, 500)).toHaveLength(195);
    ctx.state.putEvidence([{ ...evidence.at(-1)!, revision: "two" }]);
    expect(
      evidencePacket(ctx, 8).some(
        (e) => e.id === "memory" && e.revision === "two",
      ),
    ).toBe(true);
  }));
test("large durable history stays usable in model packets and concise status", async () =>
  fixture(async (ctx) => {
    const base = {
      source: "github" as const,
      sourceUrl:
        "https://github.com/pedropaulovc/harmonic-analyzer/commit/proof",
      observedAt: ctx.now.toISOString(),
      occurredAt: ctx.now.toISOString(),
      revision: "one",
      text: "measured repair ".repeat(400),
      provenance: {},
    };
    const evidence: Evidence[] = Array.from({ length: 60 }, (_, i) => ({
      ...base,
      id: `proof-${i}`,
    }));
    ctx.state.putEvidence(evidence);
    for (let i = 0; i < 300; i++)
      ctx.state.putCandidate({
        id: `candidate-${i}`,
        topic: i === 0 ? "measured repair" : "Other engineering",
        sourceIds: [`proof-${i % 60}`],
        pillar:
          i % 3 === 0
            ? "harmonic-analyzer"
            : i % 3 === 1
              ? "ai-engineering"
              : "side-projects",
        readerQuestions: Array(5).fill("q".repeat(500)),
        missingEvidence: Array(8).fill("m".repeat(300)),
        createdAt: ctx.now.toISOString(),
        status: i === 0 ? "Selected" : "Inbox",
      });
    const triage = triageRequest(ctx, evidence);
    expect(JSON.stringify(triage).length).toBeLessThanOrEqual(400000);
    expect(triage.evidence.length).toBeGreaterThan(0);
    const desk = deskRequest(ctx, { blogReadership: "unavailable" });
    expect(JSON.stringify(desk).length).toBeLessThanOrEqual(400000);
    expect(desk.active.map((candidate) => candidate.id)).toContain(
      "candidate-0",
    );
    expect(
      new Set(desk.candidates.map((candidate) => candidate.pillar)).size,
    ).toBe(3);
    expect(
      desk.evidence.every((source) =>
        desk.candidates.some((candidate) =>
          candidate.sourceIds.includes(source.id),
        ),
      ),
    ).toBe(true);
    expect(ctx.state.candidates()).toHaveLength(300);
    const coverage = {
      source: "github",
      status: "degraded",
      count: 60,
      blockers: ["Traffic permission unavailable"],
    };
    ctx.state.set("coverage:github", coverage);
    const observedAt = ctx.now.toISOString();
    ctx.state.db.transaction(() => {
      for (let index = 0; index < 500; index++) {
        const repository = `${ctx.config.githubOwner}/${index === 0 ? "harmonic-analyzer" : `repo-${index}`}`;
        for (const [kind, fields] of [
          ["github-daily", { date: "2026-09-20" }],
          [
            "github-window",
            {
              uniques: 2,
              windowStart: "2026-09-07T00:00:00.000Z",
              windowEnd: "2026-09-20T00:00:00.000Z",
            },
          ],
        ] as const)
          ctx.state.db.query("INSERT INTO metrics(key,data) VALUES(?,?)").run(
            `${kind}:${index}`,
            JSON.stringify({
              kind,
              provenance: "github-traffic",
              repository,
              metric: "views",
              value: 10,
              observedAt,
              ...fields,
            }),
          );
      }
    })();
    const report = status(ctx);
    expect(report.coverage[0]).toEqual(coverage);
    expect(report.candidateCounts).toMatchObject({ backlog: 300, active: 1 });
    expect(report.active).toEqual([
      {
        id: "candidate-0",
        topic: "measured repair",
        pillar: "harmonic-analyzer",
        status: "Selected",
        issueNumber: null,
        evidenceCount: 1,
        missingEvidenceCount: 8,
      },
    ]);
    expect(report.metrics.reportedCounts.dailyRows).toBe(500);
    expect(
      report.metrics.latestWindows[
        `${ctx.config.githubOwner}/harmonic-analyzer:views`
      ],
    ).toEqual({
      observedAt,
      start: "2026-09-07T00:00:00.000Z",
      end: "2026-09-20T00:00:00.000Z",
    });
    expect(report.metrics.blogReadership).toContain("unavailable");
    expect(report.metrics.conversion).toContain("Unavailable");
    expect(JSON.stringify(report, null, 2).length).toBeLessThan(12_000);
    expect(ctx.state.candidates()).toHaveLength(300);
    expect(
      ctx.state.db.query("SELECT COUNT(*) AS count FROM metrics").get(),
    ).toEqual({ count: 1_000 });
    ctx.state.putCandidate({
      ...ctx.state.candidates()[0]!,
      id: "archived-match",
      topic: "Archived experiment",
      missingEvidence: ["Searchable old calibration gap"],
      status: "Inbox",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      status(ctx).backlog!.some(
        (candidate) => candidate.id === "archived-match",
      ),
    ).toBe(false);
    const searched = status(ctx, "  CALIBRATION GAP  ");
    expect(searched.backlog!.map((candidate) => candidate.id)).toEqual([
      "archived-match",
    ]);
    expect(searched.candidateCounts).toMatchObject({
      total: 301,
      matching: 1,
      backlog: 301,
      matchingBacklog: 1,
      matchingActive: 0,
    });
  }));
