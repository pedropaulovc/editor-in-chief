import { z } from 'zod';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
export const ConfigSchema = z.object({
 githubOwner:z.string().min(1),repository:z.string().regex(/^[\w.-]+\/[\w.-]+$/),blueskyHandle:z.string().min(1),
 hindsightUrl:z.literal('https://hindsight.vza.net'),hindsightEnvFile:z.string(),timezone:z.literal('America/Los_Angeles'),
 cadence:z.enum(['weekly','twice-weekly','paused']),model:z.string().min(1),thinking:z.enum(['min','low','medium','high','xhigh'])
}).strict();
export type Config=z.infer<typeof ConfigSchema>;
export function expandPath(path:string){return resolve(path.startsWith('~/')?homedir()+path.slice(1):path)}
export function stateDirectory(path?:string){return expandPath(path ?? `${process.env.XDG_STATE_HOME ?? homedir()+'/.local/state'}/editor-in-chief`)}
export async function loadConfig(path='editorial.config.json'):Promise<Config>{return ConfigSchema.parse(await Bun.file(expandPath(path)).json())}
