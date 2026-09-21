import { createHash } from "node:crypto";
import { z } from "zod";
import { isoWeek } from "../calendar";
import type { Collection, Context, Evidence } from "../contracts";
import { ApiError, gh, ghResponse, graphql } from "../github-api";
import { sanitize } from "../safety";

const KEY = "source:github";
const REPOS = "source:github:repositories";
const DAY = 86_400_000;
const NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LoginSchema = z.object({ login: z.string() });
const RepoSchema = z.object({
  full_name: z.string().regex(NAME),
  private: z.boolean(),
  owner: LoginSchema,
  default_branch: z.string(),
  parent: z
    .object({ full_name: z.string().regex(NAME), private: z.boolean() })
    .optional(),
});
const GraphRepoSchema = z.object({
  nameWithOwner: z.string().regex(NAME),
  isPrivate: z.boolean(),
  owner: LoginSchema,
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
});
const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const IssueSchema = z.object({
  node_id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.url(),
  user: LoginSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  state: z.string(),
  pull_request: z.unknown().optional(),
});
const PullSchema = IssueSchema.extend({
  merged_at: z.string().nullable(),
  merged_by: LoginSchema.nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ repo: RepoSchema }),
});
const CommitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  html_url: z.url(),
  author: LoginSchema.nullable(),
  committer: LoginSchema.nullable(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string(), date: z.string() }).nullable(),
    committer: z.object({ name: z.string(), date: z.string() }).nullable(),
  }),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        patch: z.string().optional(),
      }),
    )
    .optional(),
});
const SearchSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z
    .array(
      z.object({
        number: z.number().int().positive(),
        repository_url: z.string(),
        pull_request: z.unknown().optional(),
      }),
    )
    .max(100),
});
const ReviewSchema = z.object({
  node_id: z.string(),
  user: LoginSchema.nullable(),
  body: z.string(),
  state: z.string(),
  submitted_at: z.string().nullable(),
  commit_id: z.string().nullable(),
  html_url: z.url(),
});
interface Repository {
  fullName: string;
  owner: string;
  defaultBranch: string;
  priority: boolean;
  contributed: boolean;
  public: true;
}
type Task =
  | {
      id: string;
      kind: "repository";
      repository: string;
      priority: boolean;
      contributed: boolean;
    }
  | { id: string; kind: "owned"; cursor?: string }
  | { id: string; kind: "contributed"; cursor?: string }
  | { id: string; kind: "contributions" }
  | { id: string; kind: "events"; endpoint?: string }
  | {
      id: string;
      kind: "search";
      role: "authored-pr" | "authored-issue" | "reviewed-pr";
      from: string;
      to: string;
      endpoint?: string;
    }
  | { id: string; kind: "commits"; repository: string; endpoint?: string }
  | { id: string; kind: "commit"; repository: string; sha: string }
  | {
      id: string;
      kind: "issue" | "pull" | "reviews";
      repository: string;
      number: number;
      endpoint?: string;
    };
