import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.ts';
import { verifyInitData } from '../src/auth.ts';
import { makeDB, makeR2 } from './shim.ts';

const BOT = '123456:TESTTOKEN';
const ADMIN = { id: 1001, first_name: 'Admin', username: 'adm', language_code: 'ru' };
const BUYER = { id: 2002, first_name: 'Anna', username: 'anna', language_code: 'en' };
const OTHER = { id: 3003, first_name: 'Bob', language_code: 'kk' };
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PLT = new TextEncoder().encode('IN;SP1;PU0,0;PD100,100;PU;');

function initData(user: any, authDate = Math.floor(Date.now() / 1000), token = BOT) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const tgCalls: any[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const method = String(url).split('/').pop()!; const body = JSON.parse(init.body); tgCalls.push({ method, body });
  if (method === 'createInvoiceLink') return Response.json({ ok: true, result: 'https://t.me/$inv' + tgCalls.length });
  return Response.json({ ok: true, result: true });
};
const sent = (chat: number) => tgCalls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chat);

function setup(extra: any = {}) {
  const env: any = { DB: makeDB(new URL('../migrations', import.meta.url).pathname), FILES: makeR2(), BOT_TOKEN: BOT, WEBHOOK_SECRET: 'whsec', ADMIN_TELEGRAM_IDS: '1001', DOWNLOAD_SIGNING_KEY: 'sign-key', ALLOWED_ORIGIN: 'https://x.github.io', WEBAPP_URL: 'https://x.github.io/app/', ADMIN_URL: 'https://x.github.io/app/admin/', ...extra };
  return env;
}
async function call(env: any, method: string, path: string, o: any = {}) {
  const h: any = { ...(o.headers || {}) };
  if (o.user) h.authorization = 'tma ' + (o.init || initData(o.user));
  let body: any;
  if (o.raw) { body = o.raw; if (!o.noLen) h['content-length'] = String(o.raw.byteLength); }
  else if (o.body !== undefined) { body = JSON.stringify(o.body); h['content-type'] = 'application/json'; }
  if (o.secret) h['x-telegram-bot-api-secret-token'] = o.secret;
  const r = await worker.fetch(new Request('https://api.test' + path, { method, headers: h, body }), env, { waitUntil() {} });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, json: ct.includes('json') ? await r.clone().json() : null, res: r };
}
const ids = (env: any, sql: string) => env.DB.raw.prepare(sql).all().map((x: any) => x.id);
const SZ = (env: any, labels: string) => ids(env, `SELECT s.id FROM sizes s JOIN size_groups g ON g.id=s.group_id WHERE g.slug='women' AND s.label IN (${labels})`);

