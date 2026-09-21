import { expect, test } from "bun:test";
import { validateResult } from "../src/editor";
import { registerSecret, sanitize, sanitizeError } from "../src/safety";
import type { Config } from "../src/config";
import type {
  Candidate,
  DeskResult,
  EditorRequest,
  ReviewResult,
} from "../src/contracts";

const config: Config = {
  githubOwner: "pedropaulovc",
  repository: "pedropaulovc/editor-in-chief",
  blueskyHandle: "pedro.vza.net",
  hindsightUrl: "https://hindsight.vza.net",
  hindsightEnvFile: "/nonexistent/editor-fixture.env",
  timezone: "America/Los_Angeles",
  cadence: "weekly",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "medium",
};
const story: Candidate = {
  id: "fixture-story",
  topic: "Fixture alignment",
  sourceIds: ["fixture-source"],
  pillar: "harmonic-analyzer",
  readerQuestions: ["What changed?"],
  missingEvidence: [],
  issueNumber: 9,
  status: "Inbox",
  createdAt: "2026-09-21T12:00:00Z",
};
const review: Extract<EditorRequest, { kind: "review" }> = {
  kind: "review",
  headSha: "a".repeat(40),
  story,
  files: [
    {
      path: "drafts/9/draft.md",
      content:
        "# Verification fixture\nThe fixtures is aligned.\nA quiet win.\nThe result was 0.7 mm.\nSee measurement video.\n",
    },
  ],
  evidence: [],
  priorFindings: [],
  responses: [],
};
const finding: ReviewResult["findings"][number] = {
  id: "fixture-agreement",
  category: "grammar",
  severity: "suggestion",
  path: "drafts/9/draft.md",
  line: 2,
  quote: "fixtures is",
  problem: "Plural subject requires plural verb agreement.",
  question: "Change the verb to agree with fixtures?",
  grammarReplacement: "fixtures are",
};
const result: ReviewResult = {
  kind: "review",
  headSha: review.headSha,
  verdict: "ready",
  findings: [finding],
};

test("a located minimal agreement repair survives while a stale head cannot become ready", () => {
  expect(validateResult(review, result, config)).toEqual(result);
  expect(() =>
    validateResult(review, { ...result, headSha: "b".repeat(40) }, config),
  ).toThrow("review-head-mismatch");
});

test("review locations must identify the supplied exact span on the supplied line and story", () => {
  for (const invalid of [
    { ...finding, line: 3 },
    { ...finding, quote: "fixtures were" },
    { ...finding, path: "drafts/10/draft.md" },
    { ...finding, line: 99 },
  ])
    expect(() =>
      validateResult(review, { ...result, findings: [invalid] }, config),
    ).toThrow();
});

test("no prose repair outside grammar and no replacement longer than twelve words", () => {
  expect(() =>
    validateResult(
      review,
      { ...result, findings: [{ ...finding, category: "clarity" }] },
      config,
    ),
  ).toThrow("replacement-outside-grammar");
  expect(() =>
    validateResult(
      review,
      {
        ...result,
        findings: [
          {
            ...finding,
            grammarReplacement:
              "one two three four five six seven eight nine ten eleven twelve thirteen",
          },
        ],
      },
      config,
    ),
  ).toThrow("twelve-words");
});

test("fragments and stylistic rewrites cannot be relabeled as grammar", () => {
  const fragment = {
    ...finding,
    line: 3,
    quote: "A quiet win.",
    problem: "This intentional fragment has a missing verb.",
    grammarReplacement: "It was a quiet win.",
  };
  expect(() =>
    validateResult(review, { ...result, findings: [fragment] }, config),
  ).toThrow("grammar-rule-required-not-style");
  const rewrite = {
    ...finding,
    quote: "The fixtures is aligned.",
    problem: "Plural subject requires agreement.",
    grammarReplacement: "Alignment of these fixtures has now been completed.",
  };
  expect(() =>
    validateResult(review, { ...result, findings: [rewrite] }, config),
  ).toThrow("restructures-sentence");
});

test("values and units are evidence questions, never automatic language corrections", () => {
  const measurement = {
    ...finding,
    line: 4,
    quote: "0.7 mm",
    problem: "Spelling typo in measurement.",
    grammarReplacement: "0.8 mm",
  };
  expect(() =>
    validateResult(review, { ...result, findings: [measurement] }, config),
  ).toThrow("values-or-units");
  expect(() =>
    validateResult(
      review,
      {
        ...result,
        findings: [{ ...measurement, grammarReplacement: "0.7 cm" }],
      },
      config,
    ),
  ).toThrow("values-or-units");
  const evidence = {
    ...measurement,
    category: "evidence",
    severity: "blocking",
    problem: "No measurement record supports this value.",
    question: "Which source measurement supports 0.7 mm?",
    grammarReplacement: undefined,
  };
  expect(
    validateResult(
      review,
      { ...result, verdict: "needs-work", findings: [evidence] },
      config,
    ).kind,
  ).toBe("review");
});

