// Run this file in its own Bun test process: the transport is intentionally isolated.
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state";
import { loadConfig } from "../src/config";
import type {
  Candidate,
  Context,
  EditorRequest,
  EditorResponse,
  Publication,
} from "../src/contracts";

const repo = "repos/pedropaulovc/editor-in-chief";
let sha = "a".repeat(40),
  author = "pedropaulovc",
  labeled = true,
  acceptThenTimeout = false;
let reviews: {
    id: number;
    body: string;
    user: { login: string };
    commit_id: string;
    submitted_at: string;
  }[] = [],
  submissions = 0,
  edits = 0;
let boardStatus: string | null = "Inbox";
const pageInfo = { hasNextPage: false, endCursor: null };
const content = "The measurements are repeatable.\n";
const issue = {
  number: 9,
  node_id: "I_9",
  title: "Verification story",
  body: "Human notes stay unchanged.",
  html_url: "https://github.com/pedropaulovc/editor-in-chief/issues/9",
  user: { login: "pedropaulovc" },
  labels: [{ name: "editorial-story" }],
};
const inbox = {
  ...issue,
  number: 1,
  node_id: "I_1",
  title: "Capture inbox",
  body: "<!-- eic:inbox -->\nPublic capture notes.\n<!-- /eic:inbox -->",
  html_url: "https://github.com/pedropaulovc/editor-in-chief/issues/1",
  labels: [{ name: "editorial-capture" }],
};
let issues = [issue],
  issuePatches = 0,
  commentWrites = 0,
  networkDown = false;
let discussion: {
  id: number;
  body: string;
  user: { login: string };
  issueNumber: number;
}[] = [];
let boardWrites: string[] = [],
  beforeBoardRead: (() => void) | null = null;