async function makeProduct(env: any, sku: string, price = 100, publish = true, extra: any = {}) {
  const a = (path: string, o: any) => call(env, o.m || 'POST', path, { user: ADMIN, ...o });
  const c = await a('/api/admin/products', { body: { sku, name_ru: 'Платье ' + sku, name_en: 'Dress ' + sku, category_id: 1, audience_id: 1, price_stars: price, size_ids: SZ(env, "'42','44'"), tag_ids: [1], ...extra } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const id = c.json.id;
  assert.equal((await a(`/api/admin/upload/image?kind=main&product_id=${id}`, { raw: PNG })).status, 201);
  assert.equal((await a(`/api/admin/upload/file?product_id=${id}&format=pdf_a4&filename=${sku}.pdf`, { raw: PDF })).status, 201);
  if (publish) assert.equal((await a(`/api/admin/products/${id}/publish`, {})).status, 200);
  return id as number;
}
async function buy(env: any, user: any, items: number[], opts: any = {}) {
  const c = await call(env, 'POST', '/api/cart/checkout', { user, body: { items: items.map((id) => ({ product_id: id })) } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const { number, total_stars: total } = c.json.order;
  const upd = (u: any) => call(env, 'POST', '/api/telegram/webhook', { secret: 'whsec', body: u });
  const pre = await upd({ update_id: 1, pre_checkout_query: { id: 'pq' + number, from: user, currency: 'XTR', total_amount: total, invoice_payload: number } });
  assert.equal(pre.status, 200);
  const pay = { currency: 'XTR', total_amount: total, invoice_payload: number, telegram_payment_charge_id: opts.charge || 'ch_' + number, provider_payment_charge_id: 'p' };
  const r = await upd({ update_id: 2, message: { message_id: 1, from: user, chat: { id: user.id }, successful_payment: pay } });
  return { number, total, r, upd, pay };
}
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (f: number, u: number, e: number, key = 'sign-key') => { const p = b64u(Buffer.from(JSON.stringify({ f, u, e }))); return p + '.' + b64u(createHmac('sha256', key).update(p).digest()); };

// ---------------- Telegram initData ----------------
test('initData: корректная подпись принимается', async () => {
  const u = await verifyInitData(initData(BUYER), BOT, 86400);
  assert.equal(u.id, BUYER.id);
});
test('initData: неверная подпись, чужой токен, подмена данных, нет hash — отклоняются', async () => {
  await assert.rejects(verifyInitData(initData(BUYER, undefined, 'other:token'), BOT, 86400), { code: 'invalid_init_data' });
  const tampered = initData(BUYER).replace(encodeURIComponent('"id":2002'), encodeURIComponent('"id":1001'));
  await assert.rejects(verifyInitData(tampered, BOT, 86400), { code: 'invalid_init_data' });
  await assert.rejects(verifyInitData('auth_date=1&user={}', BOT, 86400), { code: 'invalid_init_data' });
  await assert.rejects(verifyInitData('', BOT, 86400), { code: 'invalid_init_data' });
});
test('initData: просроченные и «из будущего» отклоняются', async () => {
  const old = Math.floor(Date.now() / 1000) - 90000;
  await assert.rejects(verifyInitData(initData(BUYER, old), BOT, 86400), { code: 'init_data_expired' });
  await assert.rejects(verifyInitData(initData(BUYER, Math.floor(Date.now() / 1000) + 4000), BOT, 86400), { code: 'invalid_init_data' });
});

// ---------------- пользователи и админ ----------------
test('GET /api/me: без авторизации 401, с подписью — пользователь создаётся', async () => {
  const env = setup();
  assert.equal((await call(env, 'GET', '/api/me')).status, 401);
  assert.equal((await call(env, 'GET', '/api/me', { user: BUYER, init: initData(BUYER, undefined, 'x:y') })).status, 401);
  const r = await call(env, 'GET', '/api/me', { user: BUYER });
  assert.equal(r.status, 200); assert.equal(r.json.is_admin, false); assert.equal(r.json.user.lang, 'en');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});
test('админка: доступ только по whitelist', async () => {
  const env = setup();
  assert.equal((await call(env, 'GET', '/api/admin/stats')).status, 401);
  assert.equal((await call(env, 'GET', '/api/admin/stats', { user: BUYER })).status, 403);
  assert.equal((await call(env, 'POST', '/api/admin/products', { user: BUYER, body: { sku: 'X', name_ru: 'x' } })).status, 403);
  assert.equal((await call(env, 'GET', '/api/admin/stats', { user: ADMIN })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { user: ADMIN })).json.is_admin, true);
  const noAdmins = setup({ ADMIN_TELEGRAM_IDS: '' });
  assert.equal((await call(noAdmins, 'GET', '/api/admin/stats', { user: ADMIN })).status, 403);
});

// ---------------- товары ----------------
test('товар: создание, валидация, обновление, публикация, архив', async () => {
  const env = setup();
  const bad = await call(env, 'POST', '/api/admin/products', { user: ADMIN, body: { sku: 'A B', name_ru: 'x' } });
  assert.equal(bad.status, 400);
  const c = await call(env, 'POST', '/api/admin/products', { user: ADMIN, body: { sku: 'T-1', name_ru: 'Тест', category_id: 1, price_stars: 50 } });
  assert.equal(c.status, 201); assert.equal(c.json.status, 'draft');
  const id = c.json.id;
  assert.equal((await call(env, 'POST', '/api/admin/products', { user: ADMIN, body: { sku: 'T-1', name_ru: 'Дубль' } })).status, 409);
  const u = await call(env, 'PUT', `/api/admin/products/${id}`, { user: ADMIN, body: { name_en: 'Test', price_stars: 75, size_ids: SZ(env, "'42','46'") } });
  assert.equal(u.json.price_stars, 75); assert.equal(u.json.sizes.length, 2); assert.equal(u.json.name_ru, 'Тест');
  assert.equal((await call(env, 'PUT', `/api/admin/products/${id}`, { user: ADMIN, body: { size_ids: [999999] } })).status, 409);
  const nr = await call(env, 'POST', `/api/admin/products/${id}/publish`, { user: ADMIN });
  assert.equal(nr.status, 409); assert.deepEqual(nr.json.error.details.missing.sort(), ['file', 'image']);
  assert.equal((await call(env, 'GET', `/api/products/${id}`)).status, 404);
  const pid = await makeProduct(env, 'T-2');
  const pub = await call(env, 'GET', `/api/products/${pid}`);
  assert.equal(pub.status, 200); assert.ok(!JSON.stringify(pub.json).includes('storage_key')); assert.ok(pub.json.files[0].format);
  assert.equal((await call(env, 'GET', '/api/products')).json.total, 1);
  assert.equal((await call(env, 'POST', `/api/admin/products/${pid}/archive`, { user: ADMIN })).status, 200);
  assert.equal((await call(env, 'GET', '/api/products')).json.total, 0);
  assert.equal((await call(env, 'GET', '/api/admin/products', { user: ADMIN })).json.total, 2);
});
test('каталог: поиск, фильтры, сортировка, страницы, facets', async () => {
  const env = setup();
  const a = await makeProduct(env, 'SK-1', 100, true, { name_ru: 'Платье Вена', name_en: 'Dress Vienna', price_stars: 100, category_id: 1 });
  const b = await makeProduct(env, 'SK-2', 300, true, { name_ru: 'Брюки Прага', name_en: 'Trousers Prague', category_id: 7, audience_id: 2, size_ids: SZ(env, "'46'"), tag_ids: [2] });
  const list = async (qs: string) => (await call(env, 'GET', '/api/products?' + qs)).json;
  assert.equal((await list('')).total, 2);
  assert.deepEqual((await list('q=vienna')).items.map((x: any) => x.id), [a]);
  assert.deepEqual((await list('q=' + encodeURIComponent('Прага'))).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('q=SK-2')).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('q=Trousers')).items.map((x: any) => x.id), [b]);   // по названию категории тоже находится
  assert.equal((await list('q=%25')).total, 0);                                      // спецсимволы LIKE экранированы
  assert.deepEqual((await list('category=7')).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('category=trousers')).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('audience=men')).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('size=' + SZ(env, "'46'")[0])).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('tag=bestseller')).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('format=pdf_a4')).items.length, 2); assert.equal((await list('format=plt')).total, 0);
  assert.deepEqual((await list('price_min=200')).items.map((x: any) => x.id), [b]);
  assert.deepEqual((await list('price_max=150')).items.map((x: any) => x.id), [a]);
  assert.deepEqual((await list('sort=price_desc')).items.map((x: any) => x.id), [b, a]);
  assert.equal((await list('limit=1&page=2')).items.length, 1); assert.equal((await list('limit=1')).total, 2);
  assert.equal((await list(`ids=${a},${b},abc`)).total, 2);
  const f = (await call(env, 'GET', '/api/facets')).json;
  assert.equal(f.categories.length, 2); assert.equal(f.formats.length, 1); assert.equal(f.price.min, 100); assert.equal(f.price.max, 300);
});

