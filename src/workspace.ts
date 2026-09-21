import { createHash } from 'node:crypto';
import type { Candidate, Context, Coverage, DeskResult, DraftFile, EditorRequest, EditorResponse, Evidence, Publication, ReviewResult } from './contracts';
import { BriefSchema, DeskResultSchema, PublicationSchema, ReviewResultSchema } from './contracts';
import { gh, graphql, pages } from './github-api';
import { policyHash } from './editor';
import { sanitize, loadSafetySecrets } from './safety';
import { isoWeek } from './calendar';
import { deskMetrics } from './metrics';

const STATUSES = ['Inbox', 'Selected', 'Drafting', 'Review', 'Ready', 'Published', 'Parked'] as const;
type Status = (typeof STATUSES)[number];
const ACTIVE = new Set<string>(['Selected', 'Drafting', 'Review', 'Ready']);
const LABELS: Record<string, string> = {
  'editorial-story': 'Story evidence and questions, not finished copy',
  'editorial-draft': 'Human-authored content eligible for COMMENT-only editing',
  'editorial-capture': 'Public rough notes and selected media references',
  'editorial-desk': 'Weekly editorial desk; no daily reminders',
  'editorial-prerequisite': 'Publishing or measurement prerequisite',
  'editorial-publication': 'A manually published original or derivative',
  'pillar:harmonic-analyzer': 'Machining progress and the future Kickstarter',
  'pillar:ai-engineering': 'Demonstrated AI-empowered engineering',
  'pillar:side-projects': 'Side projects and open-source contributions',
};
const LOGBOOK = 'https://github.com/pedropaulovc/harmonic-analyzer/blob/main/logbook/entries/TEMPLATE.md';
const SIGNUP = 'https://github.com/pedropaulovc/harmonic-analyzer/issues/472';
const CAPTURE_CHECKLIST = `### Before-shop capture checklist
- GitHub text and attachments are public. Share only selected, safe public material; never credentials, sensitive material, or another person's identifying details.
- Before work: choose the setup, result, and measurement to capture. Mount the phone outside motion, chip, and control paths. Never reach for it during an operation or repeat a cut for a shot; collect detail clips only once safe.
- Record attempted operation, what changed or failed, measured evidence, lesson/question, and next step. Add selected photos, clip timecodes, or voice-memo/transcript links. A clearly labeled local-media pointer is fine; it is not a public attachment.
- Use original or licensed imagery, never reproduced 2014 book imagery. Raw footage is not automatically copied, uploaded, transcribed, or committed.
- Harmonic Analyzer: use the [authoritative logbook template](${LOGBOOK}) with date, module, machine (lathe/mill/bench), part, outcome (success/partial/scrapped/aborted), and hours. Entries remain in logbook/entries/YYYY-MM-DD-<slug>.md there; raw media stays in ignored logbook/media/ and selected book figures in book/figures/hand/. This inbox is not a second factual logbook.
- A watermark-free 30–60 second vertical master may serve Shorts/TikTok. Longer videos remain milestone-driven, with no extra quota. No scripts, captions, titles, or outreach copy are generated.`;

type Issue = { number: number; node_id: string; title: string; body: string | null; html_url: string; user: { login: string }; labels: Array<{ name: string } | string>; pull_request?: unknown; state?: string; updated_at?: string; created_at?: string };
type Comment = { id: number; body: string; user: { login: string }; html_url?: string; created_at?: string; updated_at?: string; commit_id?: string; submitted_at?: string; path?: string; line?: number; in_reply_to_id?: number };
type Project = { id: string; title: string; url: string; public: boolean; fieldId: string; options: Record<string, string> };
type BoardItem = { id: string; issue: number; contentId: string; status: string | null };
type StoryMeta = { id: string; topic: string; sourceIds: string[]; pillar: Candidate['pillar']; createdAt: string; surfacedWeek?: string; brief?: Candidate['brief'] };
type DeskMeta = { week: string; carried: Record<string, number>; choices: string[]; recommendations: string[] };
type Outbox = { key: string; status: string; data: string; updated_at: string };
type Pull = { number: number; node_id: string; body: string | null; user: { login: string }; labels: Array<{ name: string } | string>; head: { sha: string }; base: { repo: { full_name: string } }; changed_files?: number; state?: string; draft?: boolean };
type ChangedFile = { filename:string; previous_filename?:string; patch?:string };
type Eligible = { pr: Pull; issue: Issue; story: Candidate; changed:ChangedFile[] };
type ReviewAction = { marker: string; requestId?: number; reviews: Comment[]; comments: Comment[] };
type Editor = (ctx: Context, request: EditorRequest) => Promise<EditorResponse>;

