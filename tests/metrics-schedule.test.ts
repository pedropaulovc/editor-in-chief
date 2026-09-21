import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state";
import { loadConfig } from "../src/config";
import type { Context, Publication } from "../src/contracts";
import {
  collectMetrics,
  deskMetrics,
  importMetrics,
  metricsSummary,
} from "../src/metrics";
import { isoWeek, nextSlots } from "../src/calendar";
import { assertCronTimezone, updateCrontab } from "../src/schedule";

async function fixture(body: (ctx: Context) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "eic-metric-regression-"));
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

test("metric conflicts roll back the whole batch; replacements audit one observation rather than double-counting", async () =>
  fixture(async (ctx) => {
    const path = join(ctx.state.directory, "import.json");
    const first = {
      storyIssue: 42,
      channel: "blog",
      url: "https://example.org/post",
      observedAt: "2026-09-21T12:00:00Z",
      metric: "views",
      value: 100,
      unit: "views",
      windowStart: "2026-09-20T12:00:00Z",
      windowEnd: "2026-09-21T12:00:00Z",
      evidenceUrl: "https://example.org/report/one",
    };
    writeFileSync(path, JSON.stringify([first]));
    expect((await importMetrics(ctx, path)).inserted).toBe(1);
    expect((await importMetrics(ctx, path)).unchanged).toBe(1);
    const correction = {
      ...first,
      value: 102,
      evidenceUrl: "https://example.org/report/corrected",
    };
    writeFileSync(
      path,
      JSON.stringify([{ ...first, metric: "visitors", value: 40 }, correction]),
    );
    await expect(importMetrics(ctx, path)).rejects.toThrow(
      "no changes committed",
    );
    const before = metricsSummary(ctx).channels.find(
      (channel) => channel.channel === "blog",
    )!.measurements;
    expect(before.map((value) => [value.metric, value.value])).toEqual([
      ["views", 100],
    ]);
    writeFileSync(path, JSON.stringify([correction]));
    expect(await importMetrics(ctx, path, true)).toMatchObject({
      inserted: 0,
      replaced: 1,
      observations: 1,
    });
    const after = metricsSummary(ctx).channels.find(
      (channel) => channel.channel === "blog",
    )!.measurements;
    expect(
      after.map((value) => [value.metric, value.value, value.evidenceUrl]),
    ).toEqual([["views", 102, correction.evidenceUrl]]);
    const audit = ctx.state.db.query("SELECT data FROM metric_audit").all() as {
      data: string;
    }[];
    expect(audit.map((row) => JSON.parse(row.data))).toMatchObject([
      { previous: { value: 100 }, replacement: { value: 102 } },
    ]);
    expect((await importMetrics(ctx, path, true)).unchanged).toBe(1);
    expect(
      ctx.state.db.query("SELECT COUNT(*) AS count FROM metric_audit").get(),
    ).toEqual({ count: 1 });
  }));

test("manual import rejects invalid windows and unknown fields before committing any aggregates", async () =>
  fixture(async (ctx) => {
    const path = join(ctx.state.directory, "invalid.json");
    const metric = {
      storyIssue: 42,
      channel: "blog",
      url: "https://example.org/post",
      observedAt: "2026-09-21T12:00:00Z",
      metric: "views",
      value: 1,
      unit: "views",
      windowStart: "2026-09-20T12:00:00Z",
      windowEnd: "2026-09-21T12:00:00Z",
    };
    writeFileSync(
      path,
      JSON.stringify([
        metric,
        { ...metric, metric: "visitors", windowEnd: "2026-09-22T12:00:00Z" },
      ]),
    );
    await expect(importMetrics(ctx, path)).rejects.toThrow(
      "Invalid metric import",
    );
    expect(
      metricsSummary(ctx).channels.find(
        (channel) => channel.channel === "blog",
      )!.availability,
    ).toBe("unavailable");
    writeFileSync(
      path,
      JSON.stringify([
        { ...metric, subscriberEmail: "not-accepted@example.org" },
      ]),
    );
    await expect(importMetrics(ctx, path)).rejects.toThrow(
      "Invalid metric import",
    );
  }));