const pull = () => ({
  number: 10,
  node_id: "P_10",
  body: "Story: #9",
  user: { login: author },
  labels: labeled ? [{ name: "editorial-draft" }] : [],
  head: { sha },
  base: { repo: { full_name: "pedropaulovc/editor-in-chief" } },
  changed_files: 1,
  state: "open",
  draft: true,
});
const gh = async (
  endpoint: string,
  options: {
    method?: string;
    body?: { event?: string; commit_id?: string; body: string };
  } = {},
) => {
  if (endpoint === repo) return { node_id: "R_1", private: false };
  if (endpoint === `${repo}/pulls/10`) return pull();
  if (endpoint === `${repo}/issues/9`) {
    if (options.method === "PATCH") {
      issuePatches++;
      issue.body = options.body!.body;
    }
    return { ...issue };
  }
  if (endpoint === `${repo}/issues/1`) return { ...inbox };
  const commentEndpoint = /\/issues\/(9|1)\/comments$/.exec(endpoint);
  if (commentEndpoint && options.method === "POST") {
    commentWrites++;
    const comment = {
      id: 200 + commentWrites,
      body: options.body!.body,
      user: { login: "pedropaulovc" },
      issueNumber: Number(commentEndpoint[1]),
    };
    discussion.push(comment);
    return { ...comment };
  }
  const singleComment = /\/issues\/comments\/(\d+)$/.exec(endpoint);
  if (singleComment) {
    const comment = discussion.find(
      (item) => item.id === Number(singleComment[1]),
    );
    if (!comment) throw new Error("Missing fixture comment");
    if (options.method === "PATCH") {
      commentWrites++;
      comment.body = options.body!.body;
    }
    return { ...comment };
  }
  if (endpoint.startsWith(`${repo}/git/trees/`))
    return {
      truncated: false,
      tree: [
        {
          path: "drafts/9/draft.md",
          type: "blob",
          mode: "100644",
          sha: "blob1",
          size: content.length,
        },
      ],
    };
  if (endpoint === `${repo}/git/blobs/blob1`)
    return {
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      size: content.length,
      sha: "blob1",
    };
  if (endpoint === `${repo}/pulls/10/reviews` && options.method === "POST") {
    if (!options.body) throw new Error("Review mutation omitted body");
    submissions++;
    expect(options.body.event).toBe("COMMENT");
    expect(options.body.commit_id).toBe(sha);
    const review = {
      id: 100 + submissions,
      body: options.body.body,
      user: { login: "pedropaulovc" },
      commit_id: sha,
      submitted_at: "2026-09-21T16:00:00Z",
    };
    reviews.push(review);
    if (acceptThenTimeout) {
      acceptThenTimeout = false;
      throw new Error("simulated transport timeout after remote acceptance");
    }
    return review;
  }
  throw new Error(`Unexpected fixture endpoint ${endpoint}`);
};
const pages = async (endpoint: string) => {
  if (networkDown) throw new Error("simulated GitHub outage");
  if (endpoint === `${repo}/issues?state=all&sort=created&direction=asc`)
    return issues.map((item) => ({ ...item }));
  if (endpoint === `${repo}/pulls?state=open`) return [];
  const issueComments = /\/issues\/(\d+)\/comments$/.exec(endpoint);
  if (issueComments)
    return discussion
      .filter((item) => item.issueNumber === Number(issueComments[1]))
      .map((item) => ({ ...item }));
  if (endpoint === `${repo}/pulls/10/reviews`) return reviews;
  if (endpoint === `${repo}/pulls/10/files`)
    return [
      {
        filename: "drafts/9/draft.md",
        patch: "@@ -0,0 +1 @@\n+The measurements are repeatable.",
      },
    ];
  if (endpoint.endsWith("/comments")) return [];
  throw new Error(`Unexpected fixture pagination ${endpoint}`);
};
const graphql = async (
  query: string,
  variables: { input?: { value?: { singleSelectOptionId: string } } } = {},
) => {
  if (query.includes("updateProjectV2ItemFieldValue")) {
    boardStatus = variables.input?.value?.singleSelectOptionId ?? null;
    boardWrites.push(boardStatus!);
    return {
      updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_9" } },
    };
  }
  if (query.includes("projectsV2"))
    return {
      user: {
        projectsV2: {
          nodes: [
            {
              id: "PROJECT_2",
              title: "Editor-in-chief",
              url: "https://github.com/users/pedropaulovc/projects/2",
              public: true,
              closed: false,
            },
          ],
          pageInfo,
        },
      },
    };
  if (query.includes("repositories(first:"))
    return {
      node: {
        repositories: {
          nodes: [{ nameWithOwner: "pedropaulovc/editor-in-chief" }],
          pageInfo,
        },
      },
    };
  if (query.includes("fields(first:"))
    return {
      node: {
        fields: {
          nodes: [
            {
              id: "STATUS",
              name: "Status",
              options: [
                "Inbox",
                "Selected",
                "Drafting",
                "Review",
                "Ready",
                "Published",
                "Parked",
              ].map((name) => ({
                id: name,
                name,
                color: "BLUE",
                description: "",
              })),
            },
          ],
          pageInfo,
        },
      },
    };
  if (query.includes("items(first:")) {
    beforeBoardRead?.();
    return {
      node: {
        items: {
          nodes: [
            {
              id: "ITEM_9",
              content: {
                id: "I_9",
                number: 9,
                repository: { nameWithOwner: "pedropaulovc/editor-in-chief" },
              },
              fieldValueByName: boardStatus
                ? { name: boardStatus, optionId: boardStatus }
                : null,
            },
          ],
          pageInfo,
        },
      },
    };
  }
  if (query.includes("reviewThreads"))
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  throw new Error("Unexpected fixture GraphQL request");
};
mock.module("../src/github-api", () => ({
  gh,
  pages,
  graphql,
  ApiError: class extends Error {},
}));
// Dynamic import intentionally exercises loading after the isolated transport boundary is replaced.
const { reviewPullRequest, syncWorkspace, recordPublication, reportBlockers } =
  await import("../src/workspace");
