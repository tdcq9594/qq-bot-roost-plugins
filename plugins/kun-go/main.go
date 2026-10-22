// 养鲲（Go 版）
//
// 演示用 Go 写外部插件。协议和 Python 版完全一样：
//   stdin 读一行 JSON，stdout 写一行 JSON。
//
// 关键点：
//   - 只能用 stdout 输出协议 JSON，调试信息写 stderr
//   - init 里会下发 dataDir，存档就写在那个目录
//   - 每条消息处理完必须回 {"t":"handled","seq":N}，否则核心会等到超时
//
// 跑起来：核心执行 `go run main.go`，需要机器上装了 Go（或用 plugins.goBin 指定路径）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// ---------- 协议结构 ----------

type Msg struct {
	User    string   `json:"user"`
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Content string   `json:"content"`
	Level   int      `json:"level"`
}

type Payload struct {
	T       string         `json:"t"`
	Seq     int            `json:"seq"`
	Config  map[string]any `json:"config"`
	Levels  map[string]any `json:"levels"`
	DataDir string         `json:"dataDir"`
	Msg     *Msg           `json:"msg"`
}

// ---------- 存档 ----------

type Player struct {
	Name     string  `json:"name"`
	Species  string  `json:"species"`
	Rarity   string  `json:"rarity"`
	Rolls    int     `json:"rolls"`
	Best     int     `json:"best"`
	Luck     string  `json:"luck"`
	BornAt   int64   `json:"bornAt"`
	TotalKg  float64 `json:"totalKg"`
}

var (
	dataDir string
	players = map[string]*Player{}
	rareAdd = 3
)

func storePath() string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, "players.json")
}

func loadAll() {
	p := storePath()
	if p == "" {
		return
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	_ = json.Unmarshal(b, &players)
}

func saveAll() {
	p := storePath()
	if p == "" {
		return
	}
	b, err := json.MarshalIndent(players, "", "  ")
	if err != nil {
		return
	}
	// 先写临时文件再改名，避免写一半崩了留下坏档
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		_ = os.Rename(tmp, p)
	}
}

// ---------- 鲲 ----------

type Species struct {
	Name   string
	Rarity string
}

var pool = []Species{
	{"尘鲲", "普通"}, {"土鲲", "普通"}, {"沙鲲", "普通"}, {"石鲲", "普通"},
	{"菜虚鲲", "普通"}, {"胖头鲲", "普通"},
	{"碧鲲", "稀有"}, {"蓝鲲", "稀有"}, {"雪鲲", "稀有"}, {"虹鲲", "稀有"},
	{"炎鲲", "史诗"}, {"冰鲲", "史诗"}, {"雷鲲", "史诗"}, {"铁头鲲", "史诗"},
	{"帝鲲", "传说"}, {"圣鲲", "传说"}, {"冥鲲", "传说"}, {"尸鲲", "传说"},
}

func draw() Species {
	// 稀有度越低越难抽：普通权重高，传说靠 rareAdd 控制
	weighted := make([]Species, 0, len(pool))
	for _, s := range pool {
		w := 1
		switch s.Rarity {
		case "普通":
			w = 60
		case "稀有":
			w = 25
		case "史诗":
			w = 10
		default:
			w = rareAdd
		}
		for i := 0; i < w; i++ {
			weighted = append(weighted, s)
		}
	}
	return weighted[rand.Intn(len(weighted))]
}

func luckOf(uid string) (string, string) {
	day := time.Now().Format("2006-01-02")
	h := 0
	for _, c := range uid + day {
		h = (h*31 + int(c)) & 0x7fffffff
	}
	names := []string{"大凶", "小凶", "平", "小吉", "大吉"}
	tips := []string{"今天别赌运气", "适合窝着", "平常心", "可以试试手气", "冲！今天怎么抽都不亏"}
	i := h % 5
	return names[i], tips[i]
}

// ---------- 输出 ----------

func send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	os.Stdout.Write(b)
	os.Stdout.Write([]byte("\n"))
}

func logf(level, msg string) {
	send(map[string]any{"t": "log", "level": level, "msg": msg})
}

// ---------- 命令 ----------

func cmdKun(p *Msg, reply func(string)) {
	pl, ok := players[p.User]
	if !ok {
		pl = &Player{Name: nameOf(p), Species: "未抽", Rarity: "—", BornAt: time.Now().UnixMilli()}
		players[p.User] = pl
		saveAll()
	}
	luck, tip := luckOf(p.User)
	if pl.Species == "未抽" {
		reply(fmt.Sprintf("%s 还没有鲲。发 /gokun 抽一只。\n今日运势：%s（%s）", pl.Name, luck, tip))
		return
	}
	reply(fmt.Sprintf("%s 的鲲\n【%s】%s · 累计 %.1f 千克\n掷骰 %d 次，最高 %d\n今日运势：%s（%s）",
		pl.Name, pl.Species, pl.Rarity, pl.TotalKg, pl.Rolls, pl.Best, luck, tip))
}

