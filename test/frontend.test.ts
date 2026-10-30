// Интеграционная проверка: настоящие index.html и admin/index.html работают с настоящим Worker (в памяти).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/index.ts';
import { makeDB, makeR2 } from './shim.ts';

const BOT = '123456:TESTTOKEN';
const ADMIN = { id: 1001, first_name: 'Admin', language_code: 'ru' };
const BUYER = { id: 2002, first_name: 'Anna', username: 'anna', language_code: 'ru' };
const PDF = new TextEncoder().encode('%PDF-1.4 integration');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const root = new URL('../../', import.meta.url).pathname;
const file = (p: string) => readFileSync(root + p, 'utf8');
const scripts = (html: string) => html.split('<script>')[1].split('</script>')[0];

function initData(user: any) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(BOT).digest()).update(dcs).digest('hex'));
  return p.toString();
}
const tgLog: any[] = [];
function makeEnv() {
  return { DB: makeDB(new URL('../migrations', import.meta.url).pathname), FILES: makeR2(), BOT_TOKEN: BOT, WEBHOOK_SECRET: 'whsec', ADMIN_TELEGRAM_IDS: '1001', DOWNLOAD_SIGNING_KEY: 'k', ALLOWED_ORIGIN: 'https://x.github.io', WEBAPP_URL: 'https://x.github.io/app/', ADMIN_URL: 'https://x.github.io/app/admin/' } as any;
}
function makeCtx(env: any, user: any) {
  const els: any = {}; const mk = () => ({ innerHTML: '', textContent: '', value: '', classList: { add() {}, remove() {} }, dataset: {}, querySelector: () => null });
  const store: any = {};
  const apiFetch = async (url: string, init: any) => {
    if (String(url).startsWith('https://api.test')) return worker.fetch(new Request(url, init), env, { waitUntil() {} });
    const m = String(url).split('/').pop()!; tgLog.push({ m, body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: m === 'createInvoiceLink' ? 'https://t.me/$inv' : true });
  };
  (globalThis as any).fetch = apiFetch;
  const ctx: any = { __inv: null, __link: null, console, setTimeout, clearTimeout, URLSearchParams, Blob, __env: env,
    document: { querySelector: (s: string) => els[s] || (els[s] = mk()), querySelectorAll: () => [], createElement: mk, addEventListener() {}, documentElement: { lang: '' } },
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
    location: { search: '' }, scrollTo() {}, scrollY: 0, fetch: apiFetch, CFX: { API: 'https://api.test' } };
  ctx.window = ctx;
  ctx.Telegram = { WebApp: { initData: user ? initData(user) : '', initDataUnsafe: { user }, ready() {}, expand() {}, openInvoice(l: string, cb: any) { ctx.__inv = { l, cb }; }, openLink(u: string) { ctx.__link = u; }, isVersionAtLeast: () => false } };
  return vm.createContext(ctx);
}
async function seedProduct(env: any) {
  const call = async (m: string, p: string, o: any = {}) => {
    const h: any = { authorization: 'tma ' + initData(ADMIN) }; let body: any;
    if (o.raw) { body = o.raw; h['content-length'] = String(o.raw.byteLength); } else if (o.body) { body = JSON.stringify(o.body); h['content-type'] = 'application/json'; }
    const r = await worker.fetch(new Request('https://api.test' + p, { method: m, headers: h, body }), env, { waitUntil() {} }); return { s: r.status, j: await r.json() };
  };
  const sz = env.DB.raw.prepare("SELECT s.id FROM sizes s JOIN size_groups g ON g.id=s.group_id WHERE g.slug='women' AND s.label IN ('42','44')").all().map((x: any) => x.id);
  const c = await call('POST', '/api/admin/products', { body: { sku: 'FE-1', name_ru: 'Платье Вена', name_en: 'Dress Vienna', category_id: 1, audience_id: 1, price_stars: 150, size_ids: sz, tag_ids: [1] } });
  const id = c.j.id;
  await call('POST', `/api/admin/upload/image?kind=main&product_id=${id}`, { raw: PNG });
  await call('POST', `/api/admin/upload/file?product_id=${id}&format=pdf_a4&filename=FE-1.pdf`, { raw: PDF });
  assert.equal((await call('POST', `/api/admin/products/${id}/publish`)).s, 200);
  return id;
}
const run = async (ctx: any, js: string) => { vm.runInContext(js, ctx); await ctx.__done; return Array.from(ctx.__out) as string[]; };
const PRE = 'const sleep=ms=>new Promise(r=>setTimeout(r,ms));const el=d=>({dataset:d});globalThis.__out=[];const ok=(c,m)=>{if(!c)__out.push("FAIL "+m)};';