test("one original and two derivatives retain all URLs without becoming three original publications", async () =>
  fixture(async (ctx) => {
    const publications: Publication[] = [
      {
        storyIssue: 42,
        channel: "blog",
        url: "https://example.org/original",
        publishedAt: "2026-09-20T12:00:00Z",
        kind: "original",
      },
      {
        storyIssue: 42,
        channel: "youtube",
        url: "https://www.youtube.com/watch?v=example",
        publishedAt: "2026-09-21T12:00:00Z",
        kind: "derivative",
      },
      {
        storyIssue: 42,
        channel: "tiktok",
        url: "https://www.tiktok.com/@example/video/1",
        publishedAt: "2026-09-21T12:00:00Z",
        kind: "derivative",
      },
    ];
    for (const publication of publications)
      ctx.state.db
        .query("INSERT INTO publications(key,data) VALUES(?,?)")
        .run(publication.url, JSON.stringify(publication));
    ctx.state.set("cadence-history", [
      { from: "2026-09-07T07:00:00Z", cadence: "weekly" },
    ]);
    ctx.state.set("cadence:paused-weeks", ["2026-W37"]);
    const summary = metricsSummary(ctx);
    expect(
      ctx.state
        .publications()
        .map((publication) => publication.url)
        .sort(),
    ).toEqual(publications.map((publication) => publication.url).sort());
    expect(summary.consistency).toMatchObject({
      originalPublications: 1,
      completedEligibleWeeks: 1,
      weeksWithOriginal: 1,
      consistency: 1,
    });
    expect(summary.blogReadership).toEqual([]);
    expect(summary.signupObservations).toEqual([]);
  }));

