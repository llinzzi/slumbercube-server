# 贡献指南

## 仓库结构

```
llinzzi/slumbercube-server     ← 服务端 (Node.js, 部署在 192.168.8.192)
```

## 三处代码副本

| 位置 | 角色 | 更新方式 |
|------|------|----------|
| `192` (`/home/zulin/slumbercube-server/`) | 生产（真的在跑） | 直接 ssh 上去改 |
| `Mac` (`~/Dev/slumbercube-server/`) | 编辑/审阅 | 编辑器 + git push |
| `Mac mirror` (`/tmp/192fm-mirror/`) | Hermes agent 的中转 | scp + git push（自动） |

> **绝对不要**让 192 自己 `git push` —— 它的网络到 github.com 443 不通。

## 日常改代码

### 走法 A：直接在 192 上改（推荐）

适合：快速 fix、配置调整、debug 中的小改动。

```bash
ssh zulin@192.168.8.192
cd /home/zulin/slumbercube-server

# 改文件
vim server.js
# 或: sed -i 's/old/new/g' server.js

# syntax check
node -c server.js

# 重启 server
bash scripts/restart_server.sh

# 测一下
curl -sm 5 http://127.0.0.1:3000/api/time

# commit
git add -A
git commit -m "Fix ..."

# Mac 中转 push
git format-patch origin/master..HEAD --stdout > /tmp/relay.patch
# 让 Hermes agent 把 /tmp/relay.patch 应用到 /tmp/192fm-mirror/ 然后 push
```

> Hermes agent 在每轮对话里都会**自动**做 push 中转这一步。

### 走法 B：在 Mac 上改（适合大改）

适合：多文件改动、本地跑测试、需要 IDE 提示。

```bash
# Mac
cd ~/Dev/slumbercube-server
# 编辑器改文件
git add -A
git commit -m "Add new endpoint"
git push origin master    # Mac 可直连 GitHub

# 192 拉新代码
ssh zulin@192.168.8.192
cd /home/zulin/slumbercube-server
git pull origin master
bash scripts/restart_server.sh
```

> **关键**：Mac 改完 push 后，192 需要**手动** `git pull` —— 192 没有 webhook / auto-deploy。

## push 通道（192 → GitHub）

192 直连 github.com:443 超时（实测 130s 后失败），所以所有 push 都经过 **Mac 中转**：

```
192 改完 → git commit → git format-patch → 把 .patch 文件给 Hermes
   ↓
Hermes 在 /tmp/192fm-mirror/ 上 git am + git push
   ↓
GitHub 收到新 commit
```

## 三种重启

| 想做的事 | 命令 |
|----------|------|
| 只重启 server | `cd /home/zulin/slumbercube-server && bash scripts/restart_server.sh` |
| 只重启 worker | `pkill -9 -f dj_worker` （watchdog 5-10s 内自动拉起） |
| 重启网易云 sidecar | `pkill -f NeteaseCloudMusicApi` （ncm-watchdog 拉起） |
| 全栈重启 | reboot 192 |

> **改完代码必须 restart server**（server.js 不热重载）。worker 改完 `pkill -9` 让 watchdog 重启它。

## 添加新依赖

```bash
cd /home/zulin/slumbercube-server
npm install <package> --save
git add package.json package-lock.json
git commit -m "Add <package>"
# Mac 中转 push
```

## 文件分类

| 类别 | 路径 | git 状态 |
|------|------|----------|
| 代码 | `server.js`, `scripts/`, `views/` | ✅ 跟踪 |
| 配置模板 | `config/intro_prompts.json`, `config/dj_vibes.json` | ✅ 跟踪 |
| 用户配置 | `config/settings.json`, `config/weather.json` | ❌ gitignored（用 `/settings` UI 改） |
| 运行时数据 | `.radio_playlist/`, `data/` | ❌ gitignored |
| 系统 crontab | crontab 本身 | (不在 git) |

## 调试常用命令

```bash
# server 实时日志
tail -f /tmp/radio_server.log

# worker 实时日志
tail -f /home/zulin/slumbercube-server/.radio_playlist/worker.log

# 进程状态
ssh zulin@192.168.8.192 'ps -ef | grep -E "node|watchdog" | grep -v grep'

# 看 LLM 调用历史
ssh zulin@192.168.8.192 'tail -1 /home/zulin/slumbercube-server/.radio_playlist/llm_history.jsonl | python3 -m json.tool'

# 手动触发场景任务
curl -X POST -H "Content-Type: application/json" \
  -d '{"batch":"manual","scene":"morning"}' \
  http://192.168.8.192:3000/api/dj/trigger

# 修 current.json symlink（rename 后用）
bash scripts/fix-symlinks.sh
```

## 出问题检查清单

1. **Server 死了？** `curl http://192.168.8.192:3000/api/time` → 不通 = 看 `/tmp/radio_watchdog.log`
2. **Worker 死了？** `tail .radio_playlist/worker.log` → 看 state 字段
3. **LLM 失败？** `grep "no API key" worker.log` → 多半是 key 没读到（重启 server 重新读）
4. **天气缺失？** `curl http://192.168.8.192:3000/api/weather` → 1 分钟缓存
5. **`/api/esp` 卡死？** `bash scripts/fix-symlinks.sh`
6. **192 → GitHub 卡 130 秒？** 别在 192 上 push，用 Mac 中转

## 提交规范

每个 commit 只做一件事，message 第一行用 `动词 名词`（如 `Fix /api/esp returning empty weather`），下面 1-2 段写 `why` 而不是 `what`。

## 加入新端点

1. `server.js` 里 `app.get/post(...)`
2. 数据从 `.radio_playlist/current.json` 取 → 用 `loadCurrentPlaylist()`
3. 会泄露 API key → 通过 `maskKey()` 返回 masked 形状
4. UI 改 → 编辑对应 `views/*.ejs`，加载共享 nav 用 `partials/_nav.ejs`

## 一句话总结

**192 上编辑 → commit → Mac 中转 push → GitHub 更新。** 所有改、测、推通过 Hermes agent 自动完成。