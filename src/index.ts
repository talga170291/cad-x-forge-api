import type { Ctx, Env } from './types.ts';
import { HttpError, int, json, log, now } from './util.ts';
import { authenticate, requireAdmin } from './auth.ts';
import * as cat from './catalog.ts';
import * as up from './uploads.ts';
import * as ord from './orders.ts';
import * as adm from './admin.ts';
import { tg } from './tg.ts';

type H = (c: Ctx) => Promise<Response>;
const routes: [string, RegExp, H][] = [];
const add = (m: string, p: string, h: H) => routes.push([m, new RegExp('^' + p.replace(/:\w+/g, '([^/]+)').replace('*', '(.+)') + '$'), h]);
const A = (h: H): H => async (c) => { await requireAdmin(c); return h(c); };
const body = (c: Ctx) => c.req.json().catch(() => { throw new HttpError(400, 'validation'); });
const dictName = (c: Ctx) => { if (!cat.DICTS[c.params[0]]) throw new HttpError(404, 'not_found'); return c.params[0]; };

add('GET', '/health', async (c) => {
  let db = false, r2 = false;
  try { await c.env.DB.prepare('SELECT 1').first(); db = true; } catch { /* */ }
  try { await c.env.FILES.list({ limit: 1 }); r2 = true; } catch { /* */ }
  return json({ ok: db && r2, db, r2, time: new Date().toISOString() }, db && r2 ? 200 : 503);
});
// ----- публичный каталог -----
add('GET', '/api/bootstrap', async (c) => json(await cat.bootstrap(c.env)));
for (const k of ['categories', 'audiences', 'sizes', 'heights', 'tags', 'attributes'])
  add('GET', '/api/' + k, async (c) => json((await cat.bootstrap(c.env) as any)[k]));
