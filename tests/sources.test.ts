import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state";
import { loadConfig } from "../src/config";
import { isoWeek } from "../src/calendar";
import type { Context } from "../src/contracts";
import { collectGithub } from "../src/sources/github";
import { collectBluesky } from "../src/sources/bluesky";
import { collectHindsight } from "../src/sources/hindsight";

afterEach(() => mock.restore());

async function fixture(
  body: (ctx: Context, directory: string) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "eic-sources-"));
  const state = new State(directory);
  try {
    const config = await loadConfig();
    config.hindsightEnvFile = join(directory, "credential.env");
    writeFileSync(
      config.hindsightEnvFile,
      "HINDSIGHT_API_TOKEN=fixture-hindsight-credential\n",
      { mode: 0o600 },
    );
    await body(
      {
        state,
        config,
        now: new Date("2026-09-21T16:00:00.000Z"),
        mode: "dry-run",
        signal: new AbortController().signal,
      },
      directory,
    );
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Route {
  data?: unknown;
  status?: number;
  headers?: Record<string, string>;
}
async function fakeGithub(
  directory: string,
  routes: Record<string, Route>,
  body: (
    setRoutes: (routes: Record<string, Route>) => void,
    requests: () => string[],
  ) => Promise<void>,
) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const routeFile = join(directory, "routes.json");
  const requestFile = `${routeFile}.requests`;
  writeFileSync(requestFile, "");
  const executable = join(bin, "gh");
  // Exercise the real argv/header transport without module mocks that contaminate sibling test files.
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nconst routes=JSON.parse(readFileSync(process.env.EIC_SOURCE_ROUTES,'utf8'));\nconst endpoint=process.argv[3];\nappendFileSync(process.env.EIC_SOURCE_ROUTES+'.requests',endpoint+'\\n');\nconst route=routes[endpoint]??{status:404};\nconst status=route.status??200;\nprocess.stdout.write('HTTP/2 '+status+'\\r\\n'+Object.entries(route.headers??{}).map(([key,value])=>key+': '+value+'\\r\\n').join('')+'\\r\\n'+JSON.stringify(route.data??{}));\nif(status>=400){process.stderr.write('HTTP '+status);process.exitCode=1;}\n`,
  );
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  const oldRoutes = process.env.EIC_SOURCE_ROUTES;
  const setRoutes = (value: Record<string, Route>) =>
    writeFileSync(routeFile, JSON.stringify(value));
  setRoutes(routes);
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.EIC_SOURCE_ROUTES = routeFile;
  try {
    await body(setRoutes, () =>
      readFileSync(requestFile, "utf8").trim().split("\n").filter(Boolean),
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldRoutes === undefined) delete process.env.EIC_SOURCE_ROUTES;
    else process.env.EIC_SOURCE_ROUTES = oldRoutes;
  }
}
const FROM = "2026-08-22T16:00:00.000Z";
const TO = "2026-09-21T16:00:00.000Z";
function seedGithub(
  ctx: Context,
  tasks: unknown[],
  known: Record<string, true>,
) {
  ctx.state.set("source:github", {
    lookbackWeek: isoWeek(ctx.now, ctx.config.timezone),
    current: { from: FROM, to: TO, tasks, known, warnings: [], withheld: 0 },
  });
}
function commit(repository: string, letter: string) {
  return {
    sha: letter.repeat(40),
    html_url: `https://github.com/${repository}/commit/${letter.repeat(40)}`,
    author: { login: "pedropaulovc" },
    committer: { login: "pedropaulovc" },
    commit: {
      message: `Measured controller timing for fixture ${letter}`,
      author: { name: "Pedro", date: "2026-09-20T10:00:00Z" },
      committer: { name: "Pedro", date: "2026-09-20T10:00:00Z" },
    },
    files: [{ filename: "src/controller.ts", status: "modified" }],
  };
}

