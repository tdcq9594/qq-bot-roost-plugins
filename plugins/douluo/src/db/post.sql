-- ============================================================
-- 依赖「内容包」的增量（v12）
--
-- 这个文件在 content-pack.sql **之后**执行。
-- 教训：patch.sql 跑在内容包之前，任何「按名字 SELECT 怪物/地图」的语句
-- 在那里都会静默命中 0 行（不报错、没数据），查了很久才发现是顺序问题。
-- ============================================================

-- 按年龄档给魂兽挂技能（数据驱动，不用手填 54 行）
INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 3 FROM monster m, skill s WHERE m.age < 100 AND s.id BETWEEN 10 AND 13;
INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 3 FROM monster m, skill s WHERE m.age >= 100 AND m.age < 1000 AND s.id BETWEEN 14 AND 17;
INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 3 FROM monster m, skill s WHERE m.age >= 1000 AND m.age < 10000 AND s.id BETWEEN 18 AND 21;
INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s WHERE m.age >= 10000 AND m.age < 100000 AND s.id BETWEEN 22 AND 25;
INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s WHERE m.age >= 100000 AND s.id BETWEEN 26 AND 29;

-- ---------- 更多可占领领地 ----------
INSERT OR IGNORE INTO territory_def (map_id, mine_gold, mine_item_id, mine_item_qty, desc)
  SELECT id, 35, 3, 2, '星斗中心：每小时 35 魂币 + 2 碎片' FROM map WHERE name = '星斗中心';
INSERT OR IGNORE INTO territory_def (map_id, mine_gold, mine_item_id, mine_item_qty, desc)
  SELECT id, 25, 201, 1, '落日森林：每小时 25 魂币 + 1 蓝银草' FROM map WHERE name = '落日森林';
INSERT OR IGNORE INTO territory_def (map_id, mine_gold, mine_item_id, mine_item_qty, desc)
  SELECT id, 60, 204, 1, '天青湖：每小时 60 魂币 + 相思断肠红' FROM map WHERE name = '天青湖';

-- ---------- 补 4 张只有 0–1 只怪的地图 ----------
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '诺丁城' AND m.name IN ('哥布林', '魔狼') ;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '猎魂森林' AND m.name IN ('金刚虎', '风灵猴', '厚甲龟');

-- 图鉴奖励档位
INSERT OR IGNORE INTO bestiary_reward (count, gold, coupon, items, desc) VALUES
  (5,  500,  0,  '[]', '解锁 5 种魂兽'),
  (10, 1200, 10, '[]', '解锁 10 种魂兽'),
  (20, 3000, 30, '[{"id":3,"qty":10}]', '解锁 20 种魂兽'),
  (30, 6000, 60, '[{"id":3,"qty":20}]', '解锁 30 种魂兽'),
  (40, 12000,120,'[{"id":3,"qty":40}]', '解锁 40 种魂兽'),
  (50, 25000,300,'[{"id":3,"qty":80}]', '解锁全部 50 种魂兽');

-- ---------- 补只有 1 只怪的地图（必须等内容包加载完） ----------
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '圣天崖' AND m.name IN ('鬼藤', '妖眼魔树');
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '邪魔森林' AND m.name IN ('暗魔邪神虎', '鬼藤');
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '龙族墓地' AND m.name IN ('地狱魔龙', '地龙');

