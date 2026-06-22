# 192fm · radio_streams

床头广播盒子的 Node.js / Express 服务，部署在 `192.168.8.192:3000`。

单电台模式（`~/Music/网易云收藏/` 32 首 mp3），由 92DJ 后台自动抓网易云收藏
→ LLM 写引言 → TTS → lame 拼接 → ESP32 端通过 `/api/esp` 抽歌播放。
admin UI 编排场景、定时、音量；`/temps` 收设备温湿度画图；`/log` 看所有
API 请求。

## 部署拓扑

```
┌─────────────────────────────────────────────────────────────┐
│ 192 (192.168.8.192) — 本仓库 source of truth                │
│                                                              │
│  server.js (Express :3000) ──────── 提供 UI + API + 音频     │
│      ▲                                                       │
│      │ signals via state file                                │
│  dj_worker.js (daemon) ──── 监听 trigger → 跑 scene-fetch    │
│      │                                                       │
│      ├── scene_fetch.js ── 搜网易云 + 下载 + LLM 引言        │
│      │                       (exit 0 = success)              │
│      │                                                       │
│      └── generate_playlist.js (fallback)                     │
│                                                              │
│  三个 watchdog (crontab @reboot):                            │
│      radio-watchdog.sh        — 保活 server                  │
│      dj-worker-watchdog.sh    — 保活 dj_worker               │
│      ~/ncm-api/ncm-watchdog.sh — 保活 :3001 网易云 sidecar  │
└─────────────────────────────────────────────────────────────┘
        ▲                                       ▲
        │ /api/esp (JSON)                       │ /api/dj/trigger (POST)
        │                                       │  + crontab 每天 07/21
        │                                       │
┌───────────────┐                       ┌───────────────┐
│  ESP32 (IoT)  │                       │  Browser      │
│  客户端       │                       │  admin /      │
└───────────────┘                       │  library /    │
                                        │  temps / log  │
                                        └───────────────┘
```

## 运行 / 重启

```bash
# 服务器 (zulin@192.168.8.192)
ssh zulin@192.168.8.192
cd ~/radio_streams

# 手动启动 server (生产由 radio-watchdog.sh 守护)
node server.js                        # 默认 :3000
bash scripts/restart_server.sh        # 杀旧 PID 后台起新

# 手动启动 dj_worker (生产由 dj-worker-watchdog.sh 守护)
node scripts/dj_worker.js
# 或 npm run dj:start

# 健康检查
crontab -l                            # 看 @reboot 行 + 自动定时
ls .radio_playlist/                   # 看 playlist timestamp
tail -f .radio_playlist/worker.log    # 看 dj_worker 输出
tail -f server.log                    # 看 server 输出
```

## 三个进程

| 进程 | 入口 | 职责 | 守护 |
|------|------|------|------|
| **server** | `node server.js` | Web UI + API + 音频 | `radio-watchdog.sh` (`@reboot`) |
| **dj_worker** | `node scripts/dj_worker.js` | 监听 trigger 跑场景任务 | `dj-worker-watchdog.sh` (`@reboot`) |
| **ncm** | `~/ncm-api/app.js` (PORT=3001) | 网易云 sidecar (登录/搜索/下载 URL) | `~/ncm-api/ncm-watchdog.sh` (`@reboot`) |

## 文件布局

