import type { Candidate, Context, EditorRequest, Evidence } from './contracts';
import { isoWeek } from './calendar';

const BUDGET=400_000;
const activeStates:Record<string,true>={Selected:true,Drafting:true,Review:true,Ready:true};

/** Context projections never replace durable candidates or consume unprovided evidence. */
function project(candidate:Candidate,sourceIds:string[]):Candidate{
 return {...candidate,sourceIds,readerQuestions:candidate.readerQuestions.slice(0,5),missingEvidence:candidate.missingEvidence.slice(0,8)};
}
export function triageRequest(ctx:Context,evidence:Evidence[]):Extract<EditorRequest,{kind:'triage'}>{
 const provided=new Set(evidence.map(item=>item.id));
 const terms=new Set(evidence.flatMap(item=>item.text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)??[]));
 const ranked=ctx.state.candidates().map(candidate=>({candidate,score:candidate.sourceIds.some(id=>provided.has(id))?10000:(activeStates[candidate.status??'']?1000:0)+(candidate.topic.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)??[]).filter(word=>terms.has(word)).length})).sort((a,b)=>b.score-a.score||b.candidate.createdAt.localeCompare(a.candidate.createdAt)||a.candidate.id.localeCompare(b.candidate.id));
 const candidates=ranked.slice(0,80).map(({candidate})=>project(candidate,[...new Set([...candidate.sourceIds.filter(id=>provided.has(id)),...candidate.sourceIds.slice(-12)])].slice(0,24)));
 const request:Extract<EditorRequest,{kind:'triage'}>={kind:'triage',evidence:[...evidence],candidates};
 while(JSON.stringify(request).length>BUDGET&&request.evidence.length)request.evidence.pop();
 if(!request.evidence.length&&evidence.length)throw new Error('One source evidence object exceeds the model request envelope');
 return request;
}
export function deskRequest(ctx:Context,metrics:unknown):Extract<EditorRequest,{kind:'desk'}>{
 const all=ctx.state.candidates().filter(candidate=>candidate.status!=='Parked'&&candidate.status!=='Published');
 const active=all.filter(candidate=>activeStates[candidate.status??'']);
 const buckets=['harmonic-analyzer','ai-engineering','side-projects'].map(pillar=>all.filter(candidate=>!activeStates[candidate.status??'']&&candidate.pillar===pillar).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)));
 const selected=[...active];let turn=0;
 while(selected.length<Math.max(active.length,12)&&buckets.some(bucket=>bucket.length)){const candidate=buckets[turn++%buckets.length]!.shift();if(candidate)selected.push(candidate)}
 const lookup=ctx.state.db.query('SELECT data FROM evidence WHERE id=?');
 const evidence=new Map<string,Evidence>();
 const priorCarries=ctx.state.get<Record<string,number>>(`desk:${isoWeek(new Date(ctx.now.getTime()-7*86400000),ctx.config.timezone)}:carry`,{});
 const candidates=selected.map(candidate=>{
  const sources=candidate.sourceIds.map(id=>{const row=lookup.get(id) as {data:string}|null;return row?JSON.parse(row.data) as Evidence:null}).filter((item):item is Evidence=>item!==null).sort((a,b)=>Number(b.sourceUrl!==null)-Number(a.sourceUrl!==null)||b.observedAt.localeCompare(a.observedAt)||a.id.localeCompare(b.id)).slice(0,4);
  for(const source of sources)evidence.set(source.id,source);
  const projected=project(candidate,sources.map(source=>source.id));
  if(activeStates[candidate.status??''])projected.carriedWeeks=(priorCarries[candidate.id]??0)+1;
  return projected;
 });
 const request:Extract<EditorRequest,{kind:'desk'}>={kind:'desk',candidates,evidence:[...evidence.values()],active:candidates.filter(candidate=>activeStates[candidate.status??'']),metrics};
 while(JSON.stringify(request).length>BUDGET&&request.candidates.length>request.active.length){request.candidates.pop();const ids=new Set(request.candidates.flatMap(candidate=>candidate.sourceIds));request.evidence=request.evidence.filter(item=>ids.has(item.id))}
 if(JSON.stringify(request).length>BUDGET)throw new Error('Active story context exceeds the bounded desk envelope; narrow active stories');
 return request;
}