function digest(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function repo(ctx: Context): string { return `repos/${ctx.config.repository}`; }
function dry(ctx: Context): boolean { return ctx.mode === 'dry-run'; }
function week(ctx: Context): string { return isoWeek(ctx.now, ctx.config.timezone); }
function hasLabel(item: { labels: Array<{ name: string } | string> }, label: string): boolean { return item.labels.some(value => (typeof value === 'string' ? value : value.name) === label); }
function text(value: string): string { return sanitize(value).replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;'); }
function json(value: unknown): string { return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'); }
function marker(name: string): string { if (!/^[\w:.-]+$/.test(name)) throw new Error('Invalid managed section identifier'); return `<!-- eic:${name} -->`; }
function block(name: string, content: string): string { return `${marker(name)}\n${content.trim()}\n<!-- /eic:${name} -->`; }
function managed(body: string | null | undefined, name: string): string | null {
  const input = body ?? '', start = marker(name), end = `<!-- /eic:${name} -->`;
  const first = input.indexOf(start);
  if (first < 0) { if (input.includes(end)) throw new Error(`Malformed managed section ${name}`); return null; }
  const last = input.indexOf(end, first + start.length);
  if (last < 0 || input.indexOf(start, first + start.length) >= 0 || input.indexOf(end, last + end.length) >= 0) throw new Error(`Ambiguous managed section ${name}`);
  return input.slice(first + start.length, last).trim();
}
function merge(body: string | null | undefined, name: string, content: string): string {
  const input = body ?? '', previous = managed(input, name), replacement = block(name, content);
  if (previous === null) return `${input}${input ? '\n\n' : ''}${replacement}`;
  const start = input.indexOf(marker(name)), end = input.indexOf(`<!-- /eic:${name} -->`, start) + `<!-- /eic:${name} -->`.length;
  return input.slice(0, start) + replacement + input.slice(end);
}
function metadata<T>(body: string | null | undefined, name: string): T[] {
  const prefix = `<!-- eic:${name}:`, result: T[] = [];
  let offset = 0;
  while ((offset = (body ?? '').indexOf(prefix, offset)) >= 0) {
    const end = body!.indexOf(' -->', offset + prefix.length);
    if (end < 0) throw new Error(`Malformed ${name} metadata`);
    try { result.push(JSON.parse(body!.slice(offset + prefix.length, end)) as T); }
    catch { throw new Error(`Invalid ${name} metadata`); }
    offset = end + 4;
  }
  return result;
}
function proposal(ctx: Context, key: string, kind: string, detail: unknown): void {
  const proposals = ctx.state.get<Array<{ key: string; kind: string; detail: unknown }>>('workspace:proposals', []);
  ctx.state.set('workspace:proposals', [...proposals.filter(item => item.key !== key), { key, kind, detail }]);
}
function outbox(ctx: Context, key: string, status: string, kind: string, detail: unknown): void {
  ctx.state.db.query('INSERT INTO outbox(key,status,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at').run(key, status, JSON.stringify({ kind, detail }), ctx.now.toISOString());
}
/** Every remote mutation is preceded by a durable intent, then a complete recovery read. */
async function deliver<T>(ctx: Context, key: string, kind: string, detail: unknown, recover: () => Promise<T | null>, write: () => Promise<T>): Promise<T | null> {
  if (!dry(ctx)) outbox(ctx, key, 'pending', kind, detail);
  const existing = await recover();
  if (existing !== null) {
    if (!dry(ctx)) outbox(ctx, key, 'delivered', kind, detail);
    return existing;
  }
  if (dry(ctx)) { proposal(ctx, key, kind, detail); return null; }
  outbox(ctx, key, 'attempted', kind, detail);
  const result = await write();
  outbox(ctx, key, 'delivered', kind, detail);
  return result;
}
async function allIssues(ctx: Context): Promise<Issue[]> { return (await pages<Issue>(`${repo(ctx)}/issues?state=all&sort=created&direction=asc`, ctx.signal)).filter(issue => !issue.pull_request); }
async function issue(ctx: Context, number: number): Promise<Issue> { return gh<Issue>(`${repo(ctx)}/issues/${number}`, { signal: ctx.signal }); }
async function comments(ctx: Context, number: number): Promise<Comment[]> { return pages<Comment>(`${repo(ctx)}/issues/${number}/comments`, ctx.signal); }
function unique<T>(items: T[], description: string): T | null { if (items.length > 1) throw new Error(`Ambiguous ${description}; refusing to choose between ${items.map(item => (item as any).html_url ?? (item as any).url ?? (item as any).id).join(', ')}`); return items[0] ?? null; }
async function findIssue(ctx: Context, name: string): Promise<Issue | null> { return unique((await allIssues(ctx)).filter(item => managed(item.body, name) !== null), `issue marker ${name}`); }
async function ensureIssue(ctx: Context, name: string, title: string, content: string, labels: string[]): Promise<Issue | null> {
  const body = sanitize(block(name, content));
  return deliver(ctx, `issue:${name}`, 'create-issue', { name, title: text(title), labels, body }, () => findIssue(ctx, name), () => gh<Issue>(`${repo(ctx)}/issues`, { method: 'POST', body: { title: text(title), body, labels }, signal: ctx.signal }));
}
async function updateIssue(ctx: Context, number: number, name: string, content: string): Promise<void> {
  const desired = sanitize(content.trim());
  await deliver(ctx, `issue:${number}:${name}:${digest(desired)}`, 'update-issue-section', { number, section: name, content: desired }, async () => managed((await issue(ctx, number)).body, name) === desired ? true : null, async () => {
    const fresh = await issue(ctx, number);
    const body = merge(fresh.body, name, desired);
    if (body !== (fresh.body ?? '')) await gh(`${repo(ctx)}/issues/${number}`, { method: 'PATCH', body: { body }, signal: ctx.signal });
    return true;
  });
}
async function updateComment(ctx: Context, number: number, name: string, content: string): Promise<void> {
  const desired = sanitize(content.trim());
  const locate = async () => unique((await comments(ctx, number)).filter(item => item.user.login === ctx.config.githubOwner && managed(item.body, name) !== null), `comment marker ${name}`);
  await deliver(ctx, `comment:${number}:${name}:${digest(desired)}`, 'upsert-comment-section', { number, section: name, content: desired }, async () => {
    const current = await locate();
    return current && managed(current.body, name) === desired ? true : null;
  }, async () => {
    const current = await locate();
    if (current) {
      const fresh = await gh<Comment>(`${repo(ctx)}/issues/comments/${current.id}`, { signal: ctx.signal });
      await gh(`${repo(ctx)}/issues/comments/${current.id}`, { method: 'PATCH', body: { body: merge(fresh.body, name, desired) }, signal: ctx.signal });
    } else await gh(`${repo(ctx)}/issues/${number}/comments`, { method: 'POST', body: { body: block(name, desired) }, signal: ctx.signal });
    return true;
  });
}

async function connections<T>(load: (cursor: string | null) => Promise<{ nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>): Promise<T[]> {
  const result: T[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const connection = await load(cursor);
    result.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return result;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error('Project pagination did not advance');
    seen.add(cursor);
  }
  throw new Error('Project pagination bound reached; recovery is incomplete');
}
async function repositoryId(ctx: Context): Promise<string> {
  const current = await gh<{ node_id: string; private: boolean }>(repo(ctx), { signal: ctx.signal });
  if (current.private) throw new Error('The editorial repository must be public');
  return current.node_id;
}
async function discoverProject(ctx: Context): Promise<any | null> {
  const projects = await connections<any>(async cursor => (await graphql<any>('query($login:String!,$cursor:String){user(login:$login){projectsV2(first:100,after:$cursor){nodes{id title url public closed} pageInfo{hasNextPage endCursor}}}}', { login: ctx.config.githubOwner, cursor }, ctx.signal)).user.projectsV2);
  const matches: any[] = [];
  for (const project of projects.filter(item => item.title === 'Editor-in-chief')) {
    const linked = await connections<{ nameWithOwner: string }>(async cursor => (await graphql<any>('query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{repositories(first:100,after:$cursor){nodes{nameWithOwner} pageInfo{hasNextPage endCursor}}}}}', { id: project.id, cursor }, ctx.signal)).node.repositories);
    if (linked.some(item => item.nameWithOwner.toLowerCase() === ctx.config.repository.toLowerCase())) matches.push(project);
  }
  return unique(matches, 'Editor-in-chief projects with exact title and repository linkage');
}
async function projectFields(ctx: Context, id: string): Promise<any[]> {
  return connections<any>(async cursor => (await graphql<any>('query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{fields(first:100,after:$cursor){nodes{... on ProjectV2Field{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2SingleSelectField{id name options{id name color description}}} pageInfo{hasNextPage endCursor}}}}}', { id, cursor }, ctx.signal)).node.fields);
}
async function getProject(ctx: Context, create = false): Promise<Project | null> {
  const repository = await repositoryId(ctx);
  let found = await discoverProject(ctx);
  if (!found && create) {
    const owner = (await graphql<any>('query($login:String!){user(login:$login){id}}', { login: ctx.config.githubOwner }, ctx.signal)).user.id;
    found = await deliver(ctx, 'project:create', 'create-project', { owner, repository, title: 'Editor-in-chief' }, () => discoverProject(ctx), async () => (await graphql<any>('mutation($input:CreateProjectV2Input!){createProjectV2(input:$input){projectV2{id title url public closed}}}', { input: { ownerId: owner, repositoryId: repository, title: 'Editor-in-chief' } }, ctx.signal)).createProjectV2.projectV2);
  }
  if (!found) {
    if (dry(ctx)) { proposal(ctx, 'project:create', 'bootstrap-needed', { repository: ctx.config.repository }); return null; }
    throw new Error('No linked Editor-in-chief project exists; run bootstrap --apply');
  }
  if (found.closed) throw new Error(`Editorial project is closed: ${found.url}`);
  if (!found.public) {
    if (!create) throw new Error(`Editorial project is not public: ${found.url}`);
    await deliver(ctx, `project:${found.id}:public`, 'make-project-public', { id: found.id }, async () => (await discoverProject(ctx))?.public ? true : null, async () => {
      await graphql('mutation($input:UpdateProjectV2Input!){updateProjectV2(input:$input){projectV2{id}}}', { input: { projectId: found.id, public: true } }, ctx.signal); return true;
    });
  }
  const loadStatus = async () => unique((await projectFields(ctx, found.id)).filter(item => item.name === 'Status'), 'Status fields');
  let status = await loadStatus();
  if (status && !Array.isArray(status.options)) throw new Error('Project Status field is not single-select');
  const missing = STATUSES.filter(name => !status?.options.some((option: any) => option.name === name));
  if (missing.length) {
    if (!create) throw new Error(`Project Status is missing ${missing.join(', ')}; run bootstrap --apply`);
    status = await deliver(ctx, `project:${found.id}:status-options`, 'configure-project-status', { id: found.id, statuses: STATUSES }, async () => {
      const fresh = await loadStatus();
      return fresh && STATUSES.every(name => fresh.options?.some((option: any) => option.name === name)) ? fresh : null;
    }, async () => {
      const fresh = await loadStatus();
      const additions = STATUSES.filter(name => !fresh?.options.some((option: any) => option.name === name)).map(name => ({ name, description: name === 'Published' ? 'Requires a registered original publication URL and date' : name === 'Selected' || name === 'Parked' ? 'Pedro controls this state' : '', color: name === 'Published' || name === 'Ready' ? 'GREEN' : name === 'Parked' ? 'GRAY' : 'BLUE' }));
      if (fresh) await graphql('mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}', { input: { fieldId: fresh.id, singleSelectOptions: [...fresh.options.map((option: any) => ({ id: option.id, name: option.name, description: option.description ?? '', color: option.color })), ...additions] } }, ctx.signal);
      else await graphql('mutation($input:CreateProjectV2FieldInput!){createProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}', { input: { projectId: found.id, dataType: 'SINGLE_SELECT', name: 'Status', singleSelectOptions: additions } }, ctx.signal);
      const configured = await loadStatus();
      if (!configured) throw new Error('Created Status field could not be recovered');
      return configured;
    });
  }
  if (!status) return null;
  const options: Record<string, string> = {};
  for (const name of STATUSES) {
    const match = unique(status.options.filter((option: any) => option.name === name), `Status option ${name}`) as any;
    if (!match) { if (dry(ctx)) continue; throw new Error(`Missing Status option ${name}`); }
    options[name] = match.id;
  }
  const project: Project = { id: found.id, title: found.title, url: found.url, public: found.public || !dry(ctx), fieldId: status.id, options };
  ctx.state.set('workspace:project', project);
  return project;
}
async function boardItems(ctx: Context, project: Project): Promise<BoardItem[]> {
  const nodes = await connections<any>(async cursor => (await graphql<any>('query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){nodes{id content{... on Issue{id number repository{nameWithOwner}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}} pageInfo{hasNextPage endCursor}}}}}', { id: project.id, cursor }, ctx.signal)).node.items);
  return nodes.filter(item => item.content?.repository?.nameWithOwner.toLowerCase() === ctx.config.repository.toLowerCase()).map(item => ({ id: item.id, contentId: item.content.id, issue: item.content.number, status: item.fieldValueByName?.name ?? null }));
}
async function boardItem(ctx: Context, project: Project, number: number): Promise<BoardItem | null> { return unique((await boardItems(ctx, project)).filter(item => item.issue === number), `project items for #${number}`); }
async function ensureItem(ctx: Context, project: Project, story: Issue): Promise<BoardItem | null> {
  return deliver(ctx, `project:${project.id}:issue:${story.number}`, 'add-project-item', { project: project.id, issue: story.number }, () => boardItem(ctx, project, story.number), async () => {
    const added = (await graphql<any>('mutation($input:AddProjectV2ItemByIdInput!){addProjectV2ItemById(input:$input){item{id}}}', { input: { projectId: project.id, contentId: story.node_id } }, ctx.signal)).addProjectV2ItemById.item;
    return { id: added.id, contentId: story.node_id, issue: story.number, status: null };
  });
}
async function transition(ctx: Context, project: Project, number: number, expected: string | null, target: Status, restore = false): Promise<boolean> {
  if (expected === target) return true;
  if (!restore && (expected === 'Parked' || expected === 'Published' || ctx.state.get(`workspace:manual-hold:${number}`, '') === ctx.now.toISOString())) return false;
  if (target === 'Published' && !ctx.state.publications().some(item => item.storyIssue === number && item.kind === 'original')) return false;
  if (!restore && (target === 'Selected' || target === 'Parked')) throw new Error('Selected and Parked are Pedro-only transitions');
  const key = `status:${project.id}:${number}:${expected ?? 'unset'}:${target}:${ctx.now.toISOString()}`;
  if (!dry(ctx)) outbox(ctx, key, 'pending', 'project-status', { number, expected, target });
  const current = await boardItem(ctx, project, number);
  if (!current || current.status !== expected) {
    if (!dry(ctx)) outbox(ctx, key, current?.status === target ? 'delivered' : 'cancelled', 'project-status', { number, expected, target });
    return current?.status === target;
  }
  if (dry(ctx)) { proposal(ctx, key, 'project-status', { number, expected, target }); return false; }
  outbox(ctx, key, 'attempted', 'project-status', { number, expected, target });
  await graphql('mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}', { input: { projectId: project.id, itemId: current.id, fieldId: project.fieldId, value: { singleSelectOptionId: project.options[target] } } }, ctx.signal);
  outbox(ctx, key, 'delivered', 'project-status', { number, expected, target });
  ctx.state.set(`workspace:verified-status:${number}`, target);
  const candidate = ctx.state.candidates().find(item => item.issueNumber === number);
  if (candidate) ctx.state.putCandidate({ ...candidate, status: target });
  return true;
}

function storyMeta(value: unknown): StoryMeta {
  const data = value as StoryMeta;
  if (!data || typeof data.id !== 'string' || !/^[\w:.-]+$/.test(data.id) || typeof data.topic !== 'string' || !Array.isArray(data.sourceIds) || !data.sourceIds.every(id => typeof id === 'string') || !['harmonic-analyzer', 'ai-engineering', 'side-projects'].includes(data.pillar) || !Number.isFinite(Date.parse(data.createdAt))) throw new Error('Invalid story recovery metadata');
  return data;
}
function candidateFromIssue(ctx: Context, current: Issue): Candidate {
  const saved = ctx.state.candidates().find(candidate => candidate.issueNumber === current.number);
  const metas = storyMetadata(current.body);
  if (metas.length > 1) throw new Error(`Ambiguous story metadata on #${current.number}`);
  const meta = metas[0] ? storyMeta(metas[0]) : null;
  if (saved && meta && saved.id !== meta.id) throw new Error(`Story identity changed on #${current.number}`);
  const result: Candidate = saved ?? { id: meta?.id ?? `issue-${current.number}`, topic: meta?.topic ?? current.title, sourceIds: meta?.sourceIds ?? [], pillar: meta?.pillar ?? (hasLabel(current, 'pillar:harmonic-analyzer') ? 'harmonic-analyzer' : hasLabel(current, 'pillar:ai-engineering') ? 'ai-engineering' : 'side-projects'), readerQuestions: meta?.brief?.questions ?? [], missingEvidence: meta?.brief?.missingEvidence ?? [], brief: meta?.brief ? BriefSchema.parse(meta.brief) : undefined, createdAt: meta?.createdAt ?? current.created_at ?? ctx.now.toISOString(), status: 'Inbox' };
  return { ...result, issueNumber: current.number };
}
function storyMetadata(body:string|null|undefined):StoryMeta[]{
  const names=[...(body??'').matchAll(/^<!-- eic:(story:[\w:.-]+) -->$/gm)].map(match=>match[1]!);
  return names.flatMap(name=>metadata<StoryMeta>(managed(body,name),'candidate-data'));
}
function storyContent(ctx: Context, candidate: Candidate, surfacedWeek: string): string {
  const brief = candidate.brief;
  if (!brief) throw new Error(`Candidate ${candidate.id} has no editorial brief`);
  const lookup = ctx.state.db.query('SELECT data FROM evidence WHERE id=?');
  const sources = candidate.sourceIds.map(id => {
    const row = lookup.get(id) as { data: string } | null;
    return row ? JSON.parse(row.data) as Evidence : null;
  });
  if (sources.some(item => !item)) throw new Error(`Candidate ${candidate.id} is missing its cited evidence`);
  const citations = sources.map(source => {
    const url = source!.sourceUrl;
    const publicLink = url && /^https:\/\/(?:github\.com|bsky\.app)\//.test(url) ? `[public source](${url.replaceAll(')', '%29')})` : 'work notes; no public source link';
    const verified = source!.source === 'hindsight' || source!.provenance.verified === false ? '**Reported in work notes; Pedro must verify**' : 'Public source retrieved; cited material is not independent proof of every claim';
    return `- ${publicLink} — ${verified}. Source ID: \`${text(source!.id)}\`; revision: \`${text(source!.revision)}\`.`;
  }).join('\n');
  const meta: StoryMeta = { id: candidate.id, topic: brief.topic, sourceIds: candidate.sourceIds, pillar: candidate.pillar, createdAt: candidate.createdAt, surfacedWeek, brief };
  return `<!-- eic:candidate-data:${json(meta)} -->\n### Topic label\n${text(brief.topic)}\n\n**Pillar:** ${candidate.pillar}\n**Intended reader:** ${text(brief.reader)}\n**Reader question / payoff:** ${text(brief.question)}\n**Why now:** ${text(brief.whyNow)}\n**Suggested original format:** ${brief.format}\n\n### Cited evidence and verification\n${citations}\n\n### Questions for Pedro\n${brief.questions.map(question => `- ${text(question)}`).join('\n')}\n\n### Missing measurements / media\n${brief.missingEvidence.length ? brief.missingEvidence.map(item => `- ${text(item)}`).join('\n') : '- No additional item identified; this is not proof that unseen media or claims have been verified.'}\n\n### Optional distribution checklist\n${brief.distribution.map(item => `- [ ] ${text(item)}`).join('\n')}\n- [ ] Publish manually, then register the actual HTTPS URL, explicit timestamp, channel, and original/derivative kind. Draft merges are not publication.\n- [ ] Use only verified repository/logbook destinations until publishing prerequisites exist; [landing/email-capture prerequisite](${SIGNUP}).\n\n${CAPTURE_CHECKLIST}`;
}
function staticInbox(ctx: Context): string {
  return `This is the standing asynchronous capture inbox, not a daily writing assignment. Pedro can leave rough notes here or [open a capture form](https://github.com/${ctx.config.repository}/issues/new?template=capture.yml). Content remains human-authored; the editor asks questions and offers minimal grammar/spelling corrections only.\n\nThe weekly desk proposes at most one original at weekly cadence, never more than two when Pedro explicitly chooses twice-weekly. Derivatives do not add original quotas. A missed publication is not a debt. Select or park a story on the Project; the agent never selects or unparks it.\n\nPublishing destination and analytics are explicit prerequisite issues. The existing [Harmonic Analyzer landing/email-capture issue #472](${SIGNUP}) retains that scope; no invented signup or prelaunch link is used.\n\n${CAPTURE_CHECKLIST}`;
}
async function deskShell(ctx: Context): Promise<Issue | null> {
  const current = week(ctx);
  return ensureIssue(ctx, `desk:${current}`, `Editorial desk — ${current}`, `This week's evidence-backed choices will appear here after the editorial desk runs. Nothing is assigned by this shell, and no missed week creates a debt.\n\n${CAPTURE_CHECKLIST}`, ['editorial-desk']);
}

/** Idempotent public bootstrap. The current-week desk is a shell, not a delivered assignment. */
export async function bootstrap(ctx: Context): Promise<unknown> {
  await loadSafetySecrets(ctx.config.hindsightEnvFile);
  await repositoryId(ctx);
  for (const [name, description] of Object.entries(LABELS)) await deliver(ctx, `label:${name}`, 'create-label', { name, description }, async () => (await pages<any>(`${repo(ctx)}/labels`, ctx.signal)).find(label => label.name === name) ?? null, () => gh(`${repo(ctx)}/labels`, { method: 'POST', body: { name, description, color: name.startsWith('pillar:') ? '5319e7' : '0366d6' }, signal: ctx.signal }));
  const project = await getProject(ctx, true);
  const inbox = await ensureIssue(ctx, 'inbox', 'Capture inbox', staticInbox(ctx), ['editorial-capture']);
  if (inbox) ctx.state.set('workspace:inbox', inbox.number);
  const blog = await ensureIssue(ctx, 'prerequisite:publishing', 'Choose the blog / publishing destination', 'Choose and configure the human-controlled original publishing destination, canonical URL, and practical manual publishing workflow. This repository does not build a blog, social publisher, signup page, or video editor. Until an actual destination exists, briefs may link only to verified public repositories/logbook entries.\n\nRecord the real destination here once it exists. This prerequisite does not consume the weekly content quota.\n\nExisting Harmonic Analyzer landing/email capture remains tracked at ' + SIGNUP, ['editorial-prerequisite']);
  const analytics = await ensureIssue(ctx, 'prerequisite:analytics', 'Choose analytics and real outcome inputs', 'Choose analytics for the actual publishing destination and document metric definitions, observation windows, and access. Blog readership and signup conversion remain unavailable until a real destination and data source exist. Public Bluesky counters and GitHub repository traffic are not blog readership, conversion, or backer demand.\n\nManual metrics must include URL, channel, observation time, metric, value, unit, and window. Never fabricate missing denominators or historical values. This prerequisite does not consume the weekly content quota.\n\nThe separate landing/email-capture prerequisite is ' + SIGNUP, ['editorial-prerequisite']);
  if (inbox) await updateIssue(ctx, inbox.number, 'prerequisites', `- Publishing destination: ${blog?.html_url ?? 'pending bootstrap'}\n- Analytics: ${analytics?.html_url ?? 'pending bootstrap'}\n- Harmonic Analyzer landing/email capture: ${SIGNUP}`);
  const desk = ctx.config.cadence === 'paused' ? null : await deskShell(ctx);
  return { project: project?.url ?? null, inbox: inbox?.html_url ?? null, desk: desk?.html_url ?? null, prerequisites: [blog?.html_url, analytics?.html_url, SIGNUP].filter(Boolean), proposed: dry(ctx) };
}

function publicationKey(publication: Publication): string { return digest(publication); }
function storePublication(ctx: Context, publication: Publication): void {
  const key = publicationKey(publication);
  const conflict = ctx.state.publications().find(item => item.storyIssue === publication.storyIssue && item.channel === publication.channel && item.url === publication.url && publicationKey(item) !== key);
  if (conflict) throw new Error('Publication URL is already registered with different date or kind; refusing a conflicting record');
  ctx.state.db.query('INSERT INTO publications(key,data) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(key, JSON.stringify(publication));
}
function recoveredPublications(current: Issue): Publication[] {
  const section = managed(current.body, 'publications');
  if (section === null) return [];
  return metadata<unknown>(section, 'publication-data').map(value => {
    const publication = PublicationSchema.parse(value);
    if (publication.storyIssue !== current.number) throw new Error(`Publication mirror refers to the wrong story on #${current.number}`);
    return publication;
  });
}
async function mirrorPublications(ctx: Context, number: number, extra: Publication[] = []): Promise<void> {
  const fresh = await issue(ctx, number);
  const records = [...recoveredPublications(fresh), ...ctx.state.publications().filter(item => item.storyIssue === number), ...extra];
  const distinct = [...new Map(records.map(item => [publicationKey(item), item])).values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.url.localeCompare(b.url));
  if (!distinct.length) return;
  ctx.state.db.transaction(()=>{for (const record of distinct) { sanitize(record.url); if (!dry(ctx)) storePublication(ctx, record); }})();
  const content = `### Registered manual publications\nOnly an original publication establishes Published. Derivatives are optional distribution, not additional original output. These records can recover local state; no submitted URL is automatically fetched.\n\n${distinct.map(record => `<!-- eic:publication-data:${json(record)} -->\n- **${record.kind} / ${record.channel}** — [published URL](${record.url.replaceAll(')', '%29')}) — ${record.publishedAt}`).join('\n')}`;
  await updateIssue(ctx, number, 'publications', content);
}
/** Registers an explicit human publication, mirrors it durably, and advances only originals. */
export async function recordPublication(ctx: Context, value: Publication): Promise<unknown> {
  await loadSafetySecrets(ctx.config.hindsightEnvFile);
  const publication = PublicationSchema.parse(value);
  sanitize(publication.url);
  const storyIssue = await issue(ctx, publication.storyIssue);
  if (storyIssue.pull_request || !hasLabel(storyIssue, 'editorial-story')) throw new Error('Publication must reference an editorial-story issue in this repository');
  if(!dry(ctx))ctx.state.db.transaction(()=>{for(const existing of recoveredPublications(storyIssue))storePublication(ctx,existing);storePublication(ctx,publication)})();
  await mirrorPublications(ctx, publication.storyIssue, [publication]);
  const project = await getProject(ctx);
  if (project && publication.kind === 'original') {
    const item = await ensureItem(ctx, project, storyIssue);
    if (item) await transition(ctx, project, publication.storyIssue, item.status, 'Published');
  }
  return { publication, mirrored: !dry(ctx), proposed: dry(ctx) };
}
function formFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of body.matchAll(/^### ([^\n]+)\n+([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
    const heading = match[1]!.trim();
    if (heading in fields) throw new Error(`Duplicate form field ${heading}`);
    fields[heading] = match[2]!.trim();
  }
  return fields;
}
function formPublication(current: Issue): Publication {
  const fields = formFields(current.body ?? '');
  const number = /^#?(\d+)$/.exec(fields['Story issue'] ?? '')?.[1];
  return PublicationSchema.parse({ storyIssue: Number(number), channel: fields['Channel'], url: fields['Publication URL'], publishedAt: fields['Published at'], kind: fields['Kind'] });
}
async function collectHumanInputs(ctx: Context, issues: Issue[]): Promise<number> {
  let changed = 0;
  for (const current of issues) {
    const capture = hasLabel(current, 'editorial-capture');
    const story = hasLabel(current, 'editorial-story');
    if (!capture && !story) continue;
    const inputs: Array<{ id: string; body: string; url: string; occurredAt: string | null; revision: string }> = [];
    // The standing inbox and managed story text are automation, even though gh authenticates as Pedro.
    if (capture && current.user.login === ctx.config.githubOwner && !current.body?.includes('<!-- eic:')) inputs.push({ id: `github:capture:issue:${current.node_id}`, body: current.body ?? '', url: current.html_url, occurredAt: current.created_at ?? null, revision: current.updated_at ?? digest(current.body) });
    for (const comment of await comments(ctx, current.number)) if (comment.user.login === ctx.config.githubOwner && !comment.body.includes('<!-- eic:') && comment.body.trim() !== '/eic review') inputs.push({ id: `github:capture:comment:${comment.id}`, body: comment.body, url: comment.html_url ?? `${current.html_url}#issuecomment-${comment.id}`, occurredAt: comment.created_at ?? null, revision: comment.updated_at ?? digest(comment.body) });
    for (const input of inputs) if (input.body.trim()) changed += ctx.state.putEvidence([{ id: input.id, source: 'github', sourceUrl: input.url, observedAt: ctx.now.toISOString(), occurredAt: input.occurredAt, revision: input.revision, text: sanitize(input.body).slice(0, 12000), provenance: { authoredBy: ctx.config.githubOwner, capture: true, verified: false, attribution: 'Pedro-authored rough notes; measurements are reported, not independently verified', storyIssue: story ? current.number : null } }]);
  }
  return changed;
}

/** Rebuilds remote identities, honors human status changes, and ingests only Pedro's inputs. */
export async function syncWorkspace(ctx: Context): Promise<unknown> {
  await loadSafetySecrets(ctx.config.hindsightEnvFile);
  const project = await getProject(ctx);
  if (ctx.config.cadence === 'paused') ctx.state.set('cadence:paused-weeks', [...new Set([...ctx.state.get<string[]>('cadence:paused-weeks', []), week(ctx)])]);
  const issues = await allIssues(ctx);
  const inbox = unique(issues.filter(item => managed(item.body, 'inbox') !== null), 'capture inbox');
  if (inbox) ctx.state.set('workspace:inbox', inbox.number);
  for (const current of issues.filter(item => hasLabel(item, 'editorial-desk'))) {
    const metas = metadata<DeskMeta>(current.body, 'desk-data');
    if (metas.length > 1) throw new Error(`Ambiguous desk metadata on #${current.number}`);
    const meta = metas[0];
    if (meta && /^\d{4}-W\d{2}$/.test(meta.week)) {
      ctx.state.set(`desk:${meta.week}:carry`, meta.carried);
      if (!dry(ctx) && current.body?.includes(marker(`desk-complete:${meta.week}`))) ctx.state.set(`desk:${meta.week}:delivered`, current.html_url);
    }
  }
  const stories = issues.filter(item => hasLabel(item, 'editorial-story'));
  const recoveredIds = new Set<string>();
  for (const current of stories) {
    const candidate = candidateFromIssue(ctx, current);
    if (recoveredIds.has(candidate.id)) throw new Error(`Duplicate issues for story ${candidate.id}; refusing to mutate either`);
    recoveredIds.add(candidate.id);
    ctx.state.putCandidate(candidate);
    try{ctx.state.db.transaction(()=>{for(const publication of recoveredPublications(current))storePublication(ctx,publication)})()}
    catch{await updateComment(ctx,current.number,'publication-record-error','Conflicting or invalid mirrored publication records were withheld. Correct the URL, date/time or kind in the managed publication records; other stories can continue.');continue}
    if (ctx.state.publications().some(item => item.storyIssue === current.number)) await mirrorPublications(ctx, current.number);
    if (candidate.brief && candidate.sourceIds.every(id => ctx.state.db.query('SELECT 1 FROM evidence WHERE id=?').get(id))) {
      const previousMeta = storyMetadata(current.body)[0];
      if (managed(current.body, `story:${candidate.id}`) !== null) await updateIssue(ctx, current.number, `story:${candidate.id}`, storyContent(ctx, candidate, previousMeta?.surfacedWeek ?? week(ctx)));
    }
    if (!project) continue;
    const item = await ensureItem(ctx, project, current);
    if (!item) continue;
    const previous = ctx.state.get<string | null>(`workspace:verified-status:${current.number}`, null);
    const original = ctx.state.publications().some(record => record.storyIssue === current.number && record.kind === 'original');
    if (item.status === 'Published' && !original) {
      await updateComment(ctx, current.number, 'publication-needed', 'The Project was moved to Published, but no original publication has been registered. Please provide the actual HTTPS URL, channel, and explicit publication date/time using the publication form or record-publication command. A merged draft or a board move is not publication. The prior verified status is retained.');
      const restore = previous && previous !== 'Published' && STATUSES.includes(previous as Status) ? previous as Status : 'Inbox';
      if(await transition(ctx, project, current.number, 'Published', restore, true))ctx.state.putCandidate({ ...candidate, status: restore });
      continue;
    }
    if (item.status && !STATUSES.includes(item.status as Status)) throw new Error(`Unknown Status ${item.status} on story #${current.number}; choose one of the editorial statuses`);
    if (item.status !== previous && (item.status === 'Selected' || item.status === 'Parked')) ctx.state.set(`workspace:manual-hold:${current.number}`, ctx.now.toISOString());
    const currentStatus = item.status ?? 'Inbox';
    ctx.state.putCandidate({ ...candidate, status: currentStatus });
    if (item.status) ctx.state.set(`workspace:verified-status:${current.number}`, item.status);
    if (original && item.status !== 'Published') await transition(ctx, project, current.number, item.status, 'Published');
    else if (!item.status) await transition(ctx, project, current.number, null, 'Inbox');
  }
  const captures = await collectHumanInputs(ctx, issues);
  for (const form of issues.filter(item => item.user.login === ctx.config.githubOwner && hasLabel(item, 'editorial-publication'))) {
    const revision = digest(form.body);
    if (ctx.state.get(`publication-form:${form.number}:revision`, '') === revision) continue;
    let publication: Publication;
    try { publication = formPublication(form); }
    catch { await updateComment(ctx, form.number, 'publication-form-error', 'The publication form could not be registered. Supply a story issue number, one supported channel (blog/bluesky/linkedin/youtube/tiktok), a valid HTTPS URL, an explicit ISO date/time including timezone, and original or derivative. No submitted URL is fetched.'); continue; }
    try{await recordPublication(ctx, publication)}
    catch{await updateComment(ctx,form.number,'publication-form-error','Publication registration could not complete. Check that the story is editorial, the URL/date/kind do not conflict with an existing record, and GitHub is reachable. No conflicting record was accepted.');continue}
    await updateIssue(ctx, form.number, 'publication-receipt', `Registered ${publication.kind} / ${publication.channel} for story #${publication.storyIssue} at ${publication.publishedAt}. The durable publication record is in that story's managed publication section.`);
    if (!dry(ctx)) ctx.state.set(`publication-form:${form.number}:revision`, digest((await issue(ctx, form.number)).body));
  }
  if (project) await syncDraftStates(ctx, project);
  return { project: project?.url ?? null, stories: stories.length, captures, publications: ctx.state.publications().length, active: ctx.state.candidates().filter(candidate => ACTIVE.has(candidate.status ?? '')).map(candidate => candidate.id) };
}

/** One weekly desk, at most three surfaced stories, never automatic selection or cadence growth. */
export async function applyDesk(ctx: Context, input: DeskResult): Promise<unknown> {
  await loadSafetySecrets(ctx.config.hindsightEnvFile);
  const desk = DeskResultSchema.parse(input), currentWeek = week(ctx);
  if (ctx.config.cadence === 'paused') {
    ctx.state.set('cadence:paused-weeks', [...new Set([...ctx.state.get<string[]>('cadence:paused-weeks', []), currentWeek])]);
    return { status: 'paused', created: 0 };
  }
  const existingDesk = await findIssue(ctx, `desk:${currentWeek}`);
  if (existingDesk?.body?.includes(marker(`desk-complete:${currentWeek}`))) {
    if (!dry(ctx)) ctx.state.set(`desk:${currentWeek}:delivered`, existingDesk.html_url);
    return { status: 'already-delivered', url: existingDesk.html_url };
  }
  const project = await getProject(ctx);
  const candidates = ctx.state.candidates();
  const active = candidates.filter(candidate => ACTIVE.has(candidate.status ?? '') && candidate.issueNumber && !ctx.state.publications().some(publication => publication.storyIssue === candidate.issueNumber && publication.kind === 'original'));
  const cap = ctx.config.cadence === 'twice-weekly' ? 2 : 1;
  if (new Set(desk.choices.map(choice => choice.candidateId)).size !== desk.choices.length) throw new Error('Desk repeats a candidate');
  if (desk.recommendations.length > cap || new Set(desk.recommendations).size !== desk.recommendations.length) throw new Error('Desk recommendations exceed the operator-selected cadence');
  for (const choice of desk.choices) if (!candidates.some(candidate => candidate.id === choice.candidateId)) throw new Error('Desk references an unknown candidate');
  for (const id of desk.recommendations) if (!desk.choices.some(choice => choice.candidateId === id) && !active.some(candidate => candidate.id === id)) throw new Error('Desk recommendation is not a supplied choice or active story');
  const previousWeek = isoWeek(new Date(ctx.now.getTime() - 7 * 86400000), ctx.config.timezone);
  const priorCarries = ctx.state.get<Record<string, number>>(`desk:${previousWeek}:carry`, {});
  const carried = Object.fromEntries(active.map(candidate => [candidate.id, (priorCarries[candidate.id] ?? 0) + 1]));
  const capacity=active.some(candidate=>carried[candidate.id]!>=2)?0:Math.max(0,cap-active.length);
  if(active.length&&desk.choices.filter(choice=>!active.some(candidate=>candidate.id===choice.candidateId)).length>capacity)throw new Error('Desk choices exceed remaining original capacity');
  const surfaced = (await allIssues(ctx)).filter(item => storyMetadata(item.body).some(meta => meta.surfacedWeek === currentWeek));
  let created = surfaced.length;
  const choices: Candidate[] = [];
  // Carry an existing original rather than manufacturing another assignment or publication debt.
  for (const choice of desk.choices) {
    const candidate = candidates.find(item => item.id === choice.candidateId)!;
    if (candidate.status === 'Parked' || candidate.status === 'Published' || ACTIVE.has(candidate.status??'')) continue;
    const updated = { ...candidate, topic: choice.brief.topic, brief: choice.brief };
    const remote = await findIssue(ctx, `story:${candidate.id}`);
    if (!remote && created >= 3) continue;
    const current = remote ?? await ensureIssue(ctx, `story:${candidate.id}`, `Story: ${text(choice.brief.topic)}`, storyContent(ctx, updated, currentWeek), ['editorial-story', `pillar:${candidate.pillar}`]);
    if (!remote) created++;
    if (current) {
      updated.issueNumber = current.number;
      updated.status = candidate.status ?? 'Inbox';
      await updateIssue(ctx, current.number, `story:${candidate.id}`, storyContent(ctx, updated, storyMetadata(current.body)[0]?.surfacedWeek ?? currentWeek));
      if (project) {
        const item = await ensureItem(ctx, project, current);
        if (item?.status == null) await transition(ctx, project, current.number, null, 'Inbox');
      }
      ctx.state.putCandidate(updated);
    }
    choices.push(updated);
  }
  const recommended=[...active.slice(0,cap).map(candidate=>candidate.id),...desk.recommendations.filter(id=>choices.some(candidate=>candidate.id===id)&&!active.some(candidate=>candidate.id===id))].slice(0,cap);
  const summary=deskMetrics(ctx);
  const prerequisites = (await allIssues(ctx)).filter(item => hasLabel(item, 'editorial-prerequisite')).map(item => `- [${text(item.title)}](${item.html_url})`).join('\n');
  const meta: DeskMeta = { week: currentWeek, carried, choices: choices.map(candidate => candidate.id), recommendations: recommended };
  const carrySection=active.length?`### Carry-forward\n${active.map(candidate=>`- #${candidate.issueNumber}: ${text(candidate.topic)} — carried ${carried[candidate.id]} consecutive week(s).${carried[candidate.id]!>=2?' Narrow this same story to available evidence or park it; no additional assignment.':''}`).join('\n')}\n${active.length>cap?`There are ${active.length} manually active stories, above the cap of ${cap}. Pedro must narrow or park them; none are automatically parked.`:''}`:'';
  const choiceSection=choices.length?`### Evidence-backed choices (at most three)\n${choices.map(candidate=>`- ${candidate.issueNumber?'#'+candidate.issueNumber:'[proposed story]'}: ${text(candidate.topic)} (${candidate.pillar})`).join('\n')}`:active.length?'':'No sufficiently evidenced new option is available. Nothing is assigned.';
  const selection=[carrySection,choiceSection].filter(Boolean).join('\n\n');
  const experiment = desk.experiment && !active.some(candidate => carried[candidate.id]! >= 2) ? `### One bounded experiment\n- Hypothesis: ${text(desk.experiment.hypothesis)}\n- Changed variable: ${text(desk.experiment.variable)}\n- Observation window: ${text(desk.experiment.window)}\n- Success signal: ${text(desk.experiment.successSignal)}\nThis stays within the existing original workload cap; observations do not establish causality.` : '';
  const content=[
    `<!-- eic:desk-data:${json(meta)} -->`,marker(`desk-complete:${currentWeek}`),
    `## Weekly desk — ${currentWeek}`,
    `Cadence: **${ctx.config.cadence}**; at most **${cap} original${cap===1?'':'s'}**, absolute maximum two. Pedro alone changes cadence and selects or parks stories. Optional derivatives do not count as originals; a missed publication is not a debt.`,
    selection,
    `### Recommendation, not automatic selection\n${recommended.length?recommended.map(id=>{const candidate=[...active,...choices].find(item=>item.id===id)!;return `- ${candidate.issueNumber?'#'+candidate.issueNumber:'[proposed story]'}: ${text(candidate.topic)}`}).join('\n'):'No new recommendation.'}`,
    `### Outcomes, consistency, and missing inputs\n${text(summary)}\n\nSmall samples and missing denominators limit interpretation. GitHub traffic is repository reach, not blog readership; likes are not backer demand. Useful reader questions and editing effort count only when supplied, not guessed.`,
    experiment,`### Publishing prerequisites\n${prerequisites}\n- [Harmonic Analyzer landing/email capture #472](${SIGNUP})`,CAPTURE_CHECKLIST,
  ].filter(Boolean).join('\n\n');
  const current = existingDesk ?? await deskShell(ctx);
  if (current) await updateIssue(ctx, current.number, `desk:${currentWeek}`, content);
  else proposal(ctx, `desk:${currentWeek}`, 'weekly-desk', { content });
  if (!dry(ctx) && current) {
    ctx.state.set(`desk:${currentWeek}:carry`, carried);
    ctx.state.set(`desk:${currentWeek}:delivered`, current.html_url);
    for (const candidate of active) ctx.state.putCandidate({ ...candidate, carriedWeeks: carried[candidate.id] });
  }
  return { status: dry(ctx) ? 'proposed' : 'delivered', url: current?.html_url ?? null, choices: choices.map(candidate => candidate.id), recommended, carried, ...(dry(ctx)?{briefs:choices.map(candidate=>candidate.brief),content}:{}) };
}

async function eligible(ctx: Context, number: number): Promise<Eligible | null> {
  const pr = await gh<Pull>(`${repo(ctx)}/pulls/${number}`, { signal: ctx.signal });
  if (pr.state !== 'open' || pr.user.login !== ctx.config.githubOwner || !hasLabel(pr, 'editorial-draft') || pr.base.repo.full_name.toLowerCase() !== ctx.config.repository.toLowerCase()) return null;
  const links = [...(pr.body ?? '').matchAll(/^Story:\s*#([1-9]\d*)\s*$/gm)];
  if (links.length !== 1) return null;
  const linked = await issue(ctx, Number(links[0]![1]));
  if (linked.pull_request || !hasLabel(linked, 'editorial-story')) return null;
  const changed=await pages<ChangedFile>(`${repo(ctx)}/pulls/${number}/files`,ctx.signal);
  if(pr.changed_files!==undefined&&changed.length!==pr.changed_files)throw new Error('PR file listing is incomplete; refusing partial review');
  const prefix=`drafts/${linked.number}/`;
  if(!changed.length||changed.some(file=>!file.filename.startsWith(prefix)||(file.previous_filename&&!file.previous_filename.startsWith(prefix))||!/\.(?:md|markdown|txt|vtt|srt|png|jpe?g|webp|gif|svg|mp4|mov|m4v|webm|mp3|wav|ogg|pdf)$/i.test(file.filename)))return null;
  return { pr, issue: linked, story: candidateFromIssue(ctx, linked),changed };
}
function reviewMarkers(body: string): string[] { return [...body.matchAll(/<!-- eic:(review:\d+:[a-f0-9]+:[a-f0-9]+(?::\d+)?) -->/g)].map(match => match[1]!); }
async function reviewAction(ctx: Context, entry: Eligible, policy: string): Promise<ReviewAction | null> {
  const [reviews, discussion] = await Promise.all([pages<Comment>(`${repo(ctx)}/pulls/${entry.pr.number}/reviews`, ctx.signal), comments(ctx, entry.pr.number)]);
  const delivered = reviews.filter(review => review.user.login === ctx.config.githubOwner).flatMap(review => reviewMarkers(review.body));
  if(!dry(ctx))for(const action of delivered)ctx.state.db.query("UPDATE outbox SET status='delivered',updated_at=? WHERE key=? AND status IN ('pending','attempted')").run(ctx.now.toISOString(),action);
  const prefix = `review:${entry.pr.number}:${entry.pr.head.sha}:${policy}`;
  const requests = discussion.filter(comment => comment.user.login === ctx.config.githubOwner && comment.body.trim() === '/eic review').sort((a, b) => a.id - b.id);
  const requested = requests.find(comment => !delivered.some(action => action.endsWith(`:${comment.id}`)));
  if (requested) return { marker: `${prefix}:${requested.id}`, requestId: requested.id, reviews, comments: discussion };
  if (delivered.some(action => action === prefix || action.startsWith(prefix + ':'))) return null;
  return { marker: prefix, reviews, comments: discussion };
}
/** Draft PRs are eligible; code PRs, external authors, unrelated labels, and ambiguous links are not. */
export async function eligibleReviews(ctx: Context): Promise<number[]> {
  const policy = await policyHash(), result: number[] = [];
  for (const pr of await pages<Pull>(`${repo(ctx)}/pulls?state=open`, ctx.signal)) {
    if (pr.user.login !== ctx.config.githubOwner || !hasLabel(pr, 'editorial-draft')) continue;
    const entry = await eligible(ctx, pr.number);
    if (entry && await reviewAction(ctx, entry, policy)) result.push(pr.number);
  }
  ctx.state.set('pending-reviews', result);
  return result;
}
async function fetchDraft(ctx: Context, entry: Eligible): Promise<{ files: DraftFile[]; unseenMedia: string[] } | null> {
  const changed = entry.changed;
  const prefix = `drafts/${entry.issue.number}/`;
  const tree = await gh<{ truncated: boolean; tree: Array<{ path: string; type: string; mode: string; sha: string; size?: number }> }>(`${repo(ctx)}/git/trees/${entry.pr.head.sha}?recursive=1`, { signal: ctx.signal });
  if (tree.truncated) throw new Error('Head-SHA tree is truncated; refusing partial review');
  const entries = tree.tree.filter(item => item.path.startsWith(prefix) && item.type !== 'tree');
  if (entries.length > 100) throw new Error('Draft exceeds the bounded 100-file review envelope');
  const files: DraftFile[] = [], unseenMedia: string[] = [];
  let bytes = 0;
  for (const item of entries) {
    if (item.mode === '120000' || item.type !== 'blob') throw new Error('Draft symlinks and submodules are not reviewable');
    if (!/\.(?:md|markdown|txt|vtt|srt)$/i.test(item.path)) {
      if (/\.(?:png|jpe?g|webp|gif|svg|mp4|mov|m4v|webm|mp3|wav|ogg|pdf)$/i.test(item.path)) { unseenMedia.push(item.path); continue; }
      return null;
    }
    if ((item.size ?? 0) > 200000 || bytes + (item.size ?? 0) > 1000000) throw new Error('Draft exceeds the bounded text review envelope');
    const blob = await gh<{ encoding: string; content: string; size: number; sha: string }>(`${repo(ctx)}/git/blobs/${item.sha}`, { signal: ctx.signal });
    if (blob.encoding !== 'base64' || blob.sha !== item.sha || blob.size > 200000) throw new Error('Unexpected draft blob encoding or identity');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(blob.content, 'base64'));
    bytes += Buffer.byteLength(content);
    if (bytes > 1000000) throw new Error('Draft exceeds the bounded text review envelope');
    sanitize(content);
    files.push({ path: item.path, content, patch: changed.find(file => file.filename === item.path)?.patch });
  }
  return files.length ? { files, unseenMedia } : null;
}
async function threadStates(ctx: Context, number: number): Promise<Record<number, { resolved: boolean; outdated: boolean }>> {
  const [owner, name] = ctx.config.repository.split('/');
  const threads = await connections<any>(async cursor => (await graphql<any>('query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated comments(first:100){nodes{databaseId} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}', { owner, name, number, cursor }, ctx.signal)).repository.pullRequest.reviewThreads);
  const result: Record<number, { resolved: boolean; outdated: boolean }> = {};
  for (const thread of threads) {
    const ids = thread.comments.pageInfo.hasNextPage ? await connections<any>(async cursor => (await graphql<any>('query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{databaseId} pageInfo{hasNextPage endCursor}}}}}', { id: thread.id, cursor }, ctx.signal)).node.comments) : thread.comments.nodes;
    for (const comment of ids) result[comment.databaseId] = { resolved: thread.isResolved, outdated: thread.isOutdated };
  }
  return result;
}
function parsedReview(review: Comment): ReviewResult | null {
  const entries = metadata<unknown>(review.body, 'review-data');
  if (!entries.length) return null;
  if (entries.length !== 1) throw new Error('Ambiguous persisted review result');
  return ReviewResultSchema.parse(entries[0]);
}
function reviewBody(ctx: Context, number: number, action: string, result: ReviewResult): string {
  return sanitize(`${marker(action)}\n<!-- eic:review-data:${json(result)} -->\n## Editorial review — ${result.verdict === 'ready' ? 'Ready' : 'Needs work'}\nHead: \`${result.headSha}\`. COMMENT only; Pedro decides, edits, and publishes. Argument/evidence/comprehension first; minimal grammar/spelling second. No prose is committed or ghostwritten.\n\n${result.findings.length ? result.findings.map(finding => {
    const location = `https://github.com/${ctx.config.repository}/blob/${result.headSha}/${finding.path.split('/').map(encodeURIComponent).join('/')}#L${finding.line}`;
    return `### ${text(finding.id)} — ${finding.category} / ${finding.severity}\n[${text(finding.path)}:${finding.line}](${location})\n\nExisting span: ${JSON.stringify(text(finding.quote))}\n\n${text(finding.problem)}\n\n**Question:** ${text(finding.question)}${finding.grammarReplacement !== undefined ? `\n\n**Optional minimal grammar correction (Pedro applies):** ${JSON.stringify(text(finding.grammarReplacement))}` : ''}`;
  }).join('\n\n') : 'No actionable finding in the supplied text/evidence. This does not claim that unseen media was reviewed.'}\n\n${result.remainingIssues ? `### Remaining grouped diagnostics\n${text(result.remainingIssues)}\n\n` : ''}Readiness applies only to this head; a new head invalidates it. To request one additional round, Pedro may comment exactly \`/eic review\`.\n`);
}
async function head(ctx: Context, number: number): Promise<string> { return (await gh<Pull>(`${repo(ctx)}/pulls/${number}`, { signal: ctx.signal })).head.sha; }
async function discardHead(ctx: Context, number: number, actual: string): Promise<unknown> { ctx.state.set(`review:queued:${number}`, actual); return { status: 'head-changed', headSha: actual, queued: true }; }
/** Exact-head review; the sole remote review event is COMMENT. Rechecks head twice. */
export async function reviewPullRequest(ctx: Context, number: number, editor: Editor): Promise<unknown> {
  await loadSafetySecrets(ctx.config.hindsightEnvFile);
  const entry = await eligible(ctx, number);
  if (!entry) return { status: 'ineligible' };
  const policy = await policyHash(), action = await reviewAction(ctx, entry, policy);
  if (!action) return { status: 'already-reviewed', headSha: entry.pr.head.sha };
  const project = await getProject(ctx), planned = project ? await boardItem(ctx, project, entry.issue.number) : null;
  const files = await fetchDraft(ctx, entry);
  if (!files) return { status: 'ineligible-files' };
  const [inline, resolution] = await Promise.all([pages<Comment>(`${repo(ctx)}/pulls/${number}/comments`, ctx.signal), threadStates(ctx, number)]);
  const priorFindings = action.reviews.filter(review => review.user.login === ctx.config.githubOwner).flatMap(review => {
    const prior = parsedReview(review);
    return (prior?.findings ?? []).map(finding => ({ ...finding, reviewId: review.id, headSha: prior!.headSha, submittedAt: review.submitted_at, resolution: 'Consult Pedro responses and current text; an old-head finding is not automatically unresolved.' }));
  });
  const responses = [
    ...action.comments.filter(comment => comment.user.login === ctx.config.githubOwner && comment.body.trim() !== '/eic review' && !comment.body.includes('<!-- eic:')).map(comment => ({ type: 'human-comment', id: comment.id, text: sanitize(comment.body), createdAt: comment.created_at })),
    ...inline.filter(comment => comment.user.login === ctx.config.githubOwner).map(comment => ({ type: 'inline-response', id: comment.id, text: sanitize(comment.body), path: comment.path, line: comment.line, replyTo: comment.in_reply_to_id, ...resolution[comment.id] })),
    ...action.reviews.filter(review => review.user.login === ctx.config.githubOwner && !review.body.includes('<!-- eic:')).map(review => ({ type: 'human-review', id: review.id, text: sanitize(review.body) })),
    { type: 'media-coverage', unseenMedia: files.unseenMedia, limitation: 'Only fetched UTF-8 text is reviewed. Binary media and linked external media have not been inspected; essential unseen media cannot be treated as verified.' },
  ];
  const pending = ctx.state.db.query('SELECT key,status,data,updated_at FROM outbox WHERE key=?').get(action.marker) as Outbox | null;
  let result: ReviewResult;
  if (pending && ['pending', 'attempted'].includes(pending.status)) {
    const cached = JSON.parse(pending.data).detail?.result;
    result = ReviewResultSchema.parse(cached);
    if (result.headSha !== entry.pr.head.sha) return discardHead(ctx, number, entry.pr.head.sha);
  } else {
    const response = await editor(ctx, { kind: 'review', headSha: entry.pr.head.sha, files: files.files, story: entry.story, priorFindings, responses });
    if (response.result.kind !== 'review') throw new Error('Editor returned the wrong result kind');
    result = ReviewResultSchema.parse(response.result);
  }
  if (result.headSha !== entry.pr.head.sha) throw new Error('Editor returned a review for the wrong head');
  const body = reviewBody(ctx, number, action.marker, result);
  const beforeSubmit = await head(ctx, number);
  if (beforeSubmit !== result.headSha) return discardHead(ctx, number, beforeSubmit);
  const sent = await deliver(ctx, action.marker, 'submit-review', { number, headSha: result.headSha, result, body }, async () => unique((await pages<Comment>(`${repo(ctx)}/pulls/${number}/reviews`, ctx.signal)).filter(review => review.user.login === ctx.config.githubOwner && review.body.includes(marker(action.marker))), `review ${action.marker}`), async () => {
    const current = await head(ctx, number);
    if (current !== result.headSha) { await discardHead(ctx, number, current); throw new Error('PR head changed immediately before review submission; latest head queued'); }
    return gh<Comment>(`${repo(ctx)}/pulls/${number}/reviews`, { method: 'POST', body: { event: 'COMMENT', commit_id: result.headSha, body }, signal: ctx.signal });
  });
  const beforeProject = await head(ctx, number);
  if (beforeProject !== result.headSha) return discardHead(ctx, number, beforeProject);
  if (sent && project && planned) await transition(ctx, project, entry.issue.number, planned.status, result.verdict === 'ready' ? 'Ready' : 'Review');
  if (sent && !dry(ctx)) { ctx.state.delete(`review:queued:${number}`); ctx.state.set(`review:last:${number}`, { headSha: result.headSha, verdict: result.verdict, policy, marker: action.marker, reviewId: sent.id }); }
  if (sent && !dry(ctx)) ctx.state.set('pending-reviews', ctx.state.get<number[]>('pending-reviews', []).filter(pr => pr !== number));
  return { status: dry(ctx) ? 'proposed' : 'reviewed', headSha: result.headSha, verdict: result.verdict, storyIssue: entry.issue.number, reviewId: sent?.id ?? null, ...(dry(ctx) ? { review: result, body } : {}) };
}
async function syncDraftStates(ctx: Context, project: Project): Promise<void> {
  const policy = await policyHash();
  const states = new Map<number, Array<{ pr: number; sha: string; status: Status; reviewId: number | null }>>();
  for (const pull of await pages<Pull>(`${repo(ctx)}/pulls?state=open`, ctx.signal)) {
    if (pull.user.login !== ctx.config.githubOwner || !hasLabel(pull, 'editorial-draft')) continue;
    const entry = await eligible(ctx, pull.number);
    if (!entry) continue;
    const prefix = `review:${pull.number}:${entry.pr.head.sha}:${policy}`;
    const reviews = (await pages<Comment>(`${repo(ctx)}/pulls/${pull.number}/reviews`, ctx.signal)).filter(review => review.user.login === ctx.config.githubOwner && reviewMarkers(review.body).some(action => action === prefix || action.startsWith(prefix + ':'))).sort((a, b) => b.id - a.id);
    const latest = reviews[0] ? parsedReview(reviews[0]) : null;
    const status: Status = latest?.headSha === entry.pr.head.sha ? latest.verdict === 'ready' ? 'Ready' : 'Review' : 'Drafting';
    states.set(entry.issue.number, [...(states.get(entry.issue.number) ?? []), { pr: pull.number, sha: entry.pr.head.sha, status, reviewId: reviews[0]?.id ?? null }]);
  }
  for (const [number, pulls] of states) {
    const eventKey = `workspace:draft-event:${number}`, event = digest(pulls);
    if (ctx.state.get(eventKey, '') === event) continue;
    const item = await boardItem(ctx, project, number);
    if (!item || ctx.state.publications().some(publication => publication.storyIssue === number && publication.kind === 'original')) continue;
    const target = pulls.some(pull => pull.status === 'Drafting') ? 'Drafting' : pulls.some(pull => pull.status === 'Review') ? 'Review' : 'Ready';
    let unchanged = true;
    for (const pull of pulls) if (await head(ctx, pull.pr) !== pull.sha) { unchanged = false; break; }
    if (unchanged) {
      const advanced=await transition(ctx, project, number, item.status, target);
      const manualHold=item.status==='Parked'||item.status==='Published'||ctx.state.get(`workspace:manual-hold:${number}`,'')===ctx.now.toISOString();
      if (!dry(ctx)&&(advanced||manualHold)) ctx.state.set(eventKey, event);
    }
  }
}

/** One recoverable inbox comment is updated in place, including a single recovery resolution. */
export async function reportBlockers(ctx: Context, coverage: Coverage[], operationErrors: string[] = []): Promise<unknown> {
  await loadSafetySecrets(ctx.config.hindsightEnvFile);
  const failures = [
    ...coverage.flatMap(item=>(item.status==='failed'?[item.detail]:item.blockers??[]).map(detail=>({source:String(item.source),status:item.status,detail:sanitize(detail)}))),
    ...[...new Set(operationErrors)].map(detail => ({ source: 'editorial-operation', status: 'failed', detail: sanitize(detail) })),
  ].sort((a, b) => a.source.localeCompare(b.source) || a.detail.localeCompare(b.detail));
  const prior = ctx.state.get<{ fingerprint: string; failures: unknown[] } | null>('workspace:blockers', null);
  const pending=ctx.state.get<{fingerprint:string;failures:unknown[]}|null>('workspace:blockers-pending',null);
  const fingerprint = digest(failures);
  // Save the alert before the network: an unavailable GitHub cannot erase it.
  if(failures.length||!pending?.failures.length)ctx.state.set('workspace:blockers-pending', { fingerprint, failures });
  const inbox = await findIssue(ctx, 'inbox');
  if (!inbox) {
    if (failures.length && !dry(ctx)) throw new Error('Operational blocker retained locally; capture inbox unavailable until bootstrap');
    if (failures.length) proposal(ctx, 'operational-blockers', 'blocker-comment', { failures });
    return { status: failures.length ? 'pending-bootstrap' : 'none', proposed: dry(ctx) };
  }
  const existing = unique((await comments(ctx, inbox.number)).filter(comment => comment.user.login === ctx.config.githubOwner && managed(comment.body, 'operational-blockers') !== null), 'operational blocker comment');
  if (!failures.length && !prior?.failures.length && !pending?.failures.length && !existing) { ctx.state.delete('workspace:blockers-pending'); return { status: 'none' }; }
  const content = failures.length ? `### Operational blocker\n${failures.map(item => `- **${item.source} / ${item.status}:** ${text(item.detail)}`).join('\n')}\n\nCoverage is incomplete; no claim depending on an unavailable fetch is newly verified. Safe work from successful sources continues. This one comment is updated on change, not reposted each scan.` : '### Operational blocker — resolved\nThe previously reported source/operation blockers have recovered. Normal collection can continue; this is not a publication reminder.';
  await updateComment(ctx, inbox.number, 'operational-blockers', content);
  if (!dry(ctx)) { ctx.state.set('workspace:blockers', { fingerprint, failures }); ctx.state.delete('workspace:blockers-pending'); }
  return { status: failures.length ? 'blocked' : 'resolved', sources: failures.map(item => item.source), proposed: dry(ctx) };
}
