-- ============================================================
-- game.db —— 玩家运行时数据
--
-- 主键一律用 openid：QQ 官方接口拿不到 QQ 号，而且同一用户在不同
-- 机器人下的 openid 不同。昵称可以改，所以只能当显示字段。
-- ============================================================

CREATE TABLE IF NOT EXISTS player (
  openid     TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  gender     TEXT    NOT NULL DEFAULT '男',
  level      INTEGER NOT NULL DEFAULT 1,
  exp        INTEGER NOT NULL DEFAULT 0,
  wuhun_id   INTEGER,
  hp         INTEGER NOT NULL DEFAULT 100,
  hp_max     INTEGER NOT NULL DEFAULT 100,
  mp         INTEGER NOT NULL DEFAULT 100,
  mp_max     INTEGER NOT NULL DEFAULT 100,
  atk        INTEGER NOT NULL DEFAULT 10,
  def        INTEGER NOT NULL DEFAULT 10,
  spd        INTEGER NOT NULL DEFAULT 10,
  dodge      INTEGER NOT NULL DEFAULT 5,
  crit       INTEGER NOT NULL DEFAULT 5,
  crit_dmg   INTEGER NOT NULL DEFAULT 150,
  str        INTEGER NOT NULL DEFAULT 10,
  intel      INTEGER NOT NULL DEFAULT 10,
  gold       INTEGER NOT NULL DEFAULT 0,
  coupon     INTEGER NOT NULL DEFAULT 0,
  map_id     INTEGER NOT NULL DEFAULT 1,
  stamina    INTEGER NOT NULL DEFAULT 188,
  title_id   INTEGER,
  status     TEXT    NOT NULL DEFAULT 'idle',   -- idle/battle/dead
  created_at INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory (
  openid  TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  qty     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, item_id)
);

CREATE TABLE IF NOT EXISTS ring (
  openid   TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  slot     INTEGER NOT NULL,          -- 1..10
  years    INTEGER NOT NULL DEFAULT 10,
  name     TEXT    NOT NULL DEFAULT '',
  skill_id INTEGER,
  PRIMARY KEY (openid, slot)
);

CREATE TABLE IF NOT EXISTS title_owned (
  openid   TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  title_id INTEGER NOT NULL,
  PRIMARY KEY (openid, title_id)
);

-- 经济流水：每一笔货币/物品变动都要留痕，面板能追
CREATE TABLE IF NOT EXISTS tx_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  openid  TEXT    NOT NULL,
  kind    TEXT    NOT NULL,           -- gold/coupon/item
  ref_id  INTEGER NOT NULL DEFAULT 0, -- 物品 id（kind=item 时）
  delta   INTEGER NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  reason  TEXT    NOT NULL DEFAULT '',
  at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_openid ON tx_log(openid, id DESC);
CREATE INDEX IF NOT EXISTS idx_tx_at     ON tx_log(at DESC);

-- 管理操作日志：谁、对谁、做了什么
CREATE TABLE IF NOT EXISTS admin_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  admin  TEXT    NOT NULL DEFAULT 'panel',
  action TEXT    NOT NULL,
  target TEXT    NOT NULL DEFAULT '',
  payload TEXT   NOT NULL DEFAULT '',
  at     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, 0);

