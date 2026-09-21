import { parseArgs } from "node:util";
import { loadConfig, stateDirectory, expandPath } from "./config";
import { State } from "./state";
import { PublicationSchema, type Context } from "./contracts";
import { doctorGithub } from "./sources/github";
import { doctorBluesky } from "./sources/bluesky";
import { doctorHindsight } from "./sources/hindsight";
import { doctorEditor, edit } from "./editor";
import { bootstrap, reviewPullRequest, recordPublication } from "./workspace";
import { importMetrics } from "./metrics";
import { schedule } from "./schedule";
import { run, status, withLock } from "./run";
import { loadSafetySecrets, sanitizeError } from "./safety";
process.umask(0o077);

const help = `Editor-in-chief — public evidence, human authorship, manual publication
bun run eic doctor
bun run eic bootstrap --apply
bun run eic run --dry-run|--apply
bun run eic review --pr NUMBER --dry-run|--apply
bun run eic record-publication --issue NUMBER --channel CHANNEL --url HTTPS --published-at ISO --kind original|derivative
bun run eic import-metrics FILE [--replace]
bun run eic status
bun run eic schedule install|show|remove
Shared: --config FILE --state-dir DIRECTORY
No draft prose is written or published automatically.`;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      "state-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      pr: { type: "string" },
      issue: { type: "string" },
      channel: { type: "string" },
      url: { type: "string" },
      "published-at": { type: "string" },
      kind: { type: "string" },
      replace: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  const command = positionals[0];
  if (values.apply && values["dry-run"])
    throw new Error("Choose exactly one of --apply or --dry-run");
  if (
    ["run", "review"].includes(command) &&
    !values.apply &&
    !values["dry-run"]
  )
    throw new Error(`${command} requires --apply or --dry-run`);
  if (command === "bootstrap" && !values.apply)
    throw new Error("bootstrap requires --apply");
  const configPath = expandPath(values.config ?? "editorial.config.json");
  const config = await loadConfig(configPath),
    state = new State(stateDirectory(values["state-dir"]));
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  timer.unref();
  const ctx: Context = {
    config,
    state,
    now: new Date(),
    signal: controller.signal,
    mode: values["dry-run"] ? "dry-run" : "apply",
  };
  try {
    await loadSafetySecrets(config.hindsightEnvFile);
    let result: unknown;
    switch (command) {
      case "doctor": {
        const checks = [
          ["github", doctorGithub],
          ["bluesky", doctorBluesky],
          ["hindsight", doctorHindsight],
          ["editor", doctorEditor],
        ] as const;
        const capabilities = await Promise.all(
          checks.map(async ([name, check]) => {
            try {
              const details = await check(ctx);
              const unavailable =
                details !== null &&
                typeof details === "object" &&
                "available" in details &&
                details.available === false;
              return {
                name,
                status: unavailable ? "unavailable" : "available",
                details,
              };
            } catch (error) {
              return {
                name,
                status: "unavailable",
                error: sanitizeError(error),
              };
            }
          }),
        );
        result = {
          capabilities,
          modelPromptSent: false,
          githubMutations: false,
        };
        if (capabilities.some((c) => c.status === "unavailable"))
          process.exitCode = 1;
        break;
      }
      case "bootstrap":
        result = await withLock(ctx, () => bootstrap(ctx));
        break;
      case "run": {
        const outcome = await withLock(ctx, () => run(ctx));
        result = outcome;
        if ("exitCode" in outcome) process.exitCode = outcome.exitCode;
        break;
      }
      case "review": {
        const pr = Number(values.pr);
        if (!Number.isSafeInteger(pr) || pr < 1)
          throw new Error("--pr must be a positive integer");
        result = await withLock(ctx, () => reviewPullRequest(ctx, pr, edit));
        break;
      }
      case "record-publication": {
        const publication = PublicationSchema.parse({
          storyIssue: Number(values.issue),
          channel: values.channel,
          url: values.url,
          publishedAt: values["published-at"],
          kind: values.kind,
        });
        result = await withLock(ctx, () => recordPublication(ctx, publication));
        break;
      }
      case "import-metrics":
        if (!positionals[1]) throw new Error("A metrics JSON file is required");
        result = await withLock(ctx, () =>
          importMetrics(
            ctx,
            expandPath(positionals[1]),
            values.replace ?? false,
          ),
        );
        break;
      case "status":
        result = status(ctx);
        break;
      case "schedule":
        if (!["install", "show", "remove"].includes(positionals[1]))
          throw new Error("schedule requires install, show, or remove");
        result = await schedule(
          ctx,
          positionals[1] as "install" | "show" | "remove",
          configPath,
        );
        break;
      default:
        throw new Error("Unknown command; use --help");
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    clearTimeout(timer);
    state.close();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({ status: "failed", error: sanitizeError(error) }),
  );
  process.exitCode = 1;
});