// ---------------- справочники ----------------
test('справочники: создать, переименовать, скрыть, удаление занятых запрещено', async () => {
  const env = setup();
  const n = await call(env, 'POST', '/api/admin/dict/categories', { user: ADMIN, body: { slug: 'capes', name_ru: 'Накидки', name_en: 'Capes', sort: 50 } });
  assert.equal(n.status, 201);
  assert.equal((await call(env, 'POST', '/api/admin/dict/categories', { user: ADMIN, body: { slug: 'Bad Slug', name_ru: 'x' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/admin/dict/categories', { user: ADMIN, body: { slug: 'capes', name_ru: 'x' } })).status, 409);
  const r = await call(env, 'PUT', `/api/admin/dict/categories/${n.json.id}`, { user: ADMIN, body: { name_ru: 'Накидка', name_kk: 'Жамылғы' } });
  assert.equal(r.json.name_ru, 'Накидка');
  assert.ok((await call(env, 'GET', '/api/bootstrap')).json.categories.some((c: any) => c.slug === 'capes'));
  await call(env, 'PUT', `/api/admin/dict/categories/${n.json.id}`, { user: ADMIN, body: { archived: 1 } });
  assert.ok(!(await call(env, 'GET', '/api/bootstrap')).json.categories.some((c: any) => c.slug === 'capes'));
  await makeProduct(env, 'D-1', 10, false, { category_id: 1 });
  assert.equal((await call(env, 'DELETE', '/api/admin/dict/categories/1', { user: ADMIN })).status, 409);
  assert.equal((await call(env, 'DELETE', `/api/admin/dict/categories/${n.json.id}`, { user: ADMIN })).status, 200);
  const s = await call(env, 'POST', '/api/admin/dict/sizes', { user: ADMIN, body: { group_id: 1, label: '70', sort: 70 } });
  assert.equal(s.status, 201);
  const h = await call(env, 'POST', '/api/admin/dict/heights', { user: ADMIN, body: { group_id: 1, label: '194', cm: 194, sort: 194 } });
  assert.equal(h.status, 201);
  const fmt = await call(env, 'POST', '/api/admin/dict/file_formats', { user: ADMIN, body: { code: 'dxf', label: 'DXF', ext: 'dxf', sort: 9 } });
  assert.equal(fmt.status, 201);
  assert.equal((await call(env, 'GET', '/api/admin/dict/nope', { user: ADMIN })).status, 404);
  assert.equal((await call(env, 'GET', '/api/admin/dict/tags', { user: BUYER })).status, 403);
});

// ---------------- загрузки ----------------
test('загрузки: форматы, содержимое, размеры, версии, публичность', async () => {
  const env = setup({ MAX_FILE_MB: '0.0005', MAX_IMAGE_MB: '1' });
  const c = await call(env, 'POST', '/api/admin/products', { user: ADMIN, body: { sku: 'U-1', name_ru: 'x' } });
  const id = c.json.id; const up = (qs: string, raw: Uint8Array, o: any = {}) => call(env, 'POST', '/api/admin/upload/' + qs, { user: ADMIN, raw, ...o });
  assert.equal((await up(`file?product_id=${id}&format=pdf_a4&filename=a.pdf`, new TextEncoder().encode('%PDF-1'))).status, 201);
  assert.equal((await up(`file?product_id=${id}&format=nope&filename=a.pdf`, PDF)).status, 400);
  assert.equal((await up(`file?product_id=${id}&format=pdf_a4&filename=a.exe`, PDF)).status, 415);
  assert.equal((await up(`file?product_id=${id}&format=pdf_a4&filename=a.pdf`, new TextEncoder().encode('MZ-not-pdf'))).status, 415);
  assert.equal((await up(`file?product_id=${id}&format=plt&filename=a.plt`, new Uint8Array([0x49, 0x4e, 0, 0, 1]))).status, 415);
  assert.equal((await up(`file?product_id=${id}&format=plt&filename=a.plt`, new Uint8Array(2000).fill(65))).status, 413);
  assert.equal((await up(`file?product_id=${id}&format=pdf_a4&filename=a.pdf`, PDF, { noLen: true })).status, 411);
  assert.equal((await up(`file?product_id=9999&format=pdf_a4&filename=a.pdf`, PDF)).status, 404);
  assert.equal((await up(`image?kind=main&product_id=${id}`, new TextEncoder().encode('<script>alert(1)</script>'))).status, 415);
  assert.equal((await up(`image?kind=weird&product_id=${id}`, PNG)).status, 400);
  const img = await up(`image?kind=main&product_id=${id}`, PNG); assert.equal(img.status, 201);
  const url = new URL('https://x' + img.json.url);
  assert.equal((await call(env, 'GET', url.pathname)).status, 200);
  assert.equal((await call(env, 'GET', '/api/img/files/1/pdf_a4/v1-x')).status, 404);
  assert.equal((await call(env, 'GET', '/api/img/images/../files/1')).status, 404);
  const k = [...env.FILES.m.keys()].find((x: string) => x.startsWith('files/')); assert.ok(k);
  assert.equal((await call(env, 'GET', '/api/img/' + k)).status, 404);   // приватные файлы по публичному пути недоступны
  const admin = (await call(env, 'GET', `/api/admin/products/${id}`, { user: ADMIN })).json;
  assert.equal(admin.files[0].checksum.length, 64); assert.equal(admin.files[0].version, 1);
  await up(`file?product_id=${id}&format=pdf_a4&filename=a2.pdf`, new TextEncoder().encode('%PDF-2'));
  const v2 = (await call(env, 'GET', `/api/admin/products/${id}`, { user: ADMIN })).json.files;
  assert.deepEqual(v2.map((f: any) => [f.version, f.active]), [[2, 1], [1, 0]]);
});

// ---------------- заказы и цены ----------------
test('checkout: цена считается на сервере, номер заказа, недоступные и купленные товары', async () => {
  const env = setup();
  const a = await makeProduct(env, 'C-1', 120); const b = await makeProduct(env, 'C-2', 80); const d = await makeProduct(env, 'C-3', 50, false);
  assert.equal((await call(env, 'POST', '/api/cart/checkout', { body: { items: [{ product_id: a }] } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [] } })).status, 400);
  const un = await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a }, { product_id: d }, { product_id: 9999 }] } });
  assert.equal(un.status, 409); assert.deepEqual(un.json.error.details.unavailable.sort((x: number, y: number) => x - y), [d, 9999].sort((x, y) => x - y));
  tgCalls.length = 0;
  const c = await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a, price_stars: 1 }, { product_id: b, price: 1 }, { product_id: a }], total: 1, amount: 1 } });
  assert.equal(c.status, 201); assert.equal(c.json.order.total_stars, 200);
  assert.match(c.json.order.number, new RegExp(`^CFX-${new Date().getUTCFullYear()}-000001$`));
  const inv = tgCalls.find((x) => x.method === 'createInvoiceLink').body;
  assert.equal(inv.currency, 'XTR'); assert.equal(inv.prices.length, 1); assert.equal(inv.prices[0].amount, 200); assert.equal(inv.payload, c.json.order.number); assert.ok(inv.title.length <= 32);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM order_items').get().n, 2);
  const c2 = await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a }] } });
  assert.match(c2.json.order.number, /-000002$/);
  assert.equal((await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a, size_id: 999 }] } })).status, 400);
  await call(env, 'PUT', `/api/admin/products/${a}`, { user: ADMIN, body: { price_stars: 500 } });
  assert.equal((await call(env, 'GET', '/api/orders/' + c.json.order.number, { user: BUYER })).json.status, 'pending');
  assert.equal((await call(env, 'GET', '/api/orders/' + c.json.order.number, { user: OTHER })).status, 404);
});