-- ---------- 新地图接入世界（按名字连，不依赖 id） ----------
-- 风起地 挂在圣魂村北边，之后一路往东，形成一条「异界支线」
UPDATE map SET north = (SELECT id FROM map WHERE name = '风起地') WHERE name = '圣魂村' AND north IS NULL;
UPDATE map SET south = (SELECT id FROM map WHERE name = '圣魂村') WHERE name = '风起地' AND south IS NULL;
UPDATE map SET north = (SELECT id FROM map WHERE name = '无妄坡') WHERE name = '风起地' AND north IS NULL;
UPDATE map SET south = (SELECT id FROM map WHERE name = '风起地') WHERE name = '无妄坡' AND south IS NULL;
UPDATE map SET north = (SELECT id FROM map WHERE name = '绝云间') WHERE name = '无妄坡' AND north IS NULL;
UPDATE map SET south = (SELECT id FROM map WHERE name = '无妄坡') WHERE name = '绝云间' AND south IS NULL;
UPDATE map SET east  = (SELECT id FROM map WHERE name = '璃月港') WHERE name = '绝云间' AND east IS NULL;
UPDATE map SET west  = (SELECT id FROM map WHERE name = '绝云间') WHERE name = '璃月港' AND west IS NULL;
UPDATE map SET east  = (SELECT id FROM map WHERE name = '稻妻城') WHERE name = '璃月港' AND east IS NULL;
UPDATE map SET west  = (SELECT id FROM map WHERE name = '璃月港') WHERE name = '稻妻城' AND west IS NULL;
UPDATE map SET east  = (SELECT id FROM map WHERE name = '须弥城') WHERE name = '稻妻城' AND east IS NULL;
UPDATE map SET west  = (SELECT id FROM map WHERE name = '稻妻城') WHERE name = '须弥城' AND west IS NULL;
UPDATE map SET north = (SELECT id FROM map WHERE name = '卡塞尔学院') WHERE name = '璃月港' AND north IS NULL;
UPDATE map SET south = (SELECT id FROM map WHERE name = '璃月港') WHERE name = '卡塞尔学院' AND south IS NULL;
UPDATE map SET north = (SELECT id FROM map WHERE name = '青铜城') WHERE name = '卡塞尔学院' AND north IS NULL;
UPDATE map SET south = (SELECT id FROM map WHERE name = '卡塞尔学院') WHERE name = '青铜城' AND south IS NULL;
UPDATE map SET north = (SELECT id FROM map WHERE name = '白帝城') WHERE name = '青铜城' AND north IS NULL;
UPDATE map SET south = (SELECT id FROM map WHERE name = '青铜城') WHERE name = '白帝城' AND south IS NULL;
UPDATE map SET east  = (SELECT id FROM map WHERE name = '星斗大森林·深处') WHERE name = '星斗中心' AND east IS NULL;
UPDATE map SET west  = (SELECT id FROM map WHERE name = '星斗中心') WHERE name = '星斗大森林·深处' AND west IS NULL;

-- ---------- 新地图配怪（按等级挑最接近的魂兽） ----------
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '风起地' AND m.age < 100 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '无妄坡' AND m.age BETWEEN 100 AND 1000 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '绝云间' AND m.age BETWEEN 1000 AND 10000 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '璃月港' AND m.age BETWEEN 1000 AND 10000 LIMIT 2;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '稻妻城' AND m.age BETWEEN 10000 AND 100000 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '须弥城' AND m.age >= 10000 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '卡塞尔学院' AND m.age BETWEEN 1000 AND 10000 LIMIT 2;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '青铜城' AND m.age >= 10000 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '白帝城' AND m.age >= 100000 LIMIT 3;
INSERT OR IGNORE INTO monster_map (monster_id, map_id)
  SELECT m.id, mp.id FROM monster m, map mp
  WHERE mp.name = '星斗大森林·深处' AND m.age >= 100000 LIMIT 3;

