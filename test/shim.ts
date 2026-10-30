// Имитация Cloudflare D1 (поверх настоящей SQLite) и R2 для автотестов.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

class Stmt {
  db: any; sql: string; p: any[];
  constructor(db: any, sql: string, p: any[] = []) { this.db = db; this.sql = sql; this.p = p; }
  bind(...p: any[]) {
    for (const x of p) if (x === undefined || typeof x === 'boolean') throw new Error('bad bind value: ' + String(x));
    return new Stmt(this.db, this.sql, p);
  }
  returnsRows() { return /^\s*(SELECT|WITH)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql); }
  exec() {
    const s = this.db.prepare(this.sql);
    if (this.returnsRows()) return { results: s.all(...this.p), success: true, meta: { changes: 0 } };
    const r = s.run(...this.p);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first() { const r = this.exec().results as any[]; return r[0] ?? null; }
  async all() { return this.exec(); }
  async run() { return this.exec(); }
}
export function makeDB(migDir: string) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(migDir + '/' + f, 'utf8'));
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s.exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
export function makeR2() {
  const m = new Map<string, { buf: ArrayBuffer; meta: any }>();
  return {
    m,
    async put(k: string, v: any, o: any = {}) { m.set(k, { buf: typeof v === 'string' ? new TextEncoder().encode(v).buffer as ArrayBuffer : v, meta: o }); },
    async get(k: string) { const e = m.get(k); if (!e) return null; return { key: k, size: e.buf.byteLength, body: new Response(e.buf).body!, httpMetadata: e.meta.httpMetadata }; },
    async delete(k: any) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list() { return { objects: [...m.keys()].map((key) => ({ key })) }; },
  };
}
