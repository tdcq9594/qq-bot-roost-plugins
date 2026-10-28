-- ============================================================
-- 增量补丁：每次启动都执行，只补缺失的行
--
-- 和 seed.sql 的区别：seed 只在**空库**跑一次，之后永不覆盖；
-- 这里用 INSERT OR IGNORE，所以：
--   - 新版本加了一个系数 → 老库自动补上默认值
--   - 玩家/运营改过的值 → 不会被覆盖
-- 加新系数就往这里追加一行，别去改 seed.sql。
-- ============================================================

INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('exp_base',          '100',  'number', '升到下一级的基础经验'),
  ('exp_pow',           '1.6',  'number', '经验曲线指数'),
  ('ring_level_step',   '10',   'number', '每多少个魂环卡一级等级上限'),
  ('ring_drop_first',   '1',    'bool',   '首环是否必掉（新手保护）'),
  ('ring_drop_rate',    '60',   'number', '击杀掉魂环的基础概率 %'),
  ('ring_years_spread', '0.5',  'number', '魂环年限随机幅度（相对魂兽年龄）'),
  ('level_attr_rate',   '0.18', 'number', '每级属性线性增长系数（同 level_up_attr_rate）'),
  ('stamina_regen',     '1',    'number', '体力每分钟恢复'),
  ('sign_in_gold',      '100',  'number', '每日签到魂币'),
  ('sign_in_exp',       '50',   'number', '每日签到经验'),
  ('kill_exp_ratio',    '0.15', 'number', '击杀一只普通怪给多少「升级所需经验」的比例'),
  ('kill_gold_base',    '10',   'number', '击杀魂币基数（×魂兽 gold_rate × 等级）'),
  ('revive_cost_gold',  '50',   'number', '复活消耗魂币'),
  ('max_ring_slot',     '10',   'number', '最多几个魂环');

INSERT OR IGNORE INTO content_meta (key, value) VALUES ('schema_patch', '2');

-- ---------- 装备类测试内容（只补缺失，不覆盖后台改过的） ----------
INSERT OR IGNORE INTO equip_set (id, name, desc, bonus) VALUES
  (1, '鹿之魂骨', '四件套：两件加攻击，四件加防御', '{"2":{"atk":20},"4":{"def":30,"hp":200}}');

INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, atk, def, hp, spd, dodge, crit, desc) VALUES
  (1, '鹿之左臂骨', 'bone', 'arm_l',  2, 1, 15,  5,  50, 0,  0,  1, '魂兽掉落，带一点攻击'),
  (2, '鹿之右臂骨', 'bone', 'arm_r',  2, 1, 15,  5,  50, 0,  0,  1, '魂兽掉落，带一点攻击'),
  (3, '鹿之左腿骨', 'bone', 'leg_l',  2, 1,  5, 15,  80, 2,  1,  0, '偏防御'),
  (4, '鹿之右腿骨', 'bone', 'leg_r',  2, 1,  5, 15,  80, 2,  1,  0, '偏防御'),
  (5, '玄冰斗铠',   'armor', 'body',  3, NULL, 30, 40, 300, 0, 0, 2, '一整套斗铠，全属性小幅提升'),
  (6, '蓝银魂导器', 'conduct', 'conduct_atk', 2, NULL, 25, 0, 0, 0, 0, 3, '攻击型魂导器'),
  (7, '白虎魂导器', 'conduct', 'conduct_def', 2, NULL, 0, 25, 120, 0, 2, 0, '防御型魂导器');

-- ---------- B 批：领域 / 机甲 / 战舰 / 斗灵（复用 equip，只加 kind） ----------
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, atk, def, hp, mp, spd, dodge, crit, desc) VALUES
  (10, '杀戮之都领域', 'domain', 'domain',  3,  40,  20,  200, 100, 3, 2, 2, '开启后持续消耗魂力，全属性提升'),
  (11, '初级机甲',     'mecha',  'mecha',   2,  60,  50,  500,   0, 1, 0, 1, '可控制/退出，行动消耗能量'),
  (12, '轻型战舰',     'ship',   'ship',    2,  80,  70,  800, 100, 2, 0, 1, '需组装后激活，可传送'),
  (13, '攻击斗灵',     'spirit', 'spirit_atk', 2, 45, 0,  0,  50, 2, 1, 2, '装在攻击位，提升输出'),
  (14, '防御斗灵',     'spirit', 'spirit_def', 2,  0, 45, 200, 50, 0, 2, 0, '装在防御位，提升生存');

-- ---------- C 批：魂灵 / 战宠 / 战魂 / 集卡 ----------
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, atk, def, hp, mp, spd, dodge, crit, skill_id, desc) VALUES
  (1, '十年魂灵',   'soul',  1, 1,  8,  5,  60, 30, 1, 1, 1, NULL, '最基础的魂灵，聊胜于无'),
  (2, '百年魂灵',   'soul',  2, 2, 16, 10, 120, 60, 2, 2, 2, 1,    '能带一个魂技'),
  (3, '千年魂灵',   'soul',  3, 3, 30, 18, 220, 110, 3, 3, 3, 2,   '稀有魂灵，属性可观'),
  (4, '小老虎',     'pet',   1, 1, 12,  8, 100,  0, 2, 0, 2, NULL, '好养，能吃'),
  (5, '火狐',       'pet',   2, 2, 20, 12, 140, 40, 4, 3, 3, 1,    '速度快，会喷火'),
  (6, '唐三·战魂',  'wsoul', 3, 3, 35, 20, 180, 90, 3, 2, 4, 2,    '斗罗主角，攻守兼备'),
  (7, '小舞·战魂',  'wsoul', 3, 3, 28, 16, 160,100, 5, 4, 3, 1,    '敏攻型战魂'),
  (8, '史莱克七怪·壹', 'card', 2, 1,  5,  5,  50, 20, 0, 0, 0, NULL, '集卡：收集即生效，不占出战位'),
  (9, '史莱克七怪·贰', 'card', 2, 1,  5,  5,  50, 20, 0, 0, 0, NULL, '集卡：收集即生效'),
  (10,'封号斗罗·卡',   'card', 4, 1, 20, 20, 200, 80, 1, 1, 1, NULL, '集卡：稀有卡，加得多');

INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('companion_level_rate', '0.1', 'number', '伙伴每级属性加成比例');

-- ---------- D 批：经济（商城 / 抽奖 / 系数） ----------
INSERT OR IGNORE INTO shop (id, name, currency, desc) VALUES
  (1, '杂货铺',   'gold',   '基础补给'),
  (2, '魂币商店', 'gold',   '魂币能买的都在这'),
  (3, '点券商店', 'coupon', '点券专属，稀有货'),
  (4, '丹药铺',   'gold',   '回血回魂'),
  (5, '魂骨阁',   'coupon', '魂骨与稀有材料'),
  (6, '限时特惠', 'gold',   '每天刷新'),
  (7, '贵族专享', 'coupon', '高价值礼包');

INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES
  (1, 2, 40,  -1, 1),
  (1, 1, 50,  -1, 2),
  (2, 2, 60,  -1, 1),
  (2, 3, 10,  -1, 2),
  (3, 4, 20,  -1, 1),
  (4, 1, 45,  -1, 1),
  (4, 2, 35,  -1, 2),
  (5, 3, 30,  -1, 1),
  (6, 1, 30,  10, 1),
  (7, 4, 10,  -1, 1);

INSERT OR IGNORE INTO lottery_prize (id, name, kind, ref_id, qty, weight, rarity) VALUES
  (1, '魂币 100',   'gold',      0, 100, 40, 1),
  (2, '魂币 500',   'gold',      0, 500, 20, 2),
  (3, '金疮药',     'item',      2,   3, 20, 1),
  (4, '魂环碎片',   'item',      3,  10, 12, 2),
  (5, '鹿之左臂骨', 'equip',     1,   1,  5, 3),
  (6, '百年魂灵',   'companion', 2,   1,  2, 3),
  (7, '点券 200',   'coupon',    0, 200,  1, 4);

INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('sell_rate',              '0.5',  'number', '卖回商店的比例'),
  ('lottery_cost',           '100',  'number', '抽奖一次消耗魂币'),
  ('bank_interest_rate',     '0.01', 'number', '存款日利率'),
  ('bank_interest_hours',    '24',   'number', '多少小时结一次息'),
  ('loan_rate',              '0.02', 'number', '贷款日利率'),
  ('auction_fee_rate',       '0.05', 'number', '拍卖成交手续费'),
  ('auction_hours',          '24',   'number', '拍卖挂多久自动过期'),
  ('monthly_card_price',     '300',  'number', '月卡价格（点券）'),
  ('monthly_card_days',      '30',   'number', '月卡天数'),
  ('monthly_card_daily_gold','100',  'number', '月卡每日领取魂币');

-- ---------- E 批：职业 / 配方 / 领地矿点 ----------
INSERT OR IGNORE INTO profession (id, name, desc) VALUES
  (1, '炼药师', '能炼丹药'),
  (2, '铁匠',   '能打造装备'),
  (3, '魂导器师', '能合成魂导器'),
  (4, '驯兽师', '能捕捉战宠'),
  (5, '阵法师', '能布阵（待开放）'),
  (6, '厨师',   '能做食物（待开放）');

INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES
  (1, '回魂丹',   'alchemy', '炼药师', 1, '{"gold":20,"items":[{"id":3,"qty":2}]}', 'item', 1, 1, '2 个魂环碎片 + 20 魂币'),
  (2, '金疮药',   'alchemy', '炼药师', 1, '{"gold":20,"items":[{"id":3,"qty":2}]}', 'item', 2, 1, '2 个魂环碎片 + 20 魂币'),
  (3, '魂环碎片', 'craft',   '',       1, '{"gold":10}', 'item', 3, 5, '花 10 魂币把杂质凝成碎片'),
  (4, '玄冰斗铠', 'design',  '铁匠',   5, '{"gold":500,"items":[{"id":3,"qty":20}]}', 'equip', 5, 1, '铁匠 5 级才能打'),
  (5, '百年魂灵', 'craft',   '驯兽师', 3, '{"gold":300,"items":[{"id":3,"qty":15}]}', 'companion', 2, 1, '驯兽师 3 级');

INSERT OR IGNORE INTO territory_def (map_id, mine_gold, mine_item_id, mine_item_qty, desc) VALUES
  (4, 20, 3, 1, '星斗森林：每小时 20 魂币 + 1 碎片');

-- ---------- E 批：社交/PVP/组织/生活的系数 ----------
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('shout_cooldown_sec',  '30',   'number', '世界喊话冷却秒数'),
  ('duel_win_score',      '10',   'number', '斗魂胜利加多少排位分'),
  ('duel_lose_score',     '5',    'number', '斗魂失败扣多少排位分'),
  ('guild_create_cost',   '1000', 'number', '创建宗门费用'),
  ('guild_max_members',   '30',   'number', '宗门人数上限'),
  ('occupy_cost',         '500',  'number', '占领领地消耗的宗门资金'),
  ('mine_cap_hours',      '12',   'number', '领地挖矿最多累计几小时'),
  ('craft_exp',           '5',    'number', '制作一次获得多少经验');

-- ---------- 数值基准（v8）：怪物按内容生成，不按玩家输出反推 ----------
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('tier_elite_factor', '1.6', 'number', '精英怪的生命/攻防倍数'),
  ('tier_boss_factor',  '2.5', 'number', 'BOSS 的生命/攻防倍数');

-- 每场标准战斗结束时玩家应消耗掉多少生命（按品阶）
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('survive_normal', '0.55', 'number', '打普通怪结束时消耗的生命比例'),
  ('survive_elite',  '0.65', 'number', '打精英怪结束时消耗的生命比例'),
  ('survive_boss',   '0.80', 'number', '打 BOSS 结束时消耗的生命比例');

-- 目标回合数下调：精英 10→8、BOSS 18→12。
-- 只在还是旧默认值时才改，运营手动调过的不动。
UPDATE monster SET target_rounds = 8  WHERE id = 3 AND target_rounds = 10;
UPDATE monster SET target_rounds = 12 WHERE id = 4 AND target_rounds = 18;

-- 魂环掉率下调：60% → 35%。配合年限门槛，一个环才像回事。
UPDATE cfg SET value = '35' WHERE key = 'ring_drop_rate' AND value = '60';

-- 恢复：非战斗被动回血 + 休息
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('regen_percent_per_min', '2',  'number', '非战斗时每分钟恢复多少百分比生命'),
  ('rest_cooldown_sec',     '60', 'number', '休息冷却秒数');

-- ---------- 系统深化：强化 / 宗门等级 / 关系收益 ----------
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('equip_upgrade_base',  '200',  'number', '装备强化基础费用（按等级^1.6 递增）'),
  ('equip_upgrade_max',   '10',   'number', '装备强化上限等级'),
  ('guild_level_bonus',   '0.02', 'number', '宗门每级给全员的全属性加成比例'),
  ('guild_max_level',     '10',   'number', '宗门等级上限'),
  ('guild_upgrade_base',  '1000', 'number', '宗门升级基础费用（按等级^2 递增）'),
  ('couple_exp_bonus',    '0.15', 'number', '情侣同时在线时的经验加成'),
  ('apprentice_exp_share','0.05', 'number', '徒弟获得经验时师父分成比例');

-- 分解与伙伴助战
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('salvage_rate',        '1',  'number', '分解装备返还碎片的倍率'),
  ('salvage_item_id',     '3',  'number', '分解返还的物品 id（3=魂环碎片）'),
  ('companion_follow_rate','30','number', '出战伙伴每回合追击的概率 %');

-- 邮件保留天数
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('mail_keep_days', '30', 'number', '邮件保留天数（0=永久）');

-- ---------- v10 扩展系统内容 ----------
INSERT OR IGNORE INTO signin_reward (day, gold, coupon, exp, items, desc) VALUES
  (1, 100,  0,  50, '[]', '第 1 天'),
  (2, 150,  0,  80, '[]', '第 2 天'),
  (3, 200,  0, 120, '[{"id":2,"qty":2}]', '第 3 天 · 金疮药×2'),
  (4, 300,  0, 180, '[]', '第 4 天'),
  (5, 400,  0, 250, '[{"id":3,"qty":5}]', '第 5 天 · 碎片×5'),
  (6, 500, 20, 350, '[]', '第 6 天 · 点券×20'),
  (7, 800, 50, 600, '[{"id":3,"qty":10}]', '第 7 天 · 大奖');

INSERT OR IGNORE INTO rank_def (key, name, order_by, desc) VALUES
  ('power',  '战力榜',   'power DESC, level DESC',        '综合战力'),
  ('level',  '等级榜',   'level DESC, exp DESC',          '等级'),
  ('gold',   '魂币榜',   'gold DESC',                     '持有魂币'),
  ('coupon', '点券榜',   'coupon DESC',                   '持有点券'),
  ('rank',   '排位榜',   'rank_score DESC, level DESC',   '斗魂积分'),
  ('charm',  '魅力榜',   'charm DESC',                    '收到花的数量'),
  ('kill',   '击败榜',   'wins DESC',                     '斗魂胜场'),
  ('boss',   '屠魔榜',   'boss_kills DESC',               '世界BOSS伤害贡献');

INSERT OR IGNORE INTO challenge (id, name, kind, level_req, monster_id, max_depth, reward, daily_limit, desc) VALUES
  (1, '万兽台',  'tower', 1,  NULL, 30, '{"gold":200,"exp":300}', 3, '逐层挑战，越深越难'),
  (2, '深渊',    'abyss', 20, NULL, 20, '{"gold":500,"exp":800,"items":[{"id":3,"qty":5}]}', 2, '高危区域，奖励丰厚'),
  (3, '世界BOSS','boss',  10, 4,    1,  '{"gold":1000,"exp":2000}', 5, '全服共享血量，打掉给全员奖励'),
  (4, '神位',    'deity', 90, NULL, 1,  '{"gold":5000,"exp":20000}', 1, '满级后的终局挑战');

INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES
  (1, '赤焰石', 1, 12,  0,  0, 0, 0, 0, 0, '攻击 +12'),
  (2, '玄铁石', 1,  0, 12,  0, 0, 0, 0, 0, '防御 +12'),
  (3, '青木石', 1,  0,  0, 80, 0, 0, 0, 0, '生命 +80'),
  (4, '疾风石', 2,  6,  0,  0, 0, 6, 0, 0, '攻击 +6 速度 +6'),
  (5, '破军石', 3, 20,  0,  0, 0, 0, 5, 0, '攻击 +20 暴击 +5'),
  (6, '不动石', 4,  0, 30, 200, 0, 0, 0, 3, '防御 +30 生命 +200 闪避 +3');

INSERT OR IGNORE INTO aptitude (id, name, kind, rarity, cost, attrs, skill_id, desc) VALUES
  (1, '玄天功',     'technique', 3, '{"gold":2000}', '{"hp":120,"atk":15,"def":10}', NULL, '唐门内功，稳扎稳打'),
  (2, '控鹤擒龙',   'technique', 3, '{"gold":3000}', '{"atk":25,"spd":8}', NULL, '唐门绝学，攻击凌厉'),
  (3, '紫极魔瞳',   'technique', 4, '{"gold":5000}', '{"intel":30,"crit":5}', NULL, '洞察一切，暴击提升'),
  (4, '蓝银皇血脉', 'bloodline', 4, '{"gold":8000,"items":[{"id":3,"qty":30}]}', '{"hp":300,"atk":40}', 1, '蓝银草觉醒为蓝银皇'),
  (5, '昊天血脉',   'bloodline', 4, '{"gold":8000,"items":[{"id":3,"qty":30}]}', '{"atk":60,"def":20}', 2, '昊天锤血脉，力量爆发'),
  (6, '七宝琉璃血脉','bloodline',4, '{"gold":8000,"items":[{"id":3,"qty":30}]}', '{"mp":200,"intel":40}', 3, '辅助系顶级血脉');

INSERT OR IGNORE INTO hidden_weapon (id, name, power, cost, price, desc) VALUES
  (1, '袖箭',       120,  5, 800,  '唐门基础暗器'),
  (2, '紧背花装弩', 180, 10, 2000, '连发暗器'),
  (3, '佛怒唐莲',   400, 30, 8000, '唐门最强暗器');

INSERT OR IGNORE INTO guild_shop (item_id, price, stock) VALUES
  (2, 800,  -1),
  (3, 300,  -1),
  (1, 900,  -1);

INSERT OR IGNORE INTO tutorial (id, key, title, body, sort) VALUES
  (1, 'start',  '怎么开始',   '发「开始穿越 男 你的名字」建号。之后「菜单」看全部功能，「属性」看自己。', 1),
  (2, 'fight',  '怎么打怪',   '「魂兽」看本图有什么 → 「挑战魂兽 <名字>」→ 「自动」一键打完。血少了「休息」。', 2),
  (3, 'ring',   '怎么升环',   '等级到 10 的倍数就卡住了，要去打足够老的魂兽掉魂环，然后「附加魂环」。', 3),
  (4, 'money',  '怎么赚钱',   '打怪掉魂币，多余的装备「分解」，材料可以「出售」，也能挂「拍卖」。', 4),
  (5, 'guild',  '宗门怎么玩', '「创建宗门」后「捐献」攒资金 → 「宗门升级」全员加属性 → 「占领」领地「挖矿」。', 5),
  (6, 'social', '社交有什么用','「求婚」双方在线时打怪经验 +15%；「拜师」后徒弟打怪师父分经验。', 6);

INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('meditation_exp_per_min', '30',  'number', '冥想每分钟获得经验'),
  ('meditation_cap_hours',   '8',   'number', '冥想最多累计小时'),
  ('gem_slot_max',           '3',   'number', '每件装备可镶嵌宝石数'),
  ('gem_open_cost',          '500', 'number', '开孔费用'),
  ('rename_cost',            '500', 'number', '改名字费用'),
  ('flower_price',           '100', 'number', '一朵花的魂币价格'),
  ('charm_per_flower',       '10',  'number', '每朵花加多少魅力'),
  ('durability_max',         '100', 'number', '装备耐久上限'),
  ('durability_per_battle',  '1',   'number', '每场战斗掉多少耐久'),
  ('repair_cost_per_point',  '5',   'number', '每点耐久修理费'),
  ('battlepass_exp_per_task','100', 'number', '斗天任务每次给多少积分'),
  ('season_days',            '30',  'number', '赛季持续天数');

-- 斗天（战令）奖励档位
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('battlepass_tiers', '100,300,600,1000,2000', 'text', '斗天积分奖励档位');

-- 领地守卫与宗门战
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('war_declare_cost',       '2000', 'number', '宣战费用'),
  ('war_hours',              '24',   'number', '宣战有效期（小时）'),
  ('guard_base_rounds',      '6',    'number', '领地守卫的目标回合数'),
  ('guard_defense_base',     '100',  'number', '领地初始守卫强度'),
  ('guard_level_bonus',      '0.15', 'number', '占领方宗门每级提升多少守卫强度'),
  ('guard_time_bonus',       '0.02', 'number', '占领每小时提升多少守卫强度'),
  ('guard_max_defense',      '400',  'number', '守卫强度上限'),
  ('raid_lose_fund',         '300',  'number', '守方成功守住的资金奖励'),
  ('collect_daily_limit',    '3',    'number', '每人每天领地收取次数'),
  ('collect_guild_bonus',    '0.10', 'number', '宗门每级给领地收益的加成');

-- ---------- 丹药系统：药材 / 丹鼎 / 丹火 / 丹方 ----------
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES
  (201, '蓝银草',       'herb', 'any', 20,  '', 0, 1, '最常见的药材'),
  (202, '鸡冠凤凰葵',   'herb', 'any', 60,  '', 0, 1, '火属性药材'),
  (203, '八角玄冰草',   'herb', 'any', 60,  '', 0, 1, '冰属性药材'),
  (204, '相思断肠红',   'herb', 'any', 200,'', 0, 1, '稀有药材'),
  (205, '龙芝叶',       'herb', 'any', 150,'', 0, 1, '补气药材');

INSERT OR IGNORE INTO alchemy_tool (id, name, kind, bonus, price, desc) VALUES
  (1, '青石鼎', 'furnace',  5, 500,  '入门丹鼎'),
  (2, '玄铁鼎', 'furnace', 12, 3000, '成功率更高的丹鼎'),
  (3, '九龙鼎', 'furnace', 20, 12000,'顶级丹鼎'),
  (4, '兽火',   'fire',     5, 500,  '普通兽火'),
  (5, '地心火', 'fire',    12, 3000, '稳定的地火'),
  (6, '幽冥火', 'fire',    20, 12000,'顶级丹火');

INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES
  (6, '回魂丹·真', 'alchemy', '炼药师', 1, '{"gold":30,"items":[{"id":201,"qty":3},{"id":205,"qty":1}]}', 'item', 1, 1, '蓝银草×3 + 龙芝叶×1 + 30 魂币'),
  (7, '金疮药·真', 'alchemy', '炼药师', 3, '{"gold":40,"items":[{"id":201,"qty":2},{"id":202,"qty":1}]}', 'item', 2, 1, '蓝银草×2 + 鸡冠凤凰葵×1 + 40 魂币'),
  (8, '凝神丹',   'alchemy', '炼药师', 5, '{"gold":120,"items":[{"id":203,"qty":2},{"id":204,"qty":1}]}', 'item', 1, 2, '八角玄冰草×2 + 相思断肠红×1 + 120 魂币');

INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('alchemy_base_rate',  '55', 'number', '炼丹基础成功率 %'),
  ('alchemy_rate_cap',   '95', 'number', '炼丹成功率上限 %'),
  ('alchemy_level_bonus','2',  'number', '每高出一级加多少成功率'),
  ('alchemy_refund',     '0.5','number', '炼丹失败返还材料的比例');

-- 炼丹等级加成封顶（否则鼎火没意义）
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('alchemy_level_bonus_cap', '20', 'number', '炼丹等级加成的上限百分点');

-- ============================================================
-- v12 内容补深（审计脚本查出来的缺口）
-- ============================================================

-- ---------- 魂技 3 → 23（按魂环年限分档） ----------
INSERT OR IGNORE INTO skill (id, name, scope, power, cost, hit, cd, desc) VALUES
  -- 十年档（低耗小威力，前期主力）
  (10, '蓝银草缠',   'enemy_one', 130,  8, 95, 0, '最基础的缠绕'),
  (11, '虎啸',       'enemy_one', 145, 10, 95, 1, '一声虎啸震慑对手'),
  (12, '兔跳',       'self_one',  110,  6,100, 2, '轻身跃起，提升闪避'),
  (13, '石肤',       'self_one',  105,  8,100, 3, '硬化皮肤，提升防御'),
  -- 百年档
  (14, '蛛网束缚',   'enemy_one', 190, 14, 92, 2, '吐丝困敌'),
  (15, '幽冥爪',     'enemy_one', 210, 16, 90, 2, '幽冥猫的利爪'),
  (16, '曼陀罗毒',   'enemy_one', 175, 15, 95, 3, '剧毒侵蚀，持续伤害'),
  (17, '铁甲护身',   'self_one',  160, 14,100, 4, '凝聚护甲'),
  -- 千年档
  (18, '蓝银囚笼',   'enemy_one', 260, 22, 90, 3, '蓝银草结成牢笼'),
  (19, '白虎流星雨', 'enemy_one', 300, 26, 88, 4, '流星般的连击'),
  (20, '凤凰啸天击', 'enemy_all', 220, 30, 90, 5, '火焰横扫全场'),
  (21, '玄冰刺',     'enemy_one', 280, 24, 92, 3, '极寒之刺'),
  -- 万年档
  (22, '蓝银霸王枪', 'enemy_one', 380, 34, 88, 4, '蓝银草化枪突刺'),
  (23, '大须弥锤',   'enemy_one', 420, 40, 85, 5, '昊天锤绝技'),
  (24, '死亡蛛皇',   'enemy_all', 320, 44, 88, 6, '蛛皇降临，群体伤害'),
  (25, '冰碧帝皇蝎', 'enemy_one', 400, 38, 90, 5, '极致之冰'),
  -- 十万年档（终局）
  (26, '蓝银领域',   'enemy_all', 420, 50, 92, 6, '蓝银草领域，全场压制'),
  (27, '昊天真身',   'enemy_all', 480, 60, 88, 8, '昊天锤真身降临'),
  (28, '九幽雀鸣',   'enemy_all', 450, 55, 90, 7, '九幽之音，神魂震荡'),
  (29, '海神黄昏',   'enemy_all', 520, 70, 85,10, '海神领域，毁天灭地');

-- ---------- 称号 4 → 16 ----------
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES
  (5,  '魂尊',   '三十级魂尊',       '{"level":30}'),
  (6,  '魂宗',   '四十级魂宗',       '{"level":40}'),
  (7,  '魂王',   '五十级魂王',       '{"level":50}'),
  (8,  '魂帝',   '六十级魂帝',       '{"level":60}'),
  (9,  '魂圣',   '七十级魂圣',       '{"level":70}'),
  (10, '魂斗罗', '八十级魂斗罗',     '{"level":80}'),
  (11, '三环魂尊', '三个魂环',       '{"ring":3}'),
  (12, '五环魂王', '五个魂环',       '{"ring":5}'),
  (13, '七环魂圣', '七个魂环',       '{"ring":7}'),
  (14, '千锤百炼', '累计击杀 100 只', '{"kill":100}'),
  (15, '富甲一方', '持有 10 万魂币',  '{"gold":100000}'),
  (16, '万人迷',   '魅力达到 500',    '{"charm":500}');

-- ---------- 装备补齐缺的部位（head / torso） ----------
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES
  (13, '白虎头骨',   'bone',  'head',  3, NULL, 60,  0,  6, 18, 0,  4, 0,  2, 0, 0, '白虎魂骨，头部'),
  (14, '蓝银头冠',   'armor', 'head',  2, NULL, 40, 20,  2,  8, 2,  0, 4,  1, 1, 0, '蓝银草编成的头冠'),
  (15, '玄武躯干骨', 'bone',  'torso', 4, NULL,120,  0,  0, 30, 0,  0, 0,  1, 0, 0, '玄武魂骨，防御极高'),
  (16, '天使战甲',   'armor', 'torso', 3, NULL, 80, 30,  4, 14, 1,  2, 2,  0, 1, 0, '天使一族的战甲'),
  (17, '幽冥左爪',   'bone',  'arm_l', 3, NULL, 30,  0, 12,  6, 4,  3, 0,  2, 3, 5, '幽冥灵猫的利爪'),
  (18, '凤凰右翼',   'bone',  'arm_r', 3, NULL, 40, 20, 10,  6, 6,  0, 4,  3, 2, 0, '邪火凤凰的残翼'),
  (19, '疾风左腿',   'armor', 'leg_l', 2, NULL, 35,  0,  3,  6, 8,  1, 0,  4, 0, 0, '轻装护腿'),
  (20, '疾风右腿',   'armor', 'leg_r', 2, NULL, 35,  0,  3,  6, 8,  1, 0,  4, 0, 0, '轻装护腿');

