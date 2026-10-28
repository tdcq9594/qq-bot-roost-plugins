-- ============================================================
-- 依赖 console-pack.sql 的修补
--
-- 顺序：content-pack.sql → post.sql → console-pack.sql → post2.sql
-- 这里的内容要看到「从原版导入的 139 只魂兽 / 108 张地图 / 151 个物品」，
-- 所以必须排在 console-pack 之后。放在 post.sql 里会静默命中 0 行。
--
-- ⚠️ 这个文件必须真的存在。之前几次用 shell heredoc 写它，
-- 反引号和中文注释让 heredoc 提前结束，文件根本没生成，
-- 而 open.js 里是 `if (existsSync)` 才跑——于是「修补」静默跳过，
-- 表现成「测试说通过了，但线上数据没修」。
-- ============================================================

-- ============================================================
-- 1. 掉落覆盖
--
-- 原版导入的 139 只魂兽一开始没有掉落配置
-- （怪物 217 只，掉落只覆盖 78 只 → 测试会报「覆盖不全」）。
-- 按年龄档给「还没有掉落」的怪补一套，幂等靠 uq_drop 唯一索引。
-- ============================================================
INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc)
  SELECT m.id, 'item', 3, 30, 1, 3, '' FROM monster m
  WHERE m.age < 100 AND m.id NOT IN (SELECT monster_id FROM monster_drop);

INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc)
  SELECT m.id, 'item', 201, 28, 1, 3, '' FROM monster m
  WHERE m.age >= 100 AND m.age < 1000 AND m.id NOT IN (SELECT monster_id FROM monster_drop);

INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc)
  SELECT m.id, 'item', 206, 26, 1, 2, '' FROM monster m
  WHERE m.age >= 1000 AND m.age < 10000 AND m.id NOT IN (SELECT monster_id FROM monster_drop);

INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc)
  SELECT m.id, 'item', 208, 24, 1, 2, '' FROM monster m
  WHERE m.age >= 10000 AND m.age < 100000 AND m.id NOT IN (SELECT monster_id FROM monster_drop);

INSERT OR IGNORE INTO monster_drop (monster_id, kind, ref_id, chance, qty_min, qty_max, desc)
  SELECT m.id, 'item', 210, 22, 1, 2, '' FROM monster m
  WHERE m.age >= 100000 AND m.id NOT IN (SELECT monster_id FROM monster_drop);

-- ============================================================
-- 2. 魂兽技能补齐
--
-- 导入的怪里有 31 只没有技能（原版「魂兽技能」字段为空）。
-- 按年龄档挂对应档位的技能，和 patch.sql 里那套一致。
-- ============================================================
INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s
  WHERE m.age < 100 AND s.id BETWEEN 10 AND 13
    AND NOT EXISTS (SELECT 1 FROM monster_skill x WHERE x.monster_id = m.id);

INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s
  WHERE m.age >= 100 AND m.age < 1000 AND s.id BETWEEN 14 AND 17
    AND NOT EXISTS (SELECT 1 FROM monster_skill x WHERE x.monster_id = m.id);

INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s
  WHERE m.age >= 1000 AND m.age < 10000 AND s.id BETWEEN 18 AND 21
    AND NOT EXISTS (SELECT 1 FROM monster_skill x WHERE x.monster_id = m.id);

INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s
  WHERE m.age >= 10000 AND m.age < 100000 AND s.id BETWEEN 22 AND 25
    AND NOT EXISTS (SELECT 1 FROM monster_skill x WHERE x.monster_id = m.id);

INSERT OR IGNORE INTO monster_skill (monster_id, skill_id, weight)
  SELECT m.id, s.id, 2 FROM monster m, skill s
  WHERE m.age >= 100000 AND s.id BETWEEN 26 AND 29
    AND NOT EXISTS (SELECT 1 FROM monster_skill x WHERE x.monster_id = m.id);

-- ============================================================
-- 3. 升级卷修正
--
-- 之前用 `import-ini.mjs` 生成内容包时，把原版「能力上升=等级」
-- 一律映射成了 `add_exp`（加经验），于是「使用一个升一级」的升级卷
-- 实际只加了一点经验——玩家吃了一定会觉得被骗。
--
-- 分两步修：
--   1. 凡是 ability='等级' 的，统一改成 add_level
--   2. 内容包里那几个名字就叫「升级卷」的（没有 ability 字段），按名字修
-- ============================================================
UPDATE item SET effect = 'add_level', amount = MAX(1, MIN(10, ability_amount))
  WHERE ability = '等级' AND ability_amount > 0 AND effect <> 'add_level';

UPDATE item SET effect = 'add_level',
  amount = CASE
    WHEN name LIKE '%终极%' THEN 10
    WHEN name LIKE '%超级%' THEN 5
    WHEN name LIKE '%高级%' THEN 3
    ELSE 1 END
  WHERE (name LIKE '%升级卷%' OR name LIKE '%升级卡%') AND effect = 'add_exp';

-- 地图连通性修复与空地图配怪不在这里做：
-- SQLite 的 UPDATE 子查询里引用外层列（map.min_level / m.min_level）会报
-- no such column，UPDATE ... FROM 也不行。改成 open.js 里的
-- repairMapConnectivity() / repairMapMonsters()（纯 JS BFS）。