// ---------------- платежи ----------------
test('webhook: секрет обязателен', async () => {
  const env = setup();
  assert.equal((await call(env, 'POST', '/api/telegram/webhook', { body: {} })).status, 401);
  assert.equal((await call(env, 'POST', '/api/telegram/webhook', { secret: 'wrong', body: {} })).status, 401);
  assert.equal((await call(env, 'POST', '/api/telegram/webhook', { secret: 'whsec', body: { update_id: 1 } })).status, 200);
  assert.equal((await call(setup({ WEBHOOK_SECRET: '' }), 'POST', '/api/telegram/webhook', { secret: '', body: {} })).status, 401);
});
test('pre_checkout: проверяет пользователя, сумму и доступность', async () => {
  const env = setup(); const a = await makeProduct(env, 'P-1', 100);
  const c = await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a }] } });
  const n = c.json.order.number; const ans = () => tgCalls.filter((x) => x.method === 'answerPreCheckoutQuery').pop()!.body;
  const pre = (from: any, amount: number, payload = n, cur = 'XTR') => call(env, 'POST', '/api/telegram/webhook', { secret: 'whsec', body: { update_id: 1, pre_checkout_query: { id: 'q', from, currency: cur, total_amount: amount, invoice_payload: payload } } });
  await pre(BUYER, 100); assert.equal(ans().ok, true);
  await pre(OTHER, 100); assert.equal(ans().ok, false);
  await pre(BUYER, 1); assert.equal(ans().ok, false);
  await pre(BUYER, 100, n, 'USD'); assert.equal(ans().ok, false);
  await pre(BUYER, 100, 'CFX-0000-000000'); assert.equal(ans().ok, false);
  await call(env, 'POST', `/api/admin/products/${a}/archive`, { user: ADMIN });
  await pre(BUYER, 100); assert.equal(ans().ok, false);
});
test('оплата: заказ оплачен, покупка создана, повторная доставка идемпотентна', async () => {
  const env = setup(); const a = await makeProduct(env, 'Y-1', 100); const b = await makeProduct(env, 'Y-2', 60);
  tgCalls.length = 0;
  const p = await buy(env, BUYER, [a, b]);
  assert.equal(p.r.status, 200);
  const o = env.DB.raw.prepare('SELECT * FROM orders WHERE number=?').get(p.number);
  assert.equal(o.status, 'paid'); assert.ok(o.paid_at);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM purchases WHERE user_id=?').get(BUYER.id).n, 2);
  assert.equal(sent(BUYER.id).length, 1); assert.ok(sent(BUYER.id)[0].body.reply_markup.inline_keyboard[0][0].web_app.url.includes('tab=purchases'));
  for (let i = 0; i < 3; i++) await p.upd({ update_id: 5, message: { message_id: 9, from: BUYER, chat: { id: BUYER.id }, successful_payment: p.pay } });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM purchases').get().n, 2);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
  assert.equal(sent(BUYER.id).length, 1);
  const again = await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a }] } });
  assert.equal(again.status, 409); assert.deepEqual(again.json.error.details.owned, [a]);
});
test('оплата: несоответствие суммы/пользователя и двойная оплата не выдают доступ', async () => {
  const env = setup(); const a = await makeProduct(env, 'M-1', 100);
  const c = await call(env, 'POST', '/api/cart/checkout', { user: BUYER, body: { items: [{ product_id: a }] } });
  const n = c.json.order.number; tgCalls.length = 0;
  const wh = (from: any, amount: number, charge: string) => call(env, 'POST', '/api/telegram/webhook', { secret: 'whsec', body: { update_id: 3, message: { message_id: 1, from, chat: { id: from.id }, successful_payment: { currency: 'XTR', total_amount: amount, invoice_payload: n, telegram_payment_charge_id: charge } } } });
  await wh(BUYER, 1, 'bad1'); await wh(OTHER, 100, 'bad2'); await wh(BUYER, 100, 'orph'.replace('orph', 'bad3'));
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM purchases').get().n, 1);
  const st = env.DB.raw.prepare('SELECT telegram_charge_id c,status s FROM payments ORDER BY id').all();
  assert.deepEqual(st.map((x: any) => x.s), ['mismatch', 'mismatch', 'succeeded']);
  assert.ok(sent(ADMIN.id).length >= 2);
  await wh(BUYER, 100, 'second-charge');       // повторная оплата того же заказа другой операцией
  assert.equal(env.DB.raw.prepare("SELECT status s FROM payments WHERE telegram_charge_id='second-charge'").get().s, 'mismatch');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM purchases').get().n, 1);
  const orphan = await call(env, 'POST', '/api/telegram/webhook', { secret: 'whsec', body: { update_id: 4, message: { message_id: 1, from: BUYER, chat: { id: 2002 }, successful_payment: { currency: 'XTR', total_amount: 5, invoice_payload: 'CFX-1-1', telegram_payment_charge_id: 'orph1' } } } });
  assert.equal(orphan.status, 200); assert.equal(env.DB.raw.prepare("SELECT status s FROM payments WHERE telegram_charge_id='orph1'").get().s, 'orphan');
});