```
radio_streams/
├── server.js              # Express 主服务（2582 行，约 50 个 endpoints）
├── package.json           # 依赖：express, ejs, lowdb, sql.js
├── scripts/
│   ├── dj_worker.js       # daemon — 触发任务 → spawn scene_fetch
│   ├── dj_queue.js        # trigger file + state.json 管理
│   ├── scene_fetch.js     # NCM 搜歌 + LLM 引言 + 下载
│   ├── scene_playlist_search.js   # 搜网易云歌单候选
│   ├── scene_playlist_adopt.js    # 采纳候选
│   ├── build_playlist_from_result.js  # TTS + lame 拼接 intro+mp3
│   ├── generate_playlist.js       # 本地曲库 fallback（无 NCM 时）
│   ├── scheduled_runner.js        # 旧版 crontab 写表
│   ├── mono2stereo.js             # MP3 mono → stereo 升混
│   ├── radio-watchdog.sh          # 保活 server (crontab @reboot)
│   ├── dj-worker-watchdog.sh      # 保活 dj_worker (crontab @reboot)
│   ├── worker_healthcheck.sh      # 每 5min worker 健康检查
│   ├── restart_server.sh          # 杀旧 PID 后台起新
│   ├── lib/
│   │   ├── netease_dl.js          # 网易云下载包装
│   │   ├── scenes_index.js        # 场景 index 维护
│   │   └── scene_audit.js         # 场景命中统计
│   ├── intros/                     # 旧版 song→intro 文本 (static)
│   └── __pycache__/                # Python helper 缓存 (gitignored)
├── views/
│   ├── index.ejs                  # 首页 + 顶栏导航
│   ├── admin_dj.ejs               # 92DJ 控制台 (intro prompts + 场景管理 + 搜歌)
│   ├── library.ejs                # 曲目库 (网易云收藏单站)
│   ├── history_playlists.ejs      # 历史歌单库 (legacy)
│   ├── temps.ejs                  # 温湿度图表 (Chart.js + 每设备一色)
│   └── log.ejs                    # API 请求日志 (IP/URL/method/status 筛选)
├── config/
│   ├── schedule.json              # 定时任务 (id, hour, minute, batch, scene, volume, enabled)
│   ├── intro_prompts.json         # LLM system+user 模板 + scene_hints (label/keywords/volume)
│   ├── dj_vibes.json              # persona / vibe 配置
│   ├── scenes/{morning,night,sport,play}.json
│   └── device_readings.json       # 设备温湿度历史 (lowdb)
├── .radio_playlist/                # 运行时数据 (gitignored)
│   ├── worker.log                 # dj_worker 输出
│   ├── cron.log                   # 定时触发日志
│   ├── 2026062113121/             # 一次任务产物
│   │   ├── playlist.json
│   │   ├── intros/                # intro.mp3 (TTS 输出)
│   │   ├── stitched/              # stitched.mp3 (intro+song 拼接)
│   │   ├── progress.json
│   │   └── llm_response.txt
│   └── worker_state.json          # dj_worker 当前任务状态
├── data/                          # 历史 playlist / audit (gitignored)
├── intros/                        # 静态 song→intro (gitignored? tracked)
└── .gitignore
```

## Web UI 页面

| 路径 | 标题 | 用途 |
|------|------|------|
| `/` | 🎧 192电台 | 首页 + 当前歌 |
| `/admin/dj` | 🎧 92DJ | 控制台：intro prompts + 场景任务管理 + 网易云搜歌 |
| `/library` | 📀 网易云收藏 | 曲目库（按歌单分组） |
| `/temps` | 🌡️ 温湿度图表 | 设备上传的温湿度 + QWeather 基线 |
| `/log` | 📋 API 日志 | 所有 API 请求响应录制（自动刷新） |
| `/history` | (重定向) | → `/library` |

## API Endpoints

### 播放器 / ESP32

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/esp` | ESP32 拿一首歌：`{song, name, url, volume, weather}` |
| GET | `/api/esp/:deviceId` | 按设备持久化偏好（最近一首、跳过的歌） |
| GET | `/api/time` | 服务器时间 |
| GET | `/api/weather` | QWeather 余杭 24h + 实时 |
| GET | `/api/volume` | 当前音量 (1-100) |
| POST | `/api/volume` `{volume}` | 设置全局音量 |
| GET | `/api/devices` | 所有已知 ESP 设备 |
| POST | `/api/devices/:id/seek` | 设备 seek 到下一首 |
| GET | `/api/next` | 手动下一首 |
| POST | `/api/select-next` `{playlist, index}` | 跳到指定 index |
| POST | `/api/reshuffle` | 重洗当前歌单 |
| GET | `/api/source` | 当前歌单源（NCM / 本地） |
| GET | `/api/playlist` | 当前歌单 |
| GET | `/api/tts-intro` | 当前 TTS 介绍 |
| POST | `/api/tts-intro` `{text}` | 触发自定义 TTS |
| GET | `/api/fonts` | 字模字符集（嵌字体用） |

### 92DJ 控制台

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dj/status` | 当前 dj_worker 任务状态 |
| POST | `/api/dj/trigger` `{batch, scene?, persona?, volume?}` | 触发场景任务（同时应用 volume） |
| POST | `/api/dj/cancel` | 取消运行中任务 |
| GET | `/api/dj/llm-history` | LLM 调用历史 |
| GET | `/api/dj/intro-prompts` | 当前 prompts + scene_hints |
| POST | `/api/dj/intro-prompts` `{system_template, user_template, scene_hints}` | 保存 prompts |
| GET | `/api/dj/vibes` | persona 配置 |
| GET | `/api/dj/personas` | persona 列表 |
| POST | `/api/dj/vibes` `{...}` | 更新 persona |
| GET | `/api/schedule` | 当前定时列表 |
| POST | `/api/schedule` `{items}` | 保存定时（带 volume），自动写 crontab |
| POST | `/api/schedule/install` | 仅重写 crontab（不写 config） |

