# 在线客服聊天系统

基于 **Cloudflare Workers + D1 + R2** 的网页客服系统，访客端和客服工作台在同一个域名下，无需服务器、无需数据库服务器，可全部跑在 Cloudflare 免费额度内。

![访客端](docs/preview-visitor.png)
![客服工作台](docs/preview-agent.png)

## 功能

**访客端（`/`）**
- 免登录直接进入，自动生成会话身份并保存在浏览器本地
- 发送文字、发送图片（选图后自动压缩到长边 1600px 再上传）
- 消息撤回（默认 2 分钟内）、删除消息（只删自己看到的）
- 自己发出的消息显示 **已读 / 未读** 回执
- 点图片全屏查看，刷新后聊天记录还在

**客服工作台（`/agent`）**
- 口令登录（`AGENT_TOKEN`）
- 会话列表：按最新消息排序，显示最后一条预览和**未读数**
- 支持按访客名 / 消息内容搜索
- 打开会话自动标记已读，访客端实时看到「已读」
- 同样支持文字、图片、撤回、删除
- 窄屏下自动切换成「列表 → 聊天」的单栏移动布局

**消息状态说明**

| 状态 | 含义 |
| --- | --- |
| 未读 | 对方还没打开看过这条消息 |
| 已读 | 对方已经拉取并标记为已读 |
| 消息已撤回 | 发送方在时限内撤回，双方都只看到占位提示 |
| 删除 | 只对操作者本人隐藏，对方不受影响 |

## 技术栈

| 部分 | 方案 | 免费额度 |
| --- | --- | --- |
| 计算 | Cloudflare Workers | 10 万请求 / 天 |
| 数据库 | Cloudflare D1（SQLite） | 500 万行读取 / 天，10 万行写入 / 天 |
| 图片存储 | Cloudflare R2 | 10 GB 存储，读取不计流量费 |
| 前端 | 原生 HTML/CSS/JS，无构建步骤 | 随 Worker 静态资源一起发布 |

数据表只有两张：`conversations`（会话）、`messages`（消息）。消息的已读、撤回、删除都是行内字段，不额外建表。

## 目录结构

```
cf-kefu-chat/
├── src/index.js              # Worker：API + 静态资源路由
├── public/
│   ├── index.html            # 访客端
│   ├── agent.html            # 客服工作台
│   ├── favicon.svg
│   └── assets/
│       ├── app.css           # 两端共用样式
│       └── chat.js           # 两端共用的聊天核心（轮询/渲染/撤回/已读）
├── migrations/0001_init.sql  # D1 建表脚本
├── wrangler.toml             # Cloudflare 配置
├── .github/workflows/deploy.yml  # 推送到 GitHub 自动部署
└── docs/                     # 预览截图
```

## 一、本地跑起来

需要 Node 18+（本项目用 Node 22 验证）。

```bash
npm install

# 本地建库（不需要联网、不需要 Cloudflare 账号）
npx wrangler d1 migrations apply cf_kefu --local

# 本地口令：新建 .dev.vars
echo 'AGENT_TOKEN=你的客服口令' > .dev.vars

npx wrangler dev
```

打开 <http://127.0.0.1:8787> 是访客端，<http://127.0.0.1:8787/agent> 是客服工作台（口令就是 `.dev.vars` 里那个）。

## 二、部署到 Cloudflare（约 5 分钟）

```bash
npm install -g wrangler
wrangler login

# 1. 建数据库，复制输出里的 database_id
wrangler d1 create cf_kefu

# 2. 把 database_id 填进 wrangler.toml
#    [[d1_databases]] database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# 3. 建图片存储桶
wrangler r2 bucket create cf-kefu-files

# 4. 建表
wrangler d1 migrations apply cf_kefu --remote

# 5. 设置客服口令（只存在 Cloudflare，不写进代码和 Git）
wrangler secret put AGENT_TOKEN

# 6. 发布
wrangler deploy
```

发布完会输出一个 `https://cf-kefu-chat.<你的子域>.workers.dev`：

- 访客端：`https://cf-kefu-chat.xxx.workers.dev/`
- 客服端：`https://cf-kefu-chat.xxx.workers.dev/agent`

想用自己的域名：Cloudflare 后台 → Workers → 该 Worker → Settings → Domains & Routes → Add Custom Domain。