interface Window {
  from: string;
  to: string;
  week?: string;
  tasks: Task[];
  known: Record<string, true>;
  warnings: string[];
  withheld: number;
}
interface GitState {
  checkpoint?: string;
  current?: Window;
  lookback?: Window;
  lookbackWeek?: string;
  lastLookback?: string;
  frontier?: string;
  pending?: Window[];
}
class SourceError extends Error {}
function fail(error: unknown): string {
  if (error instanceof ApiError)
    return `GitHub ${error.endpoint.split("?")[0]}: HTTP ${error.status}`;
  return error instanceof SourceError
    ? error.message
    : "GitHub request failed or schema invalid; response body withheld";
}
function append(window: Window, task: Task): void {
  if (window.known[task.id]) return;
  window.known[task.id] = true;
  window.tasks.push(task);
}
function makeWindow(
  ctx: Context,
  from: string,
  to: string,
  weekly?: string,
): Window {
  const window: Window = {
    from,
    to,
    week: weekly,
    tasks: [],
    known: {},
    warnings: [],
    withheld: 0,
  };
  for (const name of [
    "harmonic-analyzer",
    "el400",
    "agent-plugins",
    "oh-my-pi",
  ])
    append(window, {
      id: `repository:${ctx.config.githubOwner}/${name}`,
      kind: "repository",
      repository: `${ctx.config.githubOwner}/${name}`,
      priority: true,
      contributed: false,
    });
  append(window, { id: "contributions", kind: "contributions" });
  if (!weekly) {
    append(window, { id: "owned", kind: "owned" });
    append(window, { id: "contributed", kind: "contributed" });
    append(window, { id: "events", kind: "events" });
  }
  for (const role of ["authored-pr", "authored-issue", "reviewed-pr"] as const)
    append(window, {
      id: `search:${role}:${from}:${to}`,
      kind: "search",
      role,
      from,
      to,
    });
  return window;
}
function next(
  headers: Record<string, string>,
  endpoint: string,
): string | undefined {
  const link = headers.link
    ?.split(",")
    .find((part) => /rel="next"/.test(part))
    ?.match(/<([^>]+)>/)?.[1];
  if (!link) return;
  const url = new URL(link);
  const original = new URL(endpoint, "https://api.github.com/");
  const namedRepository = original.pathname.match(
    /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.+)$/,
  );
  const numberedRepository = url.pathname.match(
    /^\/repositories\/[0-9]+(\/.+)$/,
  );
  const namedUser = original.pathname.match(/^\/users\/[A-Za-z0-9-]+(\/.+)$/);
  const numberedUser = url.pathname.match(/^\/user\/[0-9]+(\/.+)$/);
  const sameRepositoryResource =
    namedRepository &&
    numberedRepository &&
    namedRepository[1] === numberedRepository[1];
  const sameUserResource =
    namedUser && numberedUser && namedUser[1] === numberedUser[1];
  if (
    url.origin !== "https://api.github.com" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.pathname !== original.pathname &&
      !sameRepositoryResource &&
      !sameUserResource)
  )
    throw new SourceError(
      `GitHub unexpected pagination destination for ${original.pathname}: ${url.origin === "https://api.github.com" ? url.pathname : "different host"}`,
    );
  // GitHub emits numeric repository/user aliases in Link headers. Keep our
  // original named path and only follow the query, never a different resource.
  return original.pathname.slice(1) + url.search;
}
function publicUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== "https://github.com")
    throw new SourceError("GitHub unexpected public evidence URL");
  return sanitize(value);
}
function publicCommitMessage(message: string): string {
  // Public git identity trailers are attribution, not evidence of private contacts.
  // Redact only their addresses; the entire remaining message and diff still pass the global gate.
  return message.replace(
    /^((?:Co-authored-by|Signed-off-by|Acked-by|Reviewed-by|Reported-by|Tested-by|Suggested-by|Helped-by):[^\r\n<>]*<)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(>[\t ]*)$/gim,
    "$1email redacted$2",
  );
}
function persist(ctx: Context, items: Evidence[], output: Evidence[]): void {
  ctx.state.putEvidence(items);
  output.push(...items);
}
function normalize(
  ctx: Context,
  window: Window,
  data: Omit<Evidence, "source" | "observedAt" | "text"> & { text: string },
): Evidence | undefined {
  try {
    const text = sanitize(data.text);
    const provenance = JSON.parse(
      sanitize(JSON.stringify(data.provenance)),
    ) as Record<string, unknown>;
    return {
      ...data,
      source: "github",
      observedAt: ctx.now.toISOString(),
      sourceUrl: data.sourceUrl ? publicUrl(data.sourceUrl) : null,
      text: text.slice(0, 6000),
      provenance: { ...provenance, textTruncated: text.length > 6000 },
    };
  } catch {
    window.withheld++;
    return;
  }
}
function register(
  ctx: Context,
  window: Window,
  registry: Record<string, Repository>,
  input: Repository,
): void {
  if (input.fullName.toLowerCase() === ctx.config.repository.toLowerCase())
    return;
  const old = registry[input.fullName];
  const repo = {
    ...input,
    priority: input.priority || old?.priority || false,
    contributed: input.contributed || old?.contributed || false,
  };
  registry[repo.fullName] = repo;
  if (repo.priority || repo.contributed)
    append(window, {
      id: `commits:${repo.fullName}`,
      kind: "commits",
      repository: repo.fullName,
    });
}
function discover(
  window: Window,
  repository: string,
  contributed = true,
): void {
  if (!NAME.test(repository))
    throw new SourceError("GitHub repository name invalid");
  append(window, {
    id: `repository:${repository}`,
    kind: "repository",
    repository,
    priority: false,
    contributed,
  });
}
function repoFromApiUrl(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== "https://api.github.com" ||
    !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)
  )
    throw new SourceError("GitHub repository URL invalid");
  return url.pathname.slice("/repos/".length);
}
const CONTRIBUTIONS_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){commitContributionsByRepository(maxRepositories:100){repository{nameWithOwner isPrivate owner{login} defaultBranchRef{name}}}issueContributionsByRepository(maxRepositories:100){repository{nameWithOwner isPrivate owner{login} defaultBranchRef{name}}}pullRequestContributionsByRepository(maxRepositories:100){repository{nameWithOwner isPrivate owner{login} defaultBranchRef{name}}}pullRequestReviewContributionsByRepository(maxRepositories:100){repository{nameWithOwner isPrivate owner{login} defaultBranchRef{name}}}}}}`;
const CONTRIBUTED_QUERY = `query($login:String!,$after:String){user(login:$login){repositoriesContributedTo(first:100,after:$after,includeUserRepositories:true,contributionTypes:[COMMIT,ISSUE,PULL_REQUEST,PULL_REQUEST_REVIEW],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{nameWithOwner isPrivate owner{login} defaultBranchRef{name}}pageInfo{hasNextPage endCursor}}}}`;

async function step(
  ctx: Context,
  window: Window,
  task: Task,
  registry: Record<string, Repository>,
  output: Evidence[],
): Promise<boolean> {
  if (task.kind === "repository") {
    if (task.repository.toLowerCase() === ctx.config.repository.toLowerCase())
      return true;
    const repo = RepoSchema.parse(
      await gh<unknown>(`repos/${task.repository}`, { signal: ctx.signal }),
    );
    if (repo.private) {
      delete registry[task.repository];
      return true;
    }
    register(ctx, window, registry, {
      fullName: repo.full_name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch,
      priority: task.priority,
      contributed: task.contributed,
      public: true,
    });
    if (
      task.repository === `${ctx.config.githubOwner}/oh-my-pi` &&
      repo.parent &&
      !repo.parent.private
    )
      append(window, {
        id: `repository:${repo.parent.full_name}`,
        kind: "repository",
        repository: repo.parent.full_name,
        priority: true,
        contributed: true,
      });
    return true;
  }
  if (task.kind === "owned") {
    const endpoint =
      task.cursor ??
      `users/${encodeURIComponent(ctx.config.githubOwner)}/repos?type=owner&sort=updated&per_page=100`;
    const result = await ghResponse<unknown>(endpoint, { signal: ctx.signal });
    for (const repo of z.array(RepoSchema).max(100).parse(result.data)) {
      if (!repo.private)
        register(ctx, window, registry, {
          fullName: repo.full_name,
          owner: repo.owner.login,
          defaultBranch: repo.default_branch,
          priority: false,
          contributed: false,
          public: true,
        });
    }
    task.cursor = next(result.headers, endpoint);
    return !task.cursor;
  }
  if (task.kind === "contributions") {
    const entry = z.array(z.object({ repository: GraphRepoSchema })).max(100);
    const data = z
      .object({
        user: z.object({
          contributionsCollection: z.object({
            commitContributionsByRepository: entry,
            issueContributionsByRepository: entry,
            pullRequestContributionsByRepository: entry,
            pullRequestReviewContributionsByRepository: entry,
          }),
        }),
      })
      .parse(
        await graphql<unknown>(
          CONTRIBUTIONS_QUERY,
          { login: ctx.config.githubOwner, from: window.from, to: window.to },
          ctx.signal,
        ),
      );
    for (const values of Object.values(data.user.contributionsCollection)) {
      if (
        values.length === 100 &&
        !window.warnings.includes(
          "Contribution-repository group reached its 100-repository cap; supplemental connection/search enumeration used",
        )
      )
        window.warnings.push(
          "Contribution-repository group reached its 100-repository cap; supplemental connection/search enumeration used",
        );
      for (const { repository: repo } of values)
        if (!repo.isPrivate && repo.defaultBranchRef)
          register(ctx, window, registry, {
            fullName: repo.nameWithOwner,
            owner: repo.owner.login,
            defaultBranch: repo.defaultBranchRef.name,
            priority: false,
            contributed: true,
            public: true,
          });
    }
    return true;
  }
  if (task.kind === "contributed") {
    const data = z
      .object({
        user: z.object({
          repositoriesContributedTo: z.object({
            nodes: z.array(GraphRepoSchema).max(100),
            pageInfo: PageInfoSchema,
          }),
        }),
      })
      .parse(
        await graphql<unknown>(
          CONTRIBUTED_QUERY,
          { login: ctx.config.githubOwner, after: task.cursor ?? null },
          ctx.signal,
        ),
      );
    const connection = data.user.repositoriesContributedTo;
    for (const repo of connection.nodes)
      if (!repo.isPrivate && repo.defaultBranchRef)
        register(ctx, window, registry, {
          fullName: repo.nameWithOwner,
          owner: repo.owner.login,
          defaultBranch: repo.defaultBranchRef.name,
          priority: false,
          contributed: true,
          public: true,
        });
    if (
      connection.pageInfo.hasNextPage &&
      (!connection.pageInfo.endCursor ||
        connection.pageInfo.endCursor === task.cursor)
    )
      throw new SourceError(
        "GitHub contribution repository cursor did not advance",
      );
    task.cursor = connection.pageInfo.endCursor ?? undefined;
    return !connection.pageInfo.hasNextPage;
  }
  if (task.kind === "events") {
    const endpoint =
      task.endpoint ??
      `users/${encodeURIComponent(ctx.config.githubOwner)}/events/public?per_page=100`;
    const result = await ghResponse<unknown>(endpoint, { signal: ctx.signal });
    const events = z
      .array(
        z.object({
          public: z.boolean(),
          repo: z.object({ name: z.string().regex(NAME) }),
          created_at: z.string(),
          type: z.string(),
          payload: z.object({
            number: z.number().int().positive().optional(),
            pull_request: z
              .object({ number: z.number().int().positive() })
              .optional(),
            issue: z.object({ number: z.number().int().positive() }).optional(),
            commits: z
              .array(z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }))
              .optional(),
          }),
        }),
      )
      .max(100)
      .parse(result.data);
    for (const event of events) {
      if (
        !event.public ||
        event.repo.name.toLowerCase() === ctx.config.repository.toLowerCase() ||
        event.created_at < window.from ||
        event.created_at > window.to
      )
        continue;
      discover(window, event.repo.name);
      const number = event.payload.pull_request?.number ?? event.payload.number;
      if (number && /PullRequest/.test(event.type))
        append(window, {
          id: `pull:${event.repo.name}:${number}`,
          kind: "pull",
          repository: event.repo.name,
          number,
        });
      if (event.payload.issue)
        append(window, {
          id: `issue:${event.repo.name}:${event.payload.issue.number}`,
          kind: "issue",
          repository: event.repo.name,
          number: event.payload.issue.number,
        });
      for (const commit of event.payload.commits ?? [])
        append(window, {
          id: `commit:${event.repo.name}:${commit.sha}`,
          kind: "commit",
          repository: event.repo.name,
          sha: commit.sha,
        });
    }
    task.endpoint = next(result.headers, endpoint);
    // Public events are explicitly a capped freshness hint, never the completeness ledger.
    return (
      !task.endpoint || events.every((event) => event.created_at < window.from)
    );
  }
  if (task.kind === "search") {
    const query = `${task.role === "authored-issue" ? "is:issue" : "is:pr"} ${task.role === "reviewed-pr" ? "reviewed-by" : "author"}:${ctx.config.githubOwner} is:public -repo:${ctx.config.repository} updated:${task.from}..${task.to}`;
    const endpoint =
      task.endpoint ??
      `search/issues?${new URLSearchParams({ q: query, sort: "updated", order: "asc", per_page: "100" })}`;
    const result = await ghResponse<unknown>(endpoint, { signal: ctx.signal });
    const search = SearchSchema.parse(result.data);
    if (search.total_count >= 900 || search.incomplete_results) {
      const from = Date.parse(task.from);
      const to = Date.parse(task.to);
      if (to - from < 2000)
        throw new SourceError(
          "GitHub search exceeded a one-second window; checkpoint retained below search ceiling",
        );
      const middle = new Date(
        Math.floor((from + to) / 2000) * 1000,
      ).toISOString();
      for (const [start, end] of [
        [task.from, middle],
        [middle, task.to],
      ])
        append(window, {
          id: `search:${task.role}:${start}:${end}`,
          kind: "search",
          role: task.role,
          from: start!,
          to: end!,
        });
      return true;
    }
    for (const issue of search.items) {
      const repository = repoFromApiUrl(issue.repository_url);
      if (repository.toLowerCase() === ctx.config.repository.toLowerCase())
        continue;
      discover(window, repository);
      const kind = task.role === "authored-issue" ? "issue" : "pull";
      append(window, {
        id: `${kind}:${repository}:${issue.number}`,
        kind,
        repository,
        number: issue.number,
      });
      if (task.role === "reviewed-pr")
        append(window, {
          id: `reviews:${repository}:${issue.number}`,
          kind: "reviews",
          repository,
          number: issue.number,
        });
    }
    task.endpoint = next(result.headers, endpoint);
    return !task.endpoint;
  }
  // The scheduler waits for this window's repository lookup before hydrating evidence.
  const repo = registry[task.repository];
  if (
    !repo ||
    repo.fullName.toLowerCase() === ctx.config.repository.toLowerCase()
  )
    return true;
  if (task.kind === "commits") {
    const params = new URLSearchParams({
      sha:
        task.repository === `${ctx.config.githubOwner}/harmonic-analyzer`
          ? "main"
          : repo.defaultBranch,
      since: window.from,
      until: window.to,
      per_page: "100",
    });
    if (task.repository !== `${ctx.config.githubOwner}/harmonic-analyzer`)
      params.set("author", ctx.config.githubOwner);
    const endpoint =
      task.endpoint ?? `repos/${task.repository}/commits?${params}`;
    let result: { data: unknown; headers: Record<string, string> };
    try {
      result = await ghResponse<unknown>(endpoint, { signal: ctx.signal });
    } catch (error) {
      // GitHub returns 409 rather than [] for a repository with no commits.
      if (error instanceof ApiError && error.status === 409) return true;
      throw error;
    }
    for (const commit of z.array(CommitSchema).max(100).parse(result.data))
      append(window, {
        id: `commit:${task.repository}:${commit.sha}`,
        kind: "commit",
        repository: task.repository,
        sha: commit.sha,
      });
    task.endpoint = next(result.headers, endpoint);
    return !task.endpoint;
  }
  if (task.kind === "commit") {
    const commit = CommitSchema.parse(
      await gh<unknown>(`repos/${task.repository}/commits/${task.sha}`, {
        signal: ctx.signal,
      }),
    );
    const relevant = (commit.files ?? []).filter((file) =>
      /^(logbook\/entries\/|kickstarter\/campaign\/)/.test(file.filename),
    );
    const paths = (commit.files ?? [])
      .slice(0, 40)
      .map((file) => `${file.status}: ${file.filename}`)
      .join("\n");
    const excerpts = relevant
      .slice(0, 6)
      .map(
        (file) =>
          `${file.filename}\n${file.patch ?? "(patch unavailable; inspect public commit)"}`,
      )
      .join("\n");
    const item = normalize(ctx, window, {
      id: `github:commit:${task.repository}:${commit.sha}`,
      sourceUrl: commit.html_url,
      revision: commit.sha,
      occurredAt:
        commit.commit.author?.date ?? commit.commit.committer?.date ?? null,
      text: `${publicCommitMessage(commit.commit.message)}\n\nChanged paths:\n${paths}\n${excerpts ? `\nLogbook/campaign diff (not proof of a shop session):\n${excerpts}` : ""}`,
      provenance: {
        repository: task.repository,
        public: true,
        object: "commit",
        author: commit.author?.login ?? commit.commit.author?.name ?? null,
        committer:
          commit.committer?.login ?? commit.commit.committer?.name ?? null,
        actorRole:
          commit.author?.login === ctx.config.githubOwner
            ? "author"
            : "project-work-by-other-author",
        defaultBranch: repo.defaultBranch,
        verification: "public-source",
        filesListed: commit.files?.length ?? 0,
        fileListMayBeTruncated: (commit.files?.length ?? 0) >= 300,
      },
    });
    if (item) persist(ctx, [item], output);
    return true;
  }
  if (task.kind === "reviews") {
    const endpoint =
      task.endpoint ??
      `repos/${task.repository}/pulls/${task.number}/reviews?per_page=100`;
    const result = await ghResponse<unknown>(endpoint, { signal: ctx.signal });
    const items: Evidence[] = [];
    for (const review of z.array(ReviewSchema).max(100).parse(result.data)) {
      if (
        review.user?.login.toLowerCase() !==
          ctx.config.githubOwner.toLowerCase() ||
        !review.submitted_at ||
        review.submitted_at < window.from ||
        review.submitted_at > window.to
      )
        continue;
      const item = normalize(ctx, window, {
        id: `github:${review.node_id}`,
        sourceUrl: review.html_url,
        occurredAt: review.submitted_at,
        revision: createHash("sha256")
          .update(`${review.commit_id}:${review.state}:${review.body}`)
          .digest("hex"),
        text: `Pedro reviewed PR #${task.number} (${review.state}); this is review work, not authorship of the PR.\n${review.body}`,
        provenance: {
          repository: task.repository,
          public: true,
          object: "review",
          actorRole: "reviewer",
          reviewer: review.user.login,
          pullRequest: task.number,
          reviewedCommit: review.commit_id,
          verification: "public-source",
        },
      });
      if (item) items.push(item);
    }
    persist(ctx, items, output);
    task.endpoint = next(result.headers, endpoint);
    return !task.endpoint;
  }
  const endpoint = `repos/${task.repository}/${task.kind === "pull" ? "pulls" : "issues"}/${task.number}`;
  const raw = await gh<unknown>(endpoint, { signal: ctx.signal });
  const issue = IssueSchema.parse(raw);
  const pull = task.kind === "pull" ? PullSchema.parse(raw) : undefined;
  if (pull?.base.repo.private) return true;
  const item = normalize(ctx, window, {
    id: `github:${issue.node_id}`,
    sourceUrl: issue.html_url,
    occurredAt: issue.created_at,
    revision: pull
      ? `${issue.updated_at}:${pull.head.sha}:${pull.merged_at ?? ""}`
      : issue.updated_at,
    text: `${task.kind === "pull" ? "Pull request" : "Issue"} #${issue.number}: ${issue.title}\n${issue.body ?? ""}`,
    provenance: {
      repository: task.repository,
      public: true,
      object: task.kind,
      author: issue.user?.login ?? null,
      actorRole:
        issue.user?.login.toLowerCase() === ctx.config.githubOwner.toLowerCase()
          ? "author"
          : "contribution-context-not-authorship",
      mergedBy: pull?.merged_by?.login ?? null,
      mergedAt: pull?.merged_at ?? null,
      updatedAt: issue.updated_at,
      verification: "public-source",
    },
  });
  if (item) persist(ctx, [item], output);
  return true;
}

