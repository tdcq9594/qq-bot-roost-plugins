/**
 * 14 张默认表情的初始标注。
 *
 * 这些是**逐张看过图**之后写的，不是按文件名猜的。图上有明确文字的，
 * 「含义」里照抄那几个字；没有文字的只描述表情、动作和氛围，不编台词。
 *
 * 键是默认目录里的文件名；图片身份用内容 SHA-256，改名不影响关联。
 * 用户修改后以用户版本为准，这一份只在「用户没编辑过该字段」时补位。
 */

export const DEFAULT_ANNOTATIONS = {
  'call_1nEYLgSrOPyPwbBfIJUInCIx.jpg': {
    name: '眨眼叼玫瑰',
    meaning: '眨眼、叼着玫瑰、伸手指向对方，调情式的得意',
    tags: ['眨眼', '玫瑰', '调皮', '撩', '得意'],
    scenes: '打趣、接一句玩笑、想显得从容又带点撩的时候',
    avoid: '正式道歉、严肃问题、对方正在难受的时候',
  },
  'call_3SB8oPkVzfKLtE3C1PVQNkiK.jpg': {
    name: '嘟嘴不悦',
    meaning: '鼓脸嘟嘴、眉毛微皱，有点不高兴但没真的生气',
    tags: ['嘟嘴', '不悦', '傲娇', '无语'],
    scenes: '被调侃、被无视、想撒娇式抗议的时候',
    avoid: '对方认真求助、需要明确答复的时候',
  },
  'call_aQ2MgxKEPuGsCUkS4mf0dY6X.jpg': {
    name: '叠加态',
    meaning: '配文「处于有意见和没意见的叠加态中」，表示懒得表态、有点无语',
    tags: ['无语', '不想说话', '敷衍', '梗图'],
    scenes: '被问意见但不想接、话题太离谱只想表达"就这样吧"',
    avoid: '需要给出真实判断或建议的时候',
  },
  'call_aSxqzpQPAxFbEqPyrqZ2PMAM.jpg': {
    name: '杂鱼哦',
    meaning: '配文「你是杂鱼哦~♡」与「哼~♡」，得意地调侃对方',
    tags: ['调侃', '得意', '杂鱼', '挑衅', '撒娇'],
    scenes: '熟络的人之间互相打趣、对方逞强失败的时候',
    avoid: '陌生人、正式场合、对方可能被冒犯的时候',
  },
  'call_biyyYRtADMeMqHLntTk1M22V.jpg': {
    name: '擦皮鞋都不配',
    meaning: '配文「你连给本喵擦皮鞋都不配」，居高临下地嘴臭',
    tags: ['嘴臭', '傲娇', '嘲讽', '居高临下'],
    scenes: '非常熟的玩伴之间互相损、已经建立玩笑默契的场合',
    avoid: '任何不熟的人、任何可能被当真的时候（攻击性很强）',
  },
  'call_cBRBbjzs31BaDm4PRutFrFPY.jpg': {
    name: '半垂眼嫌弃',
    meaning: '半垂着眼睛、嘴角向下，嫌弃又懒得说的表情',
    tags: ['嫌弃', '无语', '冷漠', '看戏'],
    scenes: '看到离谱发言、不想接话、表达"你自己听听像话吗"',
    avoid: '对方在认真倾诉的时候',
  },
  'call_CvjASHqiwTcsvDLtwpH6XUW0.jpg': {
    name: '写检讨',
    meaning: '被指着、边哭边写满纸「对不起」，配文「还敢不敢发情了？」',
    tags: ['认错', '道歉', '求饶', '被训'],
    scenes: '玩笑式的认错、被抓住把柄时夸张服软',
    avoid: '真正的冲突、正式道歉场合（画面有枪和粗俗台词，容易冒犯）',
  },
  'call_H7N97rf5isb1vi6Leu40mM6K.jpg': {
    name: '就你？',
    meaning: '配文「就你？」，半垂眼摆手，轻蔑地质疑',
    tags: ['质疑', '轻蔑', '不屑', '调侃'],
    scenes: '熟人间互相挤兑、对方放话时捧场式拆台',
    avoid: '陌生群友、对方在展示成果的时候',
  },
  'call_N9jDURSj0xHVF1yiAZ1jUI2i.jpg': {
    name: '眼泪汪汪',
    meaning: '眼含泪水、双手握拳在胸前，委屈又可怜地求助',
    tags: ['委屈', '求求你', '可怜', '撒娇', '被欺负'],
    scenes: '想讨个方便、被拒绝后撒娇、表达"不要嘛"',
    avoid: '对方真的在生气、需要正经沟通的时候',
  },
  'call_or2BVSFhZuVdIdY00tecd8mM.jpg': {
    name: '约定与星星',
    meaning: '张开双手要抱，配文长句：约定还在，就把一起看过的星星和对话认真打包收好',
    tags: ['拥抱', '安慰', '承诺', '温柔', '长句'],
    scenes: '对方情绪低落需要安抚、深夜谈心、想郑重回应的时候',
    avoid: '刚认识、只想要一句简短回应的场合（图内文字很长）',
  },
  'call_PfMzci9JkD6KSCJisPdtTCq8.jpg': {
    name: '被孤立',
    meaning: '抱膝坐在墙角，配文「小团体又孤立我」，委屈地被冷落',
    tags: ['委屈', '冷落', '求关注', '撒娇'],
    scenes: '被无视了一阵想讨关注、玩笑式控诉没理我',
    avoid: '群里有真实矛盾、有人正在认真讨论的时候',
  },
  'call_XUYhraaC0RtZJ8wx2uGDh2mn.jpg': {
    name: '刷手机',
    meaning: '拿着手机半垂眼、嘴微瘪，边刷边无语的样子',
    tags: ['无语', '敷衍', '等着', '看手机'],
    scenes: '等对方回话、表示"我在听但没什么想说"',
    avoid: '需要积极回应的提问',
  },
  'call_XvZ0MlaVxE5n5txpJBqh7Nfx.jpg': {
    name: '比耶开心',
    meaning: '笑着抬手比出手势、周围飘爱心，轻快又开心',
    tags: ['开心', '比耶', '打招呼', '元气'],
    scenes: '被夸、被答应、心情好的时候',
    avoid: '对方在抱怨或求助的时候',
  },
  'call_YpbgevPiMTjVK05M6HvCWvpF.jpg': {
    name: '双手比心',
    meaning: '双手比心、眨眼笑，飘着爱心，直白的喜欢',
    tags: ['比心', '喜欢', '谢谢', '开心', '撒娇'],
    scenes: '想表达喜欢、道谢、被暖到的时候',
    avoid: '需要保持距离的正式场合',
  },
};

/** 首次运行时的默认设置 */
export const DEFAULT_SETTINGS = {
  /** 额外图片目录（空 = 只用内置） */
  extraDir: '',
  /** 参与判断的最低置信度 */
  threshold: 0.8,
  /** 单次判断最多几个候选 */
  maxCandidates: 24,
  /** 判断总超时（毫秒） */
  timeoutMs: 10_000,
  /**
   * 图库导出目录。空串 = `<DSH数据目录>/extension-data/sticker-reply/library`。
   *
   * 允许用户改：有人想把图库直接放进已有的表情包文件夹，或挪到别的盘。
   * 必须是绝对路径，且不能指到扩展自己的代码目录里。
   */
  libraryDir: '',
  /** 自动扫描间隔（毫秒） */
  scanIntervalMs: 15_000,
  /** 同一会话最近几次选择避免重复 */
  repeatWindow: 3,
  /** 总开关 */
  enabled: true,
};
