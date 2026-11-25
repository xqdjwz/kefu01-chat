Cloudflare部署完整教程.md
# 在线客服系统 · Cloudflare 免费部署完整教程

> 适合：想给自己网站加一个「不用登录、能发图片、有后台」的在线客服。
> 全程在浏览器里点，**不用装软件、不用命令行**，一台电脑 15～20 分钟能上线。
> 前提只有一个：有一个 GitHub 账号和一个 Cloudflare 账号（都免费）。

---

## 先花 10 秒，点个 Star ⭐

如果这个项目对你有用，麻烦在仓库右上角点一下 **Star**。

- Star 不花你任何东西，但能让更多人搜到这个项目；
- 以后项目更新，你也能在 GitHub 首页的 **Watching / Star** 列表里第一时间看到；
- Fork 之前顺手点一下，就是对我最大的支持，谢谢 🙏

---

## 目录

1. [为什么用 Fork，而不是下载压缩包](#1-为什么用-fork而不是下载压缩包)
2. [你需要准备什么](#2-你需要准备什么)
3. [六步速览（赶时间看这里）](#3-六步速览赶时间看这里)
4. [第一步：Fork 仓库（并点 Star）](#4-第一步fork-仓库并点-star)
5. [第二步：创建 D1 数据库](#5-第二步创建-d1-数据库)
6. [第三步：开通 R2 并创建存储桶（推荐）](#6-第三步开通-r2-并创建存储桶推荐)
7. [第四步：改你 fork 里的 wrangler.toml](#7-第四步改你-fork-里的-wranglertoml)
8. [第五步：让 Cloudflare 连接你的 GitHub 并自动部署](#8-第五步让-cloudflare-连接你的-github-并自动部署)
9. [第六步：首次访问 + 设置客服口令](#9-第六步首次访问--设置客服口令)
10. [上线自检清单](#10-上线自检清单)
11. [绑定自己的域名（可选）](#11-绑定自己的域名可选)
12. [以后怎么更新到新版本](#12-以后怎么更新到新版本)
13. [常见问题排查](#13-常见问题排查)
14. [免费额度与费用](#14-免费额度与费用)
15. [数据备份 / 忘记口令 / 清空数据](#15-数据备份--忘记口令--清空数据)
16. [附录：把客服窗口嵌到自己网站](#16-附录把客服窗口嵌到自己网站)

---

## 1. 为什么用 Fork，而不是下载压缩包

很多人习惯「下载 zip → 解压 → 新建仓库 → 拖文件上传」，这套流程有 4 个坑：

| 下载再上传 | Fork（推荐） |
|---|---|
| 容易漏文件、目录层级传错（`src/src/index.js` 很常见） | 一键复制完整仓库，结构不会错 |
| 以后作者更新，你得重新下载、重新覆盖 | 点 **Sync fork** 就能拉更新 |
| 你的仓库和原项目没有关系，别人也看不到来源 | 保留 Fork 关系，来源清楚，也算给项目引流 |
| 每次都要手动建仓库、传 2MB 文件 | 只需点一次 **Fork** |

**Fork 是什么**：把别人的仓库完整复制一份到你自己的 GitHub 账号下。复制出来的仓库归你，你可以随便改（比如填自己的数据库 ID），原项目不会受影响。

---

## 2. 你需要准备什么

| 需要 | 说明 |
|---|---|
| GitHub 账号 | 免费注册：`github.com` |
| Cloudflare 账号 | 免费注册：`dash.cloudflare.com`，邮箱验证一下即可 |
| 浏览器 | Chrome / Edge 都行 |
| 一张能接收验证码的卡（仅 R2 可能需要） | 见第 6 节；**不想绑卡也能部署**，只是图片存 D1、单张限制更小 |
| 没有GitHub的话 |  https://shop.xqdj.site/product/github-du-xiang-cheng-pin-zhang-hao |
| 开通R2推荐海外卡绑定 | https://shop.xqdj.site/product/cloudflare-r2-cun-chu-tong-kai-tong |

**不需要**：服务器、域名（可选）、Node.js、命令行、Docker、R2 API 密钥。

---

## 3. 六步速览（赶时间看这里）

1. 打开项目页 → 点 **Star** → 点 **Fork**（第 4 节）
2. Cloudflare 建一个 D1 数据库 `cf_kefu`，复制 **Database ID**（第 5 节）
3. （推荐）开通 R2，建一个桶 `cf-kefu-files`（第 6 节）
4. 在你 fork 的仓库里改 `wrangler.toml`：填 `database_id`，打开 R2 那三行注释（第 7 节）
5. Cloudflare → Workers & Pages → 导入你的仓库 → 构建 `npm install`、部署 `npx wrangler deploy`（第 8 节）
6. 打开 `/agent`，输入客服名 + 口令，完成初始化（第 9 节）

第一次构建大约 1～3 分钟，之后你改任何文件都会自动重新部署。

---

## 4. 第一步：Fork 仓库（并点 Star）

### 4.1 打开项目主页

用浏览器打开项目仓库地址 `https://github.com/xqdjwz/kefu01-chat`

### 4.2 点 Star ⭐

在页面右上角，**Fork** 和 **Star** 两个按钮挨着：

- 点 **Star**（有的界面显示 `Star`，已点过会变成 `Starred`）
- 不需要登录也能看代码，但点 Star / Fork 都需要先登录 GitHub

### 4.3 点 Fork

1. 点右上角 **Fork**
2. 进入 "Create a new fork" 页面：
   - **Owner**：选你自己的账号
   - **Repository name**：保持 `cf-kefu-chat` 就行（想改也可以，不影响部署）
   - **Description**：可不填
   - **Copy the `main` branch only**：保持勾选
3. 点绿色 **Create fork**

几秒后你会跳到自己的仓库：

```
https://github.com/你的用户名/cf-kefu-chat
```

> **确认一下**：页面左上角显示 `你的用户名 / cf-kefu-chat`，下面有一行小字 `forked from 作者名/cf-kefu-chat`。看到这行就说明 Fork 成功了。

后面所有「改文件」的操作，都在**你自己这个 fork 仓库**里做。

---

## 5. 第二步：创建 D1 数据库

D1 是 Cloudflare 的数据库，用来存会话、消息、备注、客服口令。

1. 登录 Cloudflare → 左侧菜单找到 **Storage & Databases / 存储和数据库**
2. 点 **D1 SQL Database**
3. 点 **Create database / 创建数据库**
4. 名称填：`cf_kefu`
   - 必须和 `wrangler.toml` 里的 `database_name` 一致；想换名字就两边一起改
5. 创建完成后进入这个库的详情页，找到 **Database ID**，点复制

它长这样：

```
a1b2c3d4-1234-5678-9abc-def012345678
```

**先把它记在记事本里，下一步（第 7 节）要用。**

> 这时**不要**建表、不要执行 SQL。程序第一次被访问时会自动建好全部表（会话、消息、设置、客服、图片、token 映射）。

---

## 6. 第三步：开通 R2 并创建存储桶（推荐）

### 6.1 先搞清楚：R2 是干什么的，不开行不行

| | 不开 R2（图片存 D1） | 开 R2（推荐） |
|---|---|---|
| 能不能正常用 | ✅ 能，聊天、图片都正常 | ✅ 能 |
| 图片存在哪 | 和文字一起挤在 D1 的 5GB 里 | 单独存 R2，D1 只存文字 |
| 单张图片限制 | 约 700KB（前端会自动压到 400KB 左右） | 不受 D1 单行限制，可放宽到 5MB |
| 长期影响 | 图片多了会占满 D1，文字也没地方存 | D1 空间几乎不消耗，容量更稳 |
| 费用 | 免费 | 免费额度内也是 0 元 |

**结论**：只是自己小范围试用，可以先不开；打算长期给客户用，建议按下面步骤开 R2。开了以后代码会自动优先用 R2，不需要改代码。

### 6.2 开通 R2

1. Cloudflare 左侧菜单找到 **R2 Object Storage**（有的界面在 **Storage & databases → R2**）
2. 第一次进入会看到 **Enable R2 / 开通 R2 / Purchase R2 plan**
3. 选择 **Free / 免费套餐（$0/month）**，确认
4. 部分账号在这一步会要求**添加付款方式**（信用卡或 PayPal）
   - 这是 Cloudflare 的账户验证要求，**只要不超额就不会扣费**；R2 的免费额度见第 14 节
   - 如果你不想绑卡：直接跳过第 6 节，走「不开 R2」方案，第 7 节里 R2 那三行保持注释即可
5. 开通成功后会进入 R2 的概览页

### 6.3 创建存储桶（Bucket）

1. 点 **Create bucket / 创建存储桶**
2. 名称填：`cf-kefu-files`
   - **必须和 `wrangler.toml` 里的 `bucket_name` 完全一致**，大小写、横杠都不能差
   - 桶名创建后不能改，填错只能删了重建
3. Location 选 **Automatic**（自动选最近的区域）即可
4. 点 **Create bucket**

### 6.4 两个「不用做」的事

- **不用**开启 Public access（公开访问）。本项目的图片是通过 Worker 的 `/api/file/xxx` 读的，桶不需要对外公开，更安全。
- **不用**创建 R2 API Token。项目是通过 Worker 的绑定（binding）访问 R2 的，不需要 S3 密钥。

---

## 7. 第四步：改你 fork 里的 wrangler.toml

`wrangler.toml` 是 Cloudflare 的部署配置，**整个项目只有这一处需要你手填**。

### 7.1 打开文件

1. 打开你自己的 fork 仓库首页
2. 点开根目录的 `wrangler.toml`（必须在根目录，和 `src` 文件夹并列）
3. 点右上角 **铅笔图标** 进入编辑

### 7.2 填 D1 的 Database ID

找到这一段：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf_kefu"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
migrations_dir = "migrations"
```

把 `database_id` 换成第 5 节复制的那串 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf_kefu"
database_id = "a1b2c3d4-1234-5678-9abc-def012345678"
migrations_dir = "migrations"
```

### 7.3 打开 R2 绑定（开了 R2 才需要）

如果第 6 节已经建好 `cf-kefu-files` 桶，把下面三行前面的 `#` 删掉：

```toml
# [[r2_buckets]]
# binding = "BUCKET"
# bucket_name = "cf-kefu-files"
```

改成：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "cf-kefu-files"
```

> 没开 R2 就保持注释状态，不要删 `#`，否则部署会因为「找不到桶」失败。

### 7.4 保存

页面拉到下面，填一句提交说明，比如 `填入 D1 ID 并启用 R2`，点 **Commit changes**。

### 7.5 对照完整配置

改完应该长这样（`SHOP_NAME` 等初始值可以不改，部署后能在后台设置里改）：

```toml
name = "cf-kefu-chat"
main = "src/index.js"
compatibility_date = "2025-04-01"
workers_dev = true

[assets]
directory = "./public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "cf_kefu"
database_id = "你的-Database-ID"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "cf-kefu-files"

[vars]
SHOP_NAME = "在线客服"
AGENT_NAME = "客服"
WELCOME_MESSAGE = "您好！欢迎光临，请问有什么可以帮您？"
MAX_IMAGE_MB = "5"
RECALL_WINDOW_SEC = "120"

[observability]
enabled = true
```

---

## 8. 第五步：让 Cloudflare 连接你的 GitHub 并自动部署

### 8.1 进入创建流程

1. Cloudflare 左侧 → **Workers & Pages**
2. 点右上角 **Create / 创建**
3. 选 **Workers** 标签页
4. 选 **Import a repository / 导入仓库**（有的界面写 **Connect to Git** 或 **Workers Builds**）

### 8.2 授权 GitHub，选你的 fork

1. 第一次会弹出 GitHub 授权 → 点 **Connect GitHub**，同意安装 Cloudflare 的 GitHub App
2. 授权范围建议选 **Only select repositories**，只勾选你刚 fork 的 `cf-kefu-chat`
3. 回到 Cloudflare，在仓库列表里选中 `你的用户名/cf-kefu-chat`，分支选 `main`

> 列表里如果同时出现作者的仓库和你的 fork，**一定要选你名字下面的那个**，否则你填的 database_id 不会生效。

### 8.3 填部署参数

| 字段 | 填什么 |
|---|---|
| Worker / 项目名称 | `cf-kefu-chat`（必须和 `wrangler.toml` 里的 `name` 一致） |
| 生产分支 | `main` |
| Root directory / 根目录 | `/` 或留空 |
| Build command / 构建命令 | `npm install` |
| Deploy command / 部署命令 | `npx wrangler deploy`（默认通常就是它） |

### 8.4 点部署

点 **Deploy / Save and Deploy**，等待构建日志出现：

```
Cloning repository
npm install
npx wrangler deploy
Success / Deployed
```

大约 1～3 分钟。成功后页面会给你一个地址：

```
https://cf-kefu-chat.你的子域.workers.dev
```

- 访客端：就是这个地址（结尾 `/`）
- 客服端：地址后面加 `/agent`

> 如果提示还没有 `workers.dev` 子域，去 Workers & Pages 首页点 **Change your workers.dev subdomain**，起一个全账号唯一的名字（比如 `kefu-xiaoqi`），保存后再回来复制地址。

> 一个 GitHub 账号可以 fork 无数个项目，但同一个 Cloudflare 账号下 **Worker 名字不能重复**。如果你想同时部署两个客服系统，把 `wrangler.toml` 的 `name` 改成 `cf-kefu-chat-2`（同时 Cloudflare 里项目名也填一样的）。

---

## 9. 第六步：首次访问 + 设置客服口令

1. 浏览器打开 `https://你的地址/agent`
2. **客服名称**：填对顾客显示的名字，例如 `小旗`
3. **客服口令**：设一个至少 4 位的口令，例如 `kefu2026`
4. 点「进入工作台」

⚠️ **这一次输入的口令，就是系统口令**。以后所有客服都用它登录；忘了只能按第 15 节重置。

进后台后，左下角 **设置** 里可以改：

| 设置项 | 作用 |
|---|---|
| 店铺名称 | 访客端顶部显示的名字 |
| 客服名称 / 头像 | 回复时显示的名字和头像 |
| 自动欢迎语 | 新访客进来是否自动发一条、发什么 |
| 对话结束语 | 点「结束对话」时自动发的收尾消息；可设沉默 N 分钟自动结束 |
| 同一 IP 复用会话 | 同一个 IP 再进来接着原会话聊，不新起一条；支持合并历史重复会话 |
| 关键词自动回复 | 在线 / 离线两套，格式 `关键词=回复内容` |
| 消息推送 | Server酱、PushPlus、钉钉、企微、Bark 五选多 |
| 存储用量 | 看已用空间、还能发多少条、自动清理天数 |

最后把访客端地址（`https://你的地址/`，**不要带 `/agent`**）发给顾客即可。

---

## 10. 上线自检清单

按顺序检查，全部通过就说明部署完整：

| # | 检查 | 怎么做 | 应该看到 |
|---|---|---|---|
| 1 | 健康检查 | 打开 `https://你的地址/api/health` | `"version":"v3.4-2026-11-25"` |
| 2 | R2 是否生效 | 同上，看 `"storage"` | 开了 R2 显示 `"r2+d1"`；没开显示 `"d1"` |
| 3 | 访客端 | 打开 `/` | 出现聊天框和欢迎语，不是「正在连接客服…」 |
| 4 | 客服端 | 打开 `/agent` | 有「客服名称」+「客服口令」两个输入框 |
| 5 | 发文字 | 访客发一句，客服端不刷新 | 2 秒左右自动出现 |
| 6 | 发图片 | 访客点图片按钮选图 | 双方都能看到，点开可全屏 |
| 7 | 已读 / 撤回 | 发一条后看状态、2 分钟内撤回 | 「未读」变「已读」；撤回双方都显示提示 |
| 8 | 结束语 | 客服点「结束对话」 | 访客端收到收尾消息，底部提示「本次会话已结束」 |
| 9 | 同 IP 会话 | 同一浏览器清站点数据后再进 | 还是原来那条会话，不会多出一条 |
| 10 | 推送（可选） | 配一个渠道后让访客发消息 | 手机/群里收到提醒 |

---

## 11. 绑定自己的域名（可选）

前提：域名已经托管在 Cloudflare（域名的 NS 指向 Cloudflare）。

1. Workers & Pages → 选中 `cf-kefu-chat` → **Settings**
2. 找 **Domains & Routes / 域名和路由** → **Add Custom Domain / 添加自定义域名**
3. 填一个子域名，例如 `kefu.你的域名.com`（也可以直接用根域名）
4. 保存，Cloudflare 会自动加 DNS 记录并签发证书，几分钟生效

之后：

- `https://kefu.你的域名.com/` 访客端
- `https://kefu.你的域名.com/agent` 客服端

> 同一个域名只能绑一个 Worker，别在多个 Worker 上重复绑。

---

## 12. 以后怎么更新到新版本

因为你用的是 Fork，更新比下载党简单很多：

1. 打开你的 fork 仓库首页
2. 如果作者更新了，页面会出现一条提示：`This branch is X commits behind 作者名:main`
3. 点右边的 **Sync fork** → **Update branch**

⚠️ **注意 database_id 冲突**：如果你改过 `wrangler.toml`（填了自己的 Database ID），同步时这个文件可能提示冲突。处理原则：

- **保留你自己的 `database_id` 和 `bucket_name`**，只把作者新增的其他内容合并进来
- 如果不会解决冲突，宁可不同步 `wrangler.toml`，手动把作者的新代码文件复制过来

同步完成后，Cloudflare 会自动重新构建部署，不用再点任何按钮。

> 只 Watch 不 Fork 也能收到更新通知，但那样你得自己同步代码，反而更麻烦。

---

## 13. 常见问题排查

| 现象 | 原因 | 怎么修 |
|---|---|---|
| `D1 未绑定` / `database_id 还是 REPLACE_WITH...` | 第 7 节没填 ID，或填错 | 改 fork 里的 `wrangler.toml`，提交后到 Worker → Deployments 点 Retry |
| 构建日志 `Could not find wrangler.toml` | 根目录设置不对，或文件不在根目录 | Root directory 填 `/`；确认 `wrangler.toml` 与 `src` 并列 |
| 构建日志 `Authentication error` / `10000` | Cloudflare 与 GitHub 授权失效 | Worker → Settings → Build → 重新连接 GitHub |
| 部署报 `bucket not found` / `Cannot find bucket` | R2 桶名和 `bucket_name` 不一致，或桶没建/没开通 R2 | 核对第 6.3 节；没开 R2 就把 `[[r2_buckets]]` 三行重新注释掉 |
| 部署报 R2 权限 / `not entitled` | 账号没开通 R2 套餐 | 回 R2 页面点 Enable R2（免费套餐），或先注释掉 R2 三段 |
| `/api/health` 返回 `server_error` | D1 没绑好，或 ID 指向了别的空库 | 核对 ID；确认填的是新建那个库 |
| 一直显示「正在连接客服…」 | 接口 500，同上 | 打开 `/api/health` 看具体错误文字 |
| 页面是老界面 / 按钮没有 | Cloudflare 缓存了旧静态文件 | Ctrl+F5 强刷；Cloudflare → Caching → Purge Everything |
| 登录提示「口令不正确」 | 之前设过口令 | 按第 15.2 节重置 |
| 发图片提示「图片过大」 | 单张超过上限 | 没开 R2 时控制在 700KB 内（前端会自动压缩）；开了 R2 可到 5MB |
| 两个人的消息互相看不到 | 一方开了代理或缓存旧页面 | 强刷、清缓存，等 2 秒轮询 |

看日志：Cloudflare → Workers & Pages → `cf-kefu-chat` → **Logs**，页面报错会实时打印在这里。

---

## 14. 免费额度与费用

全部在免费计划里，正常小店用量 **0 元**：

| 项目 | 免费额度 | 本项目的消耗 |
|---|---|---|
| Workers | 每天 10 万次请求 | 访客端 2 秒轮询一次，单页全天开着约 4.3 万次/天；客服端同理。两页都常开约 8.6 万次/天 |
| D1 存储 | 5GB（整个账号共享） | 纯文字一条约 300～400 字节；不开 R2 时图片是大头 |
| D1 读 | 每天 500 万行 | 正常聊天远用不到 |
| D1 写 | 每天 10 万行 | 一条消息约写 2 行，够日常使用 |
| R2 存储 | 10GB / 月 | 图片压缩后约 400KB，能放约 2.5 万张 |
| R2 读操作（Class B） | 1000 万次 / 月 | 看图才计数，够用 |
| R2 写操作（Class A） | 100 万次 / 月 | 上传图片才计数，够用 |
| R2 流量（Egress） | 永久免费、不限量 | 图片被访问不额外收费 |

**真正要盯的是「每天 10 万次请求」和「每天 10 万行写入」**，这两个按天重置：

- 客服不忙时把工作台标签页关掉，不轮询就不消耗
- 想更省请求：把 `public/assets/chat.js` 顶部的 `POLL_VISIBLE = 2000` 改成 `3000`（单页降到约 2.9 万次/天）
- 后台切到后台标签时程序已自动降到 8 秒一次（`POLL_HIDDEN`）

> 开了 R2 后如果超出免费额度，按量计费很便宜（存储 $0.015/GB/月，写 $4.50/百万次，读 $0.36/百万次，出流量免费）。不想产生任何费用，就在 R2 后台设置里保持免费套餐并留意用量即可。

---

## 15. 数据备份 / 忘记口令 / 清空数据

### 15.1 备份聊天记录

后台单个会话可以点 **导出** 下载 CSV（Excel/WPS 直接打开）。全量备份：

1. Cloudflare → Storage & Databases → D1 → `cf_kefu`
2. 点 **Console / 控制台**，执行：

```sql
SELECT id, conv_id, sender, sender_name, type, body, created_at FROM messages ORDER BY id;
```

结果可以复制出来存档；D1 库详情页也有 **Export** 入口可导出整库。

### 15.2 忘记客服口令

在 D1 控制台执行：

```sql
DELETE FROM settings WHERE key = 'passcode_hash';
DELETE FROM agents;
```

然后重新打开 `/agent`，输入名称 + 新口令即可重新初始化。**聊天记录不会丢。**

### 15.3 清空全部聊天（保留设置和口令）

```sql
DELETE FROM messages;
DELETE FROM conversations;
DELETE FROM files;
DELETE FROM visitor_links;
```

---

## 16. 附录：把客服窗口嵌到自己网站

项目自带 `public/embed.js`，两种用法，都不需要改你自己网站的后端。

**① 悬浮按钮（推荐）**——放到网站所有页面：

```html
<script>
window.cfKefuConfig = {
  url: "https://你的worker域名.workers.dev",  // 不要带结尾斜杠
  btnText: "在线客服",
  btnColor: "#ff4a1f",
  position: "right"                          // right 或 left
};
</script>
<script src="https://你的worker域名.workers.dev/embed.js"></script>
```

**② iframe 嵌一个「联系客服」页面**：

```html
<iframe src="https://你的worker域名.workers.dev/"
        style="width:100%;height:640px;border:0;border-radius:12px"></iframe>
```

嵌入进来的访客，后台会记录「来源：你网站的那个页面地址」，方便区分是哪个站点来的。

---

## 最后

- 部署完成后再回仓库点一次 **Star** ⭐，让更多需要的人找到它；
- 有问题优先看第 13 节，再看 Worker 的实时日志；
- 这套系统所有数据都在你自己的 Cloudflare 账号里，作者看不到、也拿不到。

祝上线顺利 🎉