add('GET', '/api/facets', async (c) => json(await cat.facets(c.env)));
add('GET', '/api/products', async (c) => json(await cat.listProducts(c.env, c.url.searchParams)));
add('GET', '/api/products/:id', async (c) => { const p = await cat.productDetail(c.env, c.params[0]); if (!p) throw new HttpError(404, 'not_found'); return json(p); });
add('GET', '/api/img/*', up.serveImage);
// ----- покупатель -----
add('GET', '/api/me', async (c) => {
  const u = await authenticate(c, true);
  const row = await c.env.DB.prepare('SELECT id,username,first_name,last_name,lang,created_at FROM users WHERE id=?').bind(u.id).first();
  return json({ user: row, is_admin: !!c.isAdmin });
});
add('PATCH', '/api/me', async (c) => {
  const u = await authenticate(c, true); const b: any = await body(c);
  if (!['ru', 'kk', 'en'].includes(b.lang)) throw new HttpError(400, 'validation', { field: 'lang' });
  await c.env.DB.prepare('UPDATE users SET lang=? WHERE id=?').bind(b.lang, u.id).run();
  return json({ lang: b.lang });
});
add('GET', '/api/me/purchases', ord.myPurchases);
add('GET', '/api/me/purchases/:id', async (c) => {
  const r: any = await (await ord.myPurchases(c)).json();
  const it = r.items.find((x: any) => x.product_id === int(c.params[0], 0));
  if (!it) throw new HttpError(404, 'not_found'); return json(it);
});
add('POST', '/api/me/files/:id/link', ord.issueLink);
add('GET', '/api/dl/:token', ord.serveDownload);
add('POST', '/api/cart/checkout', ord.checkout);
add('GET', '/api/orders/:number', ord.orderStatus);
add('POST', '/api/telegram/webhook', ord.webhook);
// ----- админ -----
add('GET', '/api/admin/dict/:name', A(async (c) => json({ items: await cat.dictList(c.env, dictName(c)) })));
add('POST', '/api/admin/dict/:name', A(async (c) => { const n = dictName(c); const r: any = await cat.dictSave(c.env, n, await body(c)); await adm.audit(c.env, c.user!.id, 'create', n, r?.id ?? r?.code); return json(r, 201); }));
add('PUT', '/api/admin/dict/:name/:id', A(async (c) => { const n = dictName(c); const r = await cat.dictSave(c.env, n, await body(c), c.params[1]); await adm.audit(c.env, c.user!.id, 'update', n, c.params[1]); return json(r); }));
add('DELETE', '/api/admin/dict/:name/:id', A(async (c) => { const n = dictName(c); await cat.dictDelete(c.env, n, c.params[1]); await adm.audit(c.env, c.user!.id, 'delete', n, c.params[1]); return json({ deleted: true }); }));
add('GET', '/api/admin/products', A(async (c) => json(await cat.listProducts(c.env, c.url.searchParams, true))));
add('GET', '/api/admin/products/:id', A(async (c) => { const p = await cat.productDetail(c.env, c.params[0], true); if (!p) throw new HttpError(404, 'not_found'); return json(p); }));
add('POST', '/api/admin/products', A(async (c) => { const p: any = await cat.saveProduct(c.env, await body(c)); await adm.audit(c.env, c.user!.id, 'create', 'product', p.id, { sku: p.sku }); return json(p, 201); }));
add('PUT', '/api/admin/products/:id', A(async (c) => {
  const id = int(c.params[0], 0); const b: any = await body(c);
  const before: any = b.price_stars !== undefined ? await c.env.DB.prepare('SELECT price_stars FROM products WHERE id=?').bind(id).first() : null;
  const p: any = await cat.saveProduct(c.env, b, id);
  await adm.audit(c.env, c.user!.id, before && before.price_stars !== p.price_stars ? 'update+price' : 'update', 'product', id, before && before.price_stars !== p.price_stars ? { price_from: before.price_stars, price_to: p.price_stars } : undefined);
  return json(p);
}));
add('DELETE', '/api/admin/products/:id', A(async (c) => { const id = int(c.params[0], 0); const r = await cat.deleteProduct(c.env, id, c.url.searchParams.get('hard') === '1'); await adm.audit(c.env, c.user!.id, 'delete', 'product', id, r); return json(r); }));
const status = (s: string | null): H => async (c) => {
  const id = int(c.params[0], 0); const st = s || String(((await body(c)) as any).status);
  const r = await cat.setStatus(c.env, id, st); await adm.audit(c.env, c.user!.id, 'status:' + st, 'product', id, { from: r.from }); return json(r);
};
add('POST', '/api/admin/products/:id/publish', A(status('published')));
add('POST', '/api/admin/products/:id/archive', A(status('archived')));
add('POST', '/api/admin/products/:id/status', A(status(null)));
add('POST', '/api/admin/products/:id/images/order', A(async (c) => up.reorderImages(c, int(c.params[0], 0))));
add('POST', '/api/admin/upload/image', A(async (c) => { const r = await up.uploadImage(c); await adm.audit(c.env, c.user!.id, 'upload_image', c.url.searchParams.get('kind') || 'extra', c.url.searchParams.get('product_id') || '-'); return r; }));
add('POST', '/api/admin/upload/file', A(async (c) => { const r = await up.uploadFile(c); await adm.audit(c.env, c.user!.id, 'upload_file', 'product', c.url.searchParams.get('product_id') || '-', { format: c.url.searchParams.get('format') }); return r; }));
add('DELETE', '/api/admin/images/:id', A(async (c) => { const r = await up.deleteImage(c, int(c.params[0], 0)); await adm.audit(c.env, c.user!.id, 'delete_image', 'image', c.params[0]); return r; }));
add('POST', '/api/admin/images/:id/main', A(async (c) => up.setMainImage(c, int(c.params[0], 0))));
add('DELETE', '/api/admin/files/:id', A(async (c) => { const r = await up.deactivateFile(c, int(c.params[0], 0)); await adm.audit(c.env, c.user!.id, 'delete_file', 'file', c.params[0]); return r; }));
add('GET', '/api/admin/orders', A(async (c) => json(await adm.adminOrders(c.env, c.url.searchParams))));
add('GET', '/api/admin/orders/:id', A(async (c) => json(await adm.adminOrder(c.env, int(c.params[0], 0)))));
add('POST', '/api/admin/orders/:id/refund', A(async (c) => { const r = await ord.refund(c, int(c.params[0], 0)); await adm.audit(c.env, c.user!.id, 'refund', 'order', c.params[0]); return json(r); }));
add('GET', '/api/admin/customers', A(async (c) => json(await adm.customers(c.env, c.url.searchParams))));
add('GET', '/api/admin/stats', A(async (c) => json(await adm.stats(c.env))));
add('GET', '/api/admin/audit', A(async (c) => json({ items: await adm.auditList(c.env) })));
add('GET', '/api/admin/settings', A(async (c) => json(await cat.getSettings(c.env))));
add('PUT', '/api/admin/settings', A(async (c) => { const r = await cat.updateSettings(c.env, await body(c)); await adm.audit(c.env, c.user!.id, 'update', 'settings', '-'); return json(r); }));
add('POST', '/api/admin/telegram/setup', A(async (c) => {
  await tg(c.env, 'setWebhook', { url: c.url.origin + '/api/telegram/webhook', secret_token: c.env.WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query'] });
  await tg(c.env, 'setMyCommands', { commands: [{ command: 'start', description: 'CAD x FORGE' }, { command: 'paysupport', description: 'Payment support' }, { command: 'help', description: 'Help' }] });
  await tg(c.env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'CAD x FORGE', web_app: { url: c.env.WEBAPP_URL } } });
  return json({ ok: true });
}));

export default {
  async fetch(req: Request, env: Env, ectx: any): Promise<Response> {
    const t0 = Date.now(); const url = new URL(req.url); const origin = req.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors: Record<string, string> = origin && allowed.includes(origin)
      ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'authorization,content-type,x-filename', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-max-age': '600' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const rid = crypto.randomUUID().slice(0, 8); let res: Response;
    try {
      let hit: [H, string[]] | null = null;
      for (const [m, re, h] of routes) { if (m !== req.method) continue; const x = re.exec(url.pathname); if (x) { hit = [h, x.slice(1)]; break; } }
      if (!hit) throw new HttpError(404, 'not_found');
      res = await hit[0]({ req, env, url, params: hit[1], wait: (p) => ectx?.waitUntil?.(p) });
    } catch (e: any) {
      if (e instanceof HttpError) res = json({ error: { code: e.code, ...(e.extra ? { details: e.extra } : {}) } }, e.status);
      else { log('error', { rid, path: url.pathname, err: String(e?.message || e) }); res = json({ error: { code: 'server_error', request_id: rid } }, 500); }
    }
    if (url.pathname !== '/health') log('req', { rid, m: req.method, p: url.pathname, s: res.status, ms: Date.now() - t0 });
    const h = new Headers(res.headers); for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
