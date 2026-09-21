import { z } from "zod";
import { expandPath } from "./config";
import type { Context, Publication } from "./contracts";
import { ApiError, gh } from "./github-api";
import { isoWeek, nextSlots } from "./calendar";

const DAY = 86_400_000;
const TARGET_DAYS = [1, 7, 28] as const;
const SUMMARY_WEEKS = 8;
const SUMMARY_DAILY_ROWS = 8 * 2 * SUMMARY_WEEKS * 7;
const SUMMARY_STREAMS = 32;
const SUMMARY_OBSERVATIONS = 36;
const summaryReady = new WeakSet<Context["state"]["db"]>();
const Count = z.number().int().nonnegative().finite();
const Timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const HttpsUrl = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  })
  .transform((value) => new URL(value).href);
const ManualMetricSchema = z
  .object({
    storyIssue: z.number().int().positive(),
    channel: z.enum(["blog", "bluesky", "linkedin", "youtube", "tiktok"]),
    url: HttpsUrl,
    observedAt: Timestamp,
    metric: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/),
    value: z.number().finite().nonnegative(),
    unit: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_ ./%:-]{0,59}$/),
    windowStart: Timestamp,
    windowEnd: Timestamp,
    evidenceUrl: HttpsUrl.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.windowStart > value.windowEnd)
      ctx.addIssue({
        code: "custom",
        message: "windowStart must not follow windowEnd",
      });
    if (value.windowEnd > value.observedAt)
      ctx.addIssue({
        code: "custom",
        message: "windowEnd must not follow observedAt",
      });
  });

type ManualMetric = z.infer<typeof ManualMetricSchema> & {
  kind: "manual";
  provenance: "manual-import";
};
type GithubDaily = {
  kind: "github-daily";
  repository: string;
  date: string;
  metric: "views" | "clones";
  value: number;
  observedAt: string;
  provenance: "github-traffic";
};
type GithubWindow = {
  kind: "github-window";
  repository: string;
  metric: "views" | "clones";
  value: number;
  uniques: number;
  observedAt: string;
  windowStart: string | null;
  windowEnd: string | null;
  provenance: "github-traffic";
};
type GithubTop = {
  kind: "github-top";
  repository: string;
  metric: "paths" | "referrers";
  entries: { name: string; count: number; uniques: number }[];
  observedAt: string;
  window: "provider rolling 14 days";
  provenance: "github-traffic";
};
type BlueskyProfile = {
  kind: "bluesky-profile";
  did: string;
  followers: number;
  observedAt: string;
  provenance: "bluesky-public-api";
};
type BlueskyPost = {
  kind: "bluesky-post";
  url: string;
  uri: string;
  cid: string;
  values: Partial<Record<"likes" | "reposts" | "replies" | "quotes", number>>;
  observedAt: string;
  provenance: "bluesky-public-api";
};
type Metric =
  | ManualMetric
  | GithubDaily
  | GithubWindow
  | GithubTop
  | BlueskyProfile
  | BlueskyPost;
type MetricEntry = { key: string; data: Metric };
type Availability = {
  status: "available" | "unavailable" | "partial";
  observedAt: string;
  detail: string;
};
type AvailabilityMap = Record<string, Availability>;
type PublicationObservation = {
  storyIssue: number;
  channel: Publication["channel"];
  url: string;
  targetDay: number;
  targetAt: string;
  status: "available" | "awaiting-input" | "pending";
  firstDueRunAt: string;
  lastAttemptAt: string;
  observedAt: string | null;
  actualAgeDays: number | null;
  late: boolean | null;
  lateBySeconds: number | null;
  metricKeys: string[];
  detail: string;
};
type ObservationMap = Record<string, PublicationObservation>;

function entries(ctx: Context): MetricEntry[] {
  return (
    ctx.state.db.query("SELECT key, data FROM metrics").all() as {
      key: string;
      data: string;
    }[]
  ).map((row) => ({ key: row.key, data: JSON.parse(row.data) as Metric }));
}

