# radio_streams

本地 MP3 点唱机的 Node.js / Express 服务，部署在 `192.168.8.105:3000`
（用 `~/radio_streams/restart.sh` 管理进程）。

把 `~/RadioStations/` 下的每个子目录当成一个电台，每个目录里的所有
`.mp3` 文件构成该电台的曲库。ESP32 走 `/api/esp` 拿一首随机单曲 URL，
播完后再请求下一首。

## 运行 / 部署

```bash
# 本地
cd ~/dev/radio_streams
npm install
node server.js          # 默认 :3000
PORT=3100 node server.js

# 105（改完 server.js 后）
rsync -avz server.js 192.168.8.105:~/radio_streams/server.js
ssh 192.168.8.105 "cd ~/radio_streams && bash restart.sh"
```

## 接口列表

| 路径                       | 方法 | 说明                                              |
|----------------------------|------|---------------------------------------------------|
| `/`                        | GET  | Web UI（EJS）                                     |
| `/api/local`               | GET  | 列出所有本地 MP3 电台                            |
| `/api/select-station`      | POST | 切换当前本地 MP3 电台                            |
| `/api/esp`                 | GET  | **ESP32 契约 — 返回一首随机单曲**                |
| `/api/time`                | GET  | 服务器时间（ISO + Asia/Shanghai）                |
| `/api/volume`              | POST | 设置全局音量 1–100                               |
| `/api/fonts`               | GET  | 所有本地 MP3 文本并集，用于烧录嵌入式字模        |
| `/audio/local/playlist`    | GET  | 当前本地电台的连续 MP3 流                        |
| `/audio/local/track/:name` | GET  | **单首 MP3，支持 `Accept-Ranges: bytes`**        |

## `/api/esp` — 单曲契约（ESP32 轮询的接口）

每次调用返回当前本地电台里**一首随机单曲**。客户端（ESP32）应把这一首
从头播到尾，播完后再发起一次请求拿下一首。

```json
GET /api/esp
→ {
    "song":   "BV12b411A7ib",
    "url":    "http://192.168.8.105:3000/audio/local/track/BV12b411A7ib",
    "volume": 80
  }
```

如果没有选中的本地电台、或该电台没有 MP3 文件，返回 `404`。

### 选歌算法

实现见 `RadioStation.nextTrack()`（server.js 约 215 行）：

1. 每个 `RadioStation` 实例内部维护一个洗牌后的播放列表 `_playlist`
   和一个播放指针 `_playIdx`。
2. 首次调用（或 `_playIdx` 走到末尾）时，对整个 `files` 数组做一遍
   **Fisher–Yates 洗牌**，然后 `_playIdx` 归零。
3. 取 `_playlist[_playIdx]` 那一首返回，`_playIdx` 自增，并刷新本电台
   的 `currentSong` / `currentPos` / `currentTotal`。

带来的语义：

- **一轮内不会重复**：同一首在该电台这次洗牌周期里只出现一次。
- **重启会变**：`_playlist` 只在内存里，服务重启后会重新洗牌。
- **每个电台独立洗牌**：切换电台不会重置新电台的指针。
- **音量是全局的**：存在进程级变量 `currentVolume` 里（持久化到
  `.radio_state.json`），按曲不区分。改音量用 `POST /api/volume`。

### 播放 URL — `/audio/local/track/:name`

`/api/esp` 给出的 URL 是一个真正的 HTTP/1.1 端点，行为：

- **原样返回 MP3 文件字节**（不剥 ID3、不转码、不加 ICY 元数据）
- 响应头带 `Accept-Ranges: bytes`，客户端可以发 `Range:` 请求做 seek
- 带 `Content-Length: <文件大小>`
- 走 keep-alive（HTTP/1.1），同一连接可复用

## `/api/fonts` — 给嵌入式字模用的字符集

```json
GET /api/fonts
→ { "count": 57, "text": "测试电台BV12T9AXEvb47i3LDHa..." }
```

返回所有本地电台（`~/RadioStations/<name>/`）的目录名、文件名、ID3
标题里出现过的、不重复的、可打印 BMP 字符。已过滤掉控制字符、
UTF-16 代理对半区（emoji 国家旗等）、非 BMP 字符。

**结果是稳定的** — 只读 STATIC 数据（磁盘上的文件名 + ID3 标题），
不读运行时状态。可以一次性抓下来直接喂 `lv_font_conv` 烧字模。

## 架构

```
ESP32 (~/Dev/ssd1322clock)
├── 唤醒
├── WiFi STA + SNTP 同步
├── 音频: GET /api/esp → track URL → HTTP 流 → I2S → NS4168
└── 主循环（10 分钟）→ deep sleep，GPIO3 唤醒

server.js (192.168.8.105:3000)
├── RadioStation 类 — 管一个 ~/RadioStations/<name>/ 文件夹
│   ├── nextTrack()     — Fisher–Yates 洗牌，给 /api/esp 用
│   └── serve(socket)   — 长连接连续流，给 /audio/local/playlist 用
├── /api/local          — 列出所有电台
├── /api/select-station — 切换当前电台
├── /api/esp            — 随机单曲 URL
├── /api/volume         — 全局音量（持久化到 .radio_state.json）
├── /api/fonts          — 本地字模字符集
├── /audio/local/playlist  — 当前电台连续流
└── /audio/local/track/:n  — 单首 MP3（带 Range 支持）
```

## 本地电台目录

`STATIONS_DIR = ~/RadioStations/`。每个子目录算一个电台，目录名去掉
`[【】·│]` 后是显示名。如果磁盘上没有持久化状态，启动时按字典序选
第一个目录作为当前电台。

```
~/RadioStations/
├── 宫崎骏电台/      69 首
├── 樊登电台/        75 首
├── 爵士电台/        84 首
└── 睡眠电台/        38 首
```

切换当前电台：`POST /api/select-station { "id": "爵士电台" }`。