## 三、用 GitHub 托管并自动部署

```bash
cd cf-kefu-chat
git init -b main
git add .
git commit -m "init: 在线客服聊天系统"
git remote add origin git@github.com:你的账号/cf-kefu-chat.git
git push -u origin main
```

然后在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加两个 Secret：

| Secret | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare 后台「我的个人资料 → API Token」，模板选 **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 后台首页右侧的 Account ID |

之后每次 `git push` 到 `main`，`.github/workflows/deploy.yml` 会自动执行 D1 迁移并发布。注意：**首次部署前仍需手动跑一次上面的第 1～3 步**（建库、建桶、改 `database_id`），`AGENT_TOKEN` 也只需 `wrangler secret put` 设置一次。

## 四、改配置

`wrangler.toml` 的 `[vars]`：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `SHOP_NAME` | 访客端顶部显示的名称 | 在线客服 |
| `AGENT_NAME` | 客服在消息里显示的名字 | 客服小蒙 |
| `MAX_IMAGE_MB` | 单张图片上限 | 5 |
| `RECALL_WINDOW_SEC` | 撤回时限（秒） | 120 |

改完执行 `wrangler deploy` 生效。

其他常用调整：

- **刷新频率**：`public/assets/chat.js` 顶部 `POLL_INTERVAL = 2500`（毫秒）。
- **配色**：`public/assets/app.css` 顶部的 `--accent` 等变量。
- **撤回后是否保留占位**：`chat.js` 里 `messageNode` 处理 `status === 'recalled'` 的分支。

## 五、接口一览

所有接口同源，无需额外域名。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/session` | 访客建立或恢复会话，返回 `token` |
| GET | `/api/messages?conv=&after=&since=` | 增量拉取消息：`after` 拉新消息，`since` 拉状态变化（已读/撤回/删除） |
| POST | `/api/messages` | 发送消息 `{conv, type:'text'\|'image', body, fileKey}` |
| POST | `/api/messages/:id/recall` | 撤回（仅发送方，限时限内） |
| POST | `/api/messages/:id/delete` | 删除（只对自己隐藏） |
| POST | `/api/upload?conv=` | 上传图片到 R2，返回 `key` |
| GET | `/api/file/:key` | 读取图片 |
| POST | `/api/read` | 标记已读 |
| GET | `/api/conversations` | 客服：会话列表 + 未读数 |
| POST | `/api/login` | 客服：校验口令 |

鉴权：访客用请求头 `x-visitor-token`，客服 `<token>` 用 `Authorization: Bearer <AGENT_TOKEN>`。

## 六、注意事项

- **免费额度与实时性**：目前是轮询（每个打开的页面每 2.5 秒 1 次请求）。按 10 万请求/天计算，大约能支撑「2 个客服页面常开 + 若干访客短时在线」。如果客服页面整天不关，建议把 `POLL_INTERVAL` 调到 5000ms，或后续升级为 Durable Objects + WebSocket 推送（那个方案仍在免费额度内，但要重写消息分发）。
- **客服账号**：当前是单口令，所有客服共用同一条口令和同一个工作台身份（消息显示同一个 `AGENT_NAME`）。要做多人坐席、各自署名和分配会话，需要在 `conversations` 加 `assignee` 字段并把口令换成账号体系。
- **图片可见性**：图片地址形如 `/api/file/<会话ID>/<40位随机名>.png`，随机名不可枚举，但没有额外鉴权——拿到链接就能看。涉及敏感图片请改成带签名的临时链接。
- **图片清理**：撤回会清空消息里的 `file_key`，但 R2 里的原文件仍保留。定期可以用 `wrangler r2 object delete` 或 Worker 定时任务按 `created_at` 清理孤儿文件。
- **数据导出**：`wrangler d1 execute cf_kefu --remote --command="SELECT * FROM messages"` 可查数据；也可以在 Cloudflare 控制台的 D1 里直接跑 SQL。
- 消息文本上限 2000 字，图片单张上限由 `MAX_IMAGE_MB` 控制，超过会在前端提示。

## 已验证

本项目在本地 `wrangler dev` 下跑通了完整链路：创建会话 → 发文字 → 发图片（上传 R2 并回读）→ 客服回复 → 已读回执 → 撤回（含超时拒绝）→ 删除单侧隐藏 → 双端轮询同步。