/** One-time backfill; subsequent reads seek bounded indexes, not retained snapshot history. */
function prepareSummary(ctx: Context) {
  if (summaryReady.has(ctx.state.db)) return;
  ctx.state.db.transaction(() => {
    ctx.state.db.exec(`
      CREATE INDEX IF NOT EXISTS metrics_daily_date ON metrics(json_extract(data,'$.date') DESC, key)
        WHERE json_extract(data,'$.kind') = 'github-daily';
      CREATE TABLE IF NOT EXISTS metric_latest(
        stream TEXT PRIMARY KEY, kind TEXT NOT NULL, observed_at TEXT NOT NULL, metric_key TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metric_latest_recent ON metric_latest(kind, observed_at DESC, stream);
      CREATE VIEW IF NOT EXISTS metric_snapshot_streams AS
        SELECT key AS metric_key, json_extract(data,'$.kind') AS kind,
          json_extract(data,'$.observedAt') AS observed_at,
          json_array(json_extract(data,'$.kind'),
            json_extract(data,'$.repository'), json_extract(data,'$.did'),
            json_extract(data,'$.url'), json_extract(data,'$.metric'),
            json_extract(data,'$.unit'), json_extract(data,'$.channel'),
            json_extract(data,'$.storyIssue')) AS stream
        FROM metrics WHERE json_extract(data,'$.kind') <> 'github-daily' AND key NOT GLOB 'github-uniques:*';
    `);
    const upsert = `ON CONFLICT(stream) DO UPDATE SET observed_at=excluded.observed_at, metric_key=excluded.metric_key
      WHERE excluded.observed_at > metric_latest.observed_at
        OR (excluded.observed_at = metric_latest.observed_at AND excluded.metric_key >= metric_latest.metric_key)`;
    for (const [name, event] of [
      ["insert", "INSERT"],
      ["update", "UPDATE OF data"],
    ] as const) {
      ctx.state.db
        .exec(`CREATE TRIGGER IF NOT EXISTS metric_latest_${name} AFTER ${event} ON metrics BEGIN
        INSERT INTO metric_latest(stream,kind,observed_at,metric_key)
          SELECT stream,kind,observed_at,metric_key FROM metric_snapshot_streams WHERE metric_key=NEW.key ${upsert};
      END`);
    }
    if (!ctx.state.get<boolean>("metrics:summary-index-v1", false)) {
      ctx.state.db
        .exec(`INSERT INTO metric_latest(stream,kind,observed_at,metric_key)
        SELECT stream,kind,observed_at,metric_key FROM metric_snapshot_streams WHERE true ${upsert}`);
      ctx.state.set("metrics:summary-index-v1", true);
    }
  })();
  summaryReady.add(ctx.state.db);
}

