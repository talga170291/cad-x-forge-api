import type { Env } from './types.ts';
import { HttpError, int, like, now } from './util.ts';

const all = (env: Env, s: string, ...a: any[]) => env.DB.prepare(s).bind(...a).all().then((r: any) => r.results as any[]);
const one = (env: Env, s: string, ...a: any[]) => env.DB.prepare(s).bind(...a).first<any>();

export async function audit(env: Env, adminId: number, action: string, type: string, id: string | number, details?: any) {
  await env.DB.prepare('INSERT INTO admin_audit_log(admin_id,action,object_type,object_id,details,created_at) VALUES(?,?,?,?,?,?)')
    .bind(adminId, action, type, String(id), details === undefined ? null : JSON.stringify(details).slice(0, 2000), now()).run();
}
export const auditList = (env: Env) => all(env, 'SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 200');

function page(sp: URLSearchParams) { const limit = Math.min(100, Math.max(1, int(sp.get('limit'), 20))); const p = Math.max(1, int(sp.get('page'), 1)); return { limit, p, off: (p - 1) * limit }; }

export async function adminOrders(env: Env, sp: URLSearchParams) {
  const { limit, p, off } = page(sp); const w: string[] = []; const a: any[] = [];
  if (sp.get('status')) { w.push('o.status=?'); a.push(sp.get('status')); }
  const q = (sp.get('q') || '').trim();
  if (q) { w.push("(o.number LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\' OR CAST(u.id AS TEXT)=?)"); a.push(like(q), like(q), like(q), q); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = (await one(env, `SELECT COUNT(*) n FROM orders o JOIN users u ON u.id=o.user_id ${where}`, ...a)).n;
  const rows = await all(env, `SELECT o.id,o.number,o.status,o.total_stars,o.currency,o.created_at,o.paid_at,u.id user_id,u.username,u.first_name FROM orders o JOIN users u ON u.id=o.user_id ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...a, limit, off);
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const it = await all(env, `SELECT order_id,product_id,title,sku,price_stars FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const r of rows) r.items = it.filter((x) => x.order_id === r.id);
  }
  return { items: rows, total, page: p, limit };
}
export async function adminOrder(env: Env, id: number) {
  const o = await one(env, 'SELECT o.*,u.username,u.first_name,u.last_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?', id);
  if (!o) throw new HttpError(404, 'not_found');
  o.items = await all(env, `SELECT oi.product_id,oi.title,oi.sku,oi.price_stars,s.label size,h.label height FROM order_items oi LEFT JOIN sizes s ON s.id=oi.size_id LEFT JOIN heights h ON h.id=oi.height_id WHERE oi.order_id=?`, id);
  o.payments = await all(env, 'SELECT id,telegram_charge_id,amount,currency,status,created_at FROM payments WHERE order_id=?', id);
  return o;
}
export async function customers(env: Env, sp: URLSearchParams) {
  const { limit, p, off } = page(sp); const q = (sp.get('q') || '').trim(); const a: any[] = [];
  let where = '';
  if (q) { where = "WHERE (u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\' OR CAST(u.id AS TEXT)=?)"; a.push(like(q), like(q), q); }
  const total = (await one(env, `SELECT COUNT(*) n FROM users u ${where}`, ...a)).n;
  const rows = await all(env, `SELECT u.id,u.username,u.first_name,u.last_name,u.lang,u.created_at,u.last_seen_at,
    (SELECT COUNT(*) FROM purchases pu WHERE pu.user_id=u.id AND pu.revoked_at IS NULL) purchases,
    (SELECT COALESCE(SUM(o.total_stars),0) FROM orders o WHERE o.user_id=u.id AND o.status='paid') spent_stars
    FROM users u ${where} ORDER BY u.last_seen_at DESC LIMIT ? OFFSET ?`, ...a, limit, off);
  return { items: rows, total, page: p, limit };
}
export async function stats(env: Env) {
  const [products, orders, sales, users, recent, daily] = await Promise.all([
    all(env, 'SELECT status,COUNT(*) n FROM products GROUP BY status'),
    all(env, 'SELECT status,COUNT(*) n FROM orders GROUP BY status'),
    one(env, "SELECT COALESCE(SUM(total_stars),0) stars,COUNT(*) orders FROM orders WHERE status='paid'"),
    one(env, 'SELECT COUNT(*) n FROM users'),
    all(env, 'SELECT o.number,o.status,o.total_stars,o.created_at,u.username,u.first_name FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 10'),
    all(env, "SELECT date(paid_at,'unixepoch') day,COUNT(*) orders,SUM(total_stars) stars FROM orders WHERE status='paid' AND paid_at>? GROUP BY day ORDER BY day", now() - 14 * 86400),
  ]);
  const by = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { products: by(products), orders: by(orders), sales_stars: sales.stars, paid_orders: sales.orders, users: users.n, recent_orders: recent, daily };
}
