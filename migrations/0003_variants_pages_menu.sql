-- 0003: варианты товара (размер × рост), редактируемые страницы, меню, загрузка файлов по частям.
-- ВАЖНО: перед применением сделайте резервную копию базы (README, раздел «Резервная копия»).
-- Миграция только добавляет таблицы/колонки и пересобирает purchases и order_items с копированием данных.
PRAGMA foreign_keys = ON;

-- ---------- варианты ----------
CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_id INTEGER NOT NULL REFERENCES sizes(id) ON DELETE RESTRICT,
  height_id INTEGER REFERENCES heights(id) ON DELETE RESTRICT,
  height_key INTEGER NOT NULL DEFAULT 0,            -- COALESCE(height_id,0): нужен для уникальности
  available INTEGER NOT NULL DEFAULT 1,             -- есть в наличии
  active INTEGER NOT NULL DEFAULT 1,                -- включён (выключенный не виден покупателям)
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (product_id, size_id, height_key)
);
CREATE INDEX idx_variants_product ON product_variants(product_id, active);

-- файл с variant_id = NULL общий для всех вариантов товара
ALTER TABLE product_files ADD COLUMN variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE;
CREATE INDEX idx_product_files_variant ON product_files(variant_id);

ALTER TABLE categories ADD COLUMN audience_id INTEGER REFERENCES audiences(id) ON DELETE SET NULL;

-- ---------- пересборка order_items (уникальность теперь по товару и варианту) ----------
CREATE TABLE order_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  variant_key INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, sku TEXT NOT NULL, price_stars INTEGER NOT NULL,
  size_id INTEGER REFERENCES sizes(id) ON DELETE SET NULL, height_id INTEGER REFERENCES heights(id) ON DELETE SET NULL,
  UNIQUE (order_id, product_id, variant_key)
);
INSERT INTO order_items_new(id,order_id,product_id,title,sku,price_stars,size_id,height_id)
  SELECT id,order_id,product_id,title,sku,price_stars,size_id,height_id FROM order_items;
DROP TABLE order_items;
ALTER TABLE order_items_new RENAME TO order_items;

-- ---------- пересборка purchases (доступ по пользователю, товару и варианту) ----------
CREATE TABLE purchases_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE RESTRICT,
  variant_key INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), revoked_at INTEGER,
  UNIQUE (user_id, product_id, variant_key)
);
INSERT INTO purchases_new(id,user_id,product_id,order_id,created_at,revoked_at)
  SELECT id,user_id,product_id,order_id,created_at,revoked_at FROM purchases;
DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;
CREATE INDEX idx_purchases_user ON purchases(user_id);

-- ---------- страницы и блоки ----------
CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('info','legal','custom')),
  title_ru TEXT NOT NULL, title_kk TEXT NOT NULL DEFAULT '', title_en TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE page_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('heading','text','faq','button','image')),
  data TEXT NOT NULL DEFAULT '{}',                  -- JSON: {"ru":{...},"kk":{...},"en":{...},"url":...,"key":...}
  sort INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_page_blocks_page ON page_blocks(page_id, sort);

-- ---------- меню (вкладки нижней панели) ----------
CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL UNIQUE,                      -- cat | cart | buys | info | page:<slug>
  icon TEXT NOT NULL DEFAULT 'info',
  label_ru TEXT NOT NULL, label_kk TEXT NOT NULL DEFAULT '', label_en TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 1
);

-- ---------- загрузка файлов по частям (продолжение после обрыва) ----------
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL, r2_upload_id TEXT NOT NULL,
  product_id INTEGER NOT NULL, variant_id INTEGER,
  format TEXT NOT NULL, filename TEXT NOT NULL,
  size INTEGER NOT NULL, part_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','aborted')),
  admin_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  n INTEGER NOT NULL, etag TEXT NOT NULL,
  PRIMARY KEY (upload_id, n)
);

-- ---------- стартовое содержимое ----------
INSERT INTO menu_items(target,icon,label_ru,label_kk,label_en,sort) VALUES
 ('cat','catalog','Каталог','Каталог','Catalog',1),
 ('cart','cart','Корзина','Себет','Cart',2),
 ('buys','bag','Покупки','Сатып алу','Purchases',3),
 ('info','info','Инфо','Ақпарат','Info',4);

INSERT INTO pages(slug,kind,title_ru,title_kk,title_en,sort) VALUES ('info','info','Инфо','Ақпарат','Info',1);
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'text','{"ru":{"t":"Цифровые лекала одежды."},"kk":{"t":"Киімнің сандық қалыптары."},"en":{"t":"Digital clothing patterns."}}',1 FROM pages WHERE slug='info';
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'heading','{"ru":{"t":"Как это работает"},"kk":{"t":"Бұл қалай жұмыс істейді"},"en":{"t":"How it works"}}',2 FROM pages WHERE slug='info';
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'text','{"ru":{"t":"1. Выберите лекало в каталоге\n2. Оплатите в Telegram Stars\n3. Файлы появятся в разделе «Покупки»"},"kk":{"t":"1. Каталогтан қалыпты таңдаңыз\n2. Telegram Stars арқылы төлеңіз\n3. Файлдар «Сатып алу» бөлімінде пайда болады"},"en":{"t":"1. Pick a pattern in the catalog\n2. Pay with Telegram Stars\n3. Files appear in Purchases"}}',3 FROM pages WHERE slug='info';
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'heading','{"ru":{"t":"Вопросы и ответы"},"kk":{"t":"Сұрақ-жауап"},"en":{"t":"FAQ"}}',4 FROM pages WHERE slug='info';
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'faq','{"ru":{"q":"Как собрать PDF A4?","a":"Печатайте в масштабе 100% и склейте листы по меткам на полях. Тестовый квадрат 10 × 10 см проверит масштаб."},"kk":{"q":"A4 PDF-ті қалай жинауға болады?","a":"100% масштабта басып шығарып, парақтарды жиектегі белгілер бойынша желімдеңіз. 10 × 10 см сынақ шаршысы масштабты тексереді."},"en":{"q":"How do I assemble the A4 PDF?","a":"Print at 100% scale and tape the sheets along the margin marks. The 10 × 10 cm test square checks the scale."}}',5 FROM pages WHERE slug='info';
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'faq','{"ru":{"q":"Чем PDF для плоттера отличается от PLT?","a":"PDF печатается на широкоформатном принтере, PLT — формат плоттеров с векторной печатью."},"kk":{"q":"Плоттерге арналған PDF пен PLT айырмашылығы неде?","a":"PDF кең форматты принтерде басылады, PLT — векторлық плоттерлерге арналған формат."},"en":{"q":"PDF Plotter vs PLT?","a":"PDF prints on a wide-format printer; PLT is the vector format for plotters."}}',6 FROM pages WHERE slug='info';
INSERT INTO page_blocks(page_id,type,data,sort) SELECT id,'faq','{"ru":{"q":"Можно ли вернуть оплату?","a":"Да, если файлы не открываются или пришли не те. Напишите в поддержку с номером заказа."},"kk":{"q":"Төлемді қайтаруға бола ма?","a":"Иә, егер файлдар ашылмаса немесе басқа файл келсе. Қолдау қызметіне тапсырыс нөмірімен жазыңыз."},"en":{"q":"Can I get a refund?","a":"Yes, if files don’t open or are not the ones you bought. Contact support with your order number."}}',7 FROM pages WHERE slug='info';