### 曲库 / 网易云

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/library` | 所有歌单概览（按 playlist 分组） |
| GET | `/api/library/:id` | 单歌单歌曲列表 |
| GET | `/api/netease/search?q=` | 搜网易云 |
| GET | `/api/netease/song/:id` | 单曲详情 |
| GET | `/api/netease/play/:id` | 单曲 mp3 流 |
| GET | `/api/netease/playlist/:id` | 歌单详情 |
| GET | `/api/netease/album/:id` | 专辑详情 |

### 温湿度 / 日志

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/temps` + `/api/devices/list` + `/api/readings` | 温湿度页 |
| POST | `/api/readings` `{device_id, temperature, humidity}` | 设备上传读数 |
| GET | `/log` + `/api/log` | API 日志页 |
| POST | `/api/log/clear` | 清空日志 |

### 音频流

| 路径 | 说明 |
|------|------|
| `/audio/local/track/<name>` | 本地 mp3（带 Range） |
| `/audio/playlist-stitched/<stamp>/<n>.mp3` | TTS intro + 歌 拼接好的 mp3 |
| `/audio/playlist-intro/<stamp>/<n>.mp3` | 单首 TTS intro |

## 场景任务管理

`/admin/dj` 上是统一的场景任务表，每个场景一行：

| 字段 | 含义 |
|------|------|
| icon | 场景 emoji |
| label | LLM 看到的场景提示（"夜深了"） |
| keywords | 网易云搜索词（多选 chip） |
| **time** | 定时时刻（HH:MM，北京时区） |
| **enabled** | ☑ 启用定时 / ☐ 仅手动 |
| **volume** | 1-100，默认 4 |
| 🏃 | 立即跑（手动触发，先应用 volume） |
| ✕ | 删除（带 confirm） |

保存后：
1. POST `/api/schedule` 写入 `config/schedule.json`（含 volume）
2. POST `/api/dj/intro-prompts` 写入 `config/intro_prompts.json`（含每场景 volume/label/keywords）
3. server 重写 crontab：`TZ=Asia/Shanghai` + `volume:N` 字段

```jsonc
// config/schedule.json
{
  "items": [
    {"id":"evening","label":"夜深了","hour":21,"minute":0,
     "batch":"evening","scene":"night","enabled":true,"volume":4},
    {"id":"morning","label":"早安","hour":7,"minute":0,
     "batch":"morning","scene":"morning","enabled":true,"volume":5}
  ]
}
```

**当只勾选 enabled 但 time 为空**：UI 自动按场景填默认时间
（morning→07:00, evening→21:00, night→22:00, sleep→23:30, sport→18:00,
game→20:00, focus→10:00, 其它→12:00）。

## 场景任务管线（DJ 自动流程）

```
crontab / 🏃
    │
    ▼
POST /api/dj/trigger {batch, scene, volume}
    │
    ├── currentVolume = volume; saveState()    // 立刻应用全局音量
    │
    ▼
DJ_QUEUE.trigger(batch, persona, scene)         // 写 state.json
    │
    ▼
dj_worker 看到 trigger → spawn scene_fetch.js   // 传 DJ_SCENE env
    │
    ▼
scene_fetch.js:
    1. 读 scenes/<scene>.json → 拿 label + keywords
    2. 调 NCM search → 拿候选 songs
    3. 选 20 首
    4. 调 LLM (MiniMax-M3) 写 20 个 intro:
       - system: "你是小盒子，2026 中国 90 后床头广播员..."
       - user: "场景：夜深了。今天 ${weatherToday}。明天 ${weatherTomorrow}。
              ${songList}"
       - 输出：每首歌一段 1-2 句的画面感引言
    5. 调 NCM download 落盘到 ~/Music/网易云收藏/
    6. 写 .radio_playlist/<stamp>/{playlist.json, llm_response.txt}
    │
    ▼ (exit 0)
spawn build_playlist_from_result.js:
    1. 为 20 首分别调 TTS (MiniMax speech) 生成 intro.mp3
    2. lame decode → mono2stereo → lame re-encode → 转成 44.1kHz 立体声
    3. ffmpeg concat intro.mp3 + song.mp3 → stitched.mp3
    4. 写 .radio_playlist/<stamp>/{intros,stitched}/*.mp3
    │
    ▼
state.json 标 done
```

### Intro 解析器（worker 兼容层）

LLM 输出格式不固定，worker 用三段策略自动解析：

1. **JSON array**: `[{"name":"...", "intro":"..."}, ...]`
2. **Strategy 2 (paragraph attribution)**: 按《歌名》归 paragraph 到对应 song
   - Pattern (a) `《name》`（优先）
   - Pattern (b) bare name 匹配（处理歌名含《》的情况）
3. **Strategy 3 (token fingerprint)**: 把歌名按 `_ - 空格 ( )` 拆，取最长 token 做 substring
4. **fallback**: `接下来请欣赏《${name}》` 兜底

参考 `references/intro-prompt-iteration.md`（迭代历史 + 调试工具 `scripts/intro-tester.py`）。

## 温湿度（`/temps`）