-- ---------- 原著向武魂（系列 id 来自内容包，必须等它加载完） ----------
INSERT OR IGNORE INTO wuhun (id, name, series_id, rarity, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES
(320, '七杀剑',    1,  4, 140, 150, 25, 9,  15, 18, 12, 6, 12, 180, '剑出必见血'),
  (321, '香肠',      11,  1, 160, 140, 7,  12, 9,  8,  10, 5, 3, 140, '食物系武魂，看着没用，其实是顶级辅助'),
  (322, '九宝琉璃塔', 11, 5, 190, 220, 12, 16, 11, 8,  30, 6, 6, 155, '辅助系最强武魂'),
  (323, '柔骨兔',    12,  3, 130, 150, 16, 9,  18, 10, 12, 9, 8, 160, '柔骨魅兔，速度极快'),
  (324, '蓝银皇',    2,  5, 240, 200, 21, 17, 12, 15, 22, 5, 7, 160, '蓝银草觉醒的皇者'),
  (325, '邪火凤凰',  1,  4, 180, 170, 23, 12, 14, 13, 18, 6, 10, 175, '邪火焚身，浴火重生'),
  (326, '幽冥灵猫',  12,  4, 150, 160, 20, 11, 20, 12, 16, 12, 9, 170, '幽冥之中，无声无息'),
  (327, '暗金恐爪熊', 10, 4, 300, 100, 22, 24, 6,  26, 6,  1, 5, 150, '力量与防御的极致');;

-- ============================================================

-- v18 魂兽掉落（按年龄档给不同产出）

-- 放在 post.sql：怪物来自内容包，patch 时还不存在

-- 注意：id 交给自增，别写死——写死的话 INSERT OR IGNORE 每条只会插进一行

-- ============================================================

INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 201, 35, 1, 3, '' FROM monster m WHERE m.age < 100;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 2, 18, 1, 2, '' FROM monster m WHERE m.age < 100;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 409, 8, 1, 1, '' FROM monster m WHERE m.age < 100;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 206, 30, 1, 2, '' FROM monster m WHERE m.age BETWEEN 100 AND 999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 3, 22, 1, 3, '' FROM monster m WHERE m.age BETWEEN 100 AND 999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 201, 25, 1, 4, '' FROM monster m WHERE m.age BETWEEN 100 AND 999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'equip', 30, 4, 1, 1, '' FROM monster m WHERE m.age BETWEEN 100 AND 999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 208, 26, 1, 2, '' FROM monster m WHERE m.age BETWEEN 1000 AND 9999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 3, 30, 2, 5, '' FROM monster m WHERE m.age BETWEEN 1000 AND 9999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 207, 20, 1, 2, '' FROM monster m WHERE m.age BETWEEN 1000 AND 9999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'equip', 20, 5, 1, 1, '' FROM monster m WHERE m.age BETWEEN 1000 AND 9999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'equip', 32, 3, 1, 1, '' FROM monster m WHERE m.age BETWEEN 1000 AND 9999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 210, 22, 1, 2, '' FROM monster m WHERE m.age BETWEEN 10000 AND 99999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 3, 36, 3, 6, '' FROM monster m WHERE m.age BETWEEN 10000 AND 99999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 209, 16, 1, 2, '' FROM monster m WHERE m.age BETWEEN 10000 AND 99999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'equip', 23, 4, 1, 1, '' FROM monster m WHERE m.age BETWEEN 10000 AND 99999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'equip', 33, 2, 1, 1, '' FROM monster m WHERE m.age BETWEEN 10000 AND 99999;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 211, 18, 1, 2, '' FROM monster m WHERE m.age >= 100000;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 410, 14, 1, 1, '' FROM monster m WHERE m.age >= 100000;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'item', 3, 40, 5, 10, '' FROM monster m WHERE m.age >= 100000;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'equip', 25, 3, 1, 1, '' FROM monster m WHERE m.age >= 100000;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'gem', 4, 3, 1, 1, '' FROM monster m WHERE m.age >= 1000;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'gem', 11, 2, 1, 1, '' FROM monster m WHERE m.age >= 10000;
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc) SELECT m.id, 'companion', 40, 1, 1, 1, '' FROM monster m WHERE m.age >= 100000 AND m.tier = 'boss';

-- ============================================================
-- 内容清洗：旧版 INI 里带进来的粗俗/民族敏感命名
--
-- 真机联调时在群里的魂兽列表上直接看到了这些名字。
-- 这类内容上线一次就够封号，必须在上线前清掉。
-- 保留 id 不变（地图出没、任务条件都按 id 引用），只换名字。
-- ============================================================
UPDATE monster SET name = '灰毛兔' WHERE id = 1001 AND name NOT IN ('灰毛兔');
UPDATE monster SET name = '野猪'   WHERE id = 1002 AND name NOT IN ('野猪');
UPDATE monster SET name = '山猫'   WHERE id = 1003 AND name NOT IN ('山猫');
UPDATE monster SET name = '赤狐'   WHERE id = 1004 AND name NOT IN ('赤狐');
UPDATE monster SET name = '黑狼'   WHERE id = 1005 AND name NOT IN ('黑狼');
UPDATE monster SET name = '石甲虫' WHERE id = 1006 AND name NOT IN ('石甲虫');
