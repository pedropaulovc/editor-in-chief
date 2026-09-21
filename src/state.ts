import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, Candidate, Publication } from './contracts';
export class State {
 readonly db:Database; readonly directory:string;
 constructor(directory:string){this.directory=directory;mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);const path=join(directory,'state.sqlite');this.db=new Database(path,{create:true});chmodSync(path,0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,revision TEXT NOT NULL,source TEXT NOT NULL,observed_at TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS outbox(key TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS publications(key TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metrics(key TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metric_audit(id INTEGER PRIMARY KEY,data TEXT NOT NULL,changed_at TEXT NOT NULL);
 `)}
 get<T>(key:string,fallback:T):T {const row=this.db.query('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|null;return row?JSON.parse(row.value):fallback}
 set(key:string,value:unknown){this.db.query('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))}
 delete(key:string){this.db.query('DELETE FROM kv WHERE key=?').run(key)}
 putEvidence(items:Evidence[]):number {let changed=0;this.db.transaction(()=>{for(const e of items){const old=this.db.query('SELECT revision FROM evidence WHERE id=?').get(e.id) as {revision:string}|null;if(old?.revision===e.revision)continue;this.db.query('INSERT INTO evidence VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, observed_at=excluded.observed_at,data=excluded.data').run(e.id,e.revision,e.source,e.observedAt,JSON.stringify(e));changed++}})();return changed}
 evidence(limit=500):Evidence[]{return (this.db.query('SELECT data FROM evidence ORDER BY observed_at DESC LIMIT ?').all(limit) as {data:string}[]).map(r=>JSON.parse(r.data))}
 candidates():Candidate[]{return (this.db.query('SELECT data FROM candidates').all() as {data:string}[]).map(r=>JSON.parse(r.data))}
 putCandidate(c:Candidate){this.db.query('INSERT INTO candidates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.id,JSON.stringify(c))}
 publications():Publication[]{return (this.db.query('SELECT data FROM publications').all() as {data:string}[]).map(r=>JSON.parse(r.data))}
 close(){this.db.close()}
}
