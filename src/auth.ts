import type { Ctx, Env, TgUser } from './types.ts';
import { HttpError, hmac, hex, safeEq, now, int } from './util.ts';

// Проверка подписи Telegram WebApp initData по официальному алгоритму.
export async function verifyInitData(initData: string, botToken: string, maxAge: number, at = now()): Promise<TgUser> {
  if (!initData || initData.length > 4096) throw new HttpError(401, 'invalid_init_data');
  const p = new URLSearchParams(initData);
  const h = p.get('hash');
  if (!h) throw new HttpError(401, 'invalid_init_data');
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  if (!safeEq(hex(await hmac(secret, dcs)), h.toLowerCase())) throw new HttpError(401, 'invalid_init_data');
  const ad = int(p.get('auth_date'), 0);
  if (!ad || at - ad > maxAge) throw new HttpError(401, 'init_data_expired');
  if (ad - at > 300) throw new HttpError(401, 'invalid_init_data');
  let user: any;
  try { user = JSON.parse(p.get('user') || ''); } catch { throw new HttpError(401, 'invalid_init_data'); }
  if (!user || !Number.isInteger(user.id) || user.id <= 0) throw new HttpError(401, 'invalid_init_data');
  return user;
}

export const adminIds = (env: Env) => new Set((env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));

export async function authenticate(c: Ctx, touch = false): Promise<TgUser> {
  if (c.user) return c.user;
  const a = c.req.headers.get('authorization') || '';
  if (!a.startsWith('tma ')) throw new HttpError(401, 'unauthorized');
  const u = await verifyInitData(a.slice(4), c.env.BOT_TOKEN, int(c.env.INITDATA_MAX_AGE, 86400));
  c.user = u; c.isAdmin = adminIds(c.env).has(u.id);
  if (touch) await upsertUser(c.env, u);
  return u;
}
export async function requireAdmin(c: Ctx) {
  const u = await authenticate(c);
  if (!c.isAdmin) throw new HttpError(403, 'forbidden');
  return u;
}
const mapLang = (l?: string) => (l && /^(ru|kk|en)/.test(l) ? l.slice(0, 2) : null);
export async function upsertUser(env: Env, u: TgUser) {
  const t = now();
  await env.DB.prepare(
    'INSERT INTO users(id,username,first_name,last_name,lang,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,last_seen_at=excluded.last_seen_at'
  ).bind(u.id, u.username ?? null, u.first_name ?? null, u.last_name ?? null, mapLang(u.language_code), t, t).run();
}