test("corrected traffic replaces daily counts; late publication snapshots keep actual ages and never sum rolling uniques", async () =>
  fixture(async (ctx) => {
    ctx.now = new Date("2026-09-21T00:00:00Z");
    const publication: Publication = {
      storyIssue: 42,
      channel: "bluesky",
      url: `https://bsky.app/profile/${ctx.config.blueskyHandle}/post/example`,
      publishedAt: "2026-08-20T00:00:00Z",
      kind: "original",
    };
    ctx.state.db
      .query("INSERT INTO publications(key,data) VALUES(?,?)")
      .run(publication.url, JSON.stringify(publication));
    const originalSpawn = Bun.spawn;
    const originalFetch = globalThis.fetch;
    let corrected = false;
    const primary = [
      `${ctx.config.githubOwner}/harmonic-analyzer`,
      `${ctx.config.githubOwner}/el400`,
    ];
    const secondary = Array.from(
      { length: 9 },
      (_, index) => `${ctx.config.githubOwner}/aaa-${index}`,
    );
    ctx.state.set(
      "source:github:repositories",
      Object.fromEntries(
        secondary.map((fullName) => [
          fullName,
          {
            fullName,
            owner: ctx.config.githubOwner,
            contributed: true,
            public: true,
          },
        ]),
      ),
    );
    const sampled: string[] = [];
    const transport = (args: unknown) => {
      if (!Array.isArray(args) || args[0] !== "gh" || args[1] !== "api")
        throw new Error("Unexpected subprocess in metric fixture");
      const endpoint = String(args[2]);
      const match = endpoint.match(
        /^repos\/([^/]+\/[^/]+)\/traffic\/(?:(views|clones)\?per=day|popular\/(paths|referrers))$/,
      );
      const metric = match?.[2] ?? match?.[3];
      if (!match || !metric)
        throw new Error("Unexpected GitHub endpoint in metric fixture");
      if (metric === "views") sampled.push(match[1]!);
      const forbidden = corrected && metric === "clones";
      let body: unknown;
      if (metric === "views" || metric === "clones") {
        body = {
          count: corrected ? 18 : 12,
          uniques: corrected ? 7 : 5,
          [metric]: [
            {
              timestamp: "2026-09-20T00:00:00Z",
              count: corrected ? 18 : 12,
              uniques: corrected ? 7 : 5,
            },
          ],
        };
      } else
        body =
          metric === "paths"
            ? [{ path: "/README.md", count: 4, uniques: 3 }]
            : [{ referrer: "github.com", count: 3, uniques: 2 }];
      return {
        stdout: new Blob([forbidden ? "" : JSON.stringify(body)]).stream(),
        stderr: new Blob([
          forbidden ? "gh: Resource inaccessible (HTTP 403)" : "",
        ]).stream(),
        exited: Promise.resolve(forbidden ? 1 : 0),
        kill() {
          return true;
        },
      };
    };
    Bun.spawn = transport as unknown as typeof Bun.spawn;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.hostname !== "public.api.bsky.app")
        throw new Error("Arbitrary publication URL fetch is prohibited");
      if (url.pathname.endsWith("/app.bsky.actor.getProfile"))
        return Response.json({ did: "did:plc:example", followersCount: 50 });
      if (url.pathname.endsWith("/app.bsky.feed.getPosts"))
        return Response.json({
          posts: url.searchParams.getAll("uris").map((uri) => ({
            uri,
            cid: "cid-example",
            author: { did: "did:plc:example" },
            likeCount: corrected ? 20 : 10,
            repostCount: 3,
          })),
        });
      throw new Error("Unexpected Bluesky endpoint in metric fixture");
    }) as typeof fetch;
    try {
      await collectMetrics(ctx);
      const first = metricsSummary(ctx);
      expect(sampled).toEqual([...primary, ...secondary.slice(0, 6)]);
      expect(
        first.github.rolling.filter(
          (row) => row.kind === "github-top" && row.repository === primary[0],
        ),
      ).toEqual([
        {
          kind: "github-top",
          repository: primary[0],
          metric: "paths",
          entries: [{ name: "/README.md", count: 4, uniques: 3 }],
          observedAt: ctx.now.toISOString(),
          window: "provider rolling 14 days",
          provenance: "github-traffic",
        },
        {
          kind: "github-top",
          repository: primary[0],
          metric: "referrers",
          entries: [{ name: "github.com", count: 3, uniques: 2 }],
          observedAt: ctx.now.toISOString(),
          window: "provider rolling 14 days",
          provenance: "github-traffic",
        },
      ]);
      expect(
        first.publications.map((observation) => [
          observation.targetDay,
          observation.actualAgeDays,
          observation.late,
        ]),
      ).toEqual([
        [1, 32, true],
        [7, 32, true],
        [28, 32, true],
      ]);
      corrected = true;
      ctx.now = new Date("2026-09-22T00:00:00Z");
      const result = await collectMetrics(ctx);
      const summary = metricsSummary(ctx);
      expect(sampled.slice(8)).toEqual([
        ...primary,
        ...secondary.slice(6),
        ...secondary.slice(0, 3),
      ]);
      const repository = `${ctx.config.githubOwner}/harmonic-analyzer`;
      expect(
        summary.github.daily
          .filter(
            (row) => row.repository === repository && row.metric === "views",
          )
          .map((row) => [row.date, row.value]),
      ).toEqual([["2026-09-20", 18]]);
      const rolling = summary.github.rolling.find(
        (row) =>
          row.kind === "github-window" &&
          row.repository === repository &&
          row.metric === "views",
      );
      if (!rolling || rolling.kind !== "github-window")
        throw new Error("Missing measured traffic snapshot");
      expect(rolling.uniques).toBe(7);
      expect(result.availability[`github:${repository}:clones`]).toMatchObject({
        status: "unavailable",
      });
      expect(
        summary.github.daily.find(
          (row) => row.repository === repository && row.metric === "clones",
        )!.value,
      ).toBe(12);
      expect(
        summary.publications.map((observation) => observation.actualAgeDays),
      ).toEqual([32, 32, 32]);
      for (const observation of summary.publications) {
        const post = observation.metrics.find(
          (metric) => metric.kind === "bluesky-post",
        );
        if (!post || post.kind !== "bluesky-post")
          throw new Error("Missing publication observation");
        expect(post.values).toEqual({ likes: 10, reposts: 3 });
      }
      const latestPost = summary.bluesky.find(
        (metric) => metric.kind === "bluesky-post",
      );
      if (!latestPost || latestPost.kind !== "bluesky-post")
        throw new Error("Missing current social snapshot");
      expect(latestPost.values.likes).toBe(20);
    } finally {
      Bun.spawn = originalSpawn;
      globalThis.fetch = originalFetch;
    }
  }));

