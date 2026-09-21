import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state";
import { evidencePacket, withLock } from "../src/run";
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
test("large durable candidate history stays usable within the model envelope", async () =>
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
  }));