CREATE INDEX IF NOT EXISTS idx_player_level ON player(level DESC, exp DESC);
CREATE INDEX IF NOT EXISTS idx_player_power ON player(atk DESC);
CREATE INDEX IF NOT EXISTS idx_player_seen  ON player(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_inv_item     ON inventory(item_id);

-- ============================================================
-- 战斗 / 进度 / 任务（v2 追加）
-- ============================================================

-- 一场进行中的战斗。一个玩家同时只能有一场。
-- 怪物属性在开战时**快照**下来：内容表后来改了也不影响正在打的这场。
CREATE TABLE IF NOT EXISTS battle (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  openid        TEXT    NOT NULL,
  monster_id    INTEGER NOT NULL,
  monster_name  TEXT    NOT NULL DEFAULT '',
  monster_hp    INTEGER NOT NULL DEFAULT 0,
  monster_hp_max INTEGER NOT NULL DEFAULT 0,
  monster_def   INTEGER NOT NULL DEFAULT 0,
  monster_atk   INTEGER NOT NULL DEFAULT 0,
  monster_age   INTEGER NOT NULL DEFAULT 0,
  round         INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER NOT NULL DEFAULT 0,
  last_act_at   INTEGER NOT NULL DEFAULT 0,
  state         TEXT    NOT NULL DEFAULT 'active'   -- active/dead
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_battle_openid ON battle(openid);

-- 打完但还没附加的魂环（麒麟那套：击杀后要玩家再发一次【附加魂环】）
CREATE TABLE IF NOT EXISTS pending_ring (
  openid     TEXT PRIMARY KEY,
  monster_id INTEGER NOT NULL,
  monster_name TEXT NOT NULL DEFAULT '',
  years      INTEGER NOT NULL DEFAULT 0,
  skill_id   INTEGER,
  at         INTEGER NOT NULL DEFAULT 0
);

-- 快捷魂技：槽位 → 魂技 id（对应麒麟的「设置魂技 1-蓝银缠绕」）
CREATE TABLE IF NOT EXISTS loadout (
  openid   TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  slot     INTEGER NOT NULL,
  skill_id INTEGER NOT NULL,
  PRIMARY KEY (openid, slot)
);

-- 任务进度
CREATE TABLE IF NOT EXISTS player_quest (
  openid   TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  quest_id INTEGER NOT NULL,
  state    TEXT    NOT NULL DEFAULT 'doing',   -- doing/done/claimed
  progress INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, quest_id)
);

-- 每日签到
CREATE TABLE IF NOT EXISTS sign_in (
  openid TEXT NOT NULL,
  day    TEXT NOT NULL,          -- YYYY-MM-DD
  at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, day)
);

-- 击杀计数（任务条件用）
CREATE TABLE IF NOT EXISTS kill_count (
  openid     TEXT    NOT NULL,
  monster_id INTEGER NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, monster_id)
);