test("retained history cannot inflate weekly summaries or replace latest measurements, and remains queryable locally", async () =>
  fixture(async (ctx) => {
    const repository = `${ctx.config.githubOwner}/harmonic-analyzer`;
    const put = (key: string, data: unknown) =>
      ctx.state.db
        .query("INSERT INTO metrics(key,data) VALUES(?,?)")
        .run(key, JSON.stringify(data));
    const manual = {
      kind: "manual",
      provenance: "manual-import",
      storyIssue: 42,
      channel: "blog",
      url: "https://example.org/post",
      metric: "views",
      unit: "views",
      value: 100,
      observedAt: "2026-09-21T12:00:00.000Z",
      windowStart: "2026-09-14T12:00:00.000Z",
      windowEnd: "2026-09-21T12:00:00.000Z",
    };
    const rolling = {
      kind: "github-window",
      provenance: "github-traffic",
      repository,
      metric: "views",
      value: 12,
      uniques: 7,
      observedAt: manual.observedAt,
      windowStart: manual.windowStart,
      windowEnd: manual.windowEnd,
    } as const;
    put("manual:current", manual);
    put("github-window:current", rolling);
    put("github-daily:current", {
      kind: "github-daily",
      provenance: "github-traffic",
      repository,
      metric: "views",
      date: "2026-09-20",
      observedAt: manual.observedAt,
      value: 12,
    });
    // Exercise the existing-database backfill before measuring steady-state summary work.
    metricsSummary(ctx);
    const readSummary = () => {
      const parse = JSON.parse;
      let decoded = 0;
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        decoded++;
        return parse(...args);
      }) as typeof JSON.parse;
      try {
        return { summary: metricsSummary(ctx), decoded };
      } finally {
        JSON.parse = parse;
      }
    };
    const before = readSummary();
    ctx.state.db.transaction(() => {
      for (let index = 0; index < 1_000; index++) {
        const observedAt = new Date(Date.UTC(2020, 0, index + 1)).toISOString();
        const date = observedAt.slice(0, 10);
        put(`manual:history-${index}`, {
          ...manual,
          observedAt,
          windowStart: observedAt,
          windowEnd: observedAt,
          value: 1_000,
        });
        put(`github-window:history-${index}`, {
          ...rolling,
          observedAt,
          value: 1_000,
          uniques: 1_000,
        });
        put(`github-uniques:history-${index}`, {
          ...rolling,
          observedAt: ctx.now.toISOString(),
          value: 9_999,
          uniques: 9_999,
        });
        put(`github-daily:history-${index}`, {
          kind: "github-daily",
          provenance: "github-traffic",
          repository,
          metric: "views",
          date,
          observedAt,
          value: 1_000,
        });
      }
    })();
    const after = readSummary();
    expect(after.summary).toEqual(before.summary);
    expect(after.decoded).toBe(before.decoded);
    expect(after.summary.github.weekly).toEqual([
      {
        repository,
        metric: "views",
        week: "2026-W38",
        value: 12,
        observedDays: 1,
      },
    ]);
    expect(after.summary.github.rolling).toEqual([rolling]);
    expect(
      after.summary.blogReadership.map((metric) => [
        metric.value,
        metric.windowStart,
        metric.windowEnd,
      ]),
    ).toEqual([[100, manual.windowStart, manual.windowEnd]]);
    expect(
      ctx.state.db.query("SELECT COUNT(*) AS count FROM metrics").get(),
    ).toEqual({ count: 4_003 });
    const retained = ctx.state.db
      .query("SELECT data FROM metrics WHERE key=?")
      .get("github-uniques:history-0") as { data: string };
    expect(JSON.parse(retained.data).uniques).toBe(9_999);
  }));

test("primary reach and weekly counts survive crowded alphabetical reporting while the desk stays compact", async () =>
  fixture(async (ctx) => {
    const observedAt = "2026-09-20T12:00:00.000Z";
    const put = (key: string, data: unknown) =>
      ctx.state.db
        .query("INSERT INTO metrics(key,data) VALUES(?,?)")
        .run(key, JSON.stringify(data));
    ctx.state.db.transaction(() => {
      for (const [project, value] of [
        ["harmonic-analyzer", 3],
        ["el400", 5],
        ...Array.from(
          { length: 40 },
          (_, index) => [`aaa-${index}`, 100] as const,
        ),
      ] as const) {
        const repository = `${ctx.config.githubOwner}/${project}`;
        for (const metric of ["views", "clones"]) {
          put(`window:${project}:${metric}`, {
            kind: "github-window",
            provenance: "github-traffic",
            repository,
            metric,
            value: value * 14,
            uniques: value,
            observedAt,
            windowStart: "2026-09-07T00:00:00.000Z",
            windowEnd: "2026-09-20T00:00:00.000Z",
          });
          for (let day = 7; day <= 20; day++) {
            put(`daily:${project}:${metric}:${day}`, {
              kind: "github-daily",
              provenance: "github-traffic",
              repository,
              metric,
              value,
              observedAt,
              date: `2026-09-${String(day).padStart(2, "0")}`,
            });
          }
        }
      }
      for (const [did, followers, date] of [
        ["did:plc:older", 9, "2026-09-19T12:00:00.000Z"],
        ["did:plc:latest", 23, observedAt],
      ] as const) {
        put(`profile:${did}`, {
          kind: "bluesky-profile",
          provenance: "bluesky-public-api",
          did,
          followers,
          observedAt: date,
        });
      }
    })();
    const summary = metricsSummary(ctx);
    const report = deskMetrics(ctx);
    const [lead, details] = report.split("<details>");
    expect(lead).toContain("**harmonic-analyzer reach:** 42");
    expect(lead).toContain("**el400 reach:** 70");
    expect(lead).toContain("**Bluesky followers:** 23");
    expect(lead).toContain("**Blog readership:** unavailable");
    expect(lead).toContain("**Conversion:** unavailable");
    expect(lead).toContain("Small or unknown samples");
    expect(lead).toContain("do not establish causality");
    expect(lead!.length).toBeLessThan(1_800);
    expect(lead).not.toContain("aaa-");
    expect(details).toContain(
      "<summary>Detailed repository/social measurements</summary>",
    );
    for (const [project, value] of [
      ["harmonic-analyzer", 21],
      ["el400", 35],
    ] as const) {
      const repository = `${ctx.config.githubOwner}/${project}`;
      expect(
        summary.github.weekly
          .slice(0, 8)
          .filter((metric) => metric.repository === repository),
      ).toHaveLength(4);
      expect(details).toContain(
        `2026-W38 ${repository}: ${value} views across 7 observed UTC days`,
      );
      expect(details).toContain(
        `2026-W38 ${repository}: ${value} clones across 7 observed UTC days`,
      );
    }
    expect(report.endsWith("</details>")).toBe(true);
    expect(report.length).toBeLessThanOrEqual(8_000);
  }));