test("GitHub interruption resumes the next Link page without skipping prior evidence or advancing its checkpoint", async () =>
  fixture(async (ctx, directory) => {
    const repository = "pedropaulovc/el400";
    const first = `repos/${repository}/commits?${new URLSearchParams({ sha: "main", since: FROM, until: TO, per_page: "100", author: ctx.config.githubOwner })}`;
    const second = `${first}&page=2`;
    const a = commit(repository, "a");
    const b = commit(repository, "b");
    ctx.state.set("source:github:repositories", {
      [repository]: {
        fullName: repository,
        owner: ctx.config.githubOwner,
        defaultBranch: "main",
        public: true,
        priority: true,
        contributed: true,
      },
    });
    seedGithub(
      ctx,
      [{ id: `commits:${repository}`, kind: "commits", repository }],
      { [`repository:${repository}`]: true, [`commits:${repository}`]: true },
    );
    const canonicalSecond = `repositories/1014035167/commits?${new URL(second, "https://api.github.com/").searchParams}`;
    const routes: Record<string, Route> = {
      [first]: {
        data: [a],
        headers: {
          Link: `<https://api.github.com/${canonicalSecond}>; rel="next"`,
        },
      },
      [second]: { status: 403 },
      [`repos/${repository}/commits/${a.sha}`]: { data: a },
      [`repos/${repository}/commits/${b.sha}`]: { data: b },
    };
    await fakeGithub(directory, routes, async (setRoutes) => {
      const interrupted = await collectGithub(ctx);
      expect(interrupted.coverage.status).toBe("partial");
      expect(interrupted.coverage.checkpoint).toBeUndefined();
      expect(ctx.state.evidence().map((item) => item.id)).toEqual([
        `github:commit:${repository}:${a.sha}`,
      ]);
      setRoutes({
        ...routes,
        [first]: { status: 403 },
        [second]: { data: [a, b] },
      });
      const resumed = await collectGithub(ctx);
      expect(resumed.coverage.checkpoint).toBe(TO);
      expect(resumed.coverage.status).toBe("complete");
      expect(
        ctx.state
          .evidence()
          .map((item) => item.id)
          .sort(),
      ).toEqual([
        `github:commit:${repository}:${a.sha}`,
        `github:commit:${repository}:${b.sha}`,
      ]);
      expect(ctx.state.putEvidence(resumed.evidence)).toBe(0);
    });
  }));

test("GitHub follows numeric public-event aliases without changing the source resource", async () =>
  fixture(async (ctx, directory) => {
    const first = `users/${ctx.config.githubOwner}/events/public?per_page=100`;
    const second = `${first}&page=2`;
    const tasks = [{ id: "events", kind: "events" }];
    const event = {
      public: true,
      repo: { name: ctx.config.repository },
      created_at: "2026-09-20T10:00:00Z",
      type: "WatchEvent",
      payload: {},
    };
    seedGithub(ctx, tasks, { events: true });
    await fakeGithub(
      directory,
      {
        [first]: {
          data: [event],
          headers: {
            Link: '<https://api.github.com/user/577970/events/public?per_page=100&page=2>; rel="next"',
          },
        },
        [second]: { data: [] },
      },
      async (setRoutes, requests) => {
        expect((await collectGithub(ctx)).coverage.status).toBe("complete");
        expect(requests()).toEqual([first, second]);
        seedGithub(ctx, tasks, { events: true });
        setRoutes({
          [first]: {
            data: [event],
            headers: {
              Link: '<https://api.github.com/user/577970/events/private?per_page=100&page=2>; rel="next"',
            },
          },
        });
        const rejected = await collectGithub(ctx);
        expect(rejected.coverage.status).toBe("partial");
        expect(
          rejected.coverage.blockers?.some((message) =>
            message.includes("unexpected pagination destination"),
          ),
        ).toBe(true);
        expect(
          requests().some((endpoint) => endpoint.includes("/private")),
        ).toBe(false);
      },
    );
  }));