-- ---------- 宝石 6 → 14 ----------
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES
  (7,  '烈焰石', 2, 16,  0,   0,  0, 0, 2, 0, '攻击 +16 暴击 +2'),
  (8,  '磐石',   2,  0, 20,  100, 0, 0, 0, 0, '防御 +20 生命 +100'),
  (9,  '清心石', 2,  0,  0,   0, 100,0, 0, 0, '魂力 +100'),
  (10, '风灵石', 2,  0,  0,   0,  0, 10,0, 3, '速度 +10 闪避 +3'),
  (11, '锐金石', 3, 24,  0,   0,  0, 0, 4, 0, '攻击 +24 暴击 +4'),
  (12, '玄龟甲', 3,  0, 26,  180, 0, 0, 0, 2, '防御 +26 生命 +180'),
  (13, '星辰石', 4, 30, 10,  120, 50,4, 3, 1, '全属性小成'),
  (14, '混沌石', 5, 45, 15,  200, 80,6, 5, 2, '传说中的宝石');

-- ---------- 功法 / 血脉 6 → 14 ----------
INSERT OR IGNORE INTO aptitude (id, name, kind, rarity, cost, attrs, skill_id, desc) VALUES
  (7,  '鬼影迷踪', 'technique', 3, '{"gold":3500}', '{"spd":20,"dodge":6}', NULL, '唐门轻身功法'),
  (8,  '玄玉手',   'technique', 3, '{"gold":3500}', '{"def":25,"hp":150}', NULL, '唐门护体功法'),
  (9,  '控鹤擒龙·上','technique',4, '{"gold":9000,"items":[{"id":3,"qty":20}]}', '{"atk":50,"spd":12}', NULL, '控鹤擒龙大成'),
  (10, '紫极魔瞳·上','technique',4,'{"gold":9000,"items":[{"id":3,"qty":20}]}', '{"intel":55,"crit":8}', NULL, '紫极魔瞳大成'),
  (11, '凤凰血脉', 'bloodline', 4, '{"gold":8000,"items":[{"id":3,"qty":30}]}', '{"atk":45,"hp":200}', 20, '邪火凤凰血脉'),
  (12, '白虎血脉', 'bloodline', 4, '{"gold":8000,"items":[{"id":3,"qty":30}]}', '{"atk":35,"def":35}', 19, '白虎一族血脉'),
  (13, '幽冥血脉', 'bloodline', 3, '{"gold":6000,"items":[{"id":3,"qty":20}]}', '{"spd":25,"dodge":8}', 15, '幽冥灵猫血脉'),
  (14, '海神血脉', 'bloodline', 5, '{"gold":20000,"items":[{"id":3,"qty":80}]}', '{"hp":500,"atk":80,"def":40}', 29, '海神传承，最强血脉');

-- ---------- 药材 5 → 11 ----------
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES
  (206, '紫丹参',     'herb', 'any', 80,  '', 0, 1, '补血药材'),
  (207, '七叶莲',     'herb', 'any', 120, '', 0, 1, '解毒药材'),
  (208, '天青藤',     'herb', 'any', 180, '', 0, 1, '通络药材'),
  (209, '血参',       'herb', 'any', 300, '', 0, 1, '大补药材'),
  (210, '九幽花',     'herb', 'any', 500, '', 0, 1, '稀有花材'),
  (211, '龙涎草',     'herb', 'any', 800, '', 0, 1, '传说药材');

-- ---------- 丹方 5 → 13 ----------
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES
  (9,  '紫丹',   'alchemy', '炼药师', 2, '{"gold":60,"items":[{"id":206,"qty":2},{"id":201,"qty":2}]}', 'item', 2, 1, '紫丹参×2 + 蓝银草×2'),
  (10, '解毒丹', 'alchemy', '炼药师', 4, '{"gold":90,"items":[{"id":207,"qty":2},{"id":201,"qty":1}]}', 'item', 1, 1, '七叶莲×2 + 蓝银草×1'),
  (11, '天青散', 'alchemy', '炼药师', 6, '{"gold":140,"items":[{"id":208,"qty":2},{"id":206,"qty":1}]}', 'item', 1, 2, '天青藤×2 + 紫丹参×1'),
  (12, '血参丹', 'alchemy', '炼药师', 8, '{"gold":220,"items":[{"id":209,"qty":1},{"id":208,"qty":2}]}', 'item', 2, 2, '血参×1 + 天青藤×2'),
  (13, '九幽丹', 'alchemy', '炼药师', 12,'{"gold":400,"items":[{"id":210,"qty":1},{"id":209,"qty":1}]}', 'item', 1, 3, '九幽花×1 + 血参×1'),
  (14, '龙涎丹', 'alchemy', '炼药师', 16,'{"gold":800,"items":[{"id":211,"qty":1},{"id":210,"qty":1}]}', 'item', 1, 3, '龙涎草×1 + 九幽花×1'),
  -- 其他职业的配方（审计发现这 3 个职业没有配方）
  (15, '魂导器·刃', 'craft', '魂导器师', 1, '{"gold":500,"items":[{"id":3,"qty":5}]}', 'equip', 5, 1, '碎片×5 + 500 魂币'),
  (16, '魂导器·盾', 'craft', '魂导器师', 3, '{"gold":800,"items":[{"id":3,"qty":8}]}', 'equip', 6, 1, '碎片×8 + 800 魂币'),
  (17, '聚灵阵盘',  'design','阵法师',   1, '{"gold":600,"items":[{"id":3,"qty":6}]}', 'equip', 7, 1, '碎片×6 + 600 魂币'),
  (18, '护身阵盘',  'design','阵法师',   4, '{"gold":1000,"items":[{"id":3,"qty":10}]}', 'equip', 8, 1, '碎片×10 + 1000 魂币'),
  (19, '玉露糕',    'craft', '厨师',     1, '{"gold":80,"items":[{"id":201,"qty":2}]}', 'item', 2, 2, '蓝银草×2 + 80 魂币'),
  (20, '龙凤宴',    'craft', '厨师',     5, '{"gold":500,"items":[{"id":209,"qty":1},{"id":205,"qty":1}]}', 'item', 1, 3, '血参×1 + 龙芝叶×1');


-- ---------- 补齐装备缺的部位（id 从 30 起，避开已占用的 13/14 斗灵） ----------
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES
  (30, '白虎头骨',   'bone',  'head',  3, NULL, 60,  0,  6, 18, 0,  4, 0,  2, 0, 0, '白虎魂骨，头部'),
  (31, '蓝银头冠',   'armor', 'head',  2, NULL, 40, 20,  2,  8, 2,  0, 4,  1, 1, 0, '蓝银草编成的头冠'),
  (32, '幽冥左爪',   'bone',  'arm_l', 3, NULL, 30,  0, 12,  6, 4,  3, 0,  2, 3, 5, '幽冥灵猫的利爪'),
  (33, '凤凰右翼',   'bone',  'arm_r', 3, NULL, 40, 20, 10,  6, 6,  0, 4,  3, 2, 0, '邪火凤凰的残翼'),
  (34, '疾风左腿',   'armor', 'leg_l', 2, NULL, 35,  0,  3,  6, 8,  1, 0,  4, 0, 0, '轻装护腿'),
  (35, '疾风右腿',   'armor', 'leg_r', 2, NULL, 35,  0,  3,  6, 8,  1, 0,  4, 0, 0, '轻装护腿');

-- ---------- 伙伴补齐 10 → 13 ----------
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES
  (30, '泰坦巨猿', 'soul', 5, 5, 400, 100, 60, 40, 12, 50, 10, 4, 8, 20, 27, '上古异种，力量无双'),
  (31, '天青牛蟒', 'soul', 5, 5, 500, 150, 50, 45, 10, 45, 20, 3, 6, 15, 26, '十万年魂兽，牛首蛇身'),
  (32, '邪火凤凰', 'pet',  4, 4, 300, 120, 55, 25, 18, 30, 30, 6, 12, 25, 20, '火属性战宠，群攻见长');

-- ---------- 补剩下 3 张只有 1 只怪的地图（依赖内容包，见 post.sql） ----------


