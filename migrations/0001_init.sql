-- CAD x FORGE: основная схема (Cloudflare D1 / SQLite). Время хранится в Unix-секундах.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,               -- Telegram user ID
  username TEXT, first_name TEXT, last_name TEXT, lang TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '',
  image_key TEXT, sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE audiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE size_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES size_groups(id) ON DELETE RESTRICT,
  label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, label)
);
CREATE TABLE height_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE heights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES height_groups(id) ON DELETE RESTRICT,
  label TEXT NOT NULL, cm INTEGER, sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, label)
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'choice' CHECK (kind IN ('text','choice')),
  filterable INTEGER NOT NULL DEFAULT 0,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE attribute_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_id INTEGER NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  value_ru TEXT NOT NULL, value_kk TEXT NOT NULL DEFAULT '', value_en TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
-- Форматы файлов: новый формат (DXF, SVG, ZIP...) добавляется строкой, без изменения кода.
CREATE TABLE file_formats (
  code TEXT PRIMARY KEY, label TEXT NOT NULL, ext TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  name_ru TEXT NOT NULL, name_kk TEXT NOT NULL DEFAULT '', name_en TEXT NOT NULL DEFAULT '',
  desc_ru TEXT NOT NULL DEFAULT '', desc_kk TEXT NOT NULL DEFAULT '', desc_en TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  audience_id INTEGER REFERENCES audiences(id) ON DELETE RESTRICT,
  price_stars INTEGER NOT NULL DEFAULT 0 CHECK (price_stars >= 0),   -- цена продажи, Telegram Stars (XTR)
  price_display REAL, currency TEXT,                                  -- справочная цена в другой валюте (необязательно)
  pieces_count INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','published','hidden','archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), published_at INTEGER
);
CREATE INDEX idx_products_status ON products(status, sort);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_audience ON products(audience_id);
CREATE INDEX idx_products_price ON products(price_stars);

CREATE TABLE product_sizes (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_id INTEGER NOT NULL REFERENCES sizes(id) ON DELETE RESTRICT, PRIMARY KEY (product_id, size_id)
);
CREATE INDEX idx_product_sizes_size ON product_sizes(size_id);
CREATE TABLE product_heights (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  height_id INTEGER NOT NULL REFERENCES heights(id) ON DELETE RESTRICT, PRIMARY KEY (product_id, height_id)
);
CREATE INDEX idx_product_heights_height ON product_heights(height_id);
CREATE TABLE product_tags (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT, PRIMARY KEY (product_id, tag_id)
);
CREATE INDEX idx_product_tags_tag ON product_tags(tag_id);
CREATE TABLE product_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attribute_id INTEGER NOT NULL REFERENCES attributes(id) ON DELETE RESTRICT,
  value_id INTEGER REFERENCES attribute_values(id) ON DELETE RESTRICT, text_value TEXT
);
CREATE INDEX idx_product_attributes_p ON product_attributes(product_id);
CREATE INDEX idx_product_attributes_v ON product_attributes(attribute_id, value_id);

CREATE TABLE product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'extra' CHECK (kind IN ('main','extra','preview')),
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_product_images_p ON product_images(product_id, sort);
CREATE TABLE product_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  format TEXT NOT NULL REFERENCES file_formats(code) ON DELETE RESTRICT,
  filename TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL, checksum TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_product_files_p ON product_files(product_id, format, active);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,                          -- CFX-2026-000001
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
  total_stars INTEGER NOT NULL CHECK (total_stars > 0), currency TEXT NOT NULL DEFAULT 'XTR',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), expires_at INTEGER NOT NULL,
  paid_at INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  title TEXT NOT NULL, sku TEXT NOT NULL, price_stars INTEGER NOT NULL,   -- снимок на момент заказа
  size_id INTEGER REFERENCES sizes(id) ON DELETE SET NULL, height_id INTEGER REFERENCES heights(id) ON DELETE SET NULL,
  UNIQUE (order_id, product_id)
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  provider TEXT NOT NULL DEFAULT 'telegram_stars',
  telegram_charge_id TEXT NOT NULL UNIQUE,              -- защита от повторной обработки
  provider_charge_id TEXT, amount INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','mismatch','orphan','refunded')),
  raw TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), revoked_at INTEGER,
  UNIQUE (user_id, product_id)
);
CREATE INDEX idx_purchases_user ON purchases(user_id);
CREATE TABLE download_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, file_id INTEGER NOT NULL,
  kind TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_download_logs_user ON download_logs(user_id, created_at);
CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL,
  object_type TEXT, object_id TEXT, details TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