function put(ctx: Context, key: string, data: Metric) {
  ctx.state.db
    .query(
      "INSERT INTO metrics(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    )
    .run(key, JSON.stringify(data));
}

function safeFailure(error: unknown): string {
  if (error instanceof ApiError)
    return `GitHub HTTP ${error.status || "request failure"}; unavailable, not zero`;
  if (error instanceof z.ZodError)
    return "Provider returned invalid metric data; unavailable, not zero";
  if (error instanceof Error && /^Bluesky HTTP \d+$/.test(error.message))
    return `${error.message}; unavailable, not zero`;
  return "Metric request failed or exceeded its deadline; previous observations retained";
}

async function bsky(
  ctx: Context,
  method: string,
  params: URLSearchParams,
): Promise<unknown> {
  ctx.signal.throwIfAborted();
  const response = await fetch(
    `https://public.api.bsky.app/xrpc/${method}?${params}`,
    {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error(`Bluesky HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2_000_000)
    throw new Error("Bluesky metric response exceeded its size bound");
  return JSON.parse(body);
}

async function collectGithubMetrics(
  ctx: Context,
  availability: AvailabilityMap,
) {
  const primary = [
    `${ctx.config.githubOwner}/harmonic-analyzer`,
    `${ctx.config.githubOwner}/el400`,
  ];
  const repositories = new Set(primary);
  const discovered = ctx.state.get<
    Record<
      string,
      {
        fullName: string;
        owner: string;
        priority?: boolean;
        contributed?: boolean;
        public: boolean;
      }
    >
  >("source:github:repositories", {});
  for (const repo of Object.values(discovered)) {
    if (
      repo.public &&
      repo.owner.toLowerCase() === ctx.config.githubOwner.toLowerCase() &&
      (repo.priority || repo.contributed)
    )
      repositories.add(repo.fullName);
  }
  const ordered = [...repositories]
    .filter(
      (repo) =>
        /^[\w.-]+\/[\w.-]+$/.test(repo) && repo !== ctx.config.repository,
    )
    .sort();
  const pinned = primary.filter((repo) => ordered.includes(repo));
  const rotating = ordered.filter((repo) => !primary.includes(repo));
  const cursor = ctx.state.get<number>("metrics:github-cursor", 0);
  const start = rotating.length ? cursor % rotating.length : 0;
  // Always sample both primary projects; rotate the remaining six repository slots.
  const selectedOthers = [
    ...rotating.slice(start),
    ...rotating.slice(0, start),
  ].slice(0, 8 - pinned.length);
  const selected = [...pinned, ...selectedOthers];
  for (const repository of selected) {
    if (ctx.signal.aborted) break;
    for (const metric of ["views", "clones", "paths", "referrers"] as const) {
      if (ctx.signal.aborted) break;
      const availabilityKey = `github:${repository}:${metric}`;
      try {
        const route =
          metric === "views" || metric === "clones"
            ? `${metric}?per=day`
            : `popular/${metric}`;
        const payload = await gh<unknown>(
          `repos/${repository}/traffic/${route}`,
          { signal: ctx.signal },
        );
        const observedAt = ctx.now.toISOString();
        if (metric === "views" || metric === "clones") {
          const dailySchema = z
            .array(
              z.object({ timestamp: Timestamp, count: Count, uniques: Count }),
            )
            .max(32);
          const data = z
            .object({
              count: Count,
              uniques: Count,
              views: dailySchema.optional(),
              clones: dailySchema.optional(),
            })
            .parse(payload);
          const days = data[metric];
          if (!days)
            throw new Error(
              "Traffic response omitted the requested daily series",
            );
          const sortedDays = [...days].sort((a, b) =>
            a.timestamp.localeCompare(b.timestamp),
          );
          const window: GithubWindow = {
            kind: "github-window",
            repository,
            metric,
            value: data.count,
            uniques: data.uniques,
            observedAt,
            windowStart: sortedDays[0]?.timestamp ?? null,
            windowEnd: sortedDays.length
              ? new Date(
                  Date.parse(sortedDays[sortedDays.length - 1]!.timestamp) +
                    DAY,
                ).toISOString()
              : null,
            provenance: "github-traffic",
          };
          ctx.state.db.transaction(() => {
            for (const row of days) {
              const date = row.timestamp.slice(0, 10);
              put(
                ctx,
                `github-daily:${JSON.stringify([repository, date, metric])}`,
                {
                  kind: "github-daily",
                  repository,
                  date,
                  metric,
                  value: row.count,
                  observedAt,
                  provenance: "github-traffic",
                },
              );
              // Daily uniques are snapshots too; never add them to a multi-day audience.
              put(
                ctx,
                `github-uniques:${JSON.stringify([repository, date, metric, observedAt])}`,
                {
                  kind: "github-window",
                  repository,
                  metric,
                  value: row.count,
                  uniques: row.uniques,
                  observedAt,
                  windowStart: `${date}T00:00:00.000Z`,
                  windowEnd: new Date(
                    Date.parse(`${date}T00:00:00Z`) + DAY,
                  ).toISOString(),
                  provenance: "github-traffic",
                },
              );
            }
            put(
              ctx,
              `github-window:${JSON.stringify([repository, metric, observedAt])}`,
              window,
            );
          })();
        } else {
          const item =
            metric === "paths"
              ? z.object({
                  path: z.string().max(2000),
                  count: Count,
                  uniques: Count,
                })
              : z.object({
                  referrer: z.string().max(2000),
                  count: Count,
                  uniques: Count,
                });
          const rows = z.array(item).max(10).parse(payload);
          const top: GithubTop = {
            kind: "github-top",
            repository,
            metric,
            observedAt,
            window: "provider rolling 14 days",
            provenance: "github-traffic",
            entries: rows.map((row) => ({
              name: "path" in row ? row.path : row.referrer,
              count: row.count,
              uniques: row.uniques,
            })),
          };
          put(
            ctx,
            `github-top:${JSON.stringify([repository, metric, observedAt])}`,
            top,
          );
        }
        availability[availabilityKey] = {
          status: "available",
          observedAt: ctx.now.toISOString(),
          detail: "Repository traffic only, not blog readership or conversions",
        };
      } catch (error) {
        availability[availabilityKey] = {
          status: "unavailable",
          observedAt: ctx.now.toISOString(),
          detail: safeFailure(error),
        };
      }
      ctx.state.set("metrics:availability", availability);
    }
  }
  if (!ctx.signal.aborted)
    ctx.state.set(
      "metrics:github-cursor",
      rotating.length ? (start + selectedOthers.length) % rotating.length : 0,
    );
  if (ordered.length > selected.length)
    availability["github:rotation"] = {
      status: "partial",
      observedAt: ctx.now.toISOString(),
      detail: `${selected.length} of ${ordered.length} relevant owned repositories sampled this run; remaining repositories rotate on later runs`,
    };
  else delete availability["github:rotation"];
}

async function collectBlueskyMetrics(
  ctx: Context,
  availability: AvailabilityMap,
) {
  let did: string;
  try {
    const profile = z
      .object({
        did: z.string().startsWith("did:"),
        followersCount: Count.optional(),
      })
      .parse(
        await bsky(
          ctx,
          "app.bsky.actor.getProfile",
          new URLSearchParams({ actor: ctx.config.blueskyHandle }),
        ),
      );
    did = profile.did;
    if (profile.followersCount === undefined)
      availability["bluesky:profile"] = {
        status: "unavailable",
        observedAt: ctx.now.toISOString(),
        detail: "Public API omitted follower count; no zero inferred",
      };
    else {
      put(
        ctx,
        `bluesky-profile:${JSON.stringify([did, ctx.now.toISOString()])}`,
        {
          kind: "bluesky-profile",
          did,
          followers: profile.followersCount,
          observedAt: ctx.now.toISOString(),
          provenance: "bluesky-public-api",
        },
      );
      availability["bluesky:profile"] = {
        status: "available",
        observedAt: ctx.now.toISOString(),
        detail: "Follower snapshot; not impressions, readership or conversions",
      };
    }
  } catch (error) {
    availability["bluesky:profile"] = {
      status: "unavailable",
      observedAt: ctx.now.toISOString(),
      detail: safeFailure(error),
    };
    return;
  }
  const publications = ctx.state
    .publications()
    .filter((publication) => publication.channel === "bluesky");
  const byUrl = new Map(
    publications.map((publication) => [
      new URL(publication.url).href,
      publication,
    ]),
  );
  const allUrls = [...byUrl.keys()].sort();
  const cursor = ctx.state.get<number>("metrics:bluesky-cursor", 0);
  const start = allUrls.length ? cursor % allUrls.length : 0;
  const selected = [...allUrls.slice(start), ...allUrls.slice(0, start)].slice(
    0,
    100,
  );
  const uris = new Map<string, string[]>();
  const actors = new Map<string, string>([
    [ctx.config.blueskyHandle, did],
    [did, did],
  ]);
  for (const url of selected) {
    if (ctx.signal.aborted) break;
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(
        /^\/profile\/([^/]+)\/post\/([A-Za-z0-9._~:-]+)\/?$/,
      );
      if (
        parsed.hostname !== "bsky.app" ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        !match
      )
        throw new Error("Not a supported Bluesky publication URL");
      const actor = decodeURIComponent(match[1]!);
      if (
        !/^(?:did:(?:plc|web):[A-Za-z0-9.:%_-]+|[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+)$/.test(
          actor,
        )
      )
        throw new Error("Invalid Bluesky actor");
      let actorDid = actors.get(actor);
      if (!actorDid && !actor.startsWith("did:")) {
        const resolved = z
          .object({ did: z.string().startsWith("did:") })
          .parse(
            await bsky(
              ctx,
              "com.atproto.identity.resolveHandle",
              new URLSearchParams({ handle: actor }),
            ),
          );
        actorDid = resolved.did;
        actors.set(actor, actorDid);
      }
      if ((actorDid ?? actor) !== did)
        throw new Error(
          "Publication author does not match configured Bluesky account",
        );
      const uri = `at://${did}/app.bsky.feed.post/${match[2]}`;
      uris.set(uri, [...(uris.get(uri) ?? []), url]);
    } catch {
      availability[`bluesky:post:${url}`] = {
        status: "unavailable",
        observedAt: ctx.now.toISOString(),
        detail:
          "Could not resolve a supported bsky.app publication owned by the configured account; arbitrary URLs were not fetched",
      };
    }
  }
  const postSchema = z.object({
    uri: z.string(),
    cid: z.string(),
    author: z.object({ did: z.string() }),
    likeCount: Count.optional(),
    repostCount: Count.optional(),
    replyCount: Count.optional(),
    quoteCount: Count.optional(),
  });
  const requested = [...uris.keys()];
  for (let offset = 0; offset < requested.length; offset += 25) {
    if (ctx.signal.aborted) break;
    const batch = requested.slice(offset, offset + 25);
    try {
      const params = new URLSearchParams();
      for (const uri of batch) params.append("uris", uri);
      const result = z
        .object({ posts: z.array(postSchema).max(25) })
        .parse(await bsky(ctx, "app.bsky.feed.getPosts", params));
      const returned = new Map(
        result.posts
          .filter((post) => batch.includes(post.uri) && post.author.did === did)
          .map((post) => [post.uri, post]),
      );
      for (const uri of batch) {
        const post = returned.get(uri);
        for (const url of uris.get(uri)!) {
          if (!post) {
            availability[`bluesky:post:${url}`] = {
              status: "unavailable",
              observedAt: ctx.now.toISOString(),
              detail:
                "Tracked post missing or inaccessible in the public API; not zero interactions",
            };
            continue;
          }
          const values: BlueskyPost["values"] = {};
          if (post.likeCount !== undefined) values.likes = post.likeCount;
          if (post.repostCount !== undefined) values.reposts = post.repostCount;
          if (post.replyCount !== undefined) values.replies = post.replyCount;
          if (post.quoteCount !== undefined) values.quotes = post.quoteCount;
          if (!Object.keys(values).length) {
            availability[`bluesky:post:${url}`] = {
              status: "unavailable",
              observedAt: ctx.now.toISOString(),
              detail: "Public API omitted interaction counts; no zero inferred",
            };
            continue;
          }
          put(
            ctx,
            `bluesky-post:${JSON.stringify([url, ctx.now.toISOString()])}`,
            {
              kind: "bluesky-post",
              url,
              uri,
              cid: post.cid,
              values,
              observedAt: ctx.now.toISOString(),
              provenance: "bluesky-public-api",
            },
          );
          availability[`bluesky:post:${url}`] = {
            status: "available",
            observedAt: ctx.now.toISOString(),
            detail:
              "Cumulative interaction snapshot; impressions and click-through unavailable",
          };
        }
      }
    } catch (error) {
      for (const uri of batch)
        for (const url of uris.get(uri)!)
          availability[`bluesky:post:${url}`] = {
            status: "unavailable",
            observedAt: ctx.now.toISOString(),
            detail: safeFailure(error),
          };
    }
    ctx.state.set("metrics:availability", availability);
  }
  if (!ctx.signal.aborted)
    ctx.state.set(
      "metrics:bluesky-cursor",
      allUrls.length ? (start + selected.length) % allUrls.length : 0,
    );
  if (allUrls.length > selected.length)
    availability["bluesky:rotation"] = {
      status: "partial",
      observedAt: ctx.now.toISOString(),
      detail: `${selected.length} of ${allUrls.length} tracked URLs sampled; remaining URLs rotate on later runs`,
    };
  else delete availability["bluesky:rotation"];
}

function reconcilePublicationObservations(ctx: Context, all: MetricEntry[]) {
  const observations = ctx.state.get<ObservationMap>(
    "metrics:publication-observations",
    {},
  );
  for (const publication of ctx.state.publications()) {
    const url = new URL(publication.url).href;
    const published = Date.parse(publication.publishedAt);
    const samples = all
      .filter(
        ({ data }) =>
          (data.kind === "manual" &&
            data.storyIssue === publication.storyIssue &&
            data.channel === publication.channel &&
            data.url === url) ||
          (data.kind === "bluesky-post" &&
            publication.channel === "bluesky" &&
            data.url === url),
      )
      .sort((a, b) => a.data.observedAt.localeCompare(b.data.observedAt));
    for (const targetDay of TARGET_DAYS) {
      const target = published + targetDay * DAY;
      if (target > ctx.now.getTime()) continue;
      const key = JSON.stringify([
        publication.storyIssue,
        publication.channel,
        url,
        publication.publishedAt,
        targetDay,
      ]);
      const prior = observations[key];
      if (prior?.status === "available") {
        // Additional real measurements at the same instant belong to the same observation.
        // Corrections remain visible through their stable keys without taking a new snapshot.
        const retained = samples.filter(
          (sample) => sample.data.observedAt === prior.observedAt,
        );
        if (retained.length) {
          prior.metricKeys = retained.map((sample) => sample.key);
          continue;
        }
      }
      const matching = samples.filter(
        (sample) =>
          Date.parse(sample.data.observedAt) >= target &&
          Date.parse(sample.data.observedAt) <= ctx.now.getTime(),
      );
      const first = matching[0];
      const observedAt = first?.data.observedAt ?? null;
      const at = observedAt ? Date.parse(observedAt) : null;
      // The next scheduled scan after the first eligible scan is an unambiguous missed opportunity.
      const lateBoundary = nextSlots(
        new Date(target - 1),
        ctx.config.timezone,
      )[1]!.getTime();
      observations[key] = {
        storyIssue: publication.storyIssue,
        channel: publication.channel,
        url,
        targetDay,
        targetAt: new Date(target).toISOString(),
        status: first
          ? "available"
          : publication.channel === "bluesky"
            ? "pending"
            : "awaiting-input",
        firstDueRunAt: prior?.firstDueRunAt ?? ctx.now.toISOString(),
        lastAttemptAt: ctx.now.toISOString(),
        observedAt,
        actualAgeDays: at === null ? null : (at - published) / DAY,
        late: at === null ? null : at >= lateBoundary,
        lateBySeconds: at === null ? null : (at - target) / 1000,
        metricKeys: matching
          .filter((sample) => sample.data.observedAt === observedAt)
          .map((sample) => sample.key),
        detail: first
          ? "Actual observed values, not reconstructed history; late means at least one scheduled observation opportunity was missed"
          : publication.channel === "bluesky"
            ? "Tracked public interactions pending; missing counts are unavailable"
            : "No authenticated integration for this channel; import real aggregate measurements with explicit windows",
      };
    }
  }
  ctx.state.set("metrics:publication-observations", observations);
}

/** Fixed-provider reads only. Never fetches a publication or evidence URL. */
export async function collectMetrics(ctx: Context) {
  prepareSummary(ctx);
  const availability = ctx.state.get<AvailabilityMap>(
    "metrics:availability",
    {},
  );
  if (!ctx.state.get<string | null>("metrics:tracking-start", null))
    ctx.state.set("metrics:tracking-start", ctx.now.toISOString());
  await Promise.all([
    collectGithubMetrics(ctx, availability),
    collectBlueskyMetrics(ctx, availability),
  ]);
  ctx.state.set("metrics:availability", availability);
  reconcilePublicationObservations(ctx, entries(ctx));
  ctx.state.set("metrics:last-collected", ctx.now.toISOString());
  return {
    status:
      ctx.signal.aborted ||
      Object.values(availability).some((value) => value.status !== "available")
        ? "partial"
        : "complete",
    observedAt: ctx.now.toISOString(),
    availability,
    inputRequests: metricsSummary(ctx).inputRequests,
  };
}

/** Validate the entire import before one transaction. Replacements retain prior aggregates. */
export async function importMetrics(
  ctx: Context,
  path: string,
  replace = false,
) {
  const file = Bun.file(expandPath(path));
  if (file.size > 10_000_000)
    throw new Error("Metric import exceeds the 10 MB limit");
  let parsed: z.infer<typeof ManualMetricSchema>[];
  try {
    parsed = z
      .array(ManualMetricSchema)
      .max(10_000)
      .parse(await file.json());
  } catch {
    throw new Error(
      "Invalid metric import: expected a strict array of finite, nonnegative aggregates with HTTPS URLs and explicit ISO timestamps/windows",
    );
  }
  const incoming = new Map<string, ManualMetric>();
  for (const item of parsed) {
    if (Date.parse(item.observedAt) > ctx.now.getTime())
      throw new Error("Metric import observedAt must not be in the future");
    const data: ManualMetric = {
      ...item,
      kind: "manual",
      provenance: "manual-import",
    };
    const key = `manual:${JSON.stringify([data.url, data.metric, data.windowStart, data.windowEnd, data.observedAt, data.provenance])}`;
    const sameBatch = incoming.get(key);
    if (sameBatch && JSON.stringify(sameBatch) !== JSON.stringify(data))
      throw new Error(
        "Conflicting observations within one import; supply one correction per observation key",
      );
    incoming.set(key, data);
  }
  prepareSummary(ctx);
  const result = ctx.state.db.transaction(() => {
    let inserted = 0;
    let replaced = 0;
    let unchanged = 0;
    for (const [key, data] of incoming) {
      const existing = ctx.state.db
        .query("SELECT data FROM metrics WHERE key=?")
        .get(key) as { data: string } | null;
      const serialized = JSON.stringify(data);
      if (existing?.data === serialized) {
        unchanged++;
        continue;
      }
      if (existing) {
        if (!replace)
          throw new Error(
            "Conflicting metric reimport; no changes committed. Use --replace for an explicit audited correction",
          );
        ctx.state.db
          .query("INSERT INTO metric_audit(data,changed_at) VALUES(?,?)")
          .run(
            JSON.stringify({
              key,
              provenance: "manual-import",
              previous: JSON.parse(existing.data),
              replacement: data,
            }),
            ctx.now.toISOString(),
          );
        replaced++;
      } else inserted++;
      put(ctx, key, data);
    }
    if (!ctx.state.get<string | null>("metrics:tracking-start", null))
      ctx.state.set("metrics:tracking-start", ctx.now.toISOString());
    reconcilePublicationObservations(ctx, entries(ctx));
    return {
      inserted,
      replaced,
      unchanged,
      observations: incoming.size,
      provenance: "manual-import" as const,
    };
  })();
  return result;
}

function consistency(ctx: Context) {
  const history = ctx.state
    .get<{ from: string; cadence: string }[]>("cadence-history", [])
    .filter((item) => Number.isFinite(Date.parse(item.from)))
    .sort((a, b) => a.from.localeCompare(b.from));
  const paused = new Set(ctx.state.get<string[]>("cadence:paused-weeks", []));
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!;
    if (entry.cadence !== "paused") continue;
    const end = Math.min(
      ctx.now.getTime(),
      Date.parse(history[index + 1]?.from ?? ctx.now.toISOString()),
    );
    for (let time = Date.parse(entry.from); time < end; time += DAY)
      paused.add(isoWeek(new Date(time), ctx.config.timezone));
    if (end > Date.parse(entry.from))
      paused.add(isoWeek(new Date(end - 1), ctx.config.timezone));
  }
  if (ctx.config.cadence === "paused")
    paused.add(isoWeek(ctx.now, ctx.config.timezone));
  const publications = ctx.state.publications();
  const counts: Record<string, number> = {};
  const unique = new Set<string>();
  for (const publication of publications) {
    if (
      publication.kind !== "original" ||
      Date.parse(publication.publishedAt) > ctx.now.getTime()
    )
      continue;
    const key = JSON.stringify([
      publication.channel,
      new URL(publication.url).href,
    ]);
    if (unique.has(key)) continue;
    unique.add(key);
    const week = isoWeek(
      new Date(publication.publishedAt),
      ctx.config.timezone,
    );
    counts[week] = (counts[week] ?? 0) + 1;
  }
  const since =
    history[0]?.from ??
    ctx.state.get<string | null>("metrics:tracking-start", null);
  const trackedWeeks = new Set<string>();
  if (since)
    for (let at = Date.parse(since); at <= ctx.now.getTime(); at += DAY)
      trackedWeeks.add(isoWeek(new Date(at), ctx.config.timezone));
  trackedWeeks.add(isoWeek(ctx.now, ctx.config.timezone));
  const currentWeek = isoWeek(ctx.now, ctx.config.timezone);
  const completed = [...trackedWeeks]
    .filter((week) => week !== currentWeek && !paused.has(week))
    .sort();
  const publishedWeeks = completed.filter(
    (week) => (counts[week] ?? 0) > 0,
  ).length;
  return {
    since,
    currentWeek,
    originalPublications: unique.size,
    countsByWeek: Object.fromEntries(
      Object.entries(counts)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, SUMMARY_WEEKS),
    ),
    pausedWeeks: [...paused].sort().reverse().slice(0, SUMMARY_WEEKS),
    completedEligibleWeeks: completed.length,
    weeksWithOriginal: publishedWeeks,
    consistency: completed.length ? publishedWeeks / completed.length : null,
    note: "Recorded original-publication dates only; paused weeks and the unfinished current week excluded from the consistency denominator. No missed-output debt.",
  };
}

