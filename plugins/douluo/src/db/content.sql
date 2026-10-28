-- ============================================================
-- content.db —— 游戏内容（全部可在面板「斗罗」页编辑）
--
-- 设计原则：凡是策划会想改的东西，一律进表，代码里不出现魔法数字。
-- 业务代码只读这个库；写入只发生在后台管理页。
-- ============================================================

CREATE TABLE IF NOT EXISTS content_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- 武魂 ----------
CREATE TABLE IF NOT EXISTS wuhun_series (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  hp      REAL    NOT NULL DEFAULT 1,   -- 系列成长系数
  mp      REAL    NOT NULL DEFAULT 1,
  str     REAL    NOT NULL DEFAULT 1,
  intel   REAL    NOT NULL DEFAULT 1,
  atk     REAL    NOT NULL DEFAULT 1,
  def     REAL    NOT NULL DEFAULT 1,
  spd     REAL    NOT NULL DEFAULT 1,
  desc    TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS wuhun (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  series_id  INTEGER REFERENCES wuhun_series(id),
  rarity     INTEGER NOT NULL DEFAULT 1,   -- 1 普通 2 稀有 3 史诗 4 传说
  hp         INTEGER NOT NULL DEFAULT 100,
  mp         INTEGER NOT NULL DEFAULT 100,
  atk        INTEGER NOT NULL DEFAULT 10,
  def        INTEGER NOT NULL DEFAULT 10,
  spd        INTEGER NOT NULL DEFAULT 10,
  str        INTEGER NOT NULL DEFAULT 10,
  intel      INTEGER NOT NULL DEFAULT 10,
  dodge      INTEGER NOT NULL DEFAULT 5,
  crit       INTEGER NOT NULL DEFAULT 5,
  crit_dmg   INTEGER NOT NULL DEFAULT 150,
  desc       TEXT    NOT NULL DEFAULT '',
  image      TEXT    NOT NULL DEFAULT '',   -- 武魂立绘：URL 或 images/ 下的文件名
  enabled    INTEGER NOT NULL DEFAULT 1
);

-- ---------- 魂技 ----------
CREATE TABLE IF NOT EXISTS skill (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  scope   TEXT    NOT NULL DEFAULT 'enemy_one', -- enemy_one/enemy_all/self_one/self_all
  power   INTEGER NOT NULL DEFAULT 100,        -- 倍率，100 = 1.0 倍
  cost    INTEGER NOT NULL DEFAULT 10,         -- 魂力消耗
  hit     INTEGER NOT NULL DEFAULT 95,         -- 命中率 %
  cd      INTEGER NOT NULL DEFAULT 0,          -- 冷却（秒）
  desc    TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- ---------- 魂兽 ----------
CREATE TABLE IF NOT EXISTS monster (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  tier          TEXT    NOT NULL DEFAULT 'normal', -- normal/elite/boss
  target_rounds INTEGER NOT NULL DEFAULT 4,        -- 目标击杀回合数（平衡锚点）
  age           INTEGER NOT NULL DEFAULT 10,       -- 魂兽年龄，决定掉落魂环年限
  atk_bias      REAL    NOT NULL DEFAULT 1,
  def_bias      REAL    NOT NULL DEFAULT 1,
  spd_bias      REAL    NOT NULL DEFAULT 1,
  exp_rate      REAL    NOT NULL DEFAULT 1,
  gold_rate     REAL    NOT NULL DEFAULT 1,
  drop_ring     INTEGER NOT NULL DEFAULT 1,        -- 是否掉魂环
  desc          TEXT    NOT NULL DEFAULT '',
  image         TEXT    NOT NULL DEFAULT '',       -- 魂兽图，开战时发
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS monster_map (
  monster_id INTEGER NOT NULL REFERENCES monster(id) ON DELETE CASCADE,
  map_id     INTEGER NOT NULL,
  PRIMARY KEY (monster_id, map_id)
);

-- ---------- 物品 ----------
CREATE TABLE IF NOT EXISTS item (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  kind       TEXT    NOT NULL DEFAULT 'material',  -- material/consumable/equip/gift
  use_scene  TEXT    NOT NULL DEFAULT 'any',       -- any/battle/out
  price      INTEGER NOT NULL DEFAULT 0,
  effect     TEXT    NOT NULL DEFAULT '',          -- heal_mp/heal_hp/add_exp/add_gold...
  amount     INTEGER NOT NULL DEFAULT 0,
  tradeable  INTEGER NOT NULL DEFAULT 1,
  desc       TEXT    NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1
);

-- ---------- 地图 / NPC ----------
CREATE TABLE IF NOT EXISTS map (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  north     INTEGER,
  south     INTEGER,
  west      INTEGER,
  east      INTEGER,
  portal    INTEGER NOT NULL DEFAULT 0,
  min_level INTEGER NOT NULL DEFAULT 1,
  desc      TEXT    NOT NULL DEFAULT '',
  image     TEXT    NOT NULL DEFAULT '',   -- 地图插画
  enabled   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS npc (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL,
  map_id  INTEGER REFERENCES map(id),
  dialog  TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- ---------- 任务 / 称号 ----------
CREATE TABLE IF NOT EXISTS quest (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  kind    TEXT    NOT NULL DEFAULT 'main',   -- main/daily
  desc    TEXT    NOT NULL DEFAULT '',
  cond    TEXT    NOT NULL DEFAULT '{}',     -- JSON：达成条件
  reward  TEXT    NOT NULL DEFAULT '{}',     -- JSON：奖励
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS title (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  desc    TEXT    NOT NULL DEFAULT '',
  cond    TEXT    NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- ---------- 数值系数 ----------
-- 用户要求"先不管数值"，但系数必须可调，所以全部进表。
CREATE TABLE IF NOT EXISTS cfg (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  type  TEXT NOT NULL DEFAULT 'number',  -- number/string/bool
  desc  TEXT NOT NULL DEFAULT ''
);

-- ---------- 索引 ----------
CREATE INDEX IF NOT EXISTS idx_monster_tier  ON monster(tier);
CREATE INDEX IF NOT EXISTS idx_monster_map   ON monster_map(map_id);
CREATE INDEX IF NOT EXISTS idx_item_kind     ON item(kind);
CREATE INDEX IF NOT EXISTS idx_npc_map       ON npc(map_id);

-- ---------- 魂兽掉落魂技（击杀后附加的魂环带哪个技能） ----------
CREATE TABLE IF NOT EXISTS monster_skill (
  monster_id INTEGER NOT NULL REFERENCES monster(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skill(id),
  weight     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (monster_id, skill_id)
);

-- ============================================================
-- 装备类内容（魂骨 / 斗铠 / 魂导器）
--
-- 归并设计：这三样在玩法上是「可装备的物件」，差别只在 kind 和 part。
-- 同类插件给每样一套 ini、一套命令、一套逻辑；这里共用一张表，
-- 以后加「领域/机甲/战舰」也只是新增 kind，不用加表。
-- ============================================================
CREATE TABLE IF NOT EXISTS equip (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL UNIQUE,
  kind     TEXT    NOT NULL DEFAULT 'bone',   -- bone/armor/conduct
  part     TEXT    NOT NULL DEFAULT 'torso',  -- head/arm_l/arm_r/leg_l/leg_r/torso/body/conduct_atk/conduct_def
  rarity   INTEGER NOT NULL DEFAULT 1,
  set_id   INTEGER REFERENCES equip_set(id),
  hp       INTEGER NOT NULL DEFAULT 0,
  mp       INTEGER NOT NULL DEFAULT 0,
  atk      INTEGER NOT NULL DEFAULT 0,
  def      INTEGER NOT NULL DEFAULT 0,
  spd      INTEGER NOT NULL DEFAULT 0,
  str      INTEGER NOT NULL DEFAULT 0,
  intel    INTEGER NOT NULL DEFAULT 0,
  dodge    INTEGER NOT NULL DEFAULT 0,
  crit     INTEGER NOT NULL DEFAULT 0,
  crit_dmg INTEGER NOT NULL DEFAULT 0,
  desc     TEXT    NOT NULL DEFAULT '',
  image    TEXT    NOT NULL DEFAULT '',   -- 装备图
  enabled  INTEGER NOT NULL DEFAULT 1
);

-- 套装：bonus 是 JSON，键是件数，值是该档位触发的属性加成
-- 例：{"2":{"atk":20},"4":{"def":30,"hp":200}}
CREATE TABLE IF NOT EXISTS equip_set (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  desc    TEXT    NOT NULL DEFAULT '',
  bonus   TEXT    NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_equip_kind ON equip(kind);
CREATE INDEX IF NOT EXISTS idx_equip_part ON equip(part);

-- ============================================================
-- 伙伴 / 收集（魂灵 / 战宠 / 战魂 / 集卡）
--
-- 归并理由：这四样在玩法上都是「可收集、有稀有度、能提供属性」的东西。
-- 差别只有两条：
--   - soul/pet/wsoul：要**出战**才生效（同 kind 只能上一个）
--   - card：收集即生效（图鉴加成），不占出战位
-- 所以一张表 + kind 就够，不用四套表四套逻辑。
-- ============================================================
CREATE TABLE IF NOT EXISTS companion (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL UNIQUE,
  kind     TEXT    NOT NULL DEFAULT 'soul',   -- soul/pet/wsoul/card
  rarity   INTEGER NOT NULL DEFAULT 1,
  star     INTEGER NOT NULL DEFAULT 1,
  hp       INTEGER NOT NULL DEFAULT 0,
  mp       INTEGER NOT NULL DEFAULT 0,
  atk      INTEGER NOT NULL DEFAULT 0,
  def      INTEGER NOT NULL DEFAULT 0,
  spd      INTEGER NOT NULL DEFAULT 0,
  str      INTEGER NOT NULL DEFAULT 0,
  intel    INTEGER NOT NULL DEFAULT 0,
  dodge    INTEGER NOT NULL DEFAULT 0,
  crit     INTEGER NOT NULL DEFAULT 0,
  crit_dmg INTEGER NOT NULL DEFAULT 0,
  skill_id INTEGER REFERENCES skill(id),
  image    TEXT    NOT NULL DEFAULT '',
  desc     TEXT    NOT NULL DEFAULT '',
  enabled  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_companion_kind ON companion(kind);

-- ============================================================
-- 经济类内容（商城 / 抽奖）
--
-- 7 个商城不是 7 套系统，是 shop 表里的 7 行。货架是 shop_item。
-- 抽奖同理：奖池就是一张带权重的表，加奖只加行。
-- ============================================================
CREATE TABLE IF NOT EXISTS shop (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL UNIQUE,
  currency TEXT    NOT NULL DEFAULT 'gold',   -- gold/coupon
  desc     TEXT    NOT NULL DEFAULT '',
  enabled  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shop_item (
  shop_id INTEGER NOT NULL REFERENCES shop(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES item(id),
  price   INTEGER NOT NULL DEFAULT 0,
  stock   INTEGER NOT NULL DEFAULT -1,        -- -1 = 不限量
  sort    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, item_id)
);

CREATE TABLE IF NOT EXISTS lottery_prize (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL,
  kind    TEXT    NOT NULL DEFAULT 'item',    -- item/equip/companion/gold/coupon
  ref_id  INTEGER NOT NULL DEFAULT 0,
  qty     INTEGER NOT NULL DEFAULT 1,
  weight  INTEGER NOT NULL DEFAULT 1,
  rarity  INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- ============================================================
-- 生活类内容（职业 / 配方）
--
-- 炼丹、合成、设计图本质都是「配方 + 材料 → 产物」，
-- 所以只有一张 recipe 表，用 kind 区分；职业只是一列。
-- ============================================================
CREATE TABLE IF NOT EXISTS profession (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  desc    TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipe (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  kind       TEXT    NOT NULL DEFAULT 'craft',   -- craft/alchemy/design
  profession TEXT    NOT NULL DEFAULT '',        -- 空 = 不限职业
  level_req  INTEGER NOT NULL DEFAULT 1,
  cost       TEXT    NOT NULL DEFAULT '{}',      -- {"gold":100,"items":[{"id":1,"qty":2}]}
  out_kind   TEXT    NOT NULL DEFAULT 'item',    -- item/equip/companion
  out_id     INTEGER NOT NULL DEFAULT 0,
  out_qty    INTEGER NOT NULL DEFAULT 1,
  desc       TEXT    NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1
);

-- 可占领的领地：**配置**放内容库，归属放游戏库
-- （谁是主人是运行时状态，不能让业务代码去写只读的内容库）
CREATE TABLE IF NOT EXISTS territory_def (
  map_id        INTEGER PRIMARY KEY,
  mine_gold     INTEGER NOT NULL DEFAULT 0,
  mine_item_id  INTEGER NOT NULL DEFAULT 0,
  mine_item_qty INTEGER NOT NULL DEFAULT 0,
  desc          TEXT    NOT NULL DEFAULT ''
);

-- NPC → 任务 的对应（一个 NPC 可能给多个任务）
CREATE TABLE IF NOT EXISTS npc_quest (
  npc_id  INTEGER NOT NULL REFERENCES npc(id) ON DELETE CASCADE,
  quest_id INTEGER NOT NULL REFERENCES quest(id) ON DELETE CASCADE,
  sort    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (npc_id, quest_id)
);

-- ============================================================
-- 扩展系统（v10）：把「同类功能」归并成通用模型
--
-- 这一批加了十几套系统，但只新建 8 张表——
-- 因为排行榜、挑战、功法/血脉、宝石 各自都是「同一件事的不同实例」。
-- ============================================================

-- 连续签到（7 天循环）
CREATE TABLE IF NOT EXISTS signin_reward (
  day     INTEGER PRIMARY KEY,
  gold    INTEGER NOT NULL DEFAULT 0,
  coupon  INTEGER NOT NULL DEFAULT 0,
  exp     INTEGER NOT NULL DEFAULT 0,
  items   TEXT    NOT NULL DEFAULT '[]',
  desc    TEXT    NOT NULL DEFAULT ''
);

-- 排行榜定义：一个 key 一行，加榜只加行，不改代码
CREATE TABLE IF NOT EXISTS rank_def (
  key      TEXT    PRIMARY KEY,
  name     TEXT    NOT NULL,
  order_by TEXT    NOT NULL,
  desc     TEXT    NOT NULL DEFAULT '',
  enabled  INTEGER NOT NULL DEFAULT 1
);

-- 挑战：万兽台 / 深渊 / 世界BOSS / 神位 都是「有层数、有每日次数、有奖励的 PVE」
CREATE TABLE IF NOT EXISTS challenge (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL DEFAULT 'tower',  -- tower/abyss/boss/deity
  level_req   INTEGER NOT NULL DEFAULT 1,
  monster_id  INTEGER REFERENCES monster(id),
  max_depth   INTEGER NOT NULL DEFAULT 10,
  reward      TEXT    NOT NULL DEFAULT '{}',
  daily_limit INTEGER NOT NULL DEFAULT 3,
  desc        TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 宝石（镶嵌用）
CREATE TABLE IF NOT EXISTS gem (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  rarity  INTEGER NOT NULL DEFAULT 1,
  atk     INTEGER NOT NULL DEFAULT 0,
  def     INTEGER NOT NULL DEFAULT 0,
  hp      INTEGER NOT NULL DEFAULT 0,
  mp      INTEGER NOT NULL DEFAULT 0,
  spd     INTEGER NOT NULL DEFAULT 0,
  crit    INTEGER NOT NULL DEFAULT 0,
  dodge   INTEGER NOT NULL DEFAULT 0,
  desc    TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- 功法 / 血脉：都是「学一门东西 → 永久加属性（+ 可能带魂技）」
CREATE TABLE IF NOT EXISTS aptitude (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL UNIQUE,
  kind     TEXT    NOT NULL DEFAULT 'technique',  -- technique(功法)/bloodline(血脉)
  rarity   INTEGER NOT NULL DEFAULT 1,
  cost     TEXT    NOT NULL DEFAULT '{}',
  attrs    TEXT    NOT NULL DEFAULT '{}',
  skill_id INTEGER REFERENCES skill(id),
  desc     TEXT    NOT NULL DEFAULT '',
  enabled  INTEGER NOT NULL DEFAULT 1
);

-- 暗器
CREATE TABLE IF NOT EXISTS hidden_weapon (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  power   INTEGER NOT NULL DEFAULT 100,
  cost    INTEGER NOT NULL DEFAULT 0,
  price   INTEGER NOT NULL DEFAULT 0,
  desc    TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- 宗门商店（用宗门资金买）
CREATE TABLE IF NOT EXISTS guild_shop (
  item_id INTEGER PRIMARY KEY REFERENCES item(id),
  price   INTEGER NOT NULL DEFAULT 100,
  stock   INTEGER NOT NULL DEFAULT -1
);

-- 教程（比帮助更口语化的引导）
CREATE TABLE IF NOT EXISTS tutorial (
  id    INTEGER PRIMARY KEY,
  key   TEXT    NOT NULL UNIQUE,
  title TEXT    NOT NULL,
  body  TEXT    NOT NULL DEFAULT '',
  sort  INTEGER NOT NULL DEFAULT 0
);

-- 丹鼎 / 丹火（炼丹前置工具，影响成功率）
CREATE TABLE IF NOT EXISTS alchemy_tool (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE,
  kind    TEXT    NOT NULL DEFAULT 'furnace',  -- furnace(鼎)/fire(火)
  bonus   INTEGER NOT NULL DEFAULT 0,          -- 成功率加成（百分点）
  price   INTEGER NOT NULL DEFAULT 0,
  desc    TEXT    NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- 图鉴收集奖励（达到 N 种解锁时发奖）
CREATE TABLE IF NOT EXISTS bestiary_reward (
  count  INTEGER PRIMARY KEY,
  gold   INTEGER NOT NULL DEFAULT 0,
  coupon INTEGER NOT NULL DEFAULT 0,
  items  TEXT    NOT NULL DEFAULT '[]',
  desc   TEXT    NOT NULL DEFAULT ''
);

-- ============================================================
-- 挑战层配置（v13）：给万兽台/深渊/神位一个「有名有姓」的纵深
--
-- 之前每层只是「第 N 层」，纯数值递推，玩家没有记忆点。
-- 现在每层有名、每 5/10 层是守关（boss），守关层有专属掉落，
-- 首次通过额外给奖励——这才叫「爬塔」。
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_floor (
  challenge_id INTEGER NOT NULL,
  floor        INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  is_boss      INTEGER NOT NULL DEFAULT 0,
  reward       TEXT    NOT NULL DEFAULT '{}',
  first_clear  TEXT    NOT NULL DEFAULT '{}',
  desc         TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (challenge_id, floor)
);

-- ============================================================
-- 状态效果（v14）
--
-- 技能之前只有纯伤害，没有战术空间。这张表让技能能附加状态：
-- 中毒/灼烧/流血/减速/眩晕/沉默/虚弱/破甲/回复/护盾/会心/疾影/冰冻/即死。
-- 加一种状态只加一行，不改代码。
-- ============================================================
CREATE TABLE IF NOT EXISTS status_def (
  key                 TEXT    PRIMARY KEY,
  name                TEXT    NOT NULL,
  kind                TEXT    NOT NULL DEFAULT 'debuff',  -- debuff/buff
  desc                TEXT    NOT NULL DEFAULT '',
  max_stack           INTEGER NOT NULL DEFAULT 1,
  duration            INTEGER NOT NULL DEFAULT 3,
  tick_pct            INTEGER NOT NULL DEFAULT 0,        -- 每回合按最大生命 % 掉血（负=回血）
  atk_pct             INTEGER NOT NULL DEFAULT 0,
  def_pct             INTEGER NOT NULL DEFAULT 0,
  spd_pct             INTEGER NOT NULL DEFAULT 0,
  dodge_pct           INTEGER NOT NULL DEFAULT 0,
  crit_pct            INTEGER NOT NULL DEFAULT 0,
  skip_turn           INTEGER NOT NULL DEFAULT 0,
  block_skill         INTEGER NOT NULL DEFAULT 0,
  instant_kill        INTEGER NOT NULL DEFAULT 0,
  instant_kill_chance INTEGER NOT NULL DEFAULT 0,
  enabled             INTEGER NOT NULL DEFAULT 1
);

-- 技能 → 状态（一个技能可以附加多个状态）
CREATE TABLE IF NOT EXISTS skill_status (
  skill_id   INTEGER NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  status_key TEXT    NOT NULL REFERENCES status_def(key) ON DELETE CASCADE,
  chance     INTEGER NOT NULL DEFAULT 100,
  duration   INTEGER NOT NULL DEFAULT 0,   -- 0 = 用 status_def 的默认值
  PRIMARY KEY (skill_id, status_key)
);

-- ============================================================
-- 魂兽掉落表（v18）
--
-- 之前击杀只给经验+魂币+魂环，材料全靠商店买，打怪没有「捡东西」的惊喜。
-- 这张表让每只怪能掉材料/装备/宝石/伙伴，按稀有度给不同概率。
-- ============================================================
CREATE TABLE IF NOT EXISTS monster_drop (
  id         INTEGER PRIMARY KEY,
  monster_id INTEGER NOT NULL REFERENCES monster(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'item',   -- item/equip/gem/companion
  ref_id     INTEGER NOT NULL,
  chance     INTEGER NOT NULL DEFAULT 10,       -- 百分比
  qty_min    INTEGER NOT NULL DEFAULT 1,
  qty_max    INTEGER NOT NULL DEFAULT 1,
  desc       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_drop_monster ON monster_drop(monster_id);

-- 掉落唯一约束：post.sql / post2.sql 里的「按年龄档补齐」要幂等，靠这个索引去重。
--
-- ⚠️ 建唯一索引**之前必须先清掉历史重复行**：
-- 这个索引是后加的，老库里同一只怪已经攒了几百条一模一样的掉落配置
-- （`INSERT OR IGNORE` 在没有唯一约束时等于普通 INSERT）。
-- 直接 CREATE UNIQUE INDEX 会报 UNIQUE constraint failed，
-- 而 content.sql 是整段 exec 的——一条失败会让**整个插件加载失败**，
-- 不是「跳过一条语句」那么轻。
DELETE FROM monster_drop WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM monster_drop GROUP BY monster_id, kind, ref_id
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_drop ON monster_drop(monster_id, kind, ref_id);

-- ============================================================
-- v24：对齐原版「斗罗控制台」的数据面
--
-- 原版 89 个 ini 的字段比我们宽，这一批把缺的表补齐。
-- 原则仍然是归并：采集+钓鱼一张表、抽奖池一个列、段位商城一个列。
-- ============================================================

-- NPC 条件对话（原版「条件对话-」前缀；一个 NPC 多段对话按条件分支）
CREATE TABLE IF NOT EXISTS npc_dialog (
  id       INTEGER PRIMARY KEY,
  npc_id   INTEGER NOT NULL REFERENCES npc(id) ON DELETE CASCADE,
  cond     TEXT    NOT NULL DEFAULT '{}',
  text     TEXT    NOT NULL DEFAULT '',
  action   TEXT    NOT NULL DEFAULT '',
  sort     INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_npcdlg ON npc_dialog(npc_id, sort);

-- 武魂融合（原版「需求武魂=A@B」双武魂 + 融合魂技 + 融合BUFF）
CREATE TABLE IF NOT EXISTS wuhun_fusion (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  wuhun_a     INTEGER NOT NULL DEFAULT 0,
  wuhun_b     INTEGER NOT NULL DEFAULT 0,
  skill_id    INTEGER NOT NULL DEFAULT 0,
  buff        TEXT    NOT NULL DEFAULT '',
  attrs       TEXT    NOT NULL DEFAULT '{}',
  desc        TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 采集点 / 钓鱼点（原版分「采集」「钓鱼」两个模块，本质是同一件事）
CREATE TABLE IF NOT EXISTS gather_point (
  id         INTEGER PRIMARY KEY,
  map_id     INTEGER NOT NULL REFERENCES map(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'gather',
  name       TEXT    NOT NULL DEFAULT '',
  item_id    INTEGER NOT NULL DEFAULT 0,
  qty_min    INTEGER NOT NULL DEFAULT 1,
  qty_max    INTEGER NOT NULL DEFAULT 1,
  need_item  INTEGER NOT NULL DEFAULT 0,
  refresh    INTEGER NOT NULL DEFAULT 300,
  level_req  INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_gather_map ON gather_point(map_id, kind);

-- 副本房间（原版副本是「房间制」：前进 / 退出副本）
CREATE TABLE IF NOT EXISTS dungeon_room (
  challenge_id INTEGER NOT NULL,
  floor        INTEGER NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'battle',
  monster_id   INTEGER NOT NULL DEFAULT 0,
  reward       TEXT    NOT NULL DEFAULT '{}',
  desc         TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (challenge_id, floor)
);

-- 职业等级（原版「职业等级.ini」：每职业 10 级经验表）
CREATE TABLE IF NOT EXISTS profession_level (
  profession TEXT    NOT NULL,
  level      INTEGER NOT NULL,
  need_exp   INTEGER NOT NULL DEFAULT 0,
  bonus      TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (profession, level)
);

-- 斗铠领域（原版「领域名称 + 附加状态」）
CREATE TABLE IF NOT EXISTS domain_def (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  status_key  TEXT    NOT NULL DEFAULT '',
  attrs       TEXT    NOT NULL DEFAULT '{}',
  cost        TEXT    NOT NULL DEFAULT '{}',
  desc        TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 多 BOSS 轮换（原版年兽 / 吞噬恶魔 / 魔帝 / 源龙 各一套）
CREATE TABLE IF NOT EXISTS world_event (
  id          INTEGER PRIMARY KEY,
  key         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'boss',
  max_hp      INTEGER NOT NULL DEFAULT 0,
  interval    INTEGER NOT NULL DEFAULT 120,
  reward      TEXT    NOT NULL DEFAULT '{}',
  desc        TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 条件对话的幂等键：一个 NPC 的同一段位只留一条。
-- 生成器用 `INSERT OR IGNORE ... SELECT ... FROM npc WHERE name = '...'`，
-- 靠这个索引去重（同 map/min_level 那类按名字回填的语句）。
DELETE FROM npc_dialog WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM npc_dialog GROUP BY npc_id, sort
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_npcdlg ON npc_dialog(npc_id, sort);
