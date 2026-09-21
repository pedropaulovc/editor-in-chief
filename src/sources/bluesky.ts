import { z } from 'zod';
import type { Collection, Context, Evidence } from '../contracts';
import { sanitize } from '../safety';

const HOST = 'https://public.api.bsky.app';
const KEY = 'source:bluesky';
const DAY = 86_400_000;
const METHODS: Record<string, true> = {
  'com.atproto.identity.resolveHandle': true, 'app.bsky.actor.getProfile': true,
  'app.bsky.feed.getAuthorFeed': true, 'app.bsky.feed.getPosts': true, 'app.bsky.feed.getPostThread': true,
};
const ActorSchema = z.object({ did: z.string().regex(/^did:[a-z]+:[A-Za-z0-9:._%-]+$/), handle: z.string().optional() });
const PostSchema = z.object({
  uri: z.string().regex(/^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~-]+$/), cid: z.string().min(1),
  author: ActorSchema, record: z.object({ text: z.string().max(30_000), createdAt: z.string() }),
  indexedAt: z.string().optional(), likeCount: z.number().nonnegative().optional(), repostCount: z.number().nonnegative().optional(),
  replyCount: z.number().nonnegative().optional(), quoteCount: z.number().nonnegative().optional(),
});
const FeedSchema = z.object({ feed: z.array(z.object({ post: PostSchema, reason: z.object({ $type: z.string(), indexedAt: z.string().optional() }).passthrough().optional() })).max(100), cursor: z.string().max(5000).optional() });
const ProfileSchema = z.object({ did: z.string(), followersCount: z.number().nonnegative().optional(), followsCount: z.number().nonnegative().optional(), postsCount: z.number().nonnegative().optional() });
type Post = z.infer<typeof PostSchema>;
interface Window { from: string; to: string; cursor?: string; pages: number }
interface FeedState { did?: string; checkpoint?: string; pending?: Window; hydrationOffset?: number; threadOffset?: number }
class SourceError extends Error {}
function failure(error: unknown): string { return error instanceof SourceError ? error.message : 'Bluesky operation failed; response body withheld'; }
async function request(ctx: Context, method: string, params: URLSearchParams): Promise<unknown> {
  if (!METHODS[method]) throw new SourceError('Bluesky endpoint is not allowlisted');
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await fetch(`${HOST}/xrpc/${method}?${params}`, { redirect: 'error', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) }); }
    catch { throw new SourceError(`Bluesky ${method}: request failed or deadline exceeded`); }
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      const retry = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      if (Number.isFinite(retry) && retry > 10) throw new SourceError(`Bluesky ${method}: HTTP ${response.status}; retry deferred`);
      await Bun.sleep(Math.max(1, retry || 2 ** attempt) * 1000);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new SourceError(`Bluesky ${method}: HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > 3_000_000) { await response.body?.cancel(); throw new SourceError(`Bluesky ${method}: response bound exceeded`); }
    try { const text = await response.text(); if (text.length > 3_000_000) throw new Error(); return JSON.parse(text); }
    catch { throw new SourceError(`Bluesky ${method}: invalid or oversized response`); }
  }
}
async function resolve(ctx: Context): Promise<string> {
  const result = z.object({ did: ActorSchema.shape.did }).safeParse(await request(ctx, 'com.atproto.identity.resolveHandle', new URLSearchParams({ handle: ctx.config.blueskyHandle })));
  if (!result.success) throw new SourceError('Bluesky handle resolution schema invalid');
  return result.data.did;
}
async function profile(ctx: Context, did: string) {
  const result = ProfileSchema.safeParse(await request(ctx, 'app.bsky.actor.getProfile', new URLSearchParams({ actor: did })));
  if (!result.success || result.data.did !== did) throw new SourceError('Bluesky profile identity mismatch or invalid schema');
  return result.data;
}
async function feed(ctx: Context, did: string, cursor?: string) {
  const params = new URLSearchParams({ actor: did, limit: '100', filter: 'posts_with_replies', includePins: 'false' });
  if (cursor) params.set('cursor', cursor);
  const result = FeedSchema.safeParse(await request(ctx, 'app.bsky.feed.getAuthorFeed', params));
  if (!result.success) throw new SourceError('Bluesky author feed schema invalid');
  return result.data;
}
function sourceUrl(uri: string): string {
  const parts = uri.slice(5).split('/');
  return `https://bsky.app/profile/${parts[0]}/post/${parts[2]}`;
}
function observation(ctx: Context, post: Post): void {
  ctx.state.set(`source:bluesky:post:${post.uri}`, {
    uri: post.uri, cid: post.cid, observedAt: ctx.now.toISOString(),
    likes: post.likeCount ?? null, reposts: post.repostCount ?? null, replies: post.replyCount ?? null, quotes: post.quoteCount ?? null,
    availability: 'public interactions, not impressions or click-through',
  });
}
function evidenceFor(ctx: Context, post: Post, role: 'author' | 'reader-feedback', root?: string): Evidence {
  const sanitized = sanitize(post.record.text);
  const text = sanitized.slice(0, 5800);
  if (!Number.isFinite(Date.parse(post.record.createdAt))) throw new SourceError('Bluesky post timestamp invalid');
  return {
    id: `bluesky:${post.uri}`, source: 'bluesky', sourceUrl: sourceUrl(post.uri), observedAt: ctx.now.toISOString(), occurredAt: post.record.createdAt,
    revision: post.cid, text: role === 'author' ? text : `Reader feedback on a tracked engineering story; not Pedro's work or a verified claim.\n${text}`,
    provenance: { actorRole: role, authorDid: role === 'author' ? post.author.did : undefined, root: root ?? null, verification: 'public-source', textTruncated: sanitized.length > 5800,
      contextPolicy: 'Quote embeds, reply roots, and third-party reposts are not attributed to Pedro. Unrelated personal/political posts must not become engineering assignments.' },
  };
}
function trackedUris(ctx: Context, did: string): string[] {
  const uris = new Set<string>();
  for (const publication of ctx.state.publications()) {
    if (publication.channel !== 'bluesky') continue;
    const url = new URL(publication.url);
    const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([A-Za-z0-9._~-]+)\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'bsky.app' || !match) continue;
    let actor: string;
    try { actor = decodeURIComponent(match[1]!); } catch { continue; }
    if (actor !== did && actor !== ctx.config.blueskyHandle) continue;
    uris.add(`at://${did}/app.bsky.feed.post/${match[2]}`);
  }
  for (const candidate of ctx.state.candidates()) {
    if (!['Selected', 'Drafting', 'Review', 'Ready', 'Published'].includes(candidate.status ?? '')) continue;
    for (const id of candidate.sourceIds) {
      if (id.startsWith(`bluesky:at://${did}/app.bsky.feed.post/`)) uris.add(id.slice('bluesky:'.length));
    }
  }
  return [...uris].sort();
}
async function readerReplies(ctx: Context, root: string, did: string): Promise<{ evidence: Evidence[]; withheld: number; partial: boolean }> {
  const result = z.object({ thread: z.unknown() }).safeParse(await request(ctx, 'app.bsky.feed.getPostThread', new URLSearchParams({ uri: root, depth: '2', parentHeight: '0' })));
  if (!result.success) throw new SourceError('Bluesky thread schema invalid');
  const nodes: unknown[] = [result.data.thread];
  const evidence: Evidence[] = [];
  let visited = 0;
  let withheld = 0;
  while (nodes.length && visited < 60 && evidence.length < 20) {
    const node = z.object({ post: PostSchema.optional(), replies: z.array(z.unknown()).optional() }).safeParse(nodes.shift());
    visited++;
    if (!node.success) continue;
    if (node.data.replies) nodes.push(...node.data.replies.slice(0, 60));
    const post = node.data.post;
    if (!post || post.uri === root || post.author.did === did) continue;
    try { evidence.push(evidenceFor(ctx, post, 'reader-feedback', root)); }
    catch { withheld++; }
  }
  return { evidence, withheld, partial: nodes.length > 0 };
}