async function fixture(body: (ctx: Context) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "eic-workspace-fixture-")),
    state = new State(directory);
  sha = "a".repeat(40);
  author = "pedropaulovc";
  labeled = true;
  acceptThenTimeout = false;
  reviews = [];
  submissions = 0;
  edits = 0;
  boardStatus = "Inbox";
  issue.body = "Human notes stay unchanged.";
  issues = [issue];
  issuePatches = 0;
  commentWrites = 0;
  networkDown = false;
  discussion = [];
  boardWrites = [];
  beforeBoardRead = null;
  const config = await loadConfig();
  config.hindsightEnvFile = join(directory, "absent.env");
  const ctx: Context = {
    state,
    config,
    now: new Date("2026-09-21T16:00:00Z"),
    signal: new AbortController().signal,
    mode: "apply",
  };
  try {
    await body(ctx);
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const editor = async (
  _ctx: Context,
  request: EditorRequest,
): Promise<EditorResponse> => {
  if (request.kind !== "review") throw new Error("Expected review request");
  edits++;
  return {
    result: {
      kind: "review",
      headSha: request.headSha,
      verdict: "ready",
      findings: [],
    },
    model: "fixture",
    usage: {},
    tools: { active: [], enabled: [] },
  };
};
test("changed head discards stale judgment; latest head is reviewed once even for a draft PR", async () =>
  fixture(async (ctx) => {
    const old = await reviewPullRequest(ctx, 10, async (c, request) => {
      const result = await editor(c, request);
      sha = "b".repeat(40);
      return result;
    });
    expect(old).toMatchObject({ status: "head-changed" });
    expect(submissions).toBe(0);
    expect(ctx.state.get<string | null>("review:queued:10", null)).toBe(sha);
    expect(boardStatus).toBe("Inbox");
    await reviewPullRequest(ctx, 10, editor);
    await reviewPullRequest(ctx, 10, editor);
    expect(submissions).toBe(1);
    expect(edits).toBe(2);
    expect(reviews[0].commit_id).toBe(sha);
    expect(boardStatus).toBe("Ready");
  }));
test("accepted review whose response times out is reconciled without another model call or POST", async () =>
  fixture(async (ctx) => {
    acceptThenTimeout = true;
    await expect(reviewPullRequest(ctx, 10, editor)).rejects.toThrow(
      "simulated transport timeout",
    );
    expect(submissions).toBe(1);
    expect(reviews).toHaveLength(1);
    await reviewPullRequest(ctx, 10, editor);
    expect(submissions).toBe(1);
    expect(edits).toBe(1);
  }));
test("code PRs and external-author PRs are ignored before editor execution", async () =>
  fixture(async (ctx) => {
    labeled = false;
    expect(await reviewPullRequest(ctx, 10, editor)).toMatchObject({
      status: "ineligible",
    });
    labeled = true;
    author = "someone-else";
    expect(await reviewPullRequest(ctx, 10, editor)).toMatchObject({
      status: "ineligible",
    });
    expect(edits).toBe(0);
    expect(submissions).toBe(0);
  }));

test("story synchronization retains cited evidence older than the most recent ten thousand records", async () =>
  fixture(async (ctx) => {
    const candidate: Candidate = {
      id: "old-story",
      topic: "A measured repair",
      pillar: "side-projects",
      sourceIds: ["old-citation"],
      readerQuestions: [],
      missingEvidence: [],
      createdAt: "2026-01-01T00:00:00Z",
      issueNumber: 9,
      status: "Inbox",
      brief: {
        topic: "A measured repair",
        reader: "Engineers repeating the repair",
        question: "Which measurement demonstrates the change?",
        whyNow: "The measurement is recorded.",
        questions: [
          "What did you measure?",
          "How did you measure it?",
          "What remains uncertain?",
        ],
        missingEvidence: [],
        format: "blog",
        distribution: [],
      },
    };
    ctx.state.putCandidate(candidate);
    ctx.state.putEvidence([
      {
        id: "old-citation",
        source: "github",
        sourceUrl: "https://github.com/pedropaulovc/el400/issues/123",
        observedAt: "2026-01-01T00:00:00Z",
        occurredAt: "2026-01-01T00:00:00Z",
        revision: "measured-revision",
        text: "Human-recorded repair measurement.",
        provenance: { verified: true },
      },
    ]);
    ctx.state.putEvidence(
      Array.from({ length: 10001 }, (_, index) => ({
        id: `newer-${index}`,
        source: "github" as const,
        sourceUrl: null,
        observedAt: "2026-09-21T00:00:00Z",
        occurredAt: null,
        revision: "1",
        text: "Newer unrelated evidence.",
        provenance: {},
      })),
    );
    issue.body =
      "Human introduction.\n\n<!-- eic:story:old-story -->\nAn older brief.\n<!-- /eic:story:old-story -->\n\nHuman conclusion.";
    await syncWorkspace(ctx);
    expect(issue.body).toContain(
      "[public source](https://github.com/pedropaulovc/el400/issues/123)",
    );
    expect(issue.body).toContain("measured-revision");
    expect(issue.body.startsWith("Human introduction.\n\n")).toBe(true);
    expect(issue.body.endsWith("\n\nHuman conclusion.")).toBe(true);
  }));

test("quoted candidate metadata outside the managed story cannot replace recovered story identity", async () =>
  fixture(async (ctx) => {
    const actual = {
      id: "actual-story",
      topic: "Actual public story",
      sourceIds: [],
      pillar: "side-projects",
      createdAt: "2026-09-01T00:00:00Z",
    };
    const quoted = {
      ...actual,
      id: "quoted-other-story",
      topic: "Quoted example, not this story",
    };
    const human = `Human explanation quotes metadata as an example:\n<!-- eic:candidate-data:${JSON.stringify(quoted)} -->`;
    issue.body = `${human}\n\n<!-- eic:story:actual-story -->\n<!-- eic:candidate-data:${JSON.stringify(actual)} -->\nActual brief.\n<!-- /eic:story:actual-story -->`;
    await syncWorkspace(ctx);
    expect(
      ctx.state
        .candidates()
        .map((candidate) => ({
          id: candidate.id,
          topic: candidate.topic,
          issueNumber: candidate.issueNumber,
        })),
    ).toEqual([
      { id: "actual-story", topic: "Actual public story", issueNumber: 9 },
    ]);
    expect(issue.body.startsWith(human)).toBe(true);
  }));

test("dry-run Published restoration never overwrites local status or writes a transition", async () =>
  fixture(async (ctx) => {
    const candidate: Candidate = {
      id: "story-9",
      topic: "Human story",
      sourceIds: [],
      pillar: "side-projects",
      readerQuestions: [],
      missingEvidence: [],
      createdAt: "2026-09-01T00:00:00Z",
      issueNumber: 9,
      status: "Ready",
    };
    ctx.state.putCandidate(candidate);
    ctx.state.set("workspace:verified-status:9", "Review");
    boardStatus = "Published";
    ctx.mode = "dry-run";
    await syncWorkspace(ctx);
    expect(boardStatus).toBe("Published");
    expect(boardWrites).toEqual([]);
    expect(ctx.state.candidates()[0]?.status).toBe("Ready");
    expect(commentWrites).toBe(0);
    expect(issuePatches).toBe(0);
  }));

test("a human status move racing Published restoration is not replaced by the planned prior status", async () =>
  fixture(async (ctx) => {
    const candidate: Candidate = {
      id: "story-9",
      topic: "Human story",
      sourceIds: [],
      pillar: "side-projects",
      readerQuestions: [],
      missingEvidence: [],
      createdAt: "2026-09-01T00:00:00Z",
      issueNumber: 9,
      status: "Ready",
    };
    ctx.state.putCandidate(candidate);
    ctx.state.set("workspace:verified-status:9", "Review");
    boardStatus = "Published";
    let reads = 0;
    beforeBoardRead = () => {
      if (++reads === 2) boardStatus = "Parked";
    };
    await syncWorkspace(ctx);
    expect(boardStatus).toBe("Parked");
    expect(boardWrites).toEqual([]);
    expect(ctx.state.candidates()[0]?.status).toBe("Ready");
  }));

test("a recovered original publication advances an unset board status directly to Published", async () =>
  fixture(async (ctx) => {
    const publication: Publication = {
      storyIssue: 9,
      channel: "blog",
      url: "https://example.org/measured-repair",
      publishedAt: "2026-09-21T10:00:00-07:00",
      kind: "original",
    };
    await recordPublication(ctx, publication);
    boardStatus = null;
    boardWrites = [];
    await syncWorkspace(ctx);
    expect(boardWrites).toEqual(["Published"]);
    expect(String(boardStatus)).toBe("Published");
    expect(ctx.state.candidates()[0]?.status).toBe("Published");
  }));

test("timezone-equivalent registration is idempotent and one original plus two derivatives survives mirror recovery", async () =>
  fixture(async (ctx) => {
    const original: Publication = {
      storyIssue: 9,
      channel: "blog",
      url: "https://example.org/measured-repair",
      publishedAt: "2026-09-21T10:00:00-07:00",
      kind: "original",
    };
    await recordPublication(ctx, original);
    const writesAfterFirst = issuePatches;
    await recordPublication(ctx, {
      ...original,
      url: "https://EXAMPLE.ORG:443/measured-repair",
      publishedAt: "2026-09-21T17:00:00Z",
    });
    expect(ctx.state.publications()).toEqual([
      { ...original, publishedAt: "2026-09-21T17:00:00.000Z" },
    ]);
    expect(issuePatches).toBe(writesAfterFirst);
    const bluesky: Publication = {
      ...original,
      channel: "bluesky",
      url: "https://bsky.app/profile/pedro.vza.net/post/example1",
      kind: "derivative",
    };
    const youtube: Publication = {
      ...original,
      channel: "youtube",
      url: "https://www.youtube.com/watch?v=example1",
      kind: "derivative",
    };
    await recordPublication(ctx, bluesky);
    await recordPublication(ctx, youtube);
    expect(boardStatus).toBe("Published");
    ctx.state.db.exec("DELETE FROM publications");
    await syncWorkspace(ctx);
    const recovered = ctx.state.publications();
    expect(
      recovered.filter((publication) => publication.kind === "original"),
    ).toHaveLength(1);
    expect(recovered.map((publication) => publication.url).sort()).toEqual(
      [original.url, bluesky.url, youtube.url].sort(),
    );
    expect(boardStatus).toBe("Published");
  }));

test("conflicting publication registration rolls back recovered records atomically and leaves human issue text untouched", async () =>
  fixture(async (ctx) => {
    const original: Publication = {
      storyIssue: 9,
      channel: "blog",
      url: "https://example.org/measured-repair",
      publishedAt: "2026-09-21T17:00:00Z",
      kind: "original",
    };
    const derivative: Publication = {
      ...original,
      channel: "youtube",
      url: "https://www.youtube.com/watch?v=example1",
      kind: "derivative",
    };
    issue.body = `Human notes.\n\n<!-- eic:publications -->\n<!-- eic:publication-data:${JSON.stringify(original)} -->\n<!-- eic:publication-data:${JSON.stringify(derivative)} -->\n<!-- /eic:publications -->`;
    const untouched = issue.body;
    await expect(
      recordPublication(ctx, { ...original, kind: "derivative" }),
    ).rejects.toThrow("different date or kind");
    expect(ctx.state.publications()).toEqual([]);
    expect(issue.body).toBe(untouched);
    expect(issuePatches).toBe(0);
    expect(boardWrites).toEqual([]);
  }));

test("healthy partial coverage stays quiet and an undelivered outage resolves through one recovered inbox comment", async () =>
  fixture(async (ctx) => {
    issues = [inbox];
    const partial = {
      source: "github" as const,
      status: "partial" as const,
      count: 10,
      detail: "Bounded historical work remains queued for the next scan.",
    };
    expect(await reportBlockers(ctx, [partial])).toMatchObject({
      status: "none",
    });
    expect(commentWrites).toBe(0);
    networkDown = true;
    await expect(
      reportBlockers(ctx, [
        {
          source: "github",
          status: "failed",
          count: 0,
          detail: "GitHub is unavailable.",
        },
      ]),
    ).rejects.toThrow("simulated GitHub outage");
    expect(
      ctx.state.get<{ failures: unknown[] } | null>(
        "workspace:blockers-pending",
        null,
      )?.failures,
    ).toHaveLength(1);
    networkDown = false;
    expect(await reportBlockers(ctx, [partial])).toMatchObject({
      status: "resolved",
    });
    expect(ctx.state.get("workspace:blockers-pending", null)).toBeNull();
    expect(discussion).toHaveLength(1);
    expect(commentWrites).toBe(1);
    await reportBlockers(ctx, [partial]);
    expect(discussion).toHaveLength(1);
    expect(commentWrites).toBe(1);
  }));