export async function collectGithub(ctx: Context): Promise<Collection> {
  const state = ctx.state.get<GitState>(KEY, {});
  const registry = ctx.state.get<Record<string, Repository>>(REPOS, {});
  const evidence: Evidence[] = [];
  const failures: string[] = [];
  const thisWeek = isoWeek(ctx.now, ctx.config.timezone);
  const now = ctx.now.toISOString();
  const pending = (state.pending ??= []);
  // Discovery may move forward while the completeness checkpoint waits for every gap.
  // Keep each unfinished window, including page cursors and its visibility lookups.
  state.frontier ??= state.current?.to ?? state.checkpoint;
  if (state.current && state.current.to < now) {
    pending.push(state.current);
    state.current = undefined;
  }
  if (!state.current && (!state.frontier || state.frontier < now)) {
    state.current = makeWindow(
      ctx,
      new Date(
        state.frontier
          ? Date.parse(state.frontier) - 2 * DAY
          : ctx.now.getTime() - 30 * DAY,
      ).toISOString(),
      now,
    );
    state.frontier = now;
  }
  if (state.lookback && state.lookback.week !== thisWeek) {
    pending.push(state.lookback);
    state.lookback = undefined;
  }
  if (!state.lookback && state.lookbackWeek !== thisWeek)
    state.lookback = makeWindow(
      ctx,
      new Date(ctx.now.getTime() - 90 * DAY).toISOString(),
      now,
      thisWeek,
    );
  ctx.state.set(KEY, state);
  const blocked = new Set<Task>();
  const blockedRepositories = new Set<string>();
  function runnable(window: Window): number {
    // Discover missing metadata without spending an operation on each waiting dependent.
    for (const task of window.tasks) {
      if (
        "repository" in task &&
        task.kind !== "repository" &&
        !window.known[`repository:${task.repository}`]
      )
        discover(window, task.repository);
    }
    const metadataPending = new Set(
      window.tasks
        .filter((task) => task.kind === "repository")
        .map((task) => task.repository),
    );
    let selected = -1,
      best = -1;
    for (let index = 0; index < window.tasks.length; index++) {
      const task = window.tasks[index]!;
      if (
        blocked.has(task) ||
        ("repository" in task &&
          (task.kind === "repository"
            ? blockedRepositories.has(task.repository)
            : metadataPending.has(task.repository)))
      )
        continue;
      // Every third operation retains FIFO fairness; other turns fetch useful
      // priority evidence rather than exhausting the budget enumerating metadata.
      if (steps % 3 === 0) return index;
      const repository = "repository" in task ? task.repository : "";
      const priority =
        repository === `${ctx.config.githubOwner}/harmonic-analyzer`
          ? 100
          : repository === `${ctx.config.githubOwner}/el400`
            ? 90
            : registry[repository]?.priority
              ? 30
              : 0;
      const score =
        priority + (["commit", "pull", "issue"].includes(task.kind) ? 10 : 0);
      if (score > best) {
        selected = index;
        best = score;
      }
    }
    return selected;
  }
  let steps = 0;
  let completed = 0;
  let withheld = 0;
  const warnings = new Set<string>();
  while (steps < 80 && !ctx.signal.aborted) {
    // Reserve turns for fresh discovery, old gaps and the weekly lookback. Rotate
    // persisted windows after every attempt so an old permanent failure cannot pin them.
    const windows =
      steps % 4 === 2
        ? [...pending, state.current, state.lookback]
        : steps % 4 === 3
          ? [state.lookback, state.current, ...pending]
          : [state.current, state.lookback, ...pending];
    let window: Window | undefined;
    let index = -1;
    for (const candidate of windows) {
      if (candidate && (index = runnable(candidate)) >= 0) {
        window = candidate;
        break;
      }
    }
    if (!window) break;
    const task = window.tasks.splice(index, 1)[0]!;
    try {
      const done = await step(ctx, window, task, registry, evidence);
      if (!done) window.tasks.push(task);
      else completed++;
    } catch (error) {
      failures.push(fail(error));
      window.tasks.push(task);
      blocked.add(task);
      if (task.kind === "repository") blockedRepositories.add(task.repository);
    }
    const pendingIndex = pending.indexOf(window);
    if (pendingIndex >= 0) {
      pending.splice(pendingIndex, 1);
      pending.push(window);
    }
    steps++;
    ctx.state.set(REPOS, registry);
    ctx.state.set(KEY, state);
  }
  for (const window of [state.current, state.lookback, ...pending]) {
    if (!window) continue;
    withheld += window.withheld;
    window.warnings.forEach((warning) => warnings.add(warning));
    if (
      !window.tasks.length &&
      window.week &&
      (!state.lastLookback || state.lastLookback <= window.to)
    ) {
      state.lookbackWeek = window.week;
      state.lastLookback = window.to;
    }
  }
  if (state.current && !state.current.tasks.length) state.current = undefined;
  if (state.lookback && !state.lookback.tasks.length)
    state.lookback = undefined;
  state.pending = pending.filter((window) => window.tasks.length);
  if (!state.current && !state.pending.some((window) => !window.week))
    state.checkpoint = state.frontier;
  ctx.state.set(KEY, state);
  if (withheld)
    failures.push(
      `Source-sanitization blocker: ${withheld} evidence objects withheld`,
    );
  const remaining =
    (state.current?.tasks.length ?? 0) +
    (state.lookback?.tasks.length ?? 0) +
    state.pending.reduce((sum, window) => sum + window.tasks.length, 0);
  return {
    evidence,
    coverage: {
      source: "github",
      status:
        remaining || failures.length || warnings.size || ctx.signal.aborted
          ? "partial"
          : "complete",
      count: evidence.length,
      checkpoint: state.checkpoint,
      blockers: [...new Set(failures)],
      detail: `${completed} operations completed (${steps}/80 operation budget); ${remaining} persisted operations pending; ${Object.keys(registry).length} public repositories discovered. ${state.lookback || state.pending.some((window) => window.week) ? "Weekly 90-day contribution lookback pending." : `Weekly lookback completed at ${state.lastLookback ?? "never"}.`} Public events are a capped freshness hint; default-branch commit scans are not all-branch history. Editorial automation excluded; human workspace inputs are handled separately.${[...warnings, ...new Set(failures)].length ? ` ${[...warnings, ...new Set(failures)].join("; ")}` : ""}`,
    },
  };
}