-- ---------- 挑战层配置：万兽台 30 层 / 深渊 20 层 / 神位 1 层 ----------
INSERT OR IGNORE INTO challenge_floor (challenge_id, floor, name, is_boss, reward, first_clear, desc) VALUES
  (1, 1, '青石阶', 0, '{"gold":200,"exp":300}', '{}', ''),
  (1, 2, '灰岩阶', 0, '{"gold":236,"exp":354}', '{}', ''),
  (1, 3, '苔痕阶', 0, '{"gold":272,"exp":408}', '{}', ''),
  (1, 4, '铁索阶', 0, '{"gold":308,"exp":462}', '{}', ''),
  (1, 5, '碎石阶', 0, '{"gold":344,"exp":516}', '{}', ''),
  (1, 6, '古木阶', 0, '{"gold":380,"exp":570}', '{}', ''),
  (1, 7, '雾锁阶', 0, '{"gold":416,"exp":624}', '{}', ''),
  (1, 8, '断崖阶', 0, '{"gold":452,"exp":678}', '{}', ''),
  (1, 9, '寒风阶', 0, '{"gold":488,"exp":732}', '{}', ''),
  (1, 10, '兽王台', 1, '{"gold":524,"exp":786,"items":[{"id":3,"qty":10}]}', '{"gold":2000,"coupon":40,"equips":[30]}', '守关层'),
  (1, 11, '血砂道', 0, '{"gold":560,"exp":840}', '{}', ''),
  (1, 12, '白骨廊', 0, '{"gold":596,"exp":894}', '{}', ''),
  (1, 13, '赤炎廊', 0, '{"gold":632,"exp":948}', '{}', ''),
  (1, 14, '幽影廊', 0, '{"gold":668,"exp":1002}', '{}', ''),
  (1, 15, '毒瘴廊', 0, '{"gold":704,"exp":1056}', '{}', ''),
  (1, 16, '雷鸣廊', 0, '{"gold":740,"exp":1110}', '{}', ''),
  (1, 17, '冰封廊', 0, '{"gold":776,"exp":1164}', '{}', ''),
  (1, 18, '烈焰廊', 0, '{"gold":812,"exp":1218}', '{}', ''),
  (1, 19, '深渊廊', 0, '{"gold":848,"exp":1272}', '{}', ''),
  (1, 20, '万兽殿', 1, '{"gold":884,"exp":1326,"items":[{"id":3,"qty":15}]}', '{"gold":4000,"coupon":80,"gems":[5]}', '守关层'),
  (1, 21, '问心台', 0, '{"gold":920,"exp":1380}', '{}', ''),
  (1, 22, '照影台', 0, '{"gold":956,"exp":1434}', '{}', ''),
  (1, 23, '无我台', 0, '{"gold":992,"exp":1488}', '{}', ''),
  (1, 24, '破妄台', 0, '{"gold":1028,"exp":1542}', '{}', ''),
  (1, 25, '明心台', 0, '{"gold":1064,"exp":1596}', '{}', ''),
  (1, 26, '见性台', 0, '{"gold":1100,"exp":1650}', '{}', ''),
  (1, 27, '归元台', 0, '{"gold":1136,"exp":1704}', '{}', ''),
  (1, 28, '天问台', 0, '{"gold":1172,"exp":1758}', '{}', ''),
  (1, 29, '忘尘台', 0, '{"gold":1208,"exp":1812}', '{}', ''),
  (1, 30, '万兽之巅', 1, '{"gold":1244,"exp":1866,"items":[{"id":3,"qty":20}]}', '{"gold":6000,"coupon":120,"companions":[30]}', '守关层'),
  (2, 1, '幽冥道', 0, '{"gold":500,"exp":800}', '{}', ''),
  (2, 2, '沉沦道', 0, '{"gold":590,"exp":944}', '{}', ''),
  (2, 3, '裂魂道', 0, '{"gold":680,"exp":1088}', '{}', ''),
  (2, 4, '噬心道', 0, '{"gold":770,"exp":1232}', '{}', ''),
  (2, 5, '深渊守卫', 1, '{"gold":860,"exp":1376,"items":[{"id":3,"qty":7}]}', '{"gold":1000,"coupon":20,"gems":[4]}', '守关层'),
  (2, 6, '血池', 0, '{"gold":950,"exp":1520}', '{}', ''),
  (2, 7, '骨海', 0, '{"gold":1040,"exp":1664}', '{}', ''),
  (2, 8, '怨井', 0, '{"gold":1130,"exp":1808}', '{}', ''),
  (2, 9, '魂渊', 0, '{"gold":1220,"exp":1952}', '{}', ''),
  (2, 10, '深渊领主', 1, '{"gold":1310,"exp":2096,"items":[{"id":3,"qty":10}]}', '{"gold":2000,"coupon":40,"equips":[32]}', '守关层'),
  (2, 11, '魔音廊', 0, '{"gold":1400,"exp":2240}', '{}', ''),
  (2, 12, '邪影廊', 0, '{"gold":1490,"exp":2384}', '{}', ''),
  (2, 13, '蚀骨廊', 0, '{"gold":1580,"exp":2528}', '{}', ''),
  (2, 14, '绝望廊', 0, '{"gold":1670,"exp":2672}', '{}', ''),
  (2, 15, '深渊魔帝', 1, '{"gold":1760,"exp":2816,"items":[{"id":3,"qty":12}]}', '{"gold":3000,"coupon":60,"gems":[6]}', '守关层'),
  (2, 16, '终末之门', 0, '{"gold":1850,"exp":2960}', '{}', ''),
  (2, 17, '虚无之门', 0, '{"gold":1940,"exp":3104}', '{}', ''),
  (2, 18, '寂灭之门', 0, '{"gold":2030,"exp":3248}', '{}', ''),
  (2, 19, '归墟之门', 0, '{"gold":2120,"exp":3392}', '{}', ''),
  (2, 20, '深渊之底', 1, '{"gold":2210,"exp":3536,"items":[{"id":3,"qty":15}]}', '{"gold":4000,"coupon":80,"companions":[31]}', '守关层'),
  (4, 1, '神位之试', 1, '{"gold":5000,"exp":20000}', '{"gold":20000,"coupon":500,"companions":[31]}', '成神之路');

-- ---------- 状态效果 14 种 ----------
INSERT OR IGNORE INTO status_def (key, name, kind, desc, max_stack, duration, tick_pct, atk_pct, def_pct, spd_pct, dodge_pct, crit_pct, skip_turn, block_skill, instant_kill, instant_kill_chance) VALUES
  ('poison',      '中毒',   'debuff', '每回合按最大生命掉血，可叠 3 层', 3, 3,  6,   0,   0,   0,   0,  0, 0, 0, 0, 0),
  ('burn',        '灼烧',   'debuff', '每回合掉血，比中毒猛但短',        2, 2,  8,   0,   0,   0,   0,  0, 0, 0, 0, 0),
  ('bleed',       '流血',   'debuff', '每回合掉血，可叠 4 层',           4, 3,  5,   0,   0,   0,   0,  0, 0, 0, 0, 0),
  ('slow',        '减速',   'debuff', '速度 -30%',                      1, 3,  0,   0,   0, -30,   0,  0, 0, 0, 0, 0),
  ('stun',        '眩晕',   'debuff', '跳过一回合',                      1, 1,  0,   0,   0,   0,   0,  0, 1, 0, 0, 0),
  ('freeze',      '冰冻',   'debuff', '跳过两回合，命中率低',            1, 2,  0,   0,   0,   0,   0,  0, 1, 0, 0, 0),
  ('silence',     '沉默',   'debuff', '不能使用魂技',                    1, 2,  0,   0,   0,   0,   0,  0, 0, 1, 0, 0),
  ('weaken',      '虚弱',   'debuff', '攻击 -25%',                       2, 3,  0, -25,   0,   0,   0,  0, 0, 0, 0, 0),
  ('armor_break', '破甲',   'debuff', '防御 -30%',                       2, 3,  0,   0, -30,   0,   0,  0, 0, 0, 0, 0),
  ('regen',       '回复',   'buff',   '每回合回血',                      1, 4, -6,   0,   0,   0,   0,  0, 0, 0, 0, 0),
  ('shield',      '护盾',   'buff',   '防御 +40%',                       1, 3,  0,   0,  40,   0,   0,  0, 0, 0, 0, 0),
  ('focus',       '会心',   'buff',   '暴击 +20%',                       1, 3,  0,   0,   0,   0,   0, 20, 0, 0, 0, 0),
  ('swift',       '疾影',   'buff',   '闪避 +20% 速度 +15%',             1, 3,  0,   0,   0,  15,  20,  0, 0, 0, 0, 0),
  ('death_mark',  '即死印记','debuff','每回合有 8% 概率直接击杀',        1, 1,  0,   0,   0,   0,   0,  0, 0, 0, 1, 8);

-- ---------- 技能 → 状态 ----------
INSERT OR IGNORE INTO skill_status (skill_id, status_key, chance, duration) VALUES
  (10, 'slow',        30, 2),
  (11, 'weaken',      40, 2),
  (12, 'swift',      100, 3),
  (13, 'shield',     100, 3),
  (14, 'slow',        50, 3),
  (15, 'bleed',       50, 3),
  (16, 'poison',     100, 3),
  (17, 'shield',     100, 3),
  (18, 'stun',        35, 1),
  (19, 'bleed',       45, 2),
  (20, 'burn',        60, 2),
  (21, 'slow',        60, 3),
  (22, 'armor_break', 45, 3),
  (23, 'stun',        25, 1),
  (24, 'poison',      70, 3),
  (24, 'weaken',      40, 2),
  (25, 'freeze',      30, 2),
  (26, 'slow',        50, 3),
  (26, 'silence',     30, 2),
  (27, 'armor_break', 50, 3),
  (28, 'silence',     45, 2),
  (29, 'death_mark',   8, 1),
  (29, 'weaken',      50, 3);

-- PVP 平衡系数
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('pvp_damage_scale',      '0.75', 'number', 'PVP 伤害缩放（拉长回合，避免先手决定胜负）'),
  ('pvp_second_mover_bonus','0.12', 'number', 'PVP 后手伤害补偿比例'),
  ('pvp_level_gap_soft',    '10',   'number', '等级差软上限（超过后强者伤害递减）'),
  ('pvp_max_rounds',        '15',   'number', 'PVP 最大回合数'),
  ('pvp_daily_limit',       '10',   'number', '每人每天最多斗魂场次'),
  ('pvp_score_damping',     '0.85', 'number', '实力差距导致的积分衰减上限');

-- ============================================================
-- v15 内容扩充：武魂 / 地图 / 道具
-- 参考原著 + 网络热点（原神/龙族等 IP 的风格化致敬）
-- ============================================================