/** Aggregate-only reporting: latest rolling snapshots are not additive totals. */
export function metricsSummary(ctx: Context) {
  prepareSummary(ctx);
  const since = new Date(ctx.now.getTime() - SUMMARY_WEEKS * 7 * DAY)
    .toISOString()
    .slice(0, 10);
  const dailySince = new Date(ctx.now.getTime() - 14 * DAY)
    .toISOString()
    .slice(0, 10);
  const githubDaily = (
    ctx.state.db
      .query(
        `SELECT data FROM metrics
    WHERE json_extract(data,'$.kind') = 'github-daily' AND json_extract(data,'$.date') >= ?
      AND json_extract(data,'$.date') <= ?
    ORDER BY json_extract(data,'$.date') DESC, key LIMIT ?`,
      )
      .all(since, ctx.now.toISOString().slice(0, 10), SUMMARY_DAILY_ROWS) as {
      data: string;
    }[]
  ).map((row) => JSON.parse(row.data) as GithubDaily);
  const latest: MetricEntry[] = [];
  for (const kind of [
    "manual",
    "github-window",
    "github-top",
    "bluesky-profile",
    "bluesky-post",
  ]) {
    const rows = ctx.state.db
      .query(
        `SELECT m.key,m.data FROM
      (SELECT metric_key FROM metric_latest WHERE kind=? ORDER BY observed_at DESC,stream LIMIT ?) AS latest
      JOIN metrics m ON m.key=latest.metric_key`,
      )
      .all(kind, SUMMARY_STREAMS) as { key: string; data: string }[];
    latest.push(
      ...rows.map((row) => ({
        key: row.key,
        data: JSON.parse(row.data) as Metric,
      })),
    );
  }
  const manual = latest
    .filter(
      (entry): entry is MetricEntry & { data: ManualMetric } =>
        entry.data.kind === "manual",
    )
    .map((entry) => ({ key: entry.key, ...entry.data }));
  const availability = Object.fromEntries(
    (
      ctx.state.db
        .query(
          `SELECT j.key,j.value FROM kv,json_each(kv.value) j
    WHERE kv.key='metrics:availability' ORDER BY json_extract(j.value,'$.observedAt') DESC,j.key LIMIT ?`,
        )
        .all(SUMMARY_STREAMS * 4) as { key: string; value: string }[]
    ).map((row) => [row.key, JSON.parse(row.value) as Availability]),
  );
  const observations = (
    ctx.state.db
      .query(
        `SELECT j.value FROM kv,json_each(kv.value) j
    WHERE kv.key='metrics:publication-observations'
    ORDER BY CASE json_extract(j.value,'$.status') WHEN 'available' THEN 1 ELSE 0 END,
      json_extract(j.value,'$.targetAt') DESC,j.key LIMIT ?`,
      )
      .all(SUMMARY_OBSERVATIONS) as { value: string }[]
  )
    .map((row) => {
      const observation = JSON.parse(row.value) as PublicationObservation;
      const metricKeys = observation.metricKeys.slice(0, SUMMARY_STREAMS);
      const metrics = metricKeys.flatMap((key) => {
        const metric = ctx.state.db
          .query("SELECT data FROM metrics WHERE key=?")
          .get(key) as { data: string } | null;
        return metric ? [JSON.parse(metric.data) as Metric] : [];
      });
      return {
        ...observation,
        metricKeys,
        metrics,
        omittedMetrics: observation.metricKeys.length - metricKeys.length,
      };
    })
    .sort((a, b) => a.targetAt.localeCompare(b.targetAt));
  const weekly = new Map<
    string,
    {
      repository: string;
      metric: GithubDaily["metric"];
      week: string;
      value: number;
      observedDays: number;
    }
  >();
  for (const day of githubDaily) {
    const week = isoWeek(new Date(`${day.date}T12:00:00Z`), "UTC");
    const key = JSON.stringify([day.repository, day.metric, week]);
    const aggregate = weekly.get(key) ?? {
      repository: day.repository,
      metric: day.metric,
      week,
      value: 0,
      observedDays: 0,
    };
    aggregate.value += day.value;
    aggregate.observedDays++;
    weekly.set(key, aggregate);
  }
  const inputRequests = observations
    .filter((observation) => observation.status !== "available")
    .map((observation) => ({
      storyIssue: observation.storyIssue,
      channel: observation.channel,
      url: observation.url,
      targetDay: observation.targetDay,
      targetAt: observation.targetAt,
      status: observation.status,
      request: `Supply real aggregate ${observation.channel} measurements observed on or after ${observation.targetAt}, with metric, value, unit, observation time and window. Missing values remain unavailable.`,
    }));
  const channels = (
    ["blog", "bluesky", "linkedin", "youtube", "tiktok"] as const
  ).map((channel) => ({
    channel,
    availability:
      manual.some((value) => value.channel === channel) ||
      (channel === "bluesky" &&
        latest.some((entry) => entry.data.kind === "bluesky-post"))
        ? "observed"
        : "unavailable",
    measurements: manual.filter((value) => value.channel === channel),
    caveat:
      channel === "bluesky"
        ? "Public interactions are not impressions or click-through; manual denominators required for conversion claims"
        : "Operator-supplied aggregates only; no automatic channel integration",
  }));
  return {
    observedAt: ctx.state.get<string | null>("metrics:last-collected", null),
    availability,
    scope: {
      since,
      dailyRowLimit: SUMMARY_DAILY_ROWS,
      latestStreamsPerKind: SUMMARY_STREAMS,
      publicationObservationLimit: SUMMARY_OBSERVATIONS,
      note: "Bounded recent reporting, not complete history. Latest manual measurements retain their actual windows and are never added together. Weekly counts include only observed UTC dates; partial weeks and missing days are not zero. Full measurements, publication observations and correction history remain in the local database.",
    },
    consistency: consistency(ctx),
    github: {
      daily: githubDaily.filter((day) => day.date >= dailySince),
      weekly: [...weekly.values()],
      rolling: latest
        .filter(
          (entry) =>
            entry.data.kind === "github-window" ||
            entry.data.kind === "github-top",
        )
        .map((entry) => entry.data),
      interpretation:
        "Repository traffic, not blog readership. Recent daily counts are date-keyed corrected values; weekly counts sum those observed dates only. Rolling counts, top-ten lists and uniques must not be summed.",
    },
    bluesky: latest
      .filter(
        (entry) =>
          entry.data.kind === "bluesky-profile" ||
          entry.data.kind === "bluesky-post",
      )
      .map((entry) => entry.data),
    channels,
    publications: observations,
    inputRequests,
    blogReadership: manual.filter(
      (value) =>
        value.channel === "blog" &&
        /^(views|pageviews|readers|unique_visitors|visitors|readership)$/.test(
          value.metric,
        ),
    ),
    signupObservations: manual.filter((value) =>
      /^(signups|signup_count|prelaunch_signups|prelaunch_count|subscribers|subscriber_count)$/.test(
        value.metric,
      ),
    ),
    conversionObservations: manual.filter((value) =>
      /^(conversion|conversion_rate|signup_conversion|signup_conversion_rate)$/.test(
        value.metric,
      ),
    ),
    conversion: manual.some((value) =>
      /^(conversion|conversion_rate|signup_conversion|signup_conversion_rate)$/.test(
        value.metric,
      ),
    )
      ? "Operator-supplied measured conversion aggregates are present with explicit units/windows; no inferred rate."
      : "Unavailable: no operator-supplied measured conversion aggregate. No inferred rate from mismatched or missing denominators.",
    caveats: [
      "Absent measurements are unavailable, never zero. Blog readership and signup conversion are unavailable until actual destination data is supplied.",
      "Small or unknown samples: retain explicit units/windows; audience denominators are missing unless supplied. Do not add overlapping windows or uniques.",
      "Observed changes do not establish causality; likes and repository visits are not backer demand.",
      "Overdue +1/+7/+28 observations use the same actual late snapshot when necessary, not fabricated historical measurements.",
      "Manual corrections replace an observation and preserve prior aggregate values in local audit history; no subscriber identities are accepted.",
    ],
  };
}