-- ============================================================
-- 玩家持有的装备实例（v3 追加）
--
-- part 冗余存一份：装备后要保证「一个部位只能穿一件」，
-- 用部分唯一索引在库层面兜住，比在代码里到处判断可靠。
-- ============================================================
CREATE TABLE IF NOT EXISTS equip_owned (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  openid      TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  equip_id    INTEGER NOT NULL,
  part        TEXT    NOT NULL DEFAULT '',
  level       INTEGER NOT NULL DEFAULT 1,
  equipped    INTEGER NOT NULL DEFAULT 0,
  obtained_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_eo_openid ON equip_owned(openid, equipped);
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipped_part ON equip_owned(openid, part) WHERE equipped = 1;

-- ============================================================
-- 玩家持有的伙伴实例（v5 追加）
--
-- kind 冗余存一份，配合部分唯一索引实现「同一类只能出战一个」，
-- 和装备的「一个部位只能穿一件」是同一个套路。
-- ============================================================
CREATE TABLE IF NOT EXISTS companion_owned (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  openid       TEXT    NOT NULL REFERENCES player(openid) ON DELETE CASCADE,
  companion_id INTEGER NOT NULL,
  kind         TEXT    NOT NULL DEFAULT '',
  level        INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 0,
  obtained_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_co_openid ON companion_owned(openid, active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_kind ON companion_owned(openid, kind) WHERE active = 1;

-- ============================================================
-- 经济运行时数据（v6 追加）
-- ============================================================
-- 银行：存款、贷款、上次计息时间
CREATE TABLE IF NOT EXISTS bank (
  openid          TEXT PRIMARY KEY REFERENCES player(openid) ON DELETE CASCADE,
  deposit         INTEGER NOT NULL DEFAULT 0,
  loan            INTEGER NOT NULL DEFAULT 0,
  last_interest_at INTEGER NOT NULL DEFAULT 0
);

-- 拍卖：上架即从背包扣物品，卖不掉/下架要退回
CREATE TABLE IF NOT EXISTS auction (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seller     TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'item',  -- item/equip/companion
  ref_id     INTEGER NOT NULL,
  qty        INTEGER NOT NULL DEFAULT 1,
  price      INTEGER NOT NULL DEFAULT 0,
  currency   TEXT    NOT NULL DEFAULT 'gold',
  status     TEXT    NOT NULL DEFAULT 'open',  -- open/sold/cancelled/expired
  buyer      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  expire_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auction_status ON auction(status, expire_at);
CREATE INDEX IF NOT EXISTS idx_auction_seller ON auction(seller);

-- 月卡
CREATE TABLE IF NOT EXISTS monthly_card (
  openid        TEXT PRIMARY KEY REFERENCES player(openid) ON DELETE CASCADE,
  expire_at     INTEGER NOT NULL DEFAULT 0,
  bought_at     INTEGER NOT NULL DEFAULT 0,
  last_claim_at INTEGER NOT NULL DEFAULT 0
);

-- 兑换码（默认一次性；max_uses>1 时按次数放开）
CREATE TABLE IF NOT EXISTS cdk (
  code       TEXT PRIMARY KEY,
  rewards    TEXT    NOT NULL DEFAULT '{}',
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used       INTEGER NOT NULL DEFAULT 0,
  used_by    TEXT    NOT NULL DEFAULT '',
  expire_at  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- 社交 / PVP / 组织（v7 追加）
-- ============================================================
-- 关系：一张表覆盖 好友/情侣/师徒/仇人
-- status: pending（待确认）/ active（生效）/ ended（已解除）
CREATE TABLE IF NOT EXISTS relation (
  from_openid TEXT    NOT NULL,
  to_openid   TEXT    NOT NULL,
  kind        TEXT    NOT NULL,   -- friend/couple/master/apprentice/enemy
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_openid, to_openid, kind)
);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relation(to_openid, kind, status);

-- 对战记录（异步 PVP 用）
CREATE TABLE IF NOT EXISTS duel (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a_openid   TEXT    NOT NULL,
  b_openid   TEXT    NOT NULL,
  winner     TEXT    NOT NULL DEFAULT '',
  a_power    INTEGER NOT NULL DEFAULT 0,
  b_power    INTEGER NOT NULL DEFAULT 0,
  rounds     INTEGER NOT NULL DEFAULT 0,
  log        TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_duel_a ON duel(a_openid, id DESC);
CREATE INDEX IF NOT EXISTS idx_duel_b ON duel(b_openid, id DESC);

-- 宗门（势力/帝国/宗门都是同一张表，用 level 表示层级）
CREATE TABLE IF NOT EXISTS guild (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  leader     TEXT    NOT NULL,
  level      INTEGER NOT NULL DEFAULT 1,
  funds      INTEGER NOT NULL DEFAULT 0,
  notice     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guild_member (
  openid    TEXT PRIMARY KEY,
  guild_id  INTEGER NOT NULL,
  rank      TEXT    NOT NULL DEFAULT 'member',  -- leader/elder/member
  joined_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gm_guild ON guild_member(guild_id);

-- 喊话限频（每人每 N 秒一次）
CREATE TABLE IF NOT EXISTS shout_log (
  openid TEXT NOT NULL,
  at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid)
);

-- 领地归属（运行时状态）。可占领的地图与产出配置在 content.territory_def
CREATE TABLE IF NOT EXISTS territory (
  map_id       INTEGER PRIMARY KEY,
  guild_id     INTEGER NOT NULL DEFAULT 0,
  occupied_at  INTEGER NOT NULL DEFAULT 0,
  last_mine_at INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- 邮件（v9）：离线奖励的兜底
--
-- 为什么要有：拍卖成交、运营补发、活动奖励这些「玩家不在场」的收益，
-- 直接加背包玩家根本不知道，也没法追查。走邮件就能「上线看到」。
-- ============================================================
CREATE TABLE IF NOT EXISTS mail (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  openid      TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  body        TEXT    NOT NULL DEFAULT '',
  attachments TEXT    NOT NULL DEFAULT '{}',   -- {gold,coupon,items:[{id,qty}],equips:[id],companions:[id]}
  read        INTEGER NOT NULL DEFAULT 0,
  claimed     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  expire_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mail_openid ON mail(openid, claimed, id DESC);

-- ============================================================
-- 扩展系统运行时数据（v10）
-- ============================================================
CREATE TABLE IF NOT EXISTS player_title (
  openid   TEXT    NOT NULL,
  title_id INTEGER NOT NULL,
  worn     INTEGER NOT NULL DEFAULT 0,
  got_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, title_id)
);

CREATE TABLE IF NOT EXISTS signin (
  openid   TEXT    PRIMARY KEY,
  streak   INTEGER NOT NULL DEFAULT 0,
  last_day TEXT    NOT NULL DEFAULT '',
  total    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS challenge_progress (
  openid       TEXT    NOT NULL,
  challenge_id INTEGER NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 0,
  daily_count  INTEGER NOT NULL DEFAULT 0,
  last_day     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (openid, challenge_id)
);

CREATE TABLE IF NOT EXISTS gem_slot (
  equip_id INTEGER NOT NULL,
  slot     INTEGER NOT NULL,
  gem_id   INTEGER NOT NULL,
  PRIMARY KEY (equip_id, slot)
);

CREATE TABLE IF NOT EXISTS aptitude_owned (
  openid      TEXT    NOT NULL,
  aptitude_id INTEGER NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  got_at      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, aptitude_id)
);

CREATE TABLE IF NOT EXISTS hidden_weapon_owned (
  openid    TEXT    NOT NULL,
  weapon_id INTEGER NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, weapon_id)
);

CREATE TABLE IF NOT EXISTS player_ext (
  openid       TEXT    PRIMARY KEY,
  bio          TEXT    NOT NULL DEFAULT '',
  anonymous    INTEGER NOT NULL DEFAULT 0,
  rename_count INTEGER NOT NULL DEFAULT 0,
  charm        INTEGER NOT NULL DEFAULT 0,
  sub_wuhun_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS duel_request (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_openid TEXT   NOT NULL,
  to_openid  TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_duelreq_to ON duel_request(to_openid, status);

CREATE TABLE IF NOT EXISTS meditation (
  openid     TEXT    PRIMARY KEY,
  started_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_boss (
  id         INTEGER PRIMARY KEY,
  hp         INTEGER NOT NULL DEFAULT 0,
  max_hp     INTEGER NOT NULL DEFAULT 0,
  day        TEXT    NOT NULL DEFAULT '',
  spawned_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flower_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_openid TEXT    NOT NULL,
  to_openid   TEXT    NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  at          INTEGER NOT NULL DEFAULT 0
);

-- 赛季积分（斗天/战令）
CREATE TABLE IF NOT EXISTS season_point (
  openid  TEXT    NOT NULL,
  season  INTEGER NOT NULL DEFAULT 1,
  points  INTEGER NOT NULL DEFAULT 0,
  claimed TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (openid, season)
);

-- 宝石库存（和暗器分开，避免用负数 id 混淆）
CREATE TABLE IF NOT EXISTS gem_owned (
  openid TEXT    NOT NULL,
  gem_id INTEGER NOT NULL,
  qty    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, gem_id)
);

-- ============================================================
-- 宗门战 / 领地争夺（v11）
--
-- 为什么之前没做：需要「多宗门并存」才有对抗性。
-- 现在用一个折中方案让它单服可玩：
--   宣战 → 24 小时窗口内可以抢对方领地 → 抢的时候打「守卫」
-- 守卫强度由**占领方宗门等级 + 占领时长**决定，
-- 所以即使对方不在线，也能体现「他的宗门有多强」。
-- ============================================================
CREATE TABLE IF NOT EXISTS guild_war (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        INTEGER NOT NULL,
  target_guild_id INTEGER NOT NULL,
  declared_at     INTEGER NOT NULL DEFAULT 0,
  expires_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_war_pair ON guild_war(guild_id, target_guild_id, expires_at);

-- 领地收益每日领取次数（防止一个人把宗门产出全收走）
CREATE TABLE IF NOT EXISTS territory_collect (
  openid TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, day)
);

-- 图鉴领奖记录
CREATE TABLE IF NOT EXISTS bestiary_claim (
  openid TEXT    NOT NULL,
  count  INTEGER NOT NULL,
  at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, count)
);

-- 每日悬赏（每人每天 3 个，按日期确定性生成）
CREATE TABLE IF NOT EXISTS bounty (
  openid     TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  monster_id INTEGER NOT NULL,
  target     INTEGER NOT NULL DEFAULT 3,
  claimed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, day, monster_id)
);

-- 挑战首通记录
CREATE TABLE IF NOT EXISTS challenge_clear (
  openid       TEXT    NOT NULL,
  challenge_id INTEGER NOT NULL,
  floor        INTEGER NOT NULL,
  at           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, challenge_id, floor)
);

-- 战斗中的状态（JSON 数组：[{key,left,stack}]）

-- 每日斗魂次数（防止无限刷分）
CREATE TABLE IF NOT EXISTS duel_daily (
  openid TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  wins   INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, day)
);

-- 魂技等级（玩家自己的技能熟练度）
CREATE TABLE IF NOT EXISTS player_skill (
  openid   TEXT    NOT NULL,
  skill_id INTEGER NOT NULL,
  level    INTEGER NOT NULL DEFAULT 1,
  exp      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, skill_id)
);

-- 玩家杂项键值（觉醒次数这类计数放这儿，免得为每个计数建一张表）
CREATE TABLE IF NOT EXISTS player_meta (
  openid TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (openid, key)
);

-- ============================================================
-- v24 运行时表
-- ============================================================

-- 快捷指令（原版 33 个槽，玩家自定义短语 → 指令）
CREATE TABLE IF NOT EXISTS quick_cmd (
  openid TEXT    NOT NULL,
  slot   INTEGER NOT NULL,
  cmd    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (openid, slot)
);

-- 组队（原版 7 条组队指令）
CREATE TABLE IF NOT EXISTS team (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  leader     TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_member (
  openid    TEXT    NOT NULL PRIMARY KEY,
  team_id   INTEGER NOT NULL,
  joined_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_team_member ON team_member(team_id);

CREATE TABLE IF NOT EXISTS team_invite (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL,
  from_openid TEXT    NOT NULL,
  to_openid   TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_teaminv ON team_invite(to_openid, status);

-- 采集点冷却（每人每个点各自刷新）
CREATE TABLE IF NOT EXISTS gather_state (
  openid   TEXT    NOT NULL,
  point_id INTEGER NOT NULL,
  last_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, point_id)
);

-- 物品每日使用次数
CREATE TABLE IF NOT EXISTS item_daily (
  openid  TEXT    NOT NULL,
  item_id INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, item_id, day)
);

-- 领域开启状态
CREATE TABLE IF NOT EXISTS domain_open (
  openid    TEXT    NOT NULL,
  domain_id INTEGER NOT NULL,
  opened_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, domain_id)
);

-- 世界事件进度（伤害贡献）
CREATE TABLE IF NOT EXISTS world_event_dmg (
  openid   TEXT    NOT NULL,
  event_id INTEGER NOT NULL,
  day      TEXT    NOT NULL,
  damage   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, event_id, day)
);

-- 武魂融合记录
CREATE TABLE IF NOT EXISTS wuhun_fused (
  openid    TEXT    NOT NULL,
  fusion_id INTEGER NOT NULL,
  at        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (openid, fusion_id)
);