-- ---------- 两个新武魂系列 ----------
INSERT OR IGNORE INTO wuhun_series (id, name, hp, mp, str, intel, atk, def, spd, desc) VALUES
  (20, '元素系', 1.0, 1.3, 0.8, 1.4, 1.1, 0.9, 1.0, '操控元素，攻守兼备'),
  (21, '龙族系', 1.3, 1.0, 1.4, 1.0, 1.3, 1.1, 0.8, '龙血沸腾，力量至上');

-- ---------- 武魂 +21（原神风 / 龙族风 / 原著） ----------
INSERT OR IGNORE INTO wuhun (id, name, series_id, rarity, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES
  -- 元素系（原神风格化）
  (300, '风之翼',   20, 2, 110, 150, 11, 8,  14, 7,  16, 7, 7, 155, '御风而行，轻盈迅捷'),
  (301, '岩之盾',   20, 2, 170, 110, 8,  16, 8,  13, 8,  4, 4, 145, '磐岩为盾，坚不可摧'),
  (302, '雷之罚',   20, 3, 110, 160, 16, 7,  12, 8,  17, 5, 9, 170, '雷霆落下，一击致命'),
  (303, '草之缚',   20, 2, 130, 150, 10, 10, 10, 9,  18, 6, 5, 150, '藤蔓束缚，控制见长'),
  (304, '冰之封',   20, 3, 140, 150, 13, 12, 9,  10, 16, 5, 7, 155, '极寒封印，减速敌人'),
  (305, '水之润',   20, 1, 150, 170, 8,  11, 10, 7,  20, 5, 4, 145, '润物无声，回复强'),
  (306, '火之烈',   20, 3, 120, 140, 17, 8,  12, 11, 12, 4, 10, 175, '烈焰焚天，爆发极高'),
  -- 龙族系（龙族风格化）
  (310, '言灵·烛龙', 21, 4, 200, 180, 24, 14, 9,  20, 18, 3, 8, 165, '言出法随，龙语之力'),
  (311, '青铜御座',  21, 4, 230, 130, 20, 20, 7,  22, 10, 2, 6, 155, '青铜与火之王'),
  (312, '黄金瞳',    21, 3, 150, 170, 18, 11, 13, 14, 20, 6, 11, 180, '黄金瞳开，洞悉一切'),
  (313, '龙王之心',  21, 5, 280, 160, 26, 18, 8,  25, 15, 2, 9, 170, '龙王之心，睥睨众生'),
  (314, '龙血战体',  21, 4, 260, 120, 22, 22, 6,  24, 8,  1, 5, 150, '龙血沸腾，越战越勇'),
  (315, '白王之翼',  21, 3, 180, 150, 19, 13, 12, 16, 14, 5, 7, 160, '白王之翼，风雷相随');

-- ---------- 地图 +10（跨 IP 风格的秘境） ----------
INSERT OR IGNORE INTO map (id, name, min_level, portal, desc) VALUES
  (2000, '风起地',      1,  1, '风穿过草原，蒲公英漫天'),
  (2001, '无妄坡',      8,  1, '雾锁荒坡，阴气森森'),
  (2002, '绝云间',      15, 1, '云海之上的仙家遗迹'),
  (2003, '璃月港',      20, 1, '商贾云集的港口'),
  (2004, '稻妻城',      30, 1, '雷雨笼罩的岛国都城'),
  (2005, '须弥城',      40, 1, '智慧之树下的学城'),
  (2006, '卡塞尔学院',  25, 1, '屠龙者的摇篮'),
  (2007, '青铜城',      45, 1, '青铜与火之王的沉眠地'),
  (2008, '白帝城',      55, 1, '龙族最后的王座'),
  (2009, '星斗大森林·深处', 60, 1, '十万年魂兽的领地');

-- ---------- 道具 +18 ----------
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES
  (300, '大还丹',     'consumable', 'any', 600,  'heal_hp', 1200, 1, '瞬间回复大量生命'),
  (301, '聚气散',     'consumable', 'any', 500,  'heal_mp', 800,  1, '瞬间回复大量魂力'),
  (302, '洗髓丹',     'consumable', 'any', 1500, 'add_exp', 3000, 1, '洗经伐髓，直接得经验'),
  (303, '凝神香',     'consumable', 'battle', 300, 'heal_mp', 300, 1, '战斗中凝神，回魂力'),
  (304, '金刚散',     'consumable', 'any', 800,  'heal_hp', 800,  1, '外用金疮，止血生肌'),
  (305, '风之翼羽',   'material',   'any', 200,  '', 0, 1, '风起地拾得的羽毛'),
  (306, '岩晶核',     'material',   'any', 250,  '', 0, 1, '无妄坡的岩元素结晶'),
  (307, '雷樱花瓣',   'material',   'any', 400,  '', 0, 1, '稻妻城飘落的雷樱'),
  (308, '龙鳞',       'material',   'any', 900,  '', 0, 1, '龙族的鳞片，极其坚硬'),
  (309, '龙骨碎片',   'material',   'any', 1200, '', 0, 1, '青铜城挖出的龙骨'),
  (310, '龙血结晶',   'material',   'any', 2500, '', 0, 1, '龙王之血的凝结'),
  (311, '紫金葫芦',   'consumable', 'any', 3000, 'heal_hp', 5000, 1, '一口回满'),
  (312, '九转还魂丹', 'consumable', 'any', 8000, 'add_exp', 20000, 1, '传说中的仙丹'),
  (313, '魂导器图纸', 'material',   'any', 600,  '', 0, 1, '魂导器的设计图'),
  (314, '阵法玉简',   'material',   'any', 700,  '', 0, 1, '阵法师的入门玉简'),
  (315, '龙凤呈祥盒', 'gift',       'any', 2000, '', 0, 1, '礼盒，打开有惊喜'),
  (316, '斗罗纪念章', 'gift',       'any', 500,  '', 0, 1, '限定纪念品'),
  (317, '星斗地图残页', 'material', 'any', 800,  '', 0, 1, '指向星斗深处的残页');

-- ============================================================
-- v16 内容大扩充：魂骨 / 套装 / 丹药 / 任务 / 魂兽 / NPC / 伙伴 / 宝石 / 称号 / 商店
-- ============================================================

-- ---------- 套装 ----------
INSERT OR IGNORE INTO equip_set (id, name, desc, bonus) VALUES (10, '白虎套装', '白虎一族的战装', '{"atk":40,"def":20,"hp":200}');
INSERT OR IGNORE INTO equip_set (id, name, desc, bonus) VALUES (11, '幽冥套装', '幽冥灵猫的影装', '{"spd":30,"dodge":8,"crit":5}');
INSERT OR IGNORE INTO equip_set (id, name, desc, bonus) VALUES (12, '蓝银套装', '蓝银草的守护', '{"hp":400,"def":30}');
INSERT OR IGNORE INTO equip_set (id, name, desc, bonus) VALUES (13, '凤凰套装', '邪火凤凰的羽衣', '{"atk":60,"crit":8}');
INSERT OR IGNORE INTO equip_set (id, name, desc, bonus) VALUES (14, '玄武套装', '玄武的重甲', '{"def":60,"hp":500}');

-- ---------- 魂骨 / 装备（六部位 × 多档 + 套装件） ----------
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (100, '白虎头骨', 'bone', 'head', 3, 10, 60, 0, 8, 18, 0, 4, 0, 0, 0, 0, '白虎一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (101, '白虎躯干骨', 'bone', 'torso', 3, 10, 60, 0, 8, 18, 0, 4, 0, 0, 0, 0, '白虎一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (102, '白虎左臂骨', 'bone', 'arm_l', 3, 10, 60, 0, 8, 18, 0, 4, 0, 0, 0, 0, '白虎一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (103, '白虎右臂骨', 'bone', 'arm_r', 3, 10, 60, 0, 8, 18, 0, 4, 0, 0, 0, 0, '白虎一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (104, '白虎左腿骨', 'bone', 'leg_l', 3, 10, 60, 0, 8, 18, 0, 4, 0, 0, 0, 0, '白虎一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (105, '白虎右腿骨', 'bone', 'leg_r', 3, 10, 60, 0, 8, 18, 0, 4, 0, 0, 0, 0, '白虎一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (106, '幽冥头骨', 'bone', 'head', 3, 11, 45, 0, 12, 0, 8, 0, 0, 3, 0, 0, '幽冥一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (107, '幽冥躯干骨', 'bone', 'torso', 3, 11, 45, 0, 12, 0, 8, 0, 0, 3, 0, 0, '幽冥一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (108, '幽冥左臂骨', 'bone', 'arm_l', 3, 11, 45, 0, 12, 0, 8, 0, 0, 3, 0, 0, '幽冥一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (109, '幽冥右臂骨', 'bone', 'arm_r', 3, 11, 45, 0, 12, 0, 8, 0, 0, 3, 0, 0, '幽冥一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (110, '幽冥左腿骨', 'bone', 'leg_l', 3, 11, 45, 0, 12, 0, 8, 0, 0, 3, 0, 0, '幽冥一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (111, '幽冥右腿骨', 'bone', 'leg_r', 3, 11, 45, 0, 12, 0, 8, 0, 0, 3, 0, 0, '幽冥一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (112, '蓝银头骨', 'bone', 'head', 2, 12, 90, 0, 0, 14, 0, 0, 6, 0, 0, 0, '蓝银一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (113, '蓝银躯干骨', 'bone', 'torso', 2, 12, 90, 0, 0, 14, 0, 0, 6, 0, 0, 0, '蓝银一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (114, '蓝银左臂骨', 'bone', 'arm_l', 2, 12, 90, 0, 0, 14, 0, 0, 6, 0, 0, 0, '蓝银一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (115, '蓝银右臂骨', 'bone', 'arm_r', 2, 12, 90, 0, 0, 14, 0, 0, 6, 0, 0, 0, '蓝银一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (116, '蓝银左腿骨', 'bone', 'leg_l', 2, 12, 90, 0, 0, 14, 0, 0, 6, 0, 0, 0, '蓝银一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (117, '蓝银右腿骨', 'bone', 'leg_r', 2, 12, 90, 0, 0, 14, 0, 0, 6, 0, 0, 0, '蓝银一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (118, '凤凰头骨', 'bone', 'head', 4, 13, 70, 0, 16, 0, 0, 0, 0, 0, 3, 5, '凤凰一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (119, '凤凰躯干骨', 'bone', 'torso', 4, 13, 70, 0, 16, 0, 0, 0, 0, 0, 3, 5, '凤凰一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (120, '凤凰左臂骨', 'bone', 'arm_l', 4, 13, 70, 0, 16, 0, 0, 0, 0, 0, 3, 5, '凤凰一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (121, '凤凰右臂骨', 'bone', 'arm_r', 4, 13, 70, 0, 16, 0, 0, 0, 0, 0, 3, 5, '凤凰一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (122, '凤凰左腿骨', 'bone', 'leg_l', 4, 13, 70, 0, 16, 0, 0, 0, 0, 0, 3, 5, '凤凰一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (123, '凤凰右腿骨', 'bone', 'leg_r', 4, 13, 70, 0, 16, 0, 0, 0, 0, 0, 3, 5, '凤凰一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (124, '玄武头骨', 'bone', 'head', 4, 14, 140, 0, 0, 26, 0, 0, 0, 0, 0, 0, '玄武一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (125, '玄武躯干骨', 'bone', 'torso', 4, 14, 140, 0, 0, 26, 0, 0, 0, 0, 0, 0, '玄武一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (126, '玄武左臂骨', 'bone', 'arm_l', 4, 14, 140, 0, 0, 26, 0, 0, 0, 0, 0, 0, '玄武一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (127, '玄武右臂骨', 'bone', 'arm_r', 4, 14, 140, 0, 0, 26, 0, 0, 0, 0, 0, 0, '玄武一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (128, '玄武左腿骨', 'bone', 'leg_l', 4, 14, 140, 0, 0, 26, 0, 0, 0, 0, 0, 0, '玄武一族的魂骨');
INSERT OR IGNORE INTO equip (id, name, kind, part, rarity, set_id, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, desc) VALUES (129, '玄武右腿骨', 'bone', 'leg_r', 4, 14, 140, 0, 0, 26, 0, 0, 0, 0, 0, 0, '玄武一族的魂骨');

-- ---------- 丹方扩充 ----------
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (21, '回春丹', 'alchemy', '炼药师', 3, '{"gold":80,"items":[{"id":201,"qty":2},{"id":206,"qty":1}]}', 'item', 2, 2, '回春丹 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (22, '固元丹', 'alchemy', '炼药师', 5, '{"gold":150,"items":[{"id":205,"qty":2},{"id":207,"qty":1}]}', 'item', 1, 2, '固元丹 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (23, '破障丹', 'alchemy', '炼药师', 9, '{"gold":300,"items":[{"id":208,"qty":2},{"id":204,"qty":1}]}', 'item', 1, 3, '破障丹 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (24, '洗髓丹', 'alchemy', '炼药师', 12, '{"gold":500,"items":[{"id":209,"qty":2},{"id":210,"qty":1}]}', 'item', 302, 1, '洗髓丹 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (25, '九幽还魂丹', 'alchemy', '炼药师', 18, '{"gold":1200,"items":[{"id":210,"qty":2},{"id":211,"qty":1}]}', 'item', 312, 1, '九幽还魂丹 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (26, '龙血丹', 'alchemy', '炼药师', 22, '{"gold":2500,"items":[{"id":211,"qty":2},{"id":310,"qty":1}]}', 'item', 312, 2, '龙血丹 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (27, '魂导·飞刃', 'craft', '魂导器师', 5, '{"gold":1200,"items":[{"id":3,"qty":12},{"id":313,"qty":1}]}', 'equip', 9, 1, '魂导·飞刃 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (28, '护身大阵', 'design', '阵法师', 8, '{"gold":2000,"items":[{"id":3,"qty":20},{"id":314,"qty":2}]}', 'equip', 10, 1, '护身大阵 的配方');
INSERT OR IGNORE INTO recipe (id, name, kind, profession, level_req, cost, out_kind, out_id, out_qty, desc) VALUES (29, '八珍宴', 'craft', '厨师', 10, '{"gold":800,"items":[{"id":209,"qty":1},{"id":210,"qty":1}]}', 'item', 300, 2, '八珍宴 的配方');

-- ---------- 道具扩充 ----------
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (400, '回春丹', 'consumable', 'any', 400, 'heal_hp', 900, 1, '回复大量生命');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (401, '固元丹', 'consumable', 'any', 600, 'heal_mp', 700, 1, '回复大量魂力');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (402, '破障丹', 'consumable', 'any', 2000, 'add_exp', 6000, 1, '突破瓶颈');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (403, '龙血丹', 'consumable', 'any', 9000, 'add_exp', 25000, 1, '龙血炼成的顶级丹药');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (404, '八珍宴', 'consumable', 'any', 3000, 'heal_hp', 4000, 1, '一桌好菜，回满生命');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (405, '白虎精血', 'material', 'any', 1500, '', 0, 1, '白虎一族的精血');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (406, '幽冥之影', 'material', 'any', 1500, '', 0, 1, '幽冥灵猫的残影');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (407, '凤凰余烬', 'material', 'any', 2000, '', 0, 1, '邪火凤凰的灰烬');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (408, '玄武甲片', 'material', 'any', 2500, '', 0, 1, '玄武脱落的甲片');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (409, '蓝银根须', 'material', 'any', 800, '', 0, 1, '蓝银草的根');
INSERT OR IGNORE INTO item (id, name, kind, use_scene, price, effect, amount, tradeable, desc) VALUES (410, '星辰砂', 'material', 'any', 3500, '', 0, 1, '从天而降的星砂');

-- ---------- 宝石扩充 ----------
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (20, '赤阳石', 3, 28, 0, 0, 0, 0, 0, 0, '攻击 +28');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (21, '幽兰石', 3, 0, 0, 0, 160, 0, 0, 0, '魂力 +160');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (22, '疾影石', 3, 0, 0, 0, 0, 14, 0, 4, '速度 +14 闪避 +4');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (23, '裂空石', 4, 36, 0, 0, 0, 0, 6, 0, '攻击 +36 暴击 +6');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (24, '玄冥石', 4, 0, 34, 260, 0, 0, 0, 0, '防御 +34 生命 +260');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (25, '龙魂石', 5, 50, 20, 300, 0, 0, 0, 0, '龙魂凝成，全属性强');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (26, '琉璃石', 4, 0, 0, 0, 220, 0, 0, 0, '魂力 +220 精神力 +20');
INSERT OR IGNORE INTO gem (id, name, rarity, atk, def, hp, mp, spd, crit, dodge, desc) VALUES (27, '天罡石', 5, 40, 40, 400, 0, 0, 0, 0, '攻守兼备的顶级宝石');

-- ---------- 称号扩充 ----------
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (20, '屠龙者', '击杀 500 只魂兽', '{"kill":500}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (21, '万兽之王', '击杀 2000 只魂兽', '{"kill":2000}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (22, '富可敌国', '持有 100 万魂币', '{"gold":1000000}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (23, '倾国倾城', '魅力 2000', '{"charm":2000}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (24, '九环封号', '九个魂环', '{"ring":9}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (25, '十环传说', '十个魂环', '{"ring":10}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (26, '登顶者', '等级 99', '{"level":99}');
INSERT OR IGNORE INTO title (id, name, desc, cond) VALUES (27, '初出茅庐', '等级 10', '{"level":10}');

-- ---------- 伙伴扩充 ----------
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (40, '蓝银皇', 'soul', 5, 5, 420, 200, 55, 35, 14, 30, 40, 4, 6, 150, 26, '蓝银草觉醒的皇者');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (41, '幽冥灵猫', 'soul', 4, 4, 260, 160, 48, 22, 22, 20, 22, 4, 6, 150, 15, '幽冥之中无声无息');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (42, '柔骨魅兔', 'soul', 3, 4, 240, 150, 38, 20, 24, 16, 24, 4, 6, 150, 12, '柔骨兔一族');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (43, '七宝琉璃', 'soul', 5, 5, 300, 320, 26, 30, 16, 10, 55, 4, 6, 150, 26, '辅助系最强');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (44, '玄武龟', 'pet', 3, 3, 500, 100, 22, 50, 6, 24, 8, 4, 6, 150, 17, '防御型战宠');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (45, '雷鹰', 'pet', 3, 3, 220, 140, 44, 16, 26, 18, 16, 4, 6, 150, 21, '速度型战宠');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (46, '青铜龙王', 'wsoul', 5, 5, 480, 200, 70, 42, 12, 55, 30, 4, 6, 150, 27, '青铜与火之王');
INSERT OR IGNORE INTO companion (id, name, kind, rarity, star, hp, mp, atk, def, spd, str, intel, dodge, crit, crit_dmg, skill_id, desc) VALUES (47, '白王', 'wsoul', 5, 5, 520, 220, 66, 46, 18, 50, 36, 4, 6, 150, 28, '白王之影');

-- ---------- 商店补货 ----------
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (1, 300, 600, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (1, 304, 800, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (1, 201, 20, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (1, 205, 150, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (2, 400, 420, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (2, 401, 640, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (2, 402, 2100, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (3, 303, 300, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (3, 404, 3000, -1, 10);
INSERT OR IGNORE INTO shop_item (shop_id, item_id, price, stock, sort) VALUES (3, 405, 1500, -1, 10);

-- ============================================================
-- v17 魂兽 / NPC / 任务扩充
-- ============================================================

-- ---------- 魂兽（新增 24 只，覆盖各年龄档） ----------
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2000, '赤练蛇', 'normal', 4, 30, 1, 1, 1, 1.5, 1.2, 1, '赤练蛇，十年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2001, '青风狼', 'normal', 4, 60, 1, 1, 1.1, 1.5, 1.2, 1, '青风狼，十年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2002, '铁背熊', 'normal', 5, 90, 1.1, 1.1, 0.9, 1.5, 1.2, 1, '铁背熊，十年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2003, '毒尾蝎', 'normal', 5, 180, 1.2, 0.9, 1, 1.5, 1.2, 1, '毒尾蝎，百年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2004, '鬼面蛛', 'normal', 5, 350, 1.1, 1, 1.1, 1.5, 1.2, 1, '鬼面蛛，百年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2005, '寒冰蟾', 'normal', 5, 600, 1, 1.2, 0.9, 1.5, 1.2, 1, '寒冰蟾，百年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2006, '烈焰虎', 'normal', 5, 900, 1.2, 1, 1, 1.5, 1.2, 1, '烈焰虎，百年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2007, '石甲龙', 'elite', 8, 1500, 1.1, 1.4, 0.8, 4, 3, 1, '石甲龙，千年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2008, '风雷鹰', 'elite', 8, 2200, 1.3, 0.9, 1.3, 4, 3, 1, '风雷鹰，千年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2009, '白鳞蟒', 'elite', 8, 3000, 1.2, 1.1, 1, 4, 3, 1, '白鳞蟒，千年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2010, '黑水玄蛇', 'elite', 8, 4500, 1.3, 1, 1.1, 4, 3, 1, '黑水玄蛇，千年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2011, '金甲犀', 'elite', 8, 6000, 1.1, 1.5, 0.8, 4, 3, 1, '金甲犀，千年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2012, '紫电貂', 'elite', 8, 8000, 1.3, 0.9, 1.4, 4, 3, 1, '紫电貂，千年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2013, '雷霆鹏', 'boss', 12, 12000, 1.3, 1, 1.4, 12, 8, 1, '雷霆鹏，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2014, '血瞳魔猿', 'boss', 12, 18000, 1.4, 1.2, 1, 12, 8, 1, '血瞳魔猿，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2015, '赤炎狮王', 'boss', 12, 25000, 1.4, 1.1, 1.1, 12, 8, 1, '赤炎狮王，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2016, '冰晶凤凰', 'boss', 12, 35000, 1.3, 1, 1.3, 12, 8, 1, '冰晶凤凰，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2017, '幽冥鬼豹', 'boss', 12, 48000, 1.3, 1, 1.5, 12, 8, 1, '幽冥鬼豹，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2018, '玄水蛟', 'boss', 12, 65000, 1.4, 1.2, 1.1, 12, 8, 1, '玄水蛟，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2019, '噬魂蛛', 'boss', 12, 80000, 1.4, 1.1, 1.2, 12, 8, 1, '噬魂蛛，万年魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2020, '三眼金猊', 'boss', 12, 150000, 1.5, 1.3, 1.1, 12, 8, 1, '三眼金猊，十万年以上魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2021, '冰天雪女·异种', 'boss', 12, 300000, 1.4, 1.2, 1.3, 12, 8, 1, '冰天雪女，十万年以上魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2022, '九幽雀', 'boss', 12, 600000, 1.5, 1.2, 1.4, 12, 8, 1, '九幽雀，十万年以上魂兽');
INSERT OR IGNORE INTO monster (id, name, tier, target_rounds, age, atk_bias, def_bias, spd_bias, exp_rate, gold_rate, drop_ring, desc) VALUES (2023, '深海魔鲸王·异种', 'boss', 12, 1000000, 1.6, 1.4, 1, 12, 8, 1, '深海魔鲸王，十万年以上魂兽');

-- ---------- NPC（新增 12 个） ----------
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2000, '铁匠老周', id, '打铁三十年，什么兵器都修得。' FROM map WHERE name = '诺丁城';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2001, '药铺掌柜', id, '药材我这儿最全。' FROM map WHERE name = '诺丁城';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2002, '猎户阿力', id, '森林里那些东西，我熟。' FROM map WHERE name = '落日森林';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2003, '守林人', id, '别往深处走，会死人的。' FROM map WHERE name = '星斗外围';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2004, '船夫老张', id, '过河？给钱就行。' FROM map WHERE name = '迷罗河';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2005, '流浪剑客', id, '剑法？我教你两招。' FROM map WHERE name = '璃月港';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2006, '学院教习', id, '屠龙不是靠勇气的。' FROM map WHERE name = '卡塞尔学院';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2007, '青铜城守卫', id, '这里睡着不该醒的东西。' FROM map WHERE name = '青铜城';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2008, '白帝城祭司', id, '王座之上，无人永生。' FROM map WHERE name = '白帝城';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2009, '丹药商人', id, '丹药要买好的。' FROM map WHERE name = '史莱克学院';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2010, '斗魂场老板', id, '来一场？押注随意。' FROM map WHERE name = '武魂殿主城';
INSERT OR IGNORE INTO npc (id, name, map_id, dialog) SELECT 2011, '星斗向导', id, '再往里，就是十万年的地盘了。' FROM map WHERE name = '星斗大森林·深处';

-- ---------- 任务（新增 15 个） ----------
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (200, '初入诺丁', 'main', '去诺丁城看看', '{"level":5}', '{"gold":300,"exp":200}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (201, '猎户的委托', 'main', '击杀 3 只赤练蛇', '{"kill":{"monster_id":2000,"count":3}}', '{"gold":400,"exp":300}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (202, '清理狼群', 'main', '击杀 5 只青风狼', '{"kill":{"monster_id":2001,"count":5}}', '{"gold":600,"exp":450}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (203, '毒尾之患', 'main', '击杀 4 只毒尾蝎', '{"kill":{"monster_id":2003,"count":4}}', '{"gold":800,"exp":600}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (204, '寒潭异动', 'main', '击杀 3 只寒冰蟾', '{"kill":{"monster_id":2005,"count":3}}', '{"gold":1000,"exp":800}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (205, '风雷之约', 'main', '击杀 2 只风雷鹰', '{"kill":{"monster_id":2008,"count":2}}', '{"gold":2000,"exp":1500}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (206, '玄蛇之影', 'main', '击杀 2 只黑水玄蛇', '{"kill":{"monster_id":2010,"count":2}}', '{"gold":3000,"exp":2200}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (207, '雷霆试炼', 'main', '击杀 1 只雷霆鹏', '{"kill":{"monster_id":2013,"count":1}}', '{"gold":6000,"exp":4000}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (208, '狮王之怒', 'main', '击杀 1 只赤炎狮王', '{"kill":{"monster_id":2015,"count":1}}', '{"gold":9000,"exp":6000}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (209, '冰晶之羽', 'main', '击杀 1 只冰晶凤凰', '{"kill":{"monster_id":2016,"count":1}}', '{"gold":12000,"exp":8000}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (210, '深渊之邀', 'main', '等级达到 20', '{"level":20}', '{"gold":1500,"exp":1200}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (211, '魂尊之路', 'main', '等级达到 30', '{"level":30}', '{"gold":4000,"exp":3000}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (212, '三环之证', 'main', '拥有 3 个魂环', '{"ring":3}', '{"gold":5000,"exp":4000}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (213, '五环之证', 'main', '拥有 5 个魂环', '{"ring":5}', '{"gold":12000,"exp":10000}');
INSERT OR IGNORE INTO quest (id, name, kind, desc, cond, reward) VALUES (214, '七环之证', 'main', '拥有 7 个魂环', '{"ring":7}', '{"gold":30000,"exp":25000}');

-- ---------- 新魂兽出没 ----------
INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '风起地' AND m.id BETWEEN 2000 AND 2023 AND m.age < 100;
INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '无妄坡' AND m.id BETWEEN 2000 AND 2023 AND m.age BETWEEN 100 AND 1000;
INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '绝云间' AND m.id BETWEEN 2000 AND 2023 AND m.age BETWEEN 1000 AND 10000;
INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '稻妻城' AND m.id BETWEEN 2000 AND 2023 AND m.age BETWEEN 10000 AND 100000;
INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '须弥城' AND m.id BETWEEN 2000 AND 2023 AND m.age >= 100000;
INSERT OR IGNORE INTO monster_map (monster_id, map_id) SELECT m.id, mp.id FROM monster m, map mp WHERE mp.name = '白帝城' AND m.id BETWEEN 2000 AND 2023 AND m.age >= 100000;

-- 魂技升级
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('skill_max_level',    '10',  'number', '魂技等级上限'),
  ('skill_level_power',  '8',   'number', '每级魂技威力加成百分比'),
  ('skill_upgrade_base', '500', 'number', '魂技升级基础消耗（按等级^1.6 递增）');

-- 怪物技能释放概率
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('monster_skill_rate', '45', 'number', '怪物每回合尝试释放技能的概率 %');

-- 武魂觉醒
INSERT OR IGNORE INTO cfg (key, value, type, desc) VALUES
  ('awaken_cost_base', '1000', 'number', '武魂觉醒基础费用（首次免费，之后递增）');
