import { expect, test } from "bun:test";
import {
  PublicationSchema,
  ReviewResultSchema,
  DeskResultSchema,
} from "../src/contracts";

test("publication requires an explicit timezone and HTTPS without extra fetch directives", () => {
  const publication = {
    storyIssue: 9,
    channel: "blog",
    url: "https://example.org/post",
    publishedAt: "2026-09-21T08:00:00-07:00",
    kind: "original",
  };
  expect(PublicationSchema.parse(publication)).toEqual(
    PublicationSchema.parse({
      ...publication,
      publishedAt: "2026-09-21T15:00:00Z",
    }),
  );
  expect(() =>
    PublicationSchema.parse({ ...publication, publishedAt: "2026-09-21" }),
  ).toThrow();
  expect(() =>
    PublicationSchema.parse({ ...publication, url: "http://example.org/post" }),
  ).toThrow();
  expect(() =>
    PublicationSchema.parse({
      ...publication,
      url: "https://user:password@example.org/post",
    }),
  ).toThrow();
  expect(() =>
    PublicationSchema.parse({
      ...publication,
      fetchUrl: "https://untrusted.example/",
    }),
  ).toThrow();
});
test("review protocol rejects arbitrary tool instructions and unbounded findings", () => {
  const valid = {
    kind: "review",
    headSha: "a".repeat(40),
    verdict: "ready",
    findings: [],
  };
  expect(() =>
    ReviewResultSchema.parse({ ...valid, command: "publish" }),
  ).toThrow();
  const finding = {
    id: "one",
    category: "evidence",
    severity: "blocking",
    path: "drafts/9/draft.md",
    line: 1,
    quote: "Claim.",
    problem: "No supporting measurement.",
    question: "Which measured run supports this?",
  };
  expect(() =>
    ReviewResultSchema.parse({ ...valid, findings: Array(6).fill(finding) }),
  ).toThrow();
});
test("desk cannot exceed the absolute two-original ceiling", () => {
  expect(() =>
    DeskResultSchema.parse({
      kind: "desk",
      choices: [],
      recommendations: ["a", "b", "c"],
      experiment: null,
    }),
  ).toThrow();
});