/** Compact public desk copy; detailed bounded status and full local history remain separate. */
export function deskMetrics(ctx: Context): string {
  const summary = metricsSummary(ctx);
  const { consistency: cadence } = summary;
  const lines = [
    `### Weekly measurement report (${cadence.currentWeek})`,
    `Original publications: ${cadence.originalPublications}; completed eligible weeks with an original: ${cadence.weeksWithOriginal}/${cadence.completedEligibleWeeks}; consistency: ${cadence.consistency === null ? "unavailable" : `${(cadence.consistency * 100).toFixed(1)}%`}. Paused and unfinished weeks excluded; no missed-output debt.`,
    "",
    "#### Channel reach",
  ];
  for (const channel of summary.channels) {
    const measurements = channel.measurements
      .slice(0, 3)
      .map(
        (metric) =>
          `${metric.metric}: ${metric.value} ${metric.unit} (observed ${metric.observedAt}; window ${metric.windowStart}–${metric.windowEnd})`,
      );
    lines.push(
      `- ${channel.channel}: ${channel.availability}. ${measurements.length ? measurements.join("; ") : channel.caveat}`,
    );
  }
  const profile = summary.bluesky.find(
    (metric): metric is BlueskyProfile => metric.kind === "bluesky-profile",
  );
  if (profile)
    lines.push(
      `- Bluesky followers: ${profile.followers}, observed ${profile.observedAt}; not impressions or readership.`,
    );
  lines.push(
    "",
    "#### Repository traffic — latest rolling snapshots, not additive",
  );
  const rolling = summary.github.rolling.filter(
    (metric): metric is GithubWindow => metric.kind === "github-window",
  );
  for (const metric of rolling.slice(0, 16)) {
    const availability =
      summary.availability[`github:${metric.repository}:${metric.metric}`];
    lines.push(
      `- ${metric.repository}: ${metric.value} ${metric.metric}, ${metric.uniques} uniques; window ${metric.windowStart ?? "unavailable"}–${metric.windowEnd ?? "unavailable"}; observed ${metric.observedAt}${availability?.status === "unavailable" ? "; current collection unavailable, retained snapshot" : ""}.`,
    );
  }
  if (!rolling.length)
    lines.push("- Unavailable: no measured rolling repository traffic.");
  lines.push("", "#### Weekly observed counts");
  for (const metric of summary.github.weekly.slice(0, 8)) {
    lines.push(
      `- ${metric.week} ${metric.repository}: ${metric.value} ${metric.metric} across ${metric.observedDays} observed UTC days; missing days are not zero.`,
    );
  }
  if (!summary.github.weekly.length)
    lines.push("- Unavailable: no recent measured daily traffic.");
  lines.push("", "#### Measurement inputs needed");
  for (const request of summary.inputRequests.slice(0, 8)) {
    lines.push(
      `- Story #${request.storyIssue}, ${request.channel}, +${request.targetDay} days: ${request.status}. Supply actual aggregates observed on or after ${request.targetAt}, with value, unit, window and evidence.`,
    );
  }
  if (!summary.inputRequests.length)
    lines.push(
      "- No missing inputs among the reported publication observations.",
    );
  lines.push(
    "",
    "#### Interpretation",
    ...summary.caveats.map((caveat) => `- ${caveat}`),
  );
  const footer =
    "\n\nBounded highlights only; detailed status is also bounded. Full original measurements and correction history remain in the local database. Never add overlapping rolling windows, uniques or manual snapshots.";
  let report = "";
  let omitted = 0;
  for (const line of lines) {
    if (report.length + line.length + 1 + footer.length + 80 > 8_000) {
      omitted++;
      continue;
    }
    report += `${report ? "\n" : ""}${line}`;
  }
  if (omitted)
    report += `\n${omitted} additional report lines omitted to keep the desk compact.`;
  return report + footer;
}
