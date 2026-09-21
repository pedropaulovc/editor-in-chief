import { z } from "zod";
import type { Config } from "./config";
import type { State } from "./state";
export type Source = "github" | "bluesky" | "hindsight";
export interface Evidence {
  id: string;
  source: Source;
  sourceUrl: string | null;
  observedAt: string;
  occurredAt: string | null;
  revision: string;
  text: string;
  provenance: Record<string, unknown>;
}
export interface Coverage {
  source: Source;
  status: "complete" | "partial" | "failed" | "ranked";
  count: number;
  detail: string;
  checkpoint?: string;
  blockers?: string[];
}
export interface Context {
  config: Config;
  state: State;
  now: Date;
  signal: AbortSignal;
  mode: "dry-run" | "apply";
}
export interface Collection {
  evidence: Evidence[];
  coverage: Coverage;
}
export const PillarSchema = z.enum([
  "harmonic-analyzer",
  "ai-engineering",
  "side-projects",
]);
export const BriefSchema = z
  .object({
    topic: z.string().max(180),
    reader: z.string().max(300),
    question: z.string().max(500),
    whyNow: z.string().max(500),
    questions: z.array(z.string().max(500)).min(3).max(5),
    missingEvidence: z.array(z.string().max(300)).max(8),
    format: z.enum(["blog", "video"]),
    distribution: z.array(z.string().max(300)).max(6),
  })
  .strict();
export interface Candidate {
  id: string;
  topic: string;
  sourceIds: string[];
  pillar: z.infer<typeof PillarSchema>;
  readerQuestions: string[];
  missingEvidence: string[];
  brief?: z.infer<typeof BriefSchema>;
  issueNumber?: number;
  status?: string;
  createdAt: string;
  carriedWeeks?: number;
}
export const TriageResultSchema = z
  .object({
    kind: z.literal("triage"),
    candidates: z
      .array(
        z
          .object({
            sourceIds: z.array(z.string()).min(1).max(12),
            pillar: PillarSchema,
            topic: z.string().max(180),
            readerQuestions: z.array(z.string().max(500)).max(5),
            missingEvidence: z.array(z.string().max(300)).max(8),
            existingCandidateId: z.string().nullable(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export const DeskResultSchema = z
  .object({
    kind: z.literal("desk"),
    choices: z
      .array(z.object({ candidateId: z.string(), brief: BriefSchema }).strict())
      .max(3),
    recommendations: z.array(z.string()).max(2),
    experiment: z
      .object({
        hypothesis: z.string().max(400),
        variable: z.string().max(200),
        window: z.string().max(150),
        successSignal: z.string().max(250),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const FindingSchema = z
  .object({
    id: z.string(),
    category: z.enum(["evidence", "structure", "clarity", "grammar", "media"]),
    severity: z.enum(["blocking", "suggestion"]),
    path: z.string(),
    line: z.number().int().positive(),
    quote: z.string().min(1).max(1500),
    problem: z.string().max(700),
    question: z.string().max(700),
    grammarReplacement: z.string().max(200).optional(),
  })
  .strict();
export const ReviewResultSchema = z
  .object({
    kind: z.literal("review"),
    headSha: z.string(),
    verdict: z.enum(["needs-work", "ready"]),
    findings: z.array(FindingSchema).max(5),
    remainingIssues: z.string().max(800).optional(),
  })
  .strict();
export type TriageResult = z.infer<typeof TriageResultSchema>;
export type DeskResult = z.infer<typeof DeskResultSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export interface DraftFile {
  path: string;
  content: string;
  patch?: string;
}
export type EditorRequest =
  | { kind: "triage"; evidence: Evidence[]; candidates: Candidate[] }
  | {
      kind: "desk";
      evidence: Evidence[];
      candidates: Candidate[];
      active: Candidate[];
      metrics: unknown;
    }
  | {
      kind: "review";
      headSha: string;
      files: DraftFile[];
      story: Candidate;
      evidence: Evidence[];
      priorFindings: unknown[];
      responses: unknown[];
    };
export type EditorResult = TriageResult | DeskResult | ReviewResult;
export const PublicationSchema = z
  .object({
    storyIssue: z.number().int().positive(),
    channel: z.enum(["blog", "bluesky", "linkedin", "youtube", "tiktok"]),
    url: z
      .url()
      .refine((v) => {
        const url = new URL(v);
        return url.protocol === "https:" && !url.username && !url.password;
      })
      .transform((v) => new URL(v).href),
    publishedAt: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v).toISOString()),
    kind: z.enum(["original", "derivative"]),
  })
  .strict();
export type Publication = z.infer<typeof PublicationSchema>;
export interface Mutation {
  key: string;
  kind: string;
  detail: unknown;
}
export interface EditorResponse {
  result: EditorResult;
  model: string;
  usage: unknown;
  tools: { active: string[]; enabled: string[] };
}