export async function collectBluesky(ctx: Context): Promise<Collection> {
  const state = ctx.state.get<FeedState>(KEY, {});
  const evidence: Evidence[] = [];
  const failures: string[] = [];
  let withheld = 0;
  let did: string;
  try {
    did = await resolve(ctx);
    if (state.did && state.did !== did) { state.checkpoint = undefined; state.pending = undefined; }
    state.did = did;
    ctx.state.set(KEY, state);
  } catch (error) { return { evidence, coverage: { source: 'bluesky', status: 'failed', count: 0, detail: failure(error), checkpoint: state.checkpoint } }; }
  try { ctx.state.set('source:bluesky:profile', { ...(await profile(ctx, did)), observedAt: ctx.now.toISOString() }); }
  catch (error) { failures.push(failure(error)); }
  state.pending ??= { from: new Date(state.checkpoint ? Date.parse(state.checkpoint) - 2 * DAY : ctx.now.getTime() - 30 * DAY).toISOString(), to: ctx.now.toISOString(), pages: 0 };
  ctx.state.set(KEY, state);
  for (let page = 0; page < 8 && state.pending && !ctx.signal.aborted; page++) {
    try {
      const window = state.pending;
      const result = await feed(ctx, did, window.cursor);
      const normalized: Evidence[] = [];
      for (const entry of result.feed) {
        // Repost/quote context is deliberately not ingested as the account owner's prose.
        if (entry.post.author.did !== did) continue;
        observation(ctx, entry.post);
        const occurred = Date.parse(entry.post.record.createdAt);
        if (!Number.isFinite(occurred) || occurred < Date.parse(window.from) || occurred > Date.parse(window.to)) continue;
        try { normalized.push(evidenceFor(ctx, entry.post, 'author')); }
        catch { withheld++; }
      }
      ctx.state.putEvidence(normalized);
      evidence.push(...normalized);
      const older = result.feed.length > 0 && result.feed.every(entry => {
        const activity = entry.reason?.indexedAt ?? entry.post.indexedAt ?? entry.post.record.createdAt;
        return Number.isFinite(Date.parse(activity)) && Date.parse(activity) < Date.parse(window.from);
      });
      if (!result.cursor || older) { state.checkpoint = window.to; state.pending = undefined; }
      else {
        if (result.cursor === window.cursor) throw new SourceError('Bluesky feed cursor did not advance');
        window.cursor = result.cursor; window.pages++;
      }
      ctx.state.set(KEY, state);
    } catch (error) { failures.push(failure(error)); break; }
  }
  const tracked = trackedUris(ctx, did);
  const offset = (state.hydrationOffset ?? 0) % Math.max(tracked.length, 1);
  const selected = [...tracked.slice(offset), ...tracked.slice(0, offset)].slice(0, 100);
  let hydrated = 0;
  for (let start = 0; start < selected.length && !ctx.signal.aborted; start += 25) {
    try {
      const batch = selected.slice(start, start + 25);
      const params = new URLSearchParams(); batch.forEach(uri => params.append('uris', uri));
      const result = z.object({ posts: z.array(PostSchema).max(25) }).safeParse(await request(ctx, 'app.bsky.feed.getPosts', params));
      if (!result.success) throw new SourceError('Bluesky tracked-post schema invalid');
      const normalized: Evidence[] = [];
      for (const post of result.data.posts) {
        if (!batch.includes(post.uri) || post.author.did !== did) continue;
        observation(ctx, post);
        try { normalized.push(evidenceFor(ctx, post, 'author')); } catch { withheld++; }
      }
      const missing = batch.length - result.data.posts.filter(post => batch.includes(post.uri) && post.author.did === did).length;
      if (missing) failures.push(`${missing} tracked Bluesky posts unavailable; not recorded as zero interactions`);
      ctx.state.putEvidence(normalized); evidence.push(...normalized);
      hydrated += batch.length;
      state.hydrationOffset = (offset + hydrated) % Math.max(tracked.length, 1); ctx.state.set(KEY, state);
    } catch (error) { failures.push(failure(error)); break; }
  }
  const threadOffset = (state.threadOffset ?? 0) % Math.max(tracked.length, 1);
  const roots = [...tracked.slice(threadOffset), ...tracked.slice(0, threadOffset)].slice(0, 4);
  let threadBound = false;
  for (let index = 0; index < roots.length && !ctx.signal.aborted; index++) {
    try {
      const replies = await readerReplies(ctx, roots[index]!, did);
      ctx.state.putEvidence(replies.evidence); evidence.push(...replies.evidence); withheld += replies.withheld; threadBound ||= replies.partial;
    } catch (error) { failures.push(failure(error)); }
    state.threadOffset = (threadOffset + index + 1) % Math.max(tracked.length, 1); ctx.state.set(KEY, state);
  }
  if (withheld) failures.push(`Source-sanitization blocker: ${withheld} posts or replies withheld`);
  const partial = Boolean(state.pending) || failures.length > 0 || ctx.signal.aborted || tracked.length > selected.length;
  return { evidence, coverage: {
    source: 'bluesky', status: partial ? 'partial' : 'complete', count: evidence.length, checkpoint: state.checkpoint,
    blockers:[...new Set(failures)],
    detail: `Author-attributed posts and replies; ${state.pending ? `feed window pending after ${state.pending.pages} pages` : 'bounded feed window complete'}; ${hydrated}/${tracked.length} tracked posts hydrated; ${roots.length} bounded reader threads${threadBound ? ' (reply bound reached)' : ''}. Reply discovery is sampled, not exhaustive. Public interactions are not impressions/click-through.${failures.length ? ` ${[...new Set(failures)].join('; ')}` : ''}`,
  } };
}

export async function doctorBluesky(ctx: Context): Promise<unknown> {
  try {
    const did = await resolve(ctx);
    const actor = await profile(ctx, did);
    const first = await feed(ctx, did);
    const second = first.cursor ? await feed(ctx, did, first.cursor) : undefined;
    if (second?.cursor && second.cursor === first.cursor) throw new SourceError('Bluesky feed cursor did not advance');
    return { source: 'bluesky', available: true, did, profileResolved: actor.did === did, firstPageCount: first.feed.length, pagination: second ? 'verified' : 'no next cursor available', secondPageCount: second?.feed.length ?? 0, parameters: { limit: 100, filter: 'posts_with_replies', includePins: false }, metrics: 'public counters only; no impressions or clicks' };
  } catch (error) { return { source: 'bluesky', available: false, error: failure(error) }; }
}
