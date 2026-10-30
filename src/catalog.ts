import type { Env } from './types.ts';
import { HttpError, int, like, now, slugify } from './util.ts';

export const imgUrl = (k: string | null | undefined) => (k ? '/api/img/' + k : null);
const q = (env: Env, s: string, ...a: any[]) => env.DB.prepare(s).bind(...a).all().then((r: any) => r.results as any[]);

export async function getSettings(env: Env) {
  const o: any = {};
  for (const x of await q(env, 'SELECT key,value FROM store_settings')) { try { o[x.key] = JSON.parse(x.value); } catch { /* skip */ } }
  return o;
}
const SET: Record<string, string> = { store_name: 's', store_description: 's', support_username: 's', bot_username: 's', default_lang: 'l', languages: 'L', currency_label: 's', maintenance: 'b', page_size: 'n', logo_key: 's', msg_welcome: 'm', msg_paid: 'm' };
export async function updateSettings(env: Env, b: any) {
  const st = [];
  for (const [k, v] of Object.entries(b || {})) {
    const t = SET[k]; if (!t) throw new HttpError(400, 'validation', { field: k });
    const bad = (t === 's' && (typeof v !== 'string' || v.length > 500)) || (t === 'l' && !['ru', 'kk', 'en'].includes(v as string)) ||
      (t === 'L' && !(Array.isArray(v) && v.length > 0 && v.every((x) => ['ru', 'kk', 'en'].includes(x)))) || (t === 'b' && typeof v !== 'boolean') ||
      (t === 'n' && !(Number.isInteger(v) && (v as number) >= 6 && (v as number) <= 50)) ||
      (t === 'm' && !(v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string' && x.length < 1000)));
    if (bad) throw new HttpError(400, 'validation', { field: k });
    st.push(env.DB.prepare('INSERT INTO store_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k, JSON.stringify(v), now()));
  }
  if (st.length) await env.DB.batch(st);
  return getSettings(env);
}

export async function bootstrap(env: Env) {
  const [settings, categories, audiences, size_groups, sizes, height_groups, heights, tags, attributes, attribute_values, formats] = await Promise.all([
    getSettings(env),
    q(env, 'SELECT id,parent_id,slug,name_ru,name_kk,name_en,image_key,sort FROM categories WHERE hidden=0 AND archived=0 ORDER BY sort,id'),
    q(env, 'SELECT id,slug,name_ru,name_kk,name_en,sort FROM audiences WHERE hidden=0 ORDER BY sort,id'),
    q(env, 'SELECT id,slug,name_ru,name_kk,name_en,sort FROM size_groups ORDER BY sort,id'),
    q(env, 'SELECT id,group_id,label,sort FROM sizes WHERE hidden=0 ORDER BY sort,id'),
    q(env, 'SELECT id,slug,name_ru,name_kk,name_en,sort FROM height_groups ORDER BY sort,id'),
    q(env, 'SELECT id,group_id,label,cm,sort FROM heights WHERE hidden=0 ORDER BY sort,id'),
    q(env, 'SELECT id,slug,name_ru,name_kk,name_en,sort FROM tags WHERE hidden=0 ORDER BY sort,id'),
    q(env, 'SELECT id,slug,kind,filterable,name_ru,name_kk,name_en,sort FROM attributes ORDER BY sort,id'),
    q(env, 'SELECT id,attribute_id,value_ru,value_kk,value_en,sort FROM attribute_values ORDER BY sort,id'),
    q(env, 'SELECT code,label,ext FROM file_formats WHERE active=1 ORDER BY sort,code'),
  ]);
  for (const c of categories) { c.image = imgUrl(c.image_key); delete c.image_key; }
  settings.logo = imgUrl(settings.logo_key);
  delete settings.logo_key;
  return { settings, categories, audiences, size_groups, sizes, height_groups, heights, tags, attributes, attribute_values, formats };
}

// Какие значения фильтров реально есть среди опубликованных товаров (пустые варианты не показываем).
export async function facets(env: Env) {
  const P = "p.status='published'";
  const [categories, audiences, sizes, heights, tags, formats, price, attributes] = await Promise.all([
    q(env, `SELECT p.category_id id,COUNT(*) n FROM products p WHERE ${P} AND p.category_id IS NOT NULL GROUP BY p.category_id`),
    q(env, `SELECT p.audience_id id,COUNT(*) n FROM products p WHERE ${P} AND p.audience_id IS NOT NULL GROUP BY p.audience_id`),
    q(env, `SELECT x.size_id id,COUNT(*) n FROM product_sizes x JOIN products p ON p.id=x.product_id WHERE ${P} GROUP BY x.size_id`),
    q(env, `SELECT x.height_id id,COUNT(*) n FROM product_heights x JOIN products p ON p.id=x.product_id WHERE ${P} GROUP BY x.height_id`),
    q(env, `SELECT x.tag_id id,COUNT(*) n FROM product_tags x JOIN products p ON p.id=x.product_id WHERE ${P} GROUP BY x.tag_id`),
    q(env, `SELECT f.format code,COUNT(DISTINCT f.product_id) n FROM product_files f JOIN products p ON p.id=f.product_id WHERE ${P} AND f.active=1 GROUP BY f.format`),
    q(env, `SELECT MIN(price_stars) min,MAX(price_stars) max FROM products p WHERE ${P}`),
    q(env, `SELECT x.attribute_id,x.value_id id,COUNT(*) n FROM product_attributes x JOIN products p ON p.id=x.product_id WHERE ${P} AND x.value_id IS NOT NULL GROUP BY x.attribute_id,x.value_id`),
  ]);
  return { categories, audiences, sizes, heights, tags, formats, price: price[0], attributes };
}

const ORDER: Record<string, string> = {
  featured: 'p.featured DESC,p.sort ASC,p.id DESC', new: 'p.published_at DESC,p.id DESC', price_asc: 'p.price_stars ASC,p.id DESC', price_desc: 'p.price_stars DESC,p.id DESC',
  popular: '(SELECT COUNT(*) FROM purchases pu WHERE pu.product_id=p.id) DESC,p.id DESC', updated: 'p.updated_at DESC,p.id DESC',
};
export async function listProducts(env: Env, sp: URLSearchParams, admin = false) {
  const w: string[] = []; const a: any[] = [];
  if (!admin) w.push("p.status='published'");
  else if (sp.get('status')) { w.push('p.status=?'); a.push(sp.get('status')); }
  const ids = (sp.get('ids') || '').split(',').map((x) => int(x, 0)).filter((x) => x > 0).slice(0, 50);
  if (sp.get('ids')) { if (!ids.length) w.push('0'); else { w.push(`p.id IN (${ids.map(() => '?').join(',')})`); a.push(...ids); } }
  const text = (sp.get('q') || '').trim().slice(0, 80);
  if (text) {
    const L = like(text); const E = " ESCAPE '\\'";
    w.push(`(p.sku LIKE ?${E} OR p.name_ru LIKE ?${E} OR p.name_kk LIKE ?${E} OR p.name_en LIKE ?${E}` +
      ` OR EXISTS(SELECT 1 FROM categories c WHERE c.id=p.category_id AND (c.name_ru LIKE ?${E} OR c.name_kk LIKE ?${E} OR c.name_en LIKE ?${E}))` +
      ` OR EXISTS(SELECT 1 FROM product_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.product_id=p.id AND (t.name_ru LIKE ?${E} OR t.name_kk LIKE ?${E} OR t.name_en LIKE ?${E}))` +
      ` OR EXISTS(SELECT 1 FROM product_attributes pa JOIN attributes at ON at.id=pa.attribute_id LEFT JOIN attribute_values av ON av.id=pa.value_id WHERE pa.product_id=p.id AND at.slug='garment-type' AND (pa.text_value LIKE ?${E} OR av.value_ru LIKE ?${E} OR av.value_kk LIKE ?${E} OR av.value_en LIKE ?${E})))`);
    for (let i = 0; i < 14; i++) a.push(L);
  }
  const cat = sp.get('category');
  if (cat) { const id = int(cat, 0); w.push('p.category_id IN (SELECT id FROM categories WHERE (id=? OR parent_id=? OR slug=?))'); a.push(id, id, cat); }
  const aud = sp.get('audience'); if (aud) { w.push('p.audience_id IN (SELECT id FROM audiences WHERE id=? OR slug=?)'); a.push(int(aud, 0), aud); }
  const rel = (param: string, tbl: string, col: string) => { const v = int(sp.get(param), 0); if (v) { w.push(`EXISTS(SELECT 1 FROM ${tbl} x WHERE x.product_id=p.id AND x.${col}=?)`); a.push(v); } };
  rel('size', 'product_sizes', 'size_id'); rel('height', 'product_heights', 'height_id');
  const tag = sp.get('tag'); if (tag) { w.push('EXISTS(SELECT 1 FROM product_tags x JOIN tags t ON t.id=x.tag_id WHERE x.product_id=p.id AND (t.id=? OR t.slug=?))'); a.push(int(tag, 0), tag); }
  const fmt = sp.get('format'); if (fmt) { w.push('EXISTS(SELECT 1 FROM product_files f WHERE f.product_id=p.id AND f.active=1 AND f.format=?)'); a.push(fmt); }
  for (const v of sp.getAll('attr')) { const [x, y] = v.split(':').map((n) => int(n, 0)); if (x && y) { w.push('EXISTS(SELECT 1 FROM product_attributes x WHERE x.product_id=p.id AND x.attribute_id=? AND x.value_id=?)'); a.push(x, y); } }
  if (sp.get('price_min')) { w.push('p.price_stars>=?'); a.push(int(sp.get('price_min'), 0)); }
  if (sp.get('price_max')) { w.push('p.price_stars<=?'); a.push(int(sp.get('price_max'), 1e9)); }
  if (sp.get('featured') === '1') w.push('p.featured=1');
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const order = ORDER[sp.get('sort') || ''] || (admin ? ORDER.updated : ORDER.featured);
  const settings = await getSettings(env);
  const limit = Math.min(50, Math.max(1, int(sp.get('limit'), settings.page_size || 20)));
  const page = Math.max(1, int(sp.get('page'), 1));
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM products p ${where}`).bind(...a).first())!.n;
  const rows = await q(env, `SELECT p.id,p.sku,p.slug,p.name_ru,p.name_kk,p.name_en,p.price_stars,p.featured,p.status,p.category_id,p.audience_id,p.updated_at,
    (SELECT i.storage_key FROM product_images i WHERE i.product_id=p.id ORDER BY (i.kind='main') DESC,i.sort,i.id LIMIT 1) image_key
    FROM products p ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...a, limit, (page - 1) * limit);
  if (rows.length) {
    const pid = rows.map((r) => r.id); const ph = pid.map(() => '?').join(',');
    const [sz, fm] = await Promise.all([
      q(env, `SELECT x.product_id pid,s.id,s.label FROM product_sizes x JOIN sizes s ON s.id=x.size_id WHERE x.product_id IN (${ph}) ORDER BY s.sort,s.id`, ...pid),
      q(env, `SELECT DISTINCT product_id pid,format FROM product_files WHERE active=1 AND product_id IN (${ph})`, ...pid),
    ]);
    for (const r of rows) { r.image = imgUrl(r.image_key); delete r.image_key; r.sizes = sz.filter((x) => x.pid === r.id).map((x) => ({ id: x.id, label: x.label })); r.formats = fm.filter((x) => x.pid === r.id).map((x) => x.format); }
  }
  return { items: rows, total, page, limit };
}

export async function productDetail(env: Env, key: string, admin = false) {
  const col = /^\d+$/.test(key) ? 'id' : 'slug';
  const p = await env.DB.prepare(`SELECT * FROM products WHERE ${col}=?`).bind(key).first();
  if (!p || (!admin && p.status !== 'published')) return null;
  const id = p.id;
  const [images, files, sizes, heights, tags, attributes] = await Promise.all([
    q(env, 'SELECT id,storage_key,kind,sort FROM product_images WHERE product_id=? ORDER BY (kind=\'main\') DESC,sort,id', id),
    admin ? q(env, 'SELECT id,format,filename,size,checksum,version,active,created_at FROM product_files WHERE product_id=? ORDER BY format,version DESC', id)
      : q(env, 'SELECT id,format,filename,size,version FROM product_files WHERE product_id=? AND active=1 ORDER BY format', id),
    q(env, 'SELECT s.id,s.label,s.group_id FROM product_sizes x JOIN sizes s ON s.id=x.size_id WHERE x.product_id=? ORDER BY s.sort,s.id', id),
    q(env, 'SELECT h.id,h.label,h.cm,h.group_id FROM product_heights x JOIN heights h ON h.id=x.height_id WHERE x.product_id=? ORDER BY h.sort,h.id', id),
    q(env, 'SELECT t.id,t.slug FROM product_tags x JOIN tags t ON t.id=x.tag_id WHERE x.product_id=? ORDER BY t.sort', id),
    q(env, 'SELECT attribute_id,value_id,text_value FROM product_attributes WHERE product_id=? ORDER BY id', id),
  ]);
  for (const i of images) { i.url = imgUrl(i.storage_key); delete i.storage_key; }
  return { ...p, images, files, sizes, heights, tags, attributes };
}

// ---------- запись товара (админ) ----------
function cleanProduct(b: any, partial: boolean) {
  const o: any = {};
  const s = (k: string, max: number, req = false) => {
    if (b[k] === undefined && (partial || !req)) return;
    const v = String(b[k] ?? '').trim();
    if ((req && !v) || v.length > max) throw new HttpError(400, 'validation', { field: k });
    o[k] = v;
  };
  const n = (k: string, min: number, max: number, nullable = false) => {
    if (b[k] === undefined) return;
    if (nullable && (b[k] === null || b[k] === '')) { o[k] = null; return; }
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, 'validation', { field: k });
    o[k] = v;
  };
  s('sku', 40, true); if (o.sku !== undefined && !/^[A-Za-z0-9._-]+$/.test(o.sku)) throw new HttpError(400, 'validation', { field: 'sku' });
  s('name_ru', 200, true); s('name_kk', 200); s('name_en', 200); s('desc_ru', 5000); s('desc_kk', 5000); s('desc_en', 5000);
  s('slug', 80); if (o.slug && !/^[a-z0-9-]+$/.test(o.slug)) throw new HttpError(400, 'validation', { field: 'slug' });
  s('currency', 8);
  for (const k of ['category_id', 'audience_id']) { if (b[k] !== undefined) o[k] = b[k] === null || b[k] === '' ? null : int(b[k], -1); if (o[k] === -1) throw new HttpError(400, 'validation', { field: k }); }
  n('price_stars', 0, 1000000); if (o.price_stars !== undefined && !Number.isInteger(o.price_stars)) throw new HttpError(400, 'validation', { field: 'price_stars' });
  n('price_display', 0, 1e9, true); n('pieces_count', 0, 10000); n('sort', -100000, 100000);
  if (b.featured !== undefined) o.featured = b.featured ? 1 : 0;
  const ids = (k: string) => { if (b[k] === undefined) return; if (!Array.isArray(b[k]) || b[k].length > 500) throw new HttpError(400, 'validation', { field: k }); const r = [...new Set(b[k].map((x: any) => int(x, 0)))] as number[]; if (r.some((x) => x <= 0)) throw new HttpError(400, 'validation', { field: k }); o[k] = r; };
  ids('size_ids'); ids('height_ids'); ids('tag_ids');
  if (b.attributes !== undefined) {
    if (!Array.isArray(b.attributes) || b.attributes.length > 100) throw new HttpError(400, 'validation', { field: 'attributes' });
    o.attributes = b.attributes.map((x: any) => ({ attribute_id: int(x?.attribute_id, 0), value_id: x?.value_id ? int(x.value_id, 0) : null, text_value: x?.text_value ? String(x.text_value).slice(0, 500) : null })).filter((x: any) => x.attribute_id > 0 && (x.value_id || x.text_value));
  }
  return o;
}
const dbErr = (e: any): never => {
  const m = String(e?.message || e);
  if (e instanceof HttpError) throw e;
  if (/UNIQUE/i.test(m)) throw new HttpError(409, 'duplicate');
  if (/FOREIGN KEY/i.test(m)) throw new HttpError(409, 'invalid_reference');
  if (/CHECK/i.test(m)) throw new HttpError(400, 'validation');
  throw e;
};
export { dbErr };

export async function saveProduct(env: Env, body: any, id?: number) {
  const o = cleanProduct(body, !!id);
  const t = now(); const st: any[] = [];
  let pidSql = '?'; let pidVal: any = id;
  if (!id) {
    if (!o.sku || !o.name_ru) throw new HttpError(400, 'validation');
    const slug = o.slug || slugify(o.sku) || 'p-' + t;
    st.push(env.DB.prepare('INSERT INTO products(sku,slug,name_ru,name_kk,name_en,desc_ru,desc_kk,desc_en,category_id,audience_id,price_stars,price_display,currency,pieces_count,featured,sort,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(o.sku, slug, o.name_ru, o.name_kk ?? '', o.name_en ?? '', o.desc_ru ?? '', o.desc_kk ?? '', o.desc_en ?? '', o.category_id ?? null, o.audience_id ?? null, o.price_stars ?? 0, o.price_display ?? null, o.currency || null, o.pieces_count ?? 0, o.featured ?? 0, o.sort ?? 0, 'draft', t, t));
    pidSql = '(SELECT id FROM products WHERE sku=?)'; pidVal = o.sku;
  } else {
    const cols = ['sku', 'slug', 'name_ru', 'name_kk', 'name_en', 'desc_ru', 'desc_kk', 'desc_en', 'category_id', 'audience_id', 'price_stars', 'price_display', 'currency', 'pieces_count', 'featured', 'sort'].filter((k) => o[k] !== undefined);
    if (cols.length) st.push(env.DB.prepare(`UPDATE products SET ${cols.map((k) => k + '=?').join(',')},updated_at=? WHERE id=?`).bind(...cols.map((k) => (o[k] === '' && k === 'currency' ? null : o[k])), t, id));
    else st.push(env.DB.prepare('UPDATE products SET updated_at=? WHERE id=?').bind(t, id));
  }
  const rel = (key: string, tbl: string, col: string) => {
    if (o[key] === undefined) return;
    if (id) st.push(env.DB.prepare(`DELETE FROM ${tbl} WHERE product_id=?`).bind(id));
    for (const v of o[key]) st.push(env.DB.prepare(`INSERT INTO ${tbl}(product_id,${col}) VALUES(${pidSql},?)`).bind(pidVal, v));
  };
  rel('size_ids', 'product_sizes', 'size_id'); rel('height_ids', 'product_heights', 'height_id'); rel('tag_ids', 'product_tags', 'tag_id');
  if (o.attributes !== undefined) {
    if (id) st.push(env.DB.prepare('DELETE FROM product_attributes WHERE product_id=?').bind(id));
    for (const x of o.attributes) st.push(env.DB.prepare(`INSERT INTO product_attributes(product_id,attribute_id,value_id,text_value) VALUES(${pidSql},?,?,?)`).bind(pidVal, x.attribute_id, x.value_id, x.text_value));
  }
  if (id && !(await env.DB.prepare('SELECT 1 x FROM products WHERE id=?').bind(id).first())) throw new HttpError(404, 'not_found');
  try { await env.DB.batch(st); } catch (e) { dbErr(e); }
  const row = await env.DB.prepare(id ? 'SELECT id FROM products WHERE id=?' : 'SELECT id FROM products WHERE sku=?').bind(id ?? o.sku).first();
  return productDetail(env, String(row!.id), true);
}

const STATUSES = ['draft', 'ready', 'published', 'hidden', 'archived'];
export async function setStatus(env: Env, id: number, status: string) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'validation', { field: 'status' });
  const p = await productDetail(env, String(id), true);
  if (!p) throw new HttpError(404, 'not_found');
  if (status === 'published' || status === 'ready') {
    const missing: string[] = [];
    if (!p.name_ru) missing.push('name_ru');
    if (!(p.price_stars >= 1)) missing.push('price');
    if (!p.category_id) missing.push('category');
    if (status === 'published') {
      if (!p.images.length) missing.push('image');
      if (!p.files.some((f: any) => f.active)) missing.push('file');
    }
    if (missing.length) throw new HttpError(409, 'not_ready', { missing });
  }
  const t = now();
  await env.DB.prepare('UPDATE products SET status=?,updated_at=?,published_at=CASE WHEN ?=\'published\' THEN COALESCE(published_at,?) ELSE published_at END WHERE id=?').bind(status, t, status, t, id).run();
  return { id, status, from: p.status };
}

export async function deleteProduct(env: Env, id: number, hard: boolean) {
  const sold = await env.DB.prepare('SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1').bind(id).first();
  if (hard && !sold) {
    const keys = [...(await q(env, 'SELECT storage_key k FROM product_images WHERE product_id=?', id)), ...(await q(env, 'SELECT storage_key k FROM product_files WHERE product_id=?', id))].map((x) => x.k);
    await env.DB.prepare('DELETE FROM products WHERE id=?').bind(id).run();
    if (keys.length) await env.FILES.delete(keys);
    return { deleted: true };
  }
  await setStatus(env, id, 'archived');
  return { archived: true, reason: sold ? 'has_orders' : 'soft' };
}

// ---------- универсальные справочники ----------
type Dict = { table: string; cols: string[]; ints: string[]; req: string[]; order: string; pk?: string; ts?: boolean };
const NAMES = ['name_ru', 'name_kk', 'name_en'];
export const DICTS: Record<string, Dict> = {
  categories: { table: 'categories', cols: ['parent_id', 'slug', ...NAMES, 'image_key', 'sort', 'hidden', 'archived'], ints: ['parent_id', 'sort', 'hidden', 'archived'], req: ['slug', 'name_ru'], order: 'sort,id', ts: true },
  audiences: { table: 'audiences', cols: ['slug', ...NAMES, 'sort', 'hidden'], ints: ['sort', 'hidden'], req: ['slug', 'name_ru'], order: 'sort,id' },
  size_groups: { table: 'size_groups', cols: ['slug', ...NAMES, 'sort'], ints: ['sort'], req: ['slug', 'name_ru'], order: 'sort,id' },
  sizes: { table: 'sizes', cols: ['group_id', 'label', 'sort', 'hidden'], ints: ['group_id', 'sort', 'hidden'], req: ['group_id', 'label'], order: 'group_id,sort,id' },
  height_groups: { table: 'height_groups', cols: ['slug', ...NAMES, 'sort'], ints: ['sort'], req: ['slug', 'name_ru'], order: 'sort,id' },
  heights: { table: 'heights', cols: ['group_id', 'label', 'cm', 'sort', 'hidden'], ints: ['group_id', 'cm', 'sort', 'hidden'], req: ['group_id', 'label'], order: 'group_id,sort,id' },
  tags: { table: 'tags', cols: ['slug', ...NAMES, 'sort', 'hidden'], ints: ['sort', 'hidden'], req: ['slug', 'name_ru'], order: 'sort,id' },
  attributes: { table: 'attributes', cols: ['slug', 'kind', 'filterable', ...NAMES, 'sort'], ints: ['filterable', 'sort'], req: ['slug', 'name_ru'], order: 'sort,id' },
  attribute_values: { table: 'attribute_values', cols: ['attribute_id', 'value_ru', 'value_kk', 'value_en', 'sort'], ints: ['attribute_id', 'sort'], req: ['attribute_id', 'value_ru'], order: 'attribute_id,sort,id' },
  file_formats: { table: 'file_formats', pk: 'code', cols: ['code', 'label', 'ext', 'sort', 'active'], ints: ['sort', 'active'], req: ['code', 'label', 'ext'], order: 'sort,code' },
};
function cleanDict(d: Dict, b: any, partial: boolean) {
  const o: any = {};
  for (const k of d.cols) {
    if (b?.[k] === undefined) { if (!partial && d.req.includes(k)) throw new HttpError(400, 'validation', { field: k }); continue; }
    if (d.ints.includes(k)) { const v = b[k]; o[k] = v === null || v === '' ? null : Number(v); if (o[k] !== null && !Number.isInteger(o[k])) throw new HttpError(400, 'validation', { field: k }); if (o[k] === null && d.req.includes(k)) throw new HttpError(400, 'validation', { field: k }); }
    else { const v = String(b[k] ?? '').trim(); if (v.length > 200 || (d.req.includes(k) && !v)) throw new HttpError(400, 'validation', { field: k }); o[k] = v; }
  }
  if (o.slug !== undefined && !/^[a-z0-9-]+$/.test(o.slug)) throw new HttpError(400, 'validation', { field: 'slug' });
  if (o.code !== undefined && !/^[a-z0-9_]+$/.test(o.code)) throw new HttpError(400, 'validation', { field: 'code' });
  if (o.ext !== undefined && !/^[a-z0-9]{1,8}$/.test(o.ext)) throw new HttpError(400, 'validation', { field: 'ext' });
  if (o.kind !== undefined && !['text', 'choice'].includes(o.kind)) throw new HttpError(400, 'validation', { field: 'kind' });
  return o;
}
export const dictList = (env: Env, name: string) => q(env, `SELECT * FROM ${DICTS[name].table} ORDER BY ${DICTS[name].order}`);
export async function dictSave(env: Env, name: string, body: any, id?: string) {
  const d = DICTS[name]; const pk = d.pk || 'id'; const o = cleanDict(d, body, !!id);
  const cols = Object.keys(o);
  try {
    if (id) {
      if (!cols.length) throw new HttpError(400, 'validation');
      const set = cols.map((k) => k + '=?').join(',') + (d.ts ? ',updated_at=?' : '');
      const r: any = await env.DB.prepare(`UPDATE ${d.table} SET ${set} WHERE ${pk}=?`).bind(...cols.map((k) => o[k]), ...(d.ts ? [now()] : []), id).run();
      if (r.meta?.changes === 0) throw new HttpError(404, 'not_found');
      return env.DB.prepare(`SELECT * FROM ${d.table} WHERE ${pk}=?`).bind(o[pk] ?? id).first();
    }
    const r: any = await env.DB.prepare(`INSERT INTO ${d.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).bind(...cols.map((k) => o[k])).run();
    return env.DB.prepare(`SELECT * FROM ${d.table} WHERE ${pk}=?`).bind(pk === 'id' ? r.meta.last_row_id : o[pk]).first();
  } catch (e) { return dbErr(e); }
}
export async function dictDelete(env: Env, name: string, id: string) {
  const d = DICTS[name];
  try { const r: any = await env.DB.prepare(`DELETE FROM ${d.table} WHERE ${d.pk || 'id'}=?`).bind(id).run(); if (r.meta?.changes === 0) throw new HttpError(404, 'not_found'); }
  catch (e: any) { if (/FOREIGN KEY/i.test(String(e?.message))) throw new HttpError(409, 'in_use'); throw e; }
}