test("GitHub repository visibility and editorial automation exclusion gate all evidence hydration", async () =>
  fixture(async (ctx, directory) => {
    const privateRepo = "pedropaulovc/private-fixture";
    const editorial = ctx.config.repository;
    const privateCommit = commit(privateRepo, "c");
    const editorialCommit = commit(editorial, "d");
    seedGithub(
      ctx,
      [
        {
          id: `repository:${privateRepo}`,
          kind: "repository",
          repository: privateRepo,
          priority: false,
          contributed: true,
        },
        {
          id: `commit:${privateRepo}:${privateCommit.sha}`,
          kind: "commit",
          repository: privateRepo,
          sha: privateCommit.sha,
        },
        {
          id: `repository:${editorial}`,
          kind: "repository",
          repository: editorial,
          priority: false,
          contributed: true,
        },
        {
          id: `commit:${editorial}:${editorialCommit.sha}`,
          kind: "commit",
          repository: editorial,
          sha: editorialCommit.sha,
        },
      ],
      {
        [`repository:${privateRepo}`]: true,
        [`repository:${editorial}`]: true,
      },
    );
    await fakeGithub(
      directory,
      {
        [`repos/${privateRepo}`]: {
          data: {
            full_name: privateRepo,
            private: true,
            owner: { login: ctx.config.githubOwner },
            default_branch: "main",
          },
        },
        [`repos/${privateRepo}/commits/${privateCommit.sha}`]: {
          data: privateCommit,
        },
        [`repos/${editorial}/commits/${editorialCommit.sha}`]: {
          data: editorialCommit,
        },
      },
      async () => {
        const result = await collectGithub(ctx);
        expect(result.coverage.status).toBe("complete");
        expect(result.evidence).toEqual([]);
        expect(ctx.state.evidence()).toEqual([]);
      },
    );
  }));

test("GitHub hydrates priority public evidence within one bounded collection without exhausting ordinary discovery", async () =>
  fixture(async (ctx, directory) => {
    const ordinary = Array.from(
      { length: 100 },
      (_, index) => `${ctx.config.githubOwner}/ordinary-fixture-${index}`,
    );
    // Queue el400 first so the outcome also distinguishes HA's higher priority.
    const priority = ["el400", "harmonic-analyzer"].map((name, index) => {
      const repository = `${ctx.config.githubOwner}/${name}`;
      return { repository, data: commit(repository, index === 0 ? "a" : "b") };
    });
    ctx.state.set(
      "source:github:repositories",
      Object.fromEntries(
        priority.map(({ repository }) => [
          repository,
          {
            fullName: repository,
            owner: ctx.config.githubOwner,
            defaultBranch: "main",
            public: true,
            priority: true,
            contributed: true,
          },
        ]),
      ),
    );
    seedGithub(
      ctx,
      [
        ...ordinary.map((repository) => ({
          id: `repository:${repository}`,
          kind: "repository",
          repository,
          priority: false,
          contributed: false,
        })),
        ...priority.map(({ repository, data }) => ({
          id: `commit:${repository}:${data.sha}`,
          kind: "commit",
          repository,
          sha: data.sha,
        })),
      ],
      Object.fromEntries(
        [...ordinary, ...priority.map(({ repository }) => repository)].map(
          (repository) => [`repository:${repository}`, true as const],
        ),
      ),
    );
    const routes: Record<string, Route> = Object.fromEntries(
      ordinary.map((repository) => [
        `repos/${repository}`,
        {
          data: {
            full_name: repository,
            private: false,
            owner: { login: ctx.config.githubOwner },
            default_branch: "main",
          },
        },
      ]),
    );
    for (const { repository, data } of priority)
      routes[`repos/${repository}/commits/${data.sha}`] = { data };
    await fakeGithub(directory, routes, async (_setRoutes, requests) => {
      const result = await collectGithub(ctx);
      const expected = [...priority].reverse().map(({ repository, data }) => ({
        id: `github:commit:${repository}:${data.sha}`,
        source: "github",
        sourceUrl: data.html_url,
        revision: data.sha,
        provenance: {
          repository,
          public: true,
          verification: "public-source",
        },
      }));
      expect(result.evidence).toMatchObject(expected);
      for (const item of result.evidence) {
        expect(item.text).toContain("Measured controller timing for fixture");
        expect(item.text).toContain("modified: src/controller.ts");
      }
      expect(
        ctx.state
          .evidence()
          .map((item) => item.id)
          .sort(),
      ).toEqual(expected.map((item) => item.id).sort());
      expect(requests()).toHaveLength(80);
      expect(requests().slice(0, 3)).toEqual([
        `repos/${ordinary[0]}`,
        ...[...priority]
          .reverse()
          .map(
            ({ repository, data }) => `repos/${repository}/commits/${data.sha}`,
          ),
      ]);
      expect(
        requests().filter((endpoint) =>
          endpoint.includes("/ordinary-fixture-"),
        ),
      ).toEqual(
        ordinary.slice(0, 78).map((repository) => `repos/${repository}`),
      );
      expect(result.coverage.status).toBe("partial");
      expect(result.coverage.checkpoint).toBeUndefined();
      expect(result.coverage.blockers).toEqual([]);
      const unfinished = ctx.state.get<{
        current?: { tasks: Array<{ id: string }> };
      }>("source:github", {});
      expect(unfinished.current?.tasks.map((task) => task.id)).toEqual(
        ordinary.slice(78).map((repository) => `repository:${repository}`),
      );
    });
  }));

