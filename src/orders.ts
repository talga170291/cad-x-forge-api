import type { Ctx, Env } from './types.ts';
import { HttpError, int, json, now, hmac, b64u, unb64u, safeEq, log } from './util.ts';
import { authenticate, adminIds, upsertUser } from './auth.ts';
import { tg, TXT, pickLang, send } from './tg.ts';
import { imgUrl, getSettings } from './catalog.ts';

const all = (env: Env, s: string, ...a: any[]) => env.DB.prepare(s).bind(...a).all().then((r: any) => r.results as any[]);
const one = (env: Env, s: string, ...a: any[]) => env.DB.prepare(s).bind(...a).first<any>();

async function orderNumber(env: Env) {
  const y = new Date().getUTCFullYear();
  const r = await one(env, 'INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1 RETURNING value', 'order_' + y);
  return `CFX-${y}-${String(r.value).padStart(6, '0')}`;
}

// Цена и состав считаются ТОЛЬКО на сервере: суммы и цены из запроса игнорируются.
export async function checkout(c: Ctx) {
  const u = await authenticate(c, true);
  const settings = await getSettings(c.env);
  if (settings.maintenance) throw new HttpError(503, 'maintenance');
  const body: any = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 20) throw new HttpError(400, 'validation', { field: 'items' });
  const want = new Map<number, { size: number | null; height: number | null }>();
  for (const it of body.items) {
    const id = int(it?.product_id ?? it?.id, 0);
    if (id <= 0) throw new HttpError(400, 'validation', { field: 'items' });
    if (!want.has(id)) want.set(id, { size: int(it?.size_id, 0) || null, height: int(it?.height_id, 0) || null });
  }
  const ids = [...want.keys()]; const ph = ids.map(() => '?').join(',');
  const prods = await all(c.env, `SELECT id,sku,name_ru,name_en,price_stars,status FROM products WHERE id IN (${ph})`, ...ids);
  const unavailable = ids.filter((id) => { const p = prods.find((x) => x.id === id); return !p || p.status !== 'published' || p.price_stars < 1; });
  const owned = (await all(c.env, `SELECT product_id FROM purchases WHERE user_id=? AND revoked_at IS NULL AND product_id IN (${ph})`, u.id, ...ids)).map((x) => x.product_id);
  if (unavailable.length || owned.length) throw new HttpError(409, 'items_unavailable', { unavailable, owned });
  for (const [id, v] of want) {
    if (v.size && !(await one(c.env, 'SELECT 1 x FROM product_sizes WHERE product_id=? AND size_id=?', id, v.size))) throw new HttpError(400, 'invalid_size');
    if (v.height && !(await one(c.env, 'SELECT 1 x FROM product_heights WHERE product_id=? AND height_id=?', id, v.height))) throw new HttpError(400, 'invalid_height');
  }
  const t = now();
  if ((await one(c.env, "SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='pending' AND created_at>?", u.id, t - 3600)).n >= 10) throw new HttpError(429, 'too_many_orders');
  const total = prods.reduce((s, p) => s + p.price_stars, 0);
  const number = await orderNumber(c.env);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO orders(number,user_id,status,total_stars,currency,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(number, u.id, 'pending', total, 'XTR', t, t + 3600, t),
    ...prods.map((p) => c.env.DB.prepare('INSERT INTO order_items(order_id,product_id,title,sku,price_stars,size_id,height_id) VALUES((SELECT id FROM orders WHERE number=?),?,?,?,?,?,?)')
      .bind(number, p.id, p.name_en || p.name_ru, p.sku, p.price_stars, want.get(p.id)!.size, want.get(p.id)!.height)),
  ]);
  let link: string;
  try {
    link = await tg(c.env, 'createInvoiceLink', {
      title: `CAD x FORGE · ${number}`, description: prods.map((p) => p.name_en || p.name_ru).join(', ').slice(0, 250),
      payload: number, currency: 'XTR', prices: [{ label: number, amount: total }],
    });
  } catch (e) {
    await c.env.DB.prepare("UPDATE orders SET status='failed',updated_at=? WHERE number=?").bind(now(), number).run();
    throw e;
  }
  log('order_created', { number, user: u.id, total });
  return json({ order: { number, status: 'pending', total_stars: total, currency: 'XTR' }, invoice_link: link }, 201);
}