export async function doctorGithub(ctx: Context): Promise<unknown> {
  const result: Record<string, unknown> = {
    source: "github",
    available: false,
  };
  try {
    const user = LoginSchema.parse(
      await gh<unknown>("user", { signal: ctx.signal }),
    );
    result.authenticatedUser = user.login;
    result.expectedUser = ctx.config.githubOwner;
    result.available =
      user.login.toLowerCase() === ctx.config.githubOwner.toLowerCase();
    if (!result.available)
      result.identityError =
        "Authenticated GitHub user does not match configured owner";
  } catch (error) {
    result.authenticationError = fail(error);
  }
  try {
    const data = z
      .object({
        viewer: z.object({
          login: z.string(),
          projectsV2: z.object({
            totalCount: z.number().int(),
            nodes: z.array(z.object({ id: z.string(), url: z.url() })),
          }),
        }),
      })
      .parse(
        await graphql<unknown>(
          "query{viewer{login projectsV2(first:1){totalCount nodes{id url}}}}",
          {},
          ctx.signal,
        ),
      );
    result.projectAccess = {
      readable: true,
      totalCount: data.viewer.projectsV2.totalCount,
      mutationTested: false,
    };
  } catch (error) {
    result.projectAccess = { readable: false, error: fail(error) };
  }
  try {
    const repo = RepoSchema.parse(
      await gh<unknown>(`repos/${ctx.config.repository}`, {
        signal: ctx.signal,
      }),
    );
    result.workspace = { accessible: true, public: !repo.private };
  } catch (error) {
    result.workspace = { accessible: false, error: fail(error) };
  }
  const traffic: Record<string, unknown> = {};
  for (const name of ["harmonic-analyzer", "el400"]) {
    const repository = `${ctx.config.githubOwner}/${name}`;
    try {
      const data = z
        .object({
          views: z.array(
            z.object({
              timestamp: z.string(),
              count: z.number(),
              uniques: z.number(),
            }),
          ),
        })
        .parse(
          await gh<unknown>(`repos/${repository}/traffic/views?per=day`, {
            signal: ctx.signal,
          }),
        );
      traffic[repository] = {
        available: true,
        dailyRecords: data.views.length,
        window: "rolling 14 days; repository visits, not blog conversion",
      };
    } catch (error) {
      traffic[repository] = { available: false, error: fail(error) };
    }
  }
  result.traffic = traffic;
  return result;
}