test("GitHub keeps failed windows pending while newer discovery and bounded continuation progress", async () =>
  fixture(async (ctx, directory) => {
    const deleted = "pedropaulovc/deleted-fixture";
    const healthy = "pedropaulovc/el400";
    const old = commit(healthy, "e");
    const fresh = commit(healthy, "f");
    const missing = Array.from({ length: 100 }, (_, index) => {
      const value = commit(deleted, "a");
      value.sha = (index + 1).toString(16).padStart(40, "0");
      value.html_url = `https://github.com/${deleted}/commit/${value.sha}`;
      return value;
    });
    ctx.state.set("source:github:repositories", {
      [healthy]: {
        fullName: healthy,
        owner: ctx.config.githubOwner,
        defaultBranch: "main",
        public: true,
        priority: true,
        contributed: true,
      },
    });
    seedGithub(
      ctx,
      [
        {
          id: `repository:${deleted}`,
          kind: "repository",
          repository: deleted,
          priority: false,
          contributed: false,
        },
        ...missing.map((item) => ({
          id: `commit:${deleted}:${item.sha}`,
          kind: "commit",
          repository: deleted,
          sha: item.sha,
        })),
        {
          id: `commit:${healthy}:${old.sha}`,
          kind: "commit",
          repository: healthy,
          sha: old.sha,
        },
      ],
      { [`repository:${deleted}`]: true, [`repository:${healthy}`]: true },
    );
    const routes: Record<string, Route> = {
      [`repos/${deleted}`]: { status: 404 },
      [`repos/${healthy}/commits/${old.sha}`]: { data: old },
      [`repos/${healthy}/commits/${fresh.sha}`]: { data: fresh },
    };
    for (const item of missing)
      routes[`repos/${deleted}/commits/${item.sha}`] = { data: item };
    await fakeGithub(directory, routes, async (setRoutes, requests) => {
      const first = await collectGithub(ctx);
      expect(first.evidence.map((item) => item.id)).toEqual([
        `github:commit:${healthy}:${old.sha}`,
      ]);
      expect(first.coverage.status).toBe("partial");
      expect(first.coverage.checkpoint).toBeUndefined();
      expect(requests()).toEqual([
        `repos/${deleted}`,
        `repos/${healthy}/commits/${old.sha}`,
      ]);

      ctx.now = new Date("2026-09-21T20:00:00.000Z");
      fresh.commit.author!.date = ctx.now.toISOString();
      fresh.commit.committer!.date = ctx.now.toISOString();
      for (const name of [
        "harmonic-analyzer",
        "el400",
        "agent-plugins",
        "oh-my-pi",
      ]) {
        const repository = `${ctx.config.githubOwner}/${name}`;
        routes[`repos/${repository}`] = {
          data: {
            full_name: repository,
            private: repository !== healthy,
            owner: { login: ctx.config.githubOwner },
            default_branch: "main",
          },
        };
      }
      routes.graphql = {
        data: {
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [],
                issueContributionsByRepository: [],
                pullRequestContributionsByRepository: [],
                pullRequestReviewContributionsByRepository: [],
              },
              repositoriesContributedTo: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
      routes[
        `users/${ctx.config.githubOwner}/repos?type=owner&sort=updated&per_page=100`
      ] = { data: [] };
      routes[`users/${ctx.config.githubOwner}/events/public?per_page=100`] = {
        data: [],
      };
      const from = "2026-09-19T16:00:00.000Z";
      const to = ctx.now.toISOString();
      for (const role of ["authored-pr", "authored-issue", "reviewed-pr"]) {
        const query = `${role === "authored-issue" ? "is:issue" : "is:pr"} ${role === "reviewed-pr" ? "reviewed-by" : "author"}:${ctx.config.githubOwner} is:public -repo:${ctx.config.repository} updated:${from}..${to}`;
        routes[
          `search/issues?${new URLSearchParams({ q: query, sort: "updated", order: "asc", per_page: "100" })}`
        ] = { data: { total_count: 0, incomplete_results: false, items: [] } };
      }
      const freshPage = `repos/${healthy}/commits?${new URLSearchParams({ sha: "main", since: from, until: to, per_page: "100", author: ctx.config.githubOwner })}`;
      routes[freshPage] = { data: [fresh] };
      setRoutes(routes);
      const second = await collectGithub(ctx);
      expect(second.evidence.map((item) => item.id)).toEqual([
        `github:commit:${healthy}:${fresh.sha}`,
      ]);
      expect(second.coverage.status).toBe("partial");
      expect(second.coverage.checkpoint).toBeUndefined();
      expect(
        requests().filter((endpoint) =>
          endpoint.startsWith(`repos/${deleted}/commits/`),
        ),
      ).toEqual([]);
      const gaps = ctx.state.get<{
        pending: Array<{ to: string; tasks: unknown[] }>;
      }>("source:github", { pending: [] }).pending;
      expect(
        gaps.map((window) => ({ to: window.to, tasks: window.tasks.length })),
      ).toEqual([{ to: TO, tasks: 101 }]);

      routes[`repos/${deleted}`] = {
        data: {
          full_name: deleted,
          private: false,
          owner: { login: ctx.config.githubOwner },
          default_branch: "main",
        },
      };
      setRoutes(routes);
      const before = requests().length;
      const third = await collectGithub(ctx);
      expect(third.evidence).toHaveLength(79);
      expect(requests().length - before).toBe(80);
      expect(third.coverage.checkpoint).toBeUndefined();
      const fourth = await collectGithub(ctx);
      expect(fourth.evidence).toHaveLength(21);
      expect(fourth.coverage.status).toBe("complete");
      expect(fourth.coverage.checkpoint).toBe(to);
      expect(
        requests().filter((endpoint) => endpoint === freshPage),
      ).toHaveLength(1);
      expect(
        requests().filter(
          (endpoint) => endpoint === `repos/${healthy}/commits/${old.sha}`,
        ),
      ).toHaveLength(1);
      expect(
        ctx.state
          .evidence()
          .filter((item) => item.provenance.repository === deleted)
          .map((item) => item.id)
          .sort(),
      ).toEqual(
        missing.map((item) => `github:commit:${deleted}:${item.sha}`).sort(),
      );
    });
  }));

test("GitHub public commit trailers redact addresses without dropping machining evidence or bypassing safety", async () =>
  fixture(async (ctx, directory) => {
    const repository = `${ctx.config.githubOwner}/harmonic-analyzer`;
    const authored = commit(repository, "a");
    const unsafe = commit(repository, "b");
    const contact = commit(repository, "c");
    authored.author = { login: "agent-author" };
    authored.commit.message =
      "Measured carriage repeatability\n\nCo-authored-by: Claude <noreply@anthropic.com>\nSigned-off-by: Pedro <123+pedro@users.noreply.github.com>";
    Object.assign(authored.files[0]!, {
      filename: "logbook/entries/fixture.md",
      patch: "+Measured carriage repeatability at 0.03 mm.",
    });
    unsafe.commit.message = `${authored.commit.message}\n\nAuthorization: Bearer fixture-secret-credential-value`;
    contact.commit.message = `${authored.commit.message}\n\nContact person@example.com for fixture details.`;
    ctx.state.set("source:github:repositories", {
      [repository]: {
        fullName: repository,
        owner: ctx.config.githubOwner,
        defaultBranch: "main",
        public: true,
        priority: true,
        contributed: false,
      },
    });
    seedGithub(
      ctx,
      [authored, unsafe, contact].map((item) => ({
        id: `commit:${repository}:${item.sha}`,
        kind: "commit",
        repository,
        sha: item.sha,
      })),
      { [`repository:${repository}`]: true },
    );
    await fakeGithub(
      directory,
      Object.fromEntries(
        [authored, unsafe, contact].map((item) => [
          `repos/${repository}/commits/${item.sha}`,
          { data: item },
        ]),
      ),
      async () => {
        const result = await collectGithub(ctx);
        expect(result.coverage.status).toBe("partial");
        expect(result.evidence.map((item) => item.id)).toEqual([
          `github:commit:${repository}:${authored.sha}`,
        ]);
        expect(result.evidence[0]!.text).toContain(
          "Co-authored-by: Claude <email redacted>",
        );
        expect(result.evidence[0]!.text).toContain(
          "Signed-off-by: Pedro <email redacted>",
        );
        expect(result.evidence[0]!.text).toContain(
          "+Measured carriage repeatability at 0.03 mm.",
        );
        expect(result.evidence[0]!.provenance.actorRole).toBe(
          "project-work-by-other-author",
        );
        expect(
          JSON.stringify({ result, stored: ctx.state.evidence() }),
        ).not.toMatch(
          /noreply@|123\+pedro@|person@example\.com|fixture-secret-credential-value/,
        );
      },
    );
  }));

const DID = "did:plc:fixtureowner";
function post(rkey: string, did = DID) {
  return {
    uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did },
    record: {
      text: `Measured motor current in fixture ${rkey}`,
      createdAt: "2026-09-20T10:00:00Z",
    },
    indexedAt: "2026-09-20T10:00:01Z",
    likeCount: 2,
    replyCount: 0,
  };
}
function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