export async function orderStatus(c: Ctx) {
  const u = await authenticate(c);
  const o = await one(c.env, 'SELECT number,status,total_stars,currency,paid_at FROM orders WHERE number=? AND user_id=?', c.params[0], u.id);
  if (!o) throw new HttpError(404, 'not_found');
  return json(o);
}

// ---------- Telegram webhook ----------
export async function webhook(c: Ctx) {
  const sec = c.req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!c.env.WEBHOOK_SECRET || !safeEq(sec, c.env.WEBHOOK_SECRET)) throw new HttpError(401, 'bad_secret');
  const upd: any = await c.req.json().catch(() => null);
  if (!upd || typeof upd !== 'object') throw new HttpError(400, 'validation');
  try {
    if (upd.pre_checkout_query) await preCheckout(c.env, upd.pre_checkout_query);
    else if (upd.message?.successful_payment) await paid(c.env, upd.message);
    else if (typeof upd.message?.text === 'string') await command(c.env, upd.message);
  } catch (e: any) {
    log('webhook_error', { err: String(e?.message || e), update_id: upd.update_id });
    if (upd.message?.successful_payment) return json({ ok: false }, 500); // Telegram повторит доставку; обработка идемпотентна
  }
  return json({ ok: true });
}

async function preCheckout(env: Env, q: any) {
  let err: string | null = null;
  try {
    const o = await one(env, 'SELECT * FROM orders WHERE number=?', String(q.invoice_payload));
    if (!o) err = 'Order not found';
    else if (o.user_id !== q.from?.id) err = 'Order belongs to another user';
    else if (o.status !== 'pending') err = 'Order is not payable';
    else if (o.expires_at < now()) err = 'Order expired';
    else if (q.currency !== 'XTR' || q.total_amount !== o.total_stars) err = 'Amount mismatch';
    else if (await one(env, `SELECT 1 x FROM order_items oi JOIN products p ON p.id=oi.product_id
      LEFT JOIN purchases pu ON pu.product_id=oi.product_id AND pu.user_id=? AND pu.revoked_at IS NULL
      WHERE oi.order_id=? AND (p.status!='published' OR pu.id IS NOT NULL OR p.price_stars!=oi.price_stars) LIMIT 1`, o.user_id, o.id)) err = 'Product unavailable or price changed';
  } catch (e) { log('precheckout_error', { err: String(e) }); err = 'Temporary error, try again'; }
  await tg(env, 'answerPreCheckoutQuery', err ? { pre_checkout_query_id: q.id, ok: false, error_message: err } : { pre_checkout_query_id: q.id, ok: true });
  log('pre_checkout', { payload: q.invoice_payload, ok: !err, err });
}

async function notifyAdmins(env: Env, text: string) {
  for (const id of adminIds(env)) { try { await send(env, id, text); } catch (e) { log('notify_fail', { id }); } }
}