- 数据存储：`config/device_readings.json`（lowdb v1.0.0 格式 `{device_readings: [...]}`）
- 每条：`{device_id, ts (ISO), temperature, humidity, source: "device"|"qweather"}`
- 设备 POST `/api/readings` 上传，自动 trim 到 1440 条（≈ 1 分钟 × 24h）
- QWeather baseline：每小时 `device_id="qweather"` 一条
- Chart.js v4.5.1（CDN）多线图，每设备一色
- 设备下拉 + 时间窗（24h / 7d / 30d）+ 温度/湿度切换
- + 📊 模拟数据 按钮（注入测试数据）

## API 日志（`/log`）

- 中间件（`server.js`）记录所有 API 请求
- EXCLUDE_PATTERNS：`/api/source`, `/api/playlist`, `/api/status`, `/api/esp`, `/api/log`, `/favicon.ico`（避免 noisy）
- 内存数组，刷新页面前最多保留 ~500 条
- 字段：`ts, ip, method, url, status, ms, ua, body?`
- 顶部筛选：URL 子串 / 方法 / 状态码 / IP 下拉
- 自动刷新（populateIpDropdown 保留选中）

## 配置（gitignored 之外）

| 文件 | 用途 |
|------|------|
| `config/schedule.json` | 定时任务（hour, minute, batch, scene, volume, enabled） |
| `config/intro_prompts.json` | LLM prompt 模板 + scene_hints (label, keywords[], volume) |
| `config/dj_vibes.json` | persona 配置（描述、关键词权重） |
| `config/scenes/*.json` | 每个场景的元数据 |
| `config/device_readings.json` | 设备温湿度 lowdb |

## 依赖

```bash
# 系统
apt-get install -y lame   # MP3 解码/编码（TTS intro 拼接需要）

# Node
npm install
# express ^4.18.0, ejs ^3.1.0, lowdb ^1.0.0, sql.js ^1.14.1
```

> lowdb 替代了 better-sqlite3 — 因为 192 上无 build-essential / python3-dev，
> 原生模块编译失败，lowdb v1 纯 JS 够用（场景读数 < 1440 条）。

## 自动化

```bash
# crontab -l 实际内容
@reboot /home/zulin/ncm-api/ncm-watchdog.sh >/dev/null 2>&1
*/5 * * * * /home/zulin/radio_streams/scripts/worker_healthcheck.sh >> /home/zulin/radio_streams/.radio_playlist/worker_healthcheck.log 2>&1
@reboot /home/zulin/radio_streams/radio-watchdog.sh >/dev/null 2>&1
@reboot /home/zulin/radio_streams/dj-worker-watchdog.sh >/dev/null 2>&1
0 13 * * * TZ=Asia/Shanghai curl -X POST http://127.0.0.1:3000/api/dj/trigger -d '{"batch":"evening","scene":"night","volume":4}'  # evening (Beijing 21:00)
0 23 * * * TZ=Asia/Shanghai curl -X POST http://127.0.0.1:3000/api/dj/trigger -d '{"batch":"morning","scene":"morning","volume":5}'  # morning (Beijing 07:00)
```

`@reboot` 三件套：server + dj_worker + ncm sidecar
`*/5` worker_healthcheck：dj_worker 异常时重启
两个 scene cron：早上 7 点 + 晚上 9 点（北京时间，由 server 重写时插入 `TZ=Asia/Shanghai`）

## 常见操作

```bash
# 查任务状态
curl -s http://192.168.8.192:3000/api/dj/status | python3 -m json.tool

# 手动跑 morning 场景（音量 5）
curl -X POST -H "Content-Type: application/json" \
  -d '{"batch":"manual","scene":"morning","volume":5}' \
  http://192.168.8.192:3000/api/dj/trigger

# 取消任务
curl -X POST http://192.168.8.192:3000/api/dj/cancel

# 列出最近 5 次任务产物
ls -lt .radio_playlist/ | head -5

# 看最近一次任务的 intros 是不是 fallback
tail -5 .radio_playlist/worker.log

# 调试 intro（不重跑场景）
python3 scripts/intro-tester.py --playlist .radio_playlist/<stamp>/playlist.json \
  --system "..." --user "..." --out /tmp/test.json
```

## 已知坑

- **192 时区是 UTC** — 调试 cron 类问题第一件事 `date && timedatectl`
- **lame 必须装系统包** — `apt-get install -y lame`，否则 stitching 全部失败
- **9p 死锁** — 一次 stat 太多 mp3 会卡死（loadFilesAsync 注释警告），19k+ 歌曲会卡，单曲库没事
- **scene_fetch LLM 格式不固定** — 三段策略 parser 兜底
- **PTY time picker** — `<input type="time">` 包在 `<label>` 里会拦截 checkbox 点击，UI 已修正