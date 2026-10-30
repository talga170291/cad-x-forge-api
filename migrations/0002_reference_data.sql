-- Начальные справочники. Это только стартовые данные: всё редактируется в админке.
INSERT INTO file_formats(code,label,ext,sort) VALUES ('pdf_a4','PDF A4','pdf',1),('pdf_plotter','PDF Plotter','pdf',2),('plt','PLT','plt',3);

INSERT INTO audiences(slug,name_ru,name_kk,name_en,sort) VALUES
 ('women','Женская','Әйелдер','Women',1),('men','Мужская','Ерлер','Men',2),('kids','Детская','Балалар','Kids',3),
 ('unisex','Унисекс','Унисекс','Unisex',4),('other','Другое','Басқа','Other',5);

INSERT INTO categories(slug,name_ru,name_kk,name_en,sort) VALUES
 ('dresses','Платья','Көйлектер','Dresses',1),('blouses','Блузки','Блузкалар','Blouses',2),('shirts','Рубашки','Жейделер','Shirts',3),
 ('t-shirts','Футболки','Футболкалар','T-shirts',4),('tops','Топы','Топтар','Tops',5),('skirts','Юбки','Юбкалар','Skirts',6),
 ('trousers','Брюки','Шалбар','Trousers',7),('shorts','Шорты','Шорттар','Shorts',8),('jackets','Жакеты','Жакеттер','Jackets',9),
 ('blazers','Пиджаки','Пиджактер','Blazers',10),('vests','Жилеты','Жилеттер','Vests',11),('coats','Пальто','Пальто','Coats',12),
 ('casual-jackets','Куртки','Күртешелер','Casual jackets',13),('trench-coats','Плащи','Плащтар','Trench coats',14),
 ('outerwear','Верхняя одежда','Сырт киім','Outerwear',15),('sportswear','Спортивная одежда','Спорт киімі','Sportswear',16),
 ('menswear','Мужская одежда','Ерлер киімі','Menswear',17),('womenswear','Женская одежда','Әйелдер киімі','Womenswear',18),
 ('kidswear','Детская одежда','Балалар киімі','Kidswear',19),('accessories','Аксессуары','Аксессуарлар','Accessories',20),
 ('workwear','Специальная одежда','Арнайы киім','Workwear',21),('other','Другое','Басқа','Other',22);

INSERT INTO size_groups(slug,name_ru,name_kk,name_en,sort) VALUES
 ('women','Женская одежда','Әйелдер киімі','Women',1),('men','Мужская одежда','Ерлер киімі','Men',2),
 ('kids','Детская одежда','Балалар киімі','Kids',3),('letters','Буквенные','Әріптік','Letter sizes',4);
INSERT INTO sizes(group_id,label,sort) WITH RECURSIVE n(x) AS (SELECT 32 UNION ALL SELECT x+2 FROM n WHERE x<68)
  SELECT (SELECT id FROM size_groups WHERE slug='women'), x, x FROM n;
INSERT INTO sizes(group_id,label,sort) WITH RECURSIVE n(x) AS (SELECT 44 UNION ALL SELECT x+2 FROM n WHERE x<66)
  SELECT (SELECT id FROM size_groups WHERE slug='men'), x, x FROM n;
INSERT INTO sizes(group_id,label,sort) WITH RECURSIVE n(x) AS (SELECT 28 UNION ALL SELECT x+2 FROM n WHERE x<40)
  SELECT (SELECT id FROM size_groups WHERE slug='kids'), x, x FROM n;
INSERT INTO sizes(group_id,label,sort) SELECT g.id, v.l, v.s FROM size_groups g,
  (SELECT 'XS' l,1 s UNION ALL SELECT 'S',2 UNION ALL SELECT 'M',3 UNION ALL SELECT 'L',4 UNION ALL SELECT 'XL',5 UNION ALL SELECT 'XXL',6 UNION ALL SELECT '3XL',7) v
  WHERE g.slug='letters';

INSERT INTO height_groups(slug,name_ru,name_kk,name_en,sort) VALUES
 ('adult','Взрослые','Ересектер','Adults',1),('kids','Детские','Балалар','Kids',2);
INSERT INTO heights(group_id,label,cm,sort) WITH RECURSIVE n(x) AS (SELECT 146 UNION ALL SELECT x+6 FROM n WHERE x<188)
  SELECT (SELECT id FROM height_groups WHERE slug='adult'), x, x, x FROM n;
INSERT INTO heights(group_id,label,cm,sort) WITH RECURSIVE n(x) AS (SELECT 80 UNION ALL SELECT x+6 FROM n WHERE x<164)
  SELECT (SELECT id FROM height_groups WHERE slug='kids'), x, x, x FROM n;

INSERT INTO tags(slug,name_ru,name_kk,name_en,sort) VALUES
 ('new','Новинка','Жаңа','New',1),('bestseller','Хит продаж','Танымал','Bestseller',2),('premium','Премиум','Премиум','Premium',3),
 ('beginner','Для начинающих','Бастаушыларға','Beginner',4),('advanced','Для опытных','Тәжірибелілерге','Advanced',5),('cad','CAD','CAD','CAD',6);

INSERT INTO attributes(slug,kind,filterable,name_ru,name_kk,name_en,sort) VALUES
 ('garment-type','text',0,'Тип изделия','Бұйым түрі','Garment type',1),
 ('difficulty','choice',1,'Сложность','Күрделілік','Difficulty',2),
 ('ease','text',0,'Прибавки на свободу облегания','Жайлылық қосымшалары','Fit ease',3),
 ('instruction-language','choice',0,'Язык инструкции','Нұсқаулық тілі','Instruction language',4);
INSERT INTO attribute_values(attribute_id,value_ru,value_kk,value_en,sort) SELECT id,'Начальный','Бастапқы','Beginner',1 FROM attributes WHERE slug='difficulty';
INSERT INTO attribute_values(attribute_id,value_ru,value_kk,value_en,sort) SELECT id,'Средний','Орташа','Intermediate',2 FROM attributes WHERE slug='difficulty';
INSERT INTO attribute_values(attribute_id,value_ru,value_kk,value_en,sort) SELECT id,'Сложный','Күрделі','Advanced',3 FROM attributes WHERE slug='difficulty';
INSERT INTO attribute_values(attribute_id,value_ru,value_kk,value_en,sort) SELECT id,'Русский','Орыс тілі','Russian',1 FROM attributes WHERE slug='instruction-language';
INSERT INTO attribute_values(attribute_id,value_ru,value_kk,value_en,sort) SELECT id,'Қазақша','Қазақша','Kazakh',2 FROM attributes WHERE slug='instruction-language';
INSERT INTO attribute_values(attribute_id,value_ru,value_kk,value_en,sort) SELECT id,'English','English','English',3 FROM attributes WHERE slug='instruction-language';

INSERT INTO store_settings(key,value) VALUES
 ('store_name','"CAD x FORGE"'),('store_description','""'),('support_username','""'),('bot_username','""'),
 ('default_lang','"ru"'),('languages','["ru","kk","en"]'),('currency_label','"★"'),('maintenance','false'),
 ('page_size','20'),('logo_key','""'),('msg_welcome','{}'),('msg_paid','{}');
