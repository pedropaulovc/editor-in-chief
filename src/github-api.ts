export class ApiError extends Error {constructor(readonly endpoint:string,readonly status:number){super(`GitHub ${endpoint.split('?')[0]}: HTTP ${status}`)}}
export async function gh<T=any>(endpoint:string,options:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<T>{
 const method=options.method??'GET';
 for(let attempt=0;;attempt++){
  if(options.signal?.aborted)throw new Error('Request deadline exceeded');
  const args=['gh','api',endpoint,'--method',method,'-H','Accept: application/vnd.github+json'];
  if(options.body!==undefined)args.push('--input','-');
  const proc=Bun.spawn(args,{stdin:options.body===undefined?'ignore':new Blob([JSON.stringify(options.body)]),stdout:'pipe',stderr:'pipe',env:process.env});
  const abort=()=>proc.kill();options.signal?.addEventListener('abort',abort,{once:true});
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);options.signal?.removeEventListener('abort',abort);
  if(code===0){if(!out.trim())return undefined as T;return JSON.parse(out)}
  const status=Number(err.match(/HTTP (\d+)/)?.[1]??0);
  if(method==='GET'&&attempt<2&&(status===429||status>=500)){await Bun.sleep(1000*2**attempt);continue}
  throw new ApiError(endpoint,status);
 }
}
export async function graphql<T=any>(query:string,variables:Record<string,unknown>={},signal?:AbortSignal):Promise<T>{const result=await gh<any>('graphql',{method:'POST',body:{query,variables},signal});if(result.errors?.length)throw new Error('GitHub GraphQL operation rejected');return result.data}
export async function pages<T=any>(endpoint:string,signal?:AbortSignal,maxPages=100):Promise<T[]>{let all:T[]=[];for(let page=1;page<=maxPages;page++){const chunk=await gh<T[]>(`${endpoint}${endpoint.includes('?')?'&':'?'}per_page=100&page=${page}`,{signal});all.push(...chunk);if(chunk.length<100)return all}throw new Error(`Pagination bound reached: ${endpoint.split('?')[0]}`)}