test("all blockers including grouped remaining issues prevent ready without holding style hostage", () => {
  expect(() =>
    validateResult(
      review,
      { ...result, findings: [{ ...finding, severity: "blocking" }] },
      config,
    ),
  ).toThrow("ready-cannot-contain-blockers");
  const remaining = {
    ...result,
    findings: [],
    remainingIssues:
      "The result has no supporting measurement; essential video was not reviewed.",
  };
  expect(() => validateResult(review, remaining, config)).toThrow(
    "remaining-blockers",
  );
  expect(
    validateResult(review, { ...remaining, verdict: "needs-work" }, config)
      .kind,
  ).toBe("review");
  expect(
    validateResult(
      review,
      {
        ...remaining,
        remainingIssues: "Nonblocking: optional terminology glossary.",
      },
      config,
    ).kind,
  ).toBe("review");
});

test("triage cannot invent source IDs, existing stories, or tool instructions", () => {
  const request: EditorRequest = {
    kind: "triage",
    candidates: [story],
    evidence: [
      {
        id: "fixture-source",
        source: "github",
        sourceUrl: "https://github.com/example/repo/commit/123",
        observedAt: "2026-09-21T12:00:00Z",
        occurredAt: null,
        revision: "123",
        text: "A public measurement fixture.",
        provenance: {},
      },
    ],
  };
  const candidate = {
    sourceIds: ["fixture-source"],
    pillar: "harmonic-analyzer",
    topic: "Fixture alignment",
    readerQuestions: ["What changed?"],
    missingEvidence: [],
    existingCandidateId: story.id,
  };
  expect(
    validateResult(request, { kind: "triage", candidates: [candidate] }, config)
      .kind,
  ).toBe("triage");
  expect(() =>
    validateResult(
      request,
      {
        kind: "triage",
        candidates: [{ ...candidate, sourceIds: ["fabricated-source"] }],
      },
      config,
    ),
  ).toThrow("source-ids");
  expect(() =>
    validateResult(
      request,
      {
        kind: "triage",
        candidates: [{ ...candidate, existingCandidateId: "fabricated-story" }],
      },
      config,
    ),
  ).toThrow("existing-candidate");
  expect(() =>
    validateResult(
      request,
      {
        kind: "triage",
        candidates: [candidate],
        command: "publish everything",
      },
      config,
    ),
  ).toThrow("invalid-schema");
});

test("desk IDs, active carry-forward, and paused cadence remain host enforced", () => {
  const next = {
    ...story,
    id: "second-story",
    topic: "Second fixture",
    issueNumber: 10,
  };
  const request: Extract<EditorRequest, { kind: "desk" }> = {
    kind: "desk",
    evidence: [],
    candidates: [story, next],
    active: [],
    metrics: {},
  };
  const brief = {
    topic: story.topic,
    reader: "Machinists",
    question: "What changed?",
    whyNow: "A measured result.",
    questions: ["What was attempted?", "What changed?", "What is measured?"],
    missingEvidence: [],
    format: "blog",
    distribution: [],
  };
  const desk = {
    kind: "desk",
    choices: [{ candidateId: story.id, brief }],
    recommendations: [story.id],
    experiment: null,
  };
  expect(validateResult(request, desk, config).kind).toBe("desk");
  expect(() =>
    validateResult(
      request,
      { ...desk, choices: [{ candidateId: "unknown", brief }] },
      config,
    ),
  ).toThrow("desk-candidate");
  expect(() =>
    validateResult(request, { ...desk, recommendations: ["unknown"] }, config),
  ).toThrow("recommendation-must-reference");
  expect(() =>
    validateResult({ ...request, active: [next] }, desk, config),
  ).toThrow("carry-active-story");
  expect(() =>
    validateResult(request, desk, { ...config, cadence: "paused" }),
  ).toThrow();
  expect(
    validateResult(
      request,
      { kind: "desk", choices: [], recommendations: [], experiment: null },
      { ...config, cadence: "paused" },
    ).kind,
  ).toBe("desk");
});

