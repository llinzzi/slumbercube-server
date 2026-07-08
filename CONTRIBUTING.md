# 贡献指南

## 项目结构

```
slumbercube-server/
├── server.js              Express 服务（API + 页面路由）
├── scripts/               后台脚本（DJ worker、歌单生成、TTS 拼接）
├── views/                 EJS 页面模板
├── config/                配置模板（API key 等运行时配置不存在 git 中）
├── public/                静态资源（CSS）
└── .radio_playlist/       运行时数据（gitignored）
```

## 本地开发

### 环境要求

- Node.js >= 18
- 可选：`lame`（MP3 编码）、`mmx` CLI（MiniMax LLM/TTS）

### 启动

```bash
npm install
node server.js
# 访问 http://localhost:3000
```

### 配置

运行后在 `/settings` UI 中配置：
- 天气 API key（和风天气）
- MiniMax API token（LLM + TTS）
- 曲库目录

配置文件存于 `config/settings.json` 和 `config/weather.json`（gitignored）。

## 代码风格

- 中文注释
- 每个 commit 只做一件事
- Message 格式：`动词 名词`（如 `Fix /api/esp returning empty weather`）

## 加入新端点

1. `server.js` 中添加 `app.get/post(...)`
2. 涉及 API key 的响应使用 `maskKey()` 掩码
3. UI 变更编辑对应 `views/*.ejs`

## 测试

```bash
# 手动触发场景任务
curl -X POST -H "Content-Type: application/json" \
  -d '{"batch":"manual","scene":"morning"}' \
  http://localhost:3000/api/dj/trigger

# 测试天气 API
curl http://localhost:3000/api/weather

# 检查服务器状态
curl http://localhost:3000/api/time
```

## 提交规范

- 每个 commit 只做一件事
- Message 第一行用简短中文描述做了什么
- 下面 1-2 段解释为什么这样改（why），而不是改了什么地方（what）