test("Bluesky cursor resume preserves owner attribution and ignores foreign repost prose", async () =>
  fixture(async (ctx) => {
    let interrupted = true;
    const cursors: Array<string | null> = [];
    const own = post("first");
    const next = post("second");
    const foreign = post("foreign", "did:plc:other");
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = requestUrl(input);
          if (url.pathname.endsWith("resolveHandle"))
            return Response.json({ did: DID });
          if (url.pathname.endsWith("getProfile"))
            return Response.json({ did: DID, followersCount: 20 });
          if (url.pathname.endsWith("getAuthorFeed")) {
            expect(
              Object.fromEntries(
                [...url.searchParams].filter(([key]) => key !== "cursor"),
              ),
            ).toEqual({
              actor: DID,
              limit: "100",
              filter: "posts_with_replies",
              includePins: "false",
            });
            cursors.push(url.searchParams.get("cursor"));
            if (!url.searchParams.has("cursor"))
              return Response.json({
                feed: [
                  { post: own },
                  {
                    post: foreign,
                    reason: {
                      $type: "app.bsky.feed.defs#reasonRepost",
                      indexedAt: "2026-09-20T11:00:00Z",
                    },
                  },
                ],
                cursor: "page-two",
              });
            if (interrupted) return new Response("", { status: 403 });
            return Response.json({ feed: [{ post: own }, { post: next }] });
          }
          throw new Error("Unexpected source endpoint");
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const first = await collectBluesky(ctx);
    expect(first.coverage.status).toBe("partial");
    expect(first.coverage.checkpoint).toBeUndefined();
    expect(ctx.state.evidence().map((item) => item.id)).toEqual([
      `bluesky:${own.uri}`,
    ]);
    interrupted = false;
    const resumed = await collectBluesky(ctx);
    expect(cursors).toEqual([null, "page-two", "page-two"]);
    expect(resumed.coverage.checkpoint).toBe(ctx.now.toISOString());
    expect(
      ctx.state
        .evidence()
        .map((item) => item.id)
        .sort(),
    ).toEqual([`bluesky:${own.uri}`, `bluesky:${next.uri}`].sort());
    expect(
      ctx.state.evidence().every((item) => item.provenance.authorDid === DID),
    ).toBe(true);
    expect(ctx.state.putEvidence(resumed.evidence)).toBe(0);
  }));