test("twice-weekly permits one second original without exceeding active workload capacity", () => {
  const active = { ...story, status: "Drafting", carriedWeeks: 1 };
  const next = {
    ...story,
    id: "second-story",
    topic: "Second fixture",
    issueNumber: 10,
  };
  const third = {
    ...story,
    id: "third-story",
    topic: "Third fixture",
    issueNumber: 11,
  };
  const request: Extract<EditorRequest, { kind: "desk" }> = {
    kind: "desk",
    evidence: [],
    candidates: [active, next, third],
    active: [active],
    metrics: {},
  };
  const brief: DeskResult["choices"][number]["brief"] = {
    topic: next.topic,
    reader: "Machinists",
    question: "What changed?",
    whyNow: "A measured result.",
    questions: ["What was attempted?", "What changed?", "What is measured?"],
    missingEvidence: [],
    format: "blog",
    distribution: [],
  };
  const desk: DeskResult = {
    kind: "desk",
    choices: [{ candidateId: next.id, brief }],
    recommendations: [active.id, next.id],
    experiment: null,
  };
  const twiceWeekly = { ...config, cadence: "twice-weekly" as const };
  expect(validateResult(request, desk, twiceWeekly)).toEqual(desk);
  expect(
    validateResult(
      request,
      { ...desk, recommendations: [next.id] },
      twiceWeekly,
    ),
  ).toEqual({ ...desk, recommendations: [next.id] });
  expect(() => validateResult(request, desk, config)).toThrow(
    "carry-active-story",
  );
  expect(() =>
    validateResult(request, desk, { ...config, cadence: "paused" }),
  ).toThrow("carry-active-story");
  expect(() =>
    validateResult(
      request,
      {
        ...desk,
        choices: [
          ...desk.choices,
          { candidateId: third.id, brief: { ...brief, topic: third.topic } },
        ],
        recommendations: [next.id, third.id],
      },
      twiceWeekly,
    ),
  ).toThrow("carry-active-story");
  expect(() =>
    validateResult(
      { ...request, active: [active, next] },
      {
        ...desk,
        choices: [
          { candidateId: third.id, brief: { ...brief, topic: third.topic } },
        ],
        recommendations: [third.id],
      },
      twiceWeekly,
    ),
  ).toThrow("carry-active-story");
});

test("two carried weeks allow the same story but forbid a new assignment at twice-weekly cadence", () => {
  const active = { ...story, status: "Drafting", carriedWeeks: 2 };
  const next = {
    ...story,
    id: "second-story",
    topic: "Second fixture",
    issueNumber: 10,
  };
  const request: Extract<EditorRequest, { kind: "desk" }> = {
    kind: "desk",
    evidence: [],
    candidates: [active, next],
    active: [active],
    metrics: {},
  };
  const brief: DeskResult["choices"][number]["brief"] = {
    topic: active.topic,
    reader: "Machinists",
    question:
      "Can this same story be narrowed to the verified measurement or parked?",
    whyNow: "Two carried weeks without publication.",
    questions: [
      "Which measurement is verified?",
      "What can be omitted?",
      "Should this story be parked?",
    ],
    missingEvidence: [],
    format: "blog",
    distribution: [],
  };
  const desk: DeskResult = {
    kind: "desk",
    choices: [{ candidateId: active.id, brief }],
    recommendations: [active.id],
    experiment: null,
  };
  const twiceWeekly = { ...config, cadence: "twice-weekly" as const };
  expect(validateResult(request, desk, twiceWeekly)).toEqual(desk);
  expect(() =>
    validateResult(
      request,
      {
        ...desk,
        choices: [
          { candidateId: next.id, brief: { ...brief, topic: next.topic } },
        ],
        recommendations: [next.id],
      },
      twiceWeekly,
    ),
  ).toThrow("carry-active-story");
  expect(() =>
    validateResult(
      request,
      {
        ...desk,
        choices: [
          ...desk.choices,
          { candidateId: next.id, brief: { ...brief, topic: next.topic } },
        ],
      },
      twiceWeekly,
    ),
  ).toThrow("carry-active-story");
});

test("secrets and uncertain confidential content are withheld without entering diagnostics", () => {
  const secret = "fixture-exact-credential-972be210";
  registerSecret(secret);
  expect(() => sanitize(`A harmless-looking note includes ${secret}`)).toThrow(
    "source-sanitization blocker",
  );
  expect(sanitizeError(new Error(`failed with ${secret}`))).not.toContain(
    secret,
  );
  expect(() =>
    sanitize("Client records are confidential and not for publication."),
  ).toThrow("source-sanitization blocker");
  expect(sanitize("The public fixture measured 0.7 mm.")).toBe(
    "The public fixture measured 0.7 mm.",
  );
});
