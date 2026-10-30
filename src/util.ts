export class HttpError extends Error {
  status: number; code: string; extra: any;
  constructor(status: number, code: string, extra?: any) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const enc = new TextEncoder();
export const now = () => Math.floor(Date.now() / 1000);
export const int = (v: any, d = 0) => { const n = Number(v); return v !== null && v !== '' && Number.isInteger(n) ? n : d; };
export function json(data: any, status = 200, h: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...h } });
}
export function b64u(x: ArrayBuffer | Uint8Array | string) {
  const b = typeof x === 'string' ? enc.encode(x) : x instanceof Uint8Array ? x : new Uint8Array(x);
  let s = ''; for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const r = atob(s); const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o;
}
export async function hmac(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false; let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
export async function sha256(buf: ArrayBuffer) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))); }
export function log(ev: string, d: Record<string, any> = {}) { console.log(JSON.stringify({ ev, t: new Date().toISOString(), ...d })); }
export function slugify(s: string) { return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
export function cleanFilename(n: string) {
  n = (n || 'file').split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().replace(/\s+/g, '_').slice(0, 120);
  return n || 'file';
}
export const like = (s: string) => '%' + s.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
