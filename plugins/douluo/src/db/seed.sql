-- ============================================================
-- 测试数据（仅用于验证功能，数值全部是占位）
--
-- 只在 content.db 为空时灌一次。之后所有修改都走面板，
-- 这份文件不会被再次执行，所以改这里不影响已经跑起来的服。
-- ============================================================

INSERT OR REPLACE INTO content_meta (key, value) VALUES
  ('pack', 'test-seed'),
  ('version', '0.1.0'),
  ('note', '测试数据，仅用于验证功能；正式数值请在面板里填');

-- ---------- 武魂系列 ----------
INSERT OR REPLACE INTO wuhun_series (id, name, hp, mp, str, intel, atk, def, spd, desc) VALUES
  (1, '强攻系', 1.0, 0.8, 1.3, 0.7, 1.3, 0.9, 1.0, '高攻低防'),
  (2, '控制系', 1.1, 1.1, 0.8, 1.3, 0.9, 1.1, 1.1, '均衡偏智'),
  (3, '敏攻系', 0.9, 0.9, 1.0, 1.0, 1.1, 0.8, 1.4, '高速高闪');

-- ---------- 武魂 ----------
INSERT OR REPLACE INTO wuhun (id, name, series_id, rarity, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES
  (1, '蓝银草',   2, 1, 100, 120,  8,  9, 10,  8, 12,  6,  5, 150, '最常见的武魂，成长性意外地好'),
  (2, '昊天锤',   1, 4,  90,  70, 16,  8,  9, 16,  6,  4,  8, 180, '天下第一器武魂'),
  (3, '白虎',     1, 2, 120,  70, 14, 11,  9, 14,  5,  5,  6, 160, '兽武魂，皮糙肉厚'),
  (4, '柔骨兔',   3, 2,  80,  90, 11,  7, 16, 10,  8, 12,  7, 155, '敏攻系代表，先手快');

-- ---------- 魂技 ----------
INSERT OR REPLACE INTO skill (id, name, scope, power, cost, hit, cd, desc) VALUES
  (1, '蓝银缠绕', 'enemy_one', 150, 10, 95, 0, '限制对手行动'),
  (2, '乱披风锤法', 'enemy_one', 220, 18, 90, 3, '连续锤击，威力很高'),
  (3, '白虎金刚变', 'self_one',  120, 15, 100, 5, '强化自身攻击');

-- ---------- 地图 ----------
INSERT OR REPLACE INTO map (id, name, north, south, west, east, portal, min_level, desc) VALUES
  (1, '圣魂村',   2, NULL, NULL, NULL, 0, 1, '一切开始的地方'),
  (2, '诺丁城郊', 3, 1,    NULL, 3,    0, 1, '低阶魂兽出没'),
  (3, '诺丁城',   NULL, 2, 2,    NULL, 1, 5, '有传送阵和 NPC'),
  (4, '星斗森林', NULL, 2, NULL, NULL, 0, 10, '危险的魂兽森林');

-- ---------- 魂兽 ----------
INSERT OR REPLACE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES
  (1, '十年白虎',   'normal',  4,    10, 1.0, 1.0, 1.0, 1.0, 1.0, 1, '新手第一只'),
  (2, '百年曼陀罗蛇', 'normal', 4,   100, 1.1, 0.9, 1.1, 1.5, 1.2, 1, '带毒'),
  (3, '千年人面魔蛛', 'elite', 10,  1000, 1.2, 1.1, 1.2, 3.0, 2.5, 1, '精英怪'),
  (4, '万年暗金恐爪熊', 'boss', 18, 10000, 1.4, 1.3, 0.9, 8.0, 6.0, 1, '世界BOSS');

INSERT OR REPLACE INTO monster_map (monster_id, map_id) VALUES
  (1, 1), (1, 2), (2, 2), (3, 4), (4, 4);

-- ---------- 物品 ----------
INSERT OR REPLACE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES
  (1, '回魂丹',   'consumable', 'battle',  50, 'heal_mp', 100, 1, '恢复 100 点魂力'),
  (2, '金疮药',   'consumable', 'battle',  40, 'heal_hp', 100, 1, '恢复 100 点生命'),
  (3, '魂环碎片', 'material',   'out',      0, '',          0, 1, '100 个可兑换一个自选魂环'),
  (4, '新手礼包', 'gift',       'out',      0, 'gift_newbie', 0, 0, '建号赠送');

-- ---------- NPC ----------
INSERT OR REPLACE INTO npc (id, name, map_id, dialog) VALUES
  (1, '村长',   1, '孩子，外面的世界很危险，先去村外练练手吧。'),
  (2, '杂货商', 3, '客官看看要点什么？');

-- ---------- 任务 ----------
INSERT OR REPLACE INTO quest (id, name, kind, desc, cond, reward) VALUES
  (1, '初入圣魂村', 'main',  '去诺丁城郊击败 3 只十年白虎', '{"kill":{"monster_id":1,"count":3}}', '{"gold":200,"exp":100,"item":[{"id":2,"qty":3}]}'),
  (2, '第一次附加魂环', 'main', '击败魂兽后附加第一个魂环', '{"ring":1}', '{"gold":300,"exp":200}');

-- ---------- 称号 ----------
INSERT OR REPLACE INTO title (id, name, desc, cond) VALUES
  (1, '魂士',     '初入魂师之门', '{"level":1}'),
  (2, '魂师',     '已拥有一个魂环', '{"ring":1}'),
  (3, '大魂师',   '两个魂环', '{"ring":2}'),
  (4, '封号斗罗', '九个魂环', '{"ring":9}');

-- ---------- 数值系数 ----------
INSERT OR REPLACE INTO cfg (key, value, type, desc) VALUES
  ('level_up_attr_rate', '0.18',  'number', '每级属性线性增长系数'),
  ('ring_attr_bonus',    '0.12',  'number', '每附加一个魂环的全属性加成'),
  ('attr_to_damage_div', '1000',  'number', '力量/智力换算伤害的分母'),
  ('defense_level_factor','50',   'number', '减伤公式里的等级系数'),
  ('crit_base_mult',     '1.5',   'number', '暴击基础倍率'),
  ('crit_dmg_div',       '200',   'number', '暴击伤害换算分母'),
  ('skill_power_max',    '400',   'number', '魂技威力上限（百分比）'),
  ('stamina_default',    '188',   'number', '默认体力'),
  ('stamina_cost_battle','1',     'number', '每场野外战斗消耗体力'),
  ('catchup_max_rounds', '5',     'number', '单次补算敌方行动的最大回合数'),
  ('idle_timeout_sec',   '90',    'number', '无操作多少秒判定逃跑'),
  ('ring_years_color',   '100,1000,10000,100000,1000000,10000000', 'string', '魂环年限颜色分界（白/黄/紫/黑/红/金/彩）');

-- ---------- 魂兽掉落魂技 ----------
INSERT OR REPLACE INTO monster_skill (monster_id, skill_id, weight) VALUES
  (1, 1, 3), (1, 3, 1), (2, 1, 2), (2, 2, 1), (3, 2, 3), (4, 2, 2), (4, 3, 2);