// ---------------- покупки и скачивание ----------------
test('скачивание: владелец получает файл, остальные — нет, ссылки подписаны и ограничены по времени', async () => {
  const env = setup(); const a = await makeProduct(env, 'D-1', 100); const b = await makeProduct(env, 'D-2', 100);
  await buy(env, BUYER, [a]);
  const list = (await call(env, 'GET', '/api/me/purchases', { user: BUYER })).json.items;
  assert.equal(list.length, 1); assert.equal(list[0].product_id, a); assert.match(list[0].order_number, /^CFX-/); assert.equal(list[0].files[0].format, 'pdf_a4');
  assert.equal((await call(env, 'GET', `/api/me/purchases/${a}`, { user: BUYER })).status, 200);
  assert.equal((await call(env, 'GET', `/api/me/purchases/${b}`, { user: BUYER })).status, 404);
  assert.equal((await call(env, 'GET', '/api/me/purchases', { user: OTHER })).json.items.length, 0);
  const fid = list[0].files[0].id;
  assert.equal((await call(env, 'POST', `/api/me/files/${fid}/link`)).status, 401);
  assert.equal((await call(env, 'POST', `/api/me/files/${fid}/link`, { user: OTHER })).status, 403);
  const bf = env.DB.raw.prepare('SELECT id FROM product_files WHERE product_id=?').get(b).id;
  assert.equal((await call(env, 'POST', `/api/me/files/${bf}/link`, { user: BUYER })).status, 403);
  assert.equal((await call(env, 'POST', `/api/me/files/99999/link`, { user: BUYER })).status, 404);
  const l = await call(env, 'POST', `/api/me/files/${fid}/link`, { user: BUYER });
  assert.equal(l.status, 200); assert.ok(l.json.expires_in <= 900);
  const path = new URL(l.json.url).pathname;
  const dl = await call(env, 'GET', path); assert.equal(dl.status, 200);
  assert.deepEqual(new Uint8Array(await dl.res.arrayBuffer()), PDF);
  assert.match(dl.res.headers.get('content-disposition')!, /attachment/);
  const tok = path.split('/').pop()!; const [p, s] = tok.split('.');
  assert.equal((await call(env, 'GET', `/api/dl/${p}.${s.slice(0, -2)}AA`)).status, 403);
  assert.equal((await call(env, 'GET', `/api/dl/${p}x.${s}`)).status, 403);
  assert.equal((await call(env, 'GET', `/api/dl/garbage`)).status, 403);
  assert.equal((await call(env, 'GET', `/api/dl/${token(fid, BUYER.id, Math.floor(Date.now() / 1000) - 5)}`)).status, 410);
  assert.equal((await call(env, 'GET', `/api/dl/${token(fid, BUYER.id, Math.floor(Date.now() / 1000) + 60, 'wrong-key')}`)).status, 403);
  assert.equal((await call(env, 'GET', `/api/dl/${token(fid, OTHER.id, Math.floor(Date.now() / 1000) + 60)}`)).status, 403);   // подписано верно, но покупки нет
  assert.equal((await call(env, 'GET', `/api/dl/${token(424242, BUYER.id, Math.floor(Date.now() / 1000) + 60)}`)).status, 404);
  assert.ok(env.DB.raw.prepare("SELECT COUNT(*) n FROM download_logs WHERE kind='download'").get().n >= 1);
});
test('доступ сохраняется после архивации и новой версии файла; возврат отзывает доступ', async () => {
  const env = setup(); const a = await makeProduct(env, 'R-1', 100);
  const pay = await buy(env, BUYER, [a]);
  await call(env, 'POST', `/api/admin/products/${a}/archive`, { user: ADMIN });
  const items = (await call(env, 'GET', '/api/me/purchases', { user: BUYER })).json.items;
  assert.equal(items.length, 1); assert.equal(items[0].product_status, 'archived');
  const NEW = new TextEncoder().encode('%PDF-1.7 version two');
  await call(env, 'POST', `/api/admin/upload/file?product_id=${a}&format=pdf_a4&filename=R-1-v2.pdf`, { user: ADMIN, raw: NEW });
  const f2 = (await call(env, 'GET', '/api/me/purchases', { user: BUYER })).json.items[0].files;
  assert.equal(f2.length, 1); assert.equal(f2[0].version, 2);
  const l = await call(env, 'POST', `/api/me/files/${f2[0].id}/link`, { user: BUYER });
  const dl = await call(env, 'GET', new URL(l.json.url).pathname);
  assert.deepEqual(new Uint8Array(await dl.res.arrayBuffer()), NEW);
  // возврат
  const orderId = env.DB.raw.prepare('SELECT id FROM orders WHERE number=?').get(pay.number).id;
  assert.equal((await call(env, 'POST', `/api/admin/orders/${orderId}/refund`, { user: BUYER })).status, 403);
  tgCalls.length = 0;
  assert.equal((await call(env, 'POST', `/api/admin/orders/${orderId}/refund`, { user: ADMIN })).status, 200);
  const rf = tgCalls.find((x) => x.method === 'refundStarPayment').body;
  assert.equal(rf.user_id, BUYER.id); assert.equal(rf.telegram_payment_charge_id, 'ch_' + pay.number);
  assert.equal((await call(env, 'GET', '/api/me/purchases', { user: BUYER })).json.items.length, 0);
  assert.equal((await call(env, 'GET', new URL(l.json.url).pathname)).status, 403);   // уже выданная ссылка перестаёт работать
  assert.equal((await call(env, 'POST', `/api/admin/orders/${orderId}/refund`, { user: ADMIN })).status, 409);
  await p_redeliver(env, pay);
  assert.equal((await call(env, 'GET', '/api/me/purchases', { user: BUYER })).json.items.length, 0);   // повторная доставка старого платежа доступ не возвращает
});
async function p_redeliver(env: any, pay: any) { await pay.upd({ update_id: 77, message: { message_id: 1, from: BUYER, chat: { id: BUYER.id }, successful_payment: pay.pay } }); }