func cmdDraw(p *Msg, reply func(string)) {
	pl, ok := players[p.User]
	if !ok {
		pl = &Player{Name: nameOf(p), BornAt: time.Now().UnixMilli()}
		players[p.User] = pl
	}
	old := pl.Species
	s := draw()
	pl.Species = s.Name
	pl.Rarity = s.Rarity
	luck, _ := luckOf(p.User)
	pl.Luck = luck
	saveAll()

	if old == "" || old == "未抽" {
		reply(fmt.Sprintf("开局一条鲲——【%s】！稀有度：%s", s.Name, s.Rarity))
		return
	}
	reply(fmt.Sprintf("抽到了【%s】（%s）\n原来的 %s 已放生。", s.Name, s.Rarity, old))
}

func cmdRoll(p *Msg, reply func(string)) {
	faces := 100
	if len(p.Args) > 0 {
		if n, err := parseInt(p.Args[0]); err == nil && n >= 2 && n <= 100000 {
			faces = n
		}
	}
	v := rand.Intn(faces) + 1

	pl, ok := players[p.User]
	if !ok {
		pl = &Player{Name: nameOf(p), BornAt: time.Now().UnixMilli()}
		players[p.User] = pl
	}
	pl.Rolls++
	if v > pl.Best {
		pl.Best = v
	}
	saveAll()
	reply(fmt.Sprintf("🎲 %d / %d\n你已掷 %d 次，最高 %d", v, faces, pl.Rolls, pl.Best))
}

func cmdRank(_ *Msg, reply func(string)) {
	type row struct {
		Name string
		Best int
	}
	rows := make([]row, 0, len(players))
	for _, pl := range players {
		if pl.Rolls > 0 {
			rows = append(rows, row{pl.Name, pl.Best})
		}
	}
	if len(rows) == 0 {
		reply("还没有人掷过。发 /goroll 试试。")
		return
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Best > rows[j].Best })
	out := "Go 版排行\n"
	for i, r := range rows {
		if i >= 5 {
			break
		}
		out += fmt.Sprintf("%d. %s · 最高 %d\n", i+1, r.Name, r.Best)
	}
	reply(out)
}

func nameOf(p *Msg) string {
	if p.Name != "" {
		return p.Name
	}
	if len(p.User) >= 8 {
		return p.User[:8]
	}
	return p.User
}

func parseInt(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("not a number")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

// ---------- 主循环 ----------

func onInit(p *Payload) {
	dataDir = p.DataDir
	if v, ok := p.Config["稀有加成"].(float64); ok && v > 0 {
		rareAdd = int(v)
	}
	loadAll()

	send(map[string]any{
		"t":       "ready",
		"listen":  []string{},
		"commands": []any{
			map[string]any{"name": "gokun", "desc": "看看我的鲲（Go 版）"},
			map[string]any{"name": "godraw", "desc": "抽一只鲲"},
			map[string]any{"name": "goroll", "pattern": "goroll [面数]", "desc": "掷骰子"},
			map[string]any{"name": "gorank", "desc": "掷骰排行前 5"},
		},
		"menus": []any{
			map[string]any{
				"title": "Go 版",
				"items": []any{
					map[string]any{"text": "godraw", "desc": "抽一只鲲，看看手气"},
					map[string]any{"text": "goroll", "desc": "掷骰子"},
				},
			},
		},
	})
}

func onMsg(p *Payload) {
	m := p.Msg
	if m == nil {
		return
	}
	reply := func(text string) {
		send(map[string]any{"t": "reply", "seq": p.Seq, "text": text})
	}

	switch m.Command {
	case "gokun":
		cmdKun(m, reply)
	case "godraw":
		cmdDraw(m, reply)
	case "goroll":
		cmdRoll(m, reply)
	case "gorank":
		cmdRank(m, reply)
	}

	// 无论处理与否都要回 handled
	send(map[string]any{"t": "handled", "seq": p.Seq})
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // 大消息也能收

	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var p Payload
		if err := json.Unmarshal(line, &p); err != nil {
			logf("warn", "收到无法解析的输入")
			continue
		}
		switch p.T {
		case "init":
			onInit(&p)
		case "msg":
			onMsg(&p)
		case "shutdown":
			return
		}
	}
}