async function paid(env: Env, msg: any) {
  const sp = msg.successful_payment; const uid = msg.from?.id; const t = now();
  const charge = String(sp.telegram_payment_charge_id || ''); if (!charge) throw new Error('no charge id');
  const o = await one(env, 'SELECT * FROM orders WHERE number=?', String(sp.invoice_payload));
  const raw = JSON.stringify(sp);
  const record = (status: string) => env.DB.prepare('INSERT OR IGNORE INTO payments(order_id,telegram_charge_id,provider_charge_id,amount,currency,status,raw,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(o?.id ?? null, charge, sp.provider_payment_charge_id ?? null, int(sp.total_amount, 0), String(sp.currency), status, raw, t);
  let bad: string | null = null;
  if (!o) bad = 'orphan';
  else if (o.user_id !== uid || o.total_stars !== sp.total_amount || sp.currency !== 'XTR') bad = 'mismatch';
  else if (await one(env, "SELECT 1 x FROM payments WHERE order_id=? AND status='succeeded' AND telegram_charge_id!=?", o.id, charge)) bad = 'mismatch'; // двойная оплата одного заказа
  if (bad) {
    const r: any = await record(bad).run();
    if (r.meta?.changes) await notifyAdmins(env, `⚠️ Платёж требует проверки (${bad}): ${sp.total_amount} ${sp.currency}, заказ ${sp.invoice_payload}, пользователь ${uid}, charge ${charge}. Доступ не выдан; при необходимости оформите возврат.`);
    log('payment_anomaly', { bad, order: sp.invoice_payload, charge });
    return;
  }
  const res = await env.DB.batch([
    record('succeeded'),
    env.DB.prepare("UPDATE orders SET status='paid',paid_at=COALESCE(paid_at,?),updated_at=? WHERE id=? AND status IN ('pending','cancelled','failed')").bind(t, t, o.id),
    env.DB.prepare(`INSERT INTO purchases(user_id,product_id,order_id,created_at) SELECT o.user_id,oi.product_id,o.id,? FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE o.id=? AND o.status='paid' AND NOT EXISTS(SELECT 1 FROM purchases x WHERE x.user_id=o.user_id AND x.product_id=oi.product_id AND x.order_id=o.id AND x.revoked_at IS NULL)
      ON CONFLICT(user_id,product_id) DO UPDATE SET revoked_at=NULL,order_id=excluded.order_id,created_at=excluded.created_at`).bind(t, o.id),
  ]);
  if (res[0].meta?.changes !== 1) { log('payment_duplicate', { charge }); return; }
  log('payment_ok', { order: o.number, user: uid, amount: o.total_stars });
  try {
    const user = await one(env, 'SELECT lang FROM users WHERE id=?', uid);
    const lang = pickLang(user?.lang || msg.from?.language_code);
    const st = await getSettings(env);
    await send(env, uid, st.msg_paid?.[lang] || TXT[lang].paid, env.WEBAPP_URL + '?tab=purchases', TXT[lang].purchases);
  } catch { log('notify_user_failed', { order: o.number }); }
}

async function command(env: Env, msg: any) {
  const text = String(msg.text).split(/[\s@]/)[0]; const uid = msg.from?.id; if (!uid) return;
  const user = await one(env, 'SELECT lang FROM users WHERE id=?', uid);
  const lang = pickLang(user?.lang || msg.from?.language_code);
  const st = await getSettings(env);
  if (text === '/start' || text === '/help') { await upsertUser(env, msg.from); await send(env, uid, st.msg_welcome?.[lang] || TXT[lang].welcome, env.WEBAPP_URL, TXT[lang].open); }
  else if (text === '/paysupport') await send(env, uid, TXT[lang].pay + (st.support_username ? ' ' + st.support_username : ''));
  else if (text === '/admin') { if (adminIds(env).has(uid)) await send(env, uid, TXT[lang].admin, env.ADMIN_URL, TXT[lang].admin); else await send(env, uid, TXT[lang].notadmin); }
}

// ---------- покупки и выдача файлов ----------
export async function myPurchases(c: Ctx) {
  const u = await authenticate(c, true);
  const rows = await all(c.env, `SELECT pu.id,pu.created_at,o.number order_number,o.status order_status,o.paid_at,p.id product_id,p.sku,p.slug,p.name_ru,p.name_kk,p.name_en,p.status product_status,
    COALESCE(oi.price_stars,p.price_stars) price_stars,
    (SELECT i.storage_key FROM product_images i WHERE i.product_id=p.id ORDER BY (i.kind='main') DESC,i.sort,i.id LIMIT 1) image_key
    FROM purchases pu JOIN products p ON p.id=pu.product_id JOIN orders o ON o.id=pu.order_id LEFT JOIN order_items oi ON oi.order_id=o.id AND oi.product_id=p.id
    WHERE pu.user_id=? AND pu.revoked_at IS NULL ORDER BY pu.created_at DESC,pu.id DESC`, u.id);
  if (rows.length) {
    const ids = rows.map((r) => r.product_id);
    const files = await all(c.env, `SELECT id,product_id,format,filename,size,version FROM product_files WHERE active=1 AND product_id IN (${ids.map(() => '?').join(',')}) ORDER BY format`, ...ids);
    for (const r of rows) { r.image = imgUrl(r.image_key); delete r.image_key; r.files = files.filter((f) => f.product_id === r.product_id); }
  }
  return json({ items: rows });
}

const ttl = (env: Env) => Math.min(900, Math.max(30, int(env.LINK_TTL_SECONDS, 120)));
const sign = async (env: Env, p: string) => b64u(await hmac(env.DOWNLOAD_SIGNING_KEY, p));

export async function issueLink(c: Ctx) {
  const u = await authenticate(c, true);
  const f = await one(c.env, 'SELECT id,product_id,filename FROM product_files WHERE id=? AND active=1', int(c.params[0], 0));
  if (!f) throw new HttpError(404, 'file_unavailable');
  if (!(await one(c.env, 'SELECT 1 x FROM purchases WHERE user_id=? AND product_id=? AND revoked_at IS NULL', u.id, f.product_id))) throw new HttpError(403, 'not_purchased');
  if ((await one(c.env, "SELECT COUNT(*) n FROM download_logs WHERE user_id=? AND kind='link' AND created_at>?", u.id, now() - 60)).n >= 20) throw new HttpError(429, 'rate_limited');
  await c.env.DB.prepare("INSERT INTO download_logs(user_id,file_id,kind,created_at) VALUES(?,?,'link',?)").bind(u.id, f.id, now()).run();
  const ex = ttl(c.env);
  const p = b64u(JSON.stringify({ f: f.id, u: u.id, e: now() + ex }));
  return json({ url: `${c.url.origin}/api/dl/${p}.${await sign(c.env, p)}`, expires_in: ex, filename: f.filename });
}

export async function serveDownload(c: Ctx) {
  const [p, s] = c.params[0].split('.');
  if (!p || !s || !safeEq(await sign(c.env, p), s)) throw new HttpError(403, 'invalid_link');
  let d: any; try { d = JSON.parse(new TextDecoder().decode(unb64u(p))); } catch { throw new HttpError(403, 'invalid_link'); }
  if (!Number.isInteger(d?.f) || !Number.isInteger(d?.u)) throw new HttpError(403, 'invalid_link');
  if (d.e < now()) throw new HttpError(410, 'link_expired');
  const f = await one(c.env, 'SELECT * FROM product_files WHERE id=?', d.f);
  if (!f) throw new HttpError(404, 'file_unavailable');
  if (!(await one(c.env, 'SELECT 1 x FROM purchases WHERE user_id=? AND product_id=? AND revoked_at IS NULL', d.u, f.product_id))) throw new HttpError(403, 'not_purchased');
  const o = await c.env.FILES.get(f.storage_key);
  if (!o) throw new HttpError(404, 'file_unavailable');
  await c.env.DB.prepare("INSERT INTO download_logs(user_id,file_id,kind,created_at) VALUES(?,?,'download',?)").bind(d.u, f.id, now()).run();
  const ascii = f.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(o.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(f.size), 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export async function refund(c: Ctx, orderId: number) {
  const o = await one(c.env, 'SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'not_found');
  if (o.status !== 'paid') throw new HttpError(409, 'not_refundable');
  const pay = await one(c.env, "SELECT * FROM payments WHERE order_id=? AND status='succeeded'", o.id);
  if (!pay) throw new HttpError(409, 'not_refundable');
  await tg(c.env, 'refundStarPayment', { user_id: o.user_id, telegram_payment_charge_id: pay.telegram_charge_id });
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE orders SET status='refunded',updated_at=? WHERE id=?").bind(t, o.id),
    c.env.DB.prepare("UPDATE payments SET status='refunded' WHERE id=?").bind(pay.id),
    c.env.DB.prepare('UPDATE purchases SET revoked_at=? WHERE order_id=? AND revoked_at IS NULL').bind(t, o.id),
  ]);
  return { number: o.number, status: 'refunded' };
}