test("one failed Hindsight bank retains successful evidence and retries pending work without exposing secrets", async () =>
  fixture(async (ctx) => {
    let failSecond = true;
    const recalls: string[] = [];
    const banks = ["omp-harmonic-analyzer", "temporary-useful-work"].map(
      (bank_id) => ({
        bank_id,
        fact_count: 1,
        last_write_at: "2026-09-20T12:00:00Z",
      }),
    );
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url = requestUrl(input);
          if (url.pathname === "/v1/default/banks")
            return Response.json({ banks, total: banks.length });
          const bank = decodeURIComponent(url.pathname.split("/")[4]!);
          recalls.push(bank);
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          expect(body.budget).toBe("low");
          expect(body.max_tokens).toBe(2048);
          expect(body.trace).toBe(false);
          if (bank === "temporary-useful-work" && failSecond)
            return new Response(
              "fixture-hindsight-credential must never escape",
              { status: 403 },
            );
          return Response.json({
            results: [
              {
                id: `memory-${bank}`,
                text: "Measured controller latency with a reproducible engineering workflow.",
                occurred_start: "2026-09-20T11:00:00Z",
              },
            ],
          });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const first = await collectHindsight(ctx);
    expect(first.coverage.status).toBe("partial");
    expect(first.coverage.detail).not.toContain("fixture-hindsight-credential");
    expect(ctx.state.evidence().map((item) => item.id)).toEqual([
      "hindsight:omp-harmonic-analyzer:memory-omp-harmonic-analyzer",
    ]);
    failSecond = false;
    const second = await collectHindsight(ctx);
    expect(second.coverage.status).toBe("ranked");
    expect(
      ctx.state
        .evidence()
        .map((item) => item.id)
        .sort(),
    ).toEqual([
      "hindsight:omp-harmonic-analyzer:memory-omp-harmonic-analyzer",
      "hindsight:temporary-useful-work:memory-temporary-useful-work",
    ]);
    expect(
      recalls.filter((bank) => bank === "temporary-useful-work"),
    ).toHaveLength(2);
    expect(
      ctx.state
        .evidence()
        .every(
          (item) =>
            item.sourceUrl === null &&
            item.provenance.verification === "reported-work-notes",
        ),
    ).toBe(true);
  }));
