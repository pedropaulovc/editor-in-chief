export class ApiError extends Error {
 constructor(readonly endpoint:string,readonly status:number){super(`GitHub ${endpoint.split('?')[0]}: HTTP ${status}`)}
}
interface ResponseData<T>{data:T;headers:Record<string,string>}
export async function ghResponse<T=any>(endpoint:string,options:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<ResponseData<T>>{
 const method=options.method??'GET';
 for(let attempt=0;;attempt++){
  if(options.signal?.aborted)throw new Error('Request deadline exceeded');
  const args=['gh','api',endpoint,'--include','--method',method,'-H','Accept: application/vnd.github+json'];
  if(options.body!==undefined)args.push('--input','-');
  const proc=Bun.spawn(args,{stdin:options.body===undefined?'ignore':new Blob([JSON.stringify(options.body)]),stdout:'pipe',stderr:'pipe',env:process.env});
  const abort=()=>proc.kill();options.signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,45000);timeout.unref();
  let out:string,err:string,code:number;
  try{[out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited])}finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort)}
  const split=out.search(/\r?\n\r?\n/),headerText=split<0?'':out.slice(0,split),body=split<0?out:out.slice(split).replace(/^\r?\n\r?\n/,'');
  const headers:Record<string,string>={};for(const line of headerText.split(/\r?\n/)){const colon=line.indexOf(':');if(colon>0)headers[line.slice(0,colon).toLowerCase()]=line.slice(colon+1).trim()}
  const status=Number(headerText.match(/^HTTP\/\S+ (\d+)/)?.[1]??err.match(/HTTP (\d+)/)?.[1]??0);
  if(code===0)return {data:body.trim()?JSON.parse(body):undefined as T,headers};
  const rateLimited=status===429||(status===403&&(headers['x-ratelimit-remaining']==='0'||headers['retry-after']!==undefined));
  if(method==='GET'&&attempt<2&&(rateLimited||status>=500)){
   const retry=headers['retry-after'];
   const retryMs=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):headers['x-ratelimit-remaining']==='0'?(Number(headers['x-ratelimit-reset'])*1000-Date.now()):1000*2**attempt;
   if(retryMs>60000)throw new ApiError(endpoint,status);
   await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('Request deadline exceeded'))};const timer=setTimeout(()=>{options.signal?.removeEventListener('abort',abort);resolve()},Math.max(1000,retryMs));options.signal?.addEventListener('abort',abort,{once:true})});continue;
  }
  throw new ApiError(endpoint,status);
 }
}
export async function gh<T=any>(endpoint:string,options:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<T>{return (await ghResponse<T>(endpoint,options)).data}
export async function graphql<T=any>(query:string,variables:Record<string,unknown>={},signal?:AbortSignal):Promise<T>{const result=await gh<any>('graphql',{method:'POST',body:{query,variables},signal});if(result.errors?.length)throw new Error('GitHub GraphQL operation rejected');return result.data}
export async function pages<T=any>(endpoint:string,signal?:AbortSignal,maxPages=100):Promise<T[]>{
 const all:T[]=[];let next:string|undefined=`${endpoint}${endpoint.includes('?')?'&':'?'}per_page=100`;
 for(let page=1;next&&page<=maxPages;page++){
  const response:ResponseData<T[]>=await ghResponse<T[]>(next,{signal});if(!Array.isArray(response.data))throw new Error('GitHub paginated endpoint returned non-array');all.push(...response.data);
  const url:string|undefined=response.headers.link?.split(',').find(part=>/rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
  if(url){const parsed:URL=new URL(url);if(parsed.origin!=='https://api.github.com')throw new Error('Unexpected GitHub pagination host');next=parsed.pathname.slice(1)+parsed.search}else next=undefined;
 }
 if(next)throw new Error(`Pagination bound reached: ${endpoint.split('?')[0]}`);return all;
}