test('магазин: каталог из API → карточка → корзина → оплата Stars → покупки → скачивание', async () => {
  const env = makeEnv(); const id = await seedProduct(env);
  const ctx = makeCtx(env, BUYER);
  const out = await run(ctx, readFileSync(root + 'api.js', 'utf8') + '\n' + scripts(file('index.html')) + '\n' + PRE + `
  globalThis.__done=(async()=>{await sleep(300);
   ok(S.boot&&S.boot.categories.length>=22,'bootstrap');ok(S.list.items.length===1,'список загружен');ok($('#res').innerHTML.includes('Платье Вена'),'карточка в HTML');
   ok(vCat().includes('Платья'),'категории из БД');ok(vCat().includes('placeholder'),'поиск есть');
   S.f.q='vienna';await loadList(true);ok(S.list.total===1,'поиск');S.f.q='zzz';await loadList(true);ok(S.list.total===0&&$('#res').innerHTML.includes(t('none')),'пустой результат');S.f.q='';await loadList(true);
   await act('f',{dataset:{k:'category',v:'7'}});await sleep(50);ok(S.list.total===0,'фильтр категории');await act('f',{dataset:{k:'category',v:'7'}});await sleep(50);ok(S.list.total===1,'сброс фильтра');
   await act('open',el({v:String(${id})}));ok(S.prod&&S.prod.sku==='FE-1','карточка загружена');const v=vPrd();ok(v.includes('PDF A4')&&v.includes('★ 150')&&v.includes('42'),'содержимое карточки');ok(!v.includes('storage_key'),'нет ключей хранилища');
   await act('add',el({v:String(${id})}));ok(S.cart.length===1&&S.cartItems.length===1,'в корзине');
   await act('tab',el({v:'cart'}));ok(vCart().includes('★ 150'),'сумма в корзине');
   await act('co',el({}));ok(S.sheet===1,'окно оформления');await act('pay',el({}));
   ok(!!__inv,'открыт счёт Telegram Stars');const o=__env.DB.raw.prepare('SELECT number,total_stars FROM orders').get();ok(o.total_stars===150,'сумма заказа посчитана сервером');
   const wh=b=>fetch('https://api.test/api/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'whsec','content-type':'application/json'},body:JSON.stringify(b)});
   await wh({update_id:1,pre_checkout_query:{id:'q',from:Telegram.WebApp.initDataUnsafe.user,currency:'XTR',total_amount:150,invoice_payload:o.number}});
   await wh({update_id:2,message:{message_id:1,from:Telegram.WebApp.initDataUnsafe.user,chat:{id:2002},successful_payment:{currency:'XTR',total_amount:150,invoice_payload:o.number,telegram_payment_charge_id:'c1'}}});
   await __inv.cb('paid');ok(S.sheet===3&&S.cart.length===0,'оплата подтверждена, корзина очищена');
   await act('tab',el({v:'buys'}));ok(vBuys().includes(o.number)&&vBuys().includes('PDF A4'),'покупка в «Покупки»');ok(owned(${id}),'товар помечен купленным');
   await act('open',el({v:String(${id})}));ok(vPrd().includes(t('own')),'карточка: уже куплено');await act('add',el({v:String(${id})}));ok(S.cart.length===0,'повторно не добавляется');
   const fid=S.buys.items[0].files[0].id;await act('get',el({v:String(fid)}));ok(typeof __link==='string'&&__link.includes('/api/dl/'),'выдана временная ссылка');
   const r=await fetch(__link);ok(r.status===200&&(await r.arrayBuffer()).byteLength===${PDF.byteLength},'файл скачивается');
   await act('lang',el({}));ok(LANG==='kk'&&t('add')==='Себетке','KZ');await act('lang',el({}));ok(LANG==='en'&&t('add')==='Add to cart','EN');await act('lang',el({}));ok(LANG==='ru','RU');
   })().catch(e=>{__out.push('ERROR '+(e&&e.message||JSON.stringify(e)))});`);
  assert.deepEqual(out, []);
  const bot = tgLog.filter((x) => x.m === 'sendMessage' && x.body.chat_id === BUYER.id);
  assert.equal(bot.length, 1);
});
test('магазин без Telegram: каталог виден, оплата и покупки недоступны', async () => {
  const env = makeEnv(); await seedProduct(env); const ctx = makeCtx(env, null);
  const out = await run(ctx, readFileSync(root + 'api.js', 'utf8') + '\n' + scripts(file('index.html')) + '\n' + PRE + `
  globalThis.__done=(async()=>{await sleep(300);ok(S.list.items.length===1,'каталог без авторизации');S.tab='buys';ok(vBuys().includes(t('openTg')),'покупки требуют Telegram');
   S.sheet=1;S.cart=[{id:1}];await loadCart();await act('pay',el({}));ok(!__inv,'без Telegram счёт не открывается');})().catch(e=>{__out.push('ERROR '+(e&&e.message||JSON.stringify(e)))});`);
  assert.deepEqual(out, []);
});
test('админка: вход по whitelist, создание товара, статусы, справочники', async () => {
  const env = makeEnv(); const ctx = makeCtx(env, ADMIN);
  const out = await run(ctx, readFileSync(root + 'api.js', 'utf8') + '\n' + scripts(file('admin/index.html')) + '\n' + PRE + `
  globalThis.__done=(async()=>{await sleep(400);ok(S.auth&&S.auth.id===1001,'вход администратора');ok(S.D.categories.length>=22&&S.D.sizes.length>30,'справочники загружены');ok($('#app').innerHTML.includes('товаров'),'дашборд');
   await act('tab',el({v:'prod'}));await act('new',el({}));S.ed.sku='ADM-1';S.ed.name_ru='Тестовое платье';S.ed.category_id=1;S.ed.price_stars='99';S.ed.size_ids=[S.D.sizes[0].id];
   await act('save',el({}));ok(S.ed&&S.ed.id&&S.ed.price_stars===99,'товар создан через API');
   await act('pst',el({v:'published'}));ok($('#toast').textContent.includes('не хватает'),'публикация без файла отклонена с понятным сообщением');
   await act('tab',el({v:'prod'}));ok(S.pl.items.length===1&&S.pl.items[0].status==='draft','товар в списке как черновик');
   S.dict='tags';const f={slug:'vip',name_ru:'VIP',name_kk:'',name_en:'VIP',sort:'9'};await act('dsave',{dataset:{v:'new'},closest:()=>({querySelector:s=>({value:f[s.match(/data-d="(\\w+)"/)[1]]||'',checked:false})})});
   ok(S.D.tags.some(x=>x.slug==='vip'),'тег создан');
   for(const t of ['dash','ord','cus','set','audit','tax']){await go(t);ok(!S.err,'вкладка '+t)}ok(S.set.store_name==='CAD x FORGE','настройки загружены');ok(S.au.length>=2,'журнал действий');
   })().catch(e=>{__out.push('ERROR '+(e&&e.message||JSON.stringify(e)))});`);
  assert.deepEqual(out, []);
});
test('админка: не-администратор получает отказ, без Telegram — подсказка', async () => {
  const env = makeEnv(); const ctx = makeCtx(env, BUYER);
  const out = await run(ctx, readFileSync(root + 'api.js', 'utf8') + '\n' + scripts(file('admin/index.html')) + '\n' + PRE + `
  globalThis.__done=(async()=>{await sleep(300);ok(S.err&&S.err.code==='forbidden'&&!S.auth,'отказ не-админу');ok(!$('#app').innerHTML.includes('Товары</button>')||S.err,'нет данных');})().catch(e=>{__out.push('ERROR '+(e&&e.message))});`);
  assert.deepEqual(out, []);
  const ctx2 = makeCtx(env, null);
  const out2 = await run(ctx2, readFileSync(root + 'api.js', 'utf8') + '\n' + scripts(file('admin/index.html')) + '\n' + PRE + `globalThis.__done=(async()=>{await sleep(100);ok(S.err&&S.err.code==='unauthorized','без Telegram');ok($('#app').innerHTML.includes('/admin'),'подсказка про /admin')})().catch(e=>{__out.push('ERROR '+e.message)});`);
  assert.deepEqual(out2, []);
});