test("calendar weeks and next three slots follow Los Angeles local dates through both DST transitions", () => {
  expect(isoWeek(new Date("2021-01-04T07:59:59Z"), "America/Los_Angeles")).toBe(
    "2020-W53",
  );
  expect(isoWeek(new Date("2021-01-04T08:00:00Z"), "America/Los_Angeles")).toBe(
    "2021-W01",
  );
  expect(
    nextSlots(new Date("2026-03-08T07:00:00Z"), "America/Los_Angeles").map(
      (date) => date.toISOString(),
    ),
  ).toEqual([
    "2026-03-08T15:00:00.000Z",
    "2026-03-08T21:00:00.000Z",
    "2026-03-09T03:00:00.000Z",
  ]);
  expect(
    nextSlots(new Date("2026-11-01T07:00:00Z"), "America/Los_Angeles").map(
      (date) => date.toISOString(),
    ),
  ).toEqual([
    "2026-11-01T16:00:00.000Z",
    "2026-11-01T22:00:00.000Z",
    "2026-11-02T04:00:00.000Z",
  ]);
});

test("managed cron replacement/removal preserves unrelated bytes including CRLF and non-UTF8 comments", () => {
  const prefix = Buffer.concat([
    Buffer.from("# other owner "),
    Buffer.from([0xff]),
    Buffer.from("\r\n17 3 * * * /usr/bin/true\r\n"),
  ]);
  const suffix = Buffer.from(
    "MAILTO=operator@example.org\n42 9 * * * /usr/bin/false\n",
  );
  const old = Buffer.from(
    "# BEGIN editor-in-chief\n0 8,14,20 * * * old-command\n# END editor-in-chief\n",
  );
  const replacement = Buffer.from(
    "# BEGIN editor-in-chief\n0 8,14,20 * * * new-command --apply\n# END editor-in-chief\n",
  );
  const current = Buffer.concat([prefix, old, suffix]);
  const changed = updateCrontab(current, replacement);
  expect(changed.equals(Buffer.concat([prefix, replacement, suffix]))).toBe(
    true,
  );
  expect(updateCrontab(changed, replacement).equals(changed)).toBe(true);
  expect(
    updateCrontab(changed, null).equals(Buffer.concat([prefix, suffix])),
  ).toBe(true);
  const unrelated = Buffer.concat([prefix, suffix]);
  expect(
    updateCrontab(updateCrontab(unrelated, replacement), null).equals(
      unrelated,
    ),
  ).toBe(true);
  expect(() =>
    updateCrontab(Buffer.concat([old, current]), replacement),
  ).toThrow("duplicate");
});

test("cron installation refuses a host mismatch or inherited foreign scheduling timezone", () => {
  expect(() => assertCronTimezone("America/Los_Angeles", "UTC")).toThrow(
    "does not match",
  );
  expect(() =>
    assertCronTimezone("America/Los_Angeles", "America/Los_Angeles", "UTC"),
  ).toThrow("does not match");
  expect(() => assertCronTimezone("America/Los_Angeles", null)).toThrow(
    "does not match",
  );
});