// ---------------- админ-разделы, настройки, служебное ----------------
test('заказы, покупатели, статистика, аудит, настройки, health', async () => {
  const env = setup(); const a = await makeProduct(env, 'S-1', 90); await buy(env, BUYER, [a]);
  const o = (await call(env, 'GET', '/api/admin/orders?status=paid', { user: ADMIN })).json;
  assert.equal(o.total, 1); assert.equal(o.items[0].items[0].sku, 'S-1');
  assert.equal((await call(env, 'GET', '/api/admin/orders?q=anna', { user: ADMIN })).json.total, 1);
  assert.equal((await call(env, 'GET', `/api/admin/orders/${o.items[0].id}`, { user: ADMIN })).json.payments[0].status, 'succeeded');
  const cu = (await call(env, 'GET', '/api/admin/customers', { user: ADMIN })).json.items.find((x: any) => x.id === BUYER.id);
  assert.equal(cu.purchases, 1); assert.equal(cu.spent_stars, 90);
  const st = (await call(env, 'GET', '/api/admin/stats', { user: ADMIN })).json;
  assert.equal(st.sales_stars, 90); assert.equal(st.products.published, 1); assert.equal(st.orders.paid, 1);
  const au = (await call(env, 'GET', '/api/admin/audit', { user: ADMIN })).json.items.map((x: any) => x.action);
  assert.ok(au.includes('create') && au.includes('upload_file') && au.includes('status:published'));
  assert.equal((await call(env, 'PUT', '/api/admin/settings', { user: ADMIN, body: { evil: 1 } })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/admin/settings', { user: ADMIN, body: { default_lang: 'de' } })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/admin/settings', { user: ADMIN, body: { store_name: 'FORGE', maintenance: true } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/bootstrap')).json.settings.store_name, 'FORGE');
  assert.equal((await call(env, 'POST', '/api/cart/checkout', { user: OTHER, body: { items: [{ product_id: a }] } })).status, 503);
  assert.equal((await call(env, 'GET', '/health')).json.ok, true);
  const cors = await worker.fetch(new Request('https://api.test/api/products', { headers: { origin: 'https://x.github.io' } }), env, {});
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://x.github.io');
  const evil = await worker.fetch(new Request('https://api.test/api/products', { headers: { origin: 'https://evil.example' } }), env, {});
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await call(env, 'GET', '/api/nope')).status, 404);
});
test('удаление товара: проданный архивируется, непроданный удаляется вместе с файлами', async () => {
  const env = setup(); const a = await makeProduct(env, 'X-1', 50); const b = await makeProduct(env, 'X-2', 50);
  await buy(env, BUYER, [a]);
  assert.equal((await call(env, 'DELETE', `/api/admin/products/${a}?hard=1`, { user: ADMIN })).json.archived, true);
  const before = env.FILES.m.size;
  assert.equal((await call(env, 'DELETE', `/api/admin/products/${b}?hard=1`, { user: ADMIN })).json.deleted, true);
  assert.ok(env.FILES.m.size < before);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM products WHERE id=?').get(b).n, 0);
});
