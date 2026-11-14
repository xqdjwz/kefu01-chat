# 在线客服系统 · Cloudflare 从零到上线完整教程

> 适用：`cf-kefu-chat-修复版.zip`（Workers + D1 + 静态页面，全部在你现有免费额度内）
> 全程浏览器官网操作，**不需要命令行、不需要装任何软件**。
> 如果界面文字和本文略有差异，认按钮位置和意思就行（Cloudflare 后台中英文会混排）。

---

## 目录

- [0. 先定方案：Workers 还是 Pages](#0-先定方案workers-还是-pages)
- [1. 名词速查（看懂后面所有步骤）](#1-名词速查看懂后面所有步骤)
- [2. 需要准备的东西](#2-需要准备的东西)
- [3. 最短路线（急着上线看这里）](#3-最短路线急着上线看这里)
- [4. 第一步：彻底清空旧部署](#4-第一步彻底清空旧部署)
- [5. 第二步：把代码传到 GitHub](#5-第二步把代码传到-github)
- [6. 第三步：创建 D1 数据库](#6-第三步创建-d1-数据库)
- [7. 第四步：把 Database ID 写进 wrangler.toml](#7-第四步把-database-id-写进-wranglertoml)
- [8. 第五步：Workers Builds 自动部署](#8-第五步workers-builds-自动部署)
- [9. 第六步：首次验证（判断到底部署的是哪一版）](#9-第六步首次验证判断到底部署的是哪一版)
- [10. 第七步：设置客服口令并开始使用](#10-第七步设置客服口令并开始使用)
- [11. 第八步：12 项功能自检清单](#11-第八步12-项功能自检清单)
- [12. 第九步：绑定自己的域名（可选）](#12-第九步绑定自己的域名可选)
- [13. 日常维护：改设置、改口令、看日志、备份](#13-日常维护改设置改口令看日志备份)
- [14. 报错排查表（按提示文字对号入座）](#14-报错排查表按提示文字对号入座)
- [15. 费用与免费额度](#15-费用与免费额度)
- [附录 A：用 GitHub Actions 部署（备选）](#附录-a用-github-actions-部署备选)
- [附录 B：本地想先预览（需要命令行，可选）](#附录-b本地想先预览需要命令行可选)

---

## 0. 先定方案：Workers 还是 Pages

**结论：用 Workers。这套代码就是按 Workers 写的，用 Pages 要改代码结构。**

| 对比项 | Workers（本项目用这个） | Pages |
|---|---|---|
| 适合什么 | 全栈：有接口、有数据库、有登录 | 静态网站 + 轻量函数 |
| 静态页面怎么放 | `[assets]` 绑定 `public/` 目录，Worker 同时处理 `/api/*` | 构建产物目录 + `functions/` 目录（另一套写法） |
| 数据库绑定（D1） | 直接在 `wrangler.toml` 里声明，部署时自动挂上 | 也能绑，但要写在 Pages 项目设置里 |
| Cloudflare 官方方向 | 新功能主线，Pages 的做法正在向 Workers 合并 | 维护中，新项目官方更推荐 Workers |
| 本项目的改动成本 | 0（已经有 `wrangler.toml` 和 `src/index.js`） | 要重写成 `functions/` 或 `_worker.js`，代码结构会变 |

再具体一点，你这套系统有 4 样东西必须同时存在：

1. 访客页面 `/` 和客服页面 `/agent`（静态文件）
2. `/api/session`、`/api/messages` 等十几个接口（动态计算）
3. D1 数据库（存会话、消息、备注、口令、图片）
4. 同一个域名下同时提供 1、2、3

Workers 用一行 `[assets]` 配置就把静态文件和接口合到一个域名里；Pages 要做到同样效果得换成它的目录约定，等于重写。所以：

**用 Workers，别用 Pages。D1 是独立的数据库产品，Workers 和 Pages 都能用，跟选哪个前端形态无关。**

---

## 1. 名词速查（看懂后面所有步骤）

| 名词 | 大白话 |
|---|---|
| **Worker** | 跑在 Cloudflare 上的程序，负责处理接口请求、返回页面。本次会创建一个，名字 `cf-kefu-chat` |
| **D1** | Cloudflare 的数据库（SQLite）。存会话、消息、备注、口令、小图。本次建一个，名字 `cf_kefu` |
| **Database ID** | 每个 D1 库的唯一编号，形如 `a1b2c3d4-1234-5678-9abc-def012345678`。**这是你唯一必须手动填的东西** |
| **Workers Builds** | Cloudflare 自家的自动部署：连上你的 GitHub 仓库，你改代码它自动重新发布。**不需要命令行** |
| **workers.dev 子域** | Cloudflare 送你的免费域名，形如 `https://cf-kefu-chat.abc.workers.dev` |
| **绑定（Binding）** | 把数据库"挂"到 Worker 上。本项目在 `wrangler.toml` 里写好了，部署时自动生效，不用在网页上点 |
| **GitHub 仓库** | 存放代码的地方。Cloudflare 从这里拉代码去部署 |

---

## 2. 需要准备的东西

- 一个 **Cloudflare 账号**（免费注册，不要信用卡；注册完第一次进 Workers 会让你起一个 `workers.dev` 子域名）
- 一个 **GitHub 账号**（免费）
- 电脑上的浏览器（Chrome / Edge）
- 解压好的 `cf-kefu-chat-修复版.zip`

**不用准备**：服务器、域名（可选）、Node.js、命令行工具、R2 存储桶、API Token。

---

## 3. 最短路线（急着上线看这里）

1. 删掉旧 Worker / 旧 D1 / 旧仓库（第 4 步）
2. 代码传 GitHub（第 5 步）
3. Cloudflare 建 D1 库 `cf_kefu`，复制 Database ID（第 6 步）
4. 在 GitHub 网页把 `wrangler.toml` 里那行占位符换成 Database ID（第 7 步）
5. Cloudflare 里 Import 仓库，构建 `npm install`、部署 `npx wrangler deploy`（第 8 步）
6. 打开 `/agent`，第一次输入名称+口令就完成初始化（第 10 步）

预计 15～20 分钟，第一次部署构建 1～3 分钟。

---

## 4. 第一步：彻底清空旧部署

> 你之前部署过别的版本，想"全部重新来"。按顺序做完这 4 小步，环境就干净了。
> **注意：删 D1 会连同聊天记录一起删掉，如果你旧库里已经有顾客消息，先看第 13 节"备份"再删。**

### 4.1 删掉旧 Worker

1. 登录 Cloudflare → 左侧 **Workers & Pages**
2. 在列表里找到你之前建的那个（名字可能是 `cf-kefu-chat`、`kefu`、`worker` 之类）
3. 点进去 → 上方切到 **Settings**
4. 拉到页面最下面 → **Delete / 删除** → 按提示输入 Worker 名称确认

> 如果列表里有两个（比如一个旧版、一个试手的），都删掉。删错了也没关系，重新导入仓库会再建一个。

### 4.2 删掉旧 D1 数据库（或换一个新库名）

1. 左侧 **Storage & Databases / 存储和数据库** → **D1 SQL Database**
2. 点开旧库（比如 `cf_kefu`）→ 切到 **Settings**
3. 拉到最下面 → **Delete database** → 确认

如果你**不想删旧数据**，就用另一个办法：新建一个库叫 `cf_kefu_v2`，然后第 7 步把 `wrangler.toml` 里的 `database_name` 也改成 `cf_kefu_v2`（两处都要改：`database_name` 和 `database_id`）。

### 4.3 删掉旧 GitHub 仓库

1. GitHub → 打开旧仓库 → **Settings**
2. 拉到最下面 → **Delete this repository** → 按提示输入仓库名确认

不想删旧仓库也行，新建一个不同名字的仓库（比如 `cf-kefu-chat-v2`）即可，不影响后面步骤。

### 4.4 清掉浏览器里的旧登录状态（可选但推荐）

旧版本可能在浏览器里存了旧的访客身份和客服 token，新站会认不出来。清理方法（任一即可）：

- **最简单**：直接用新域名打开（域名换了，旧的本地数据天然不会带过去）
- 如果沿用同一个 workers.dev 地址：浏览器地址栏左边的锁/设置图标 → **网站数据 / Cookies** → 清除该站点数据；或者用无痕窗口先测一遍

---

## 5. 第二步：把代码传到 GitHub

### 5.1 新建仓库

1. GitHub 右上角 **+** → **New repository**
2. Repository name 填 `cf-kefu-chat`（名字随便，但后面 Cloudflare 里 Worker 名要用 `cf-kefu-chat`，见 8.3）
3. 选 **Private**（私有）就行，免费账号也能用私有仓库
4. **不要**勾选 "Add a README file"（避免和包里的 README 冲突）
5. 点 **Create repository**

### 5.2 把文件传上去（网页拖拽）

1. 新仓库页面会有一个 **uploading an existing file** 的蓝字链接，点它
2. 打开你解压出来的文件夹，把里面**所有内容**一起选中拖到网页的虚线框里：
   - `src`（文件夹）
   - `public`（文件夹）
   - `migrations`（文件夹）
   - `docs`（文件夹，预览图，可不传）
   - `wrangler.toml`
   - `package.json`、`package-lock.json`
   - `README.md`、`部署说明.md`
   - 预览文件夹（可选，只影响你看图）
3. 等进度条走完（大约 2 MB，很快），下面填一句说明比如 `init`
4. 点绿色 **Commit changes**

> **关键**：`wrangler.toml` 必须出现在仓库**根目录**（和 `src` 文件夹并列），不能藏在某个子文件夹里。这是后面部署成功的硬条件。

### 5.3 传完自检

刷新仓库首页，应该能看到这样的结构（`wrangler.toml`、`package.json` 在根目录）：

```
.github/            （可选，用 Actions 才需要；没有也不影响）
docs/
migrations/
public/
src/
package.json
package-lock.json
README.md
wrangler.toml       ← 必须在根目录
部署说明.md
```

**看不到 `.github` 很正常**：以点开头的文件夹在 Windows 资源管理器里是隐藏的。这个文件夹是可选的，Workers Builds 不需要它，不传也行。

---

## 6. 第三步：创建 D1 数据库

1. Cloudflare 左侧菜单 → **Storage & Databases / 存储和数据库**
2. 点 **D1 SQL Database**
3. 点 **Create database / 创建数据库**
4. 名称填：`cf_kefu`（必须和 `wrangler.toml` 里的 `database_name` 一致；想换名字就两处一起改）
5. 创建完进入该库详情页，找到 **Database ID**，点复制（形如 `a1b2c3d4-1234-5678-9abc-def012345678`）

**记下这串 ID，下一步要用。**

> 此时**不要**建表、不要执行 SQL。程序第一次被访问时会自动把 6 张表（会话、消息、设置、客服、图片、索引）全部建好。

---

## 7. 第四步：把 Database ID 写进 wrangler.toml

1. GitHub 仓库首页点开 `wrangler.toml`
2. 右上角 **铅笔图标** 进入编辑
3. 找到这一段：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf_kefu"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
migrations_dir = "migrations"
```

把 `database_id` 的值替换成刚才复制的 ID，改完是这样（示例）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf_kefu"
database_id = "a1b2c3d4-1234-5678-9abc-def012345678"
migrations_dir = "migrations"
```

4. 页面下方 **Commit changes** 保存

完整的 `wrangler.toml` 应该是这样（可以拿来对照，别漏掉 `[assets]` 和 `[[d1_databases]]`）：

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

# 可选：想用 R2 存大图时再去掉注释
# [[r2_buckets]]
# binding = "BUCKET"
# bucket_name = "cf-kefu-files"

[vars]
SHOP_NAME = "在线客服"
AGENT_NAME = "客服"
WELCOME_MESSAGE = "您好！欢迎光临，请问有什么可以帮您？"
MAX_IMAGE_MB = "5"
RECALL_WINDOW_SEC = "120"

[observability]
enabled = true
```

> `[vars]` 里这几项只是**初始默认值**，部署后都能在「客服工作台 → 设置」里改，改完立即生效，不用回来改代码。

---

## 8. 第五步：Workers Builds 自动部署

### 8.1 进入创建流程

1. Cloudflare 左侧 → **Workers & Pages**
2. 点右上角 **Create / 创建**
3. 选 **Workers** 标签页
4. 选 **Import a repository / 导入仓库**（有的界面叫 "Connect to Git" 或 "Get started with Workers Builds"）

### 8.2 授权 GitHub 并选仓库

1. 第一次会弹 GitHub 授权 → 点 **Connect GitHub / 授权**，同意安装 Cloudflare 的 GitHub App
2. 可以选 **All repositories** 或 **Only select repositories**（推荐后者，只勾 `cf-kefu-chat`）
3. 回到 Cloudflare 页面 → 选中仓库 `cf-kefu-chat`，分支选 `main`

### 8.3 填写部署参数（关键）

| 字段 | 填什么 | 说明 |
|---|---|---|
| Worker / 项目名称 | `cf-kefu-chat` | **必须和 `wrangler.toml` 里的 `name` 一样**，否则会多出一个同内容的 Worker |
| 生产分支 | `main` | 默认即可 |
| Root directory / 根目录 | `/` 或留空 | 如果留空部署报找不到 `wrangler.toml`，填 `/` |
| Build command / 构建命令 | `npm install` | 装一下依赖，走缓存很快 |
| Deploy command / 部署命令 | `npx wrangler deploy` | 默认值通常就是这个；别改成 `npm run deploy` 以外的花活 |

> 如果界面只让填"构建命令"一项，部署命令保持默认 `npx wrangler deploy`；如果界面是 "Deploy command" 单独一栏，就按上表填。

### 8.4 点部署并等结果

1. 点 **Deploy / Save and Deploy**
2. 页面会跳到构建日志，能看到几步：
   - `Cloning repository`
   - `npm install`
   - `npx wrangler deploy`（会打印上传文件、绑定 `DB` 和 `ASSETS`、给出访问地址）
3. 大约 1～3 分钟，出现绿色 `Success` 或 `Deployed`

部署成功后会显示地址，形如：

```
https://cf-kefu-chat.你的子域.workers.dev
```

- 访客端 = 这个地址本身（结尾 `/`）
- 客服端 = 地址后面加 `/agent`

> 如果 Cloudflare 提示你还没设置 `workers.dev` 子域，点 Workers & Pages 首页的 **Change your workers.dev subdomain / 设置子域名**，起一个全站唯一的名字（比如 `kefu-xiaoqi`），保存后再回来看地址。

### 8.5 以后怎么更新

在 GitHub 网页上改任何文件（改配置、改文案、换代码）→ 提交 → Cloudflare 自动重新构建部署，全程不用管。想手动重来：Worker 详情页 → **Deployments** → 最近一次 → **Retry**。

---

## 9. 第六步：首次验证（判断到底部署的是哪一版）

这一步很重要：你之前踩过"部署了旧代码"的坑，用下面 3 个检查点就能确认跑的是这一版。

### 检查点 1：健康检查（最硬的证据）

> 打开 `https://你的地址/api/health`，看到 `"version":"v3-2026-11-14"` 和 `"features":[...]` 里带 `geo`、`autoReply`、`embed` 等字样，就说明部署的是最新这版（含 IP 归属地、关键词自动回复、网站嵌入、联系方式、导出、微信推送）。只有 `"storage"` 没有 `"version"` 的是上一版。

浏览器打开：

```
https://你的地址/api/health
```

应该看到类似：

```json
{"ok":true,"ts":1762940000000,"storage":"d1"}
```

判断标准：**有 `"storage":"d1"` 字段** = 新版（旧版只有 `ok` 和 `ts`）。

- 显示 `"storage":"r2+d1"` 也对，意思是检测到 R2 绑定。
- 出现 `{"error":"server_error","message":"服务暂时不可用：..."}` → 看第 14 节，通常是 `database_id` 没填对。

### 检查点 2：访客端打不开或一直转圈

打开首页 `/`，应该立刻看到聊天框、顶部有「在线客服」、自动出现一条欢迎语。如果一直显示「正在连接客服…」，说明第一步建会话的接口失败了，看第 14 节。

### 检查点 3：客服端登录框

打开 `/agent`，登录框里应该有**两个输入框**：上面「客服名称」，下面「客服口令」，并且有一句提示"第一次登录时，你输入的口令会自动成为系统口令"。

如果只有一个口令框，说明部署的还是旧版，回 GitHub 确认文件是否覆盖成功，再 Retry 一次部署。

---

## 10. 第七步：设置客服口令并开始使用

1. 打开 `https://你的地址/agent`
2. **客服名称**：填你想对外显示的名字，例如 `小旗`
3. **客服口令**：设一个 ≥ 4 位的口令，例如 `kefu2026`（**这一次输入的值就是系统口令**，以后所有客服都用它登录）
4. 点「进入工作台」

进去后左下角有 **设置**，可以马上改：

| 设置项 | 作用 |
|---|---|
| 店铺名称 | 访客端顶部显示的名字 |
| 我的客服名称 | 你回复消息时显示的名字（完整名称显示在对方消息上方，改完新消息就用新名字） |
| 客服头像 | 「我的客服名称」下方可上传正方形图片作为头像；不上传时用名称首字圆框代替；可随时清除 |
| 自动欢迎语开关 | 新访客第一次进来是否自动发一条 |
| 欢迎语内容 | 那条消息的文字 |
| 欢迎语署名 | 欢迎语显示是谁发的（默认「客服」） |
| 修改口令 | 换一个新口令，留空表示不改 |

最后把访客端地址（`https://你的地址/`，不带 `/agent`）发给顾客即可。同一个手机/电脑再打开会继续原来的会话，聊天记录都在。

---

## 11. 第八步：12 项功能自检清单

用两个窗口（或一台电脑 + 一部手机）对着点一遍，全部打勾就是完整可用：

| # | 要验证的事 | 怎么做 | 应该看到 |
|---|---|---|---|
| 1 | 前台免登录对话 | 访客端直接打开 | 立刻出现聊天框 + 欢迎语 |
| 2 | 后台口令登录 | `/agent` 输入名称+口令 | 进入工作台，会话列表出现该访客 |
| 3 | 实时聊天（访客→客服） | 访客发一句话，**不刷新**看客服端 | 2 秒左右客服端自动出现这条 |
| 4 | 实时聊天（客服→访客） | 客服回复，**不刷新**看访客端 | 2 秒左右访客端自动出现 |
| 5 | 发图片 | 访客点输入框左边图片按钮选图 | 双方都看到图片，点图可全屏 |
| 6 | 发表情 | 点笑脸按钮，选一个表情发送 | 双方都看到表情（纯表情会放大显示） |
| 7 | 已读/未读 | 客服打开该会话后看访客端自己那条消息 | 消息下方从「未读」变「已读」 |
| 8 | 撤回 | 访客 2 分钟内长按/点消息右侧「⋯」→ 撤回 | 双方都变成"撤回了一条消息" |
| 9 | 删除 | 点「⋯」→ 删除 | 只有操作的那一方看不到，另一边还在 |
| 10 | 备注顾客 | 客服点会话右上角铅笔，填"张先生-询价" | 会话列表显示备注名 + 「备注」小标签 |
| 11 | 修改客服名称 / 头像 | 设置里改成别的名字、或上传头像并保存，再发一条 | 访客端这条消息上方显示完整新名字，左侧头像为新头像或新名字首字 |
| 12 | 未读角标 | 让第二个访客（换浏览器或无痕窗口）发一句 | 客服会话列表出现红色数字角标 |
| 13 | 存储用量面板 | 客服端点「设置」 | 底部「存储用量」显示 已用/共 5.0 GB/剩余 + 还能发多少条 + 自动清理天数输入框 |

补充两项体验检查：

- 关掉客服页面再打开 → 仍是登录状态（不用重新输口令）
- 手机打开客服端 → 先看到会话列表，点某个会话才进入聊天，左上角有返回箭头

---

## 12. 第九步：绑定自己的域名（可选）

前提：你的域名已经托管在 Cloudflare（NS 指向 Cloudflare）。

1. Workers & Pages → 选中 `cf-kefu-chat` → **Settings**
2. 找 **Domains & Routes / 域名和路由** → **Add Custom Domain / 添加自定义域**
3. 输入域名，例如 `kefu.你的域名.com`（或直接用根域名 `你的域名.com`）
4. 保存，Cloudflare 会自动配好记录（几分钟生效，证书自动签发）

之后：

- `https://kefu.你的域名.com/` 访客端
- `https://kefu.你的域名.com/agent` 客服端

> 一个域名只能挂一个 Worker。别在多个 Worker 上绑同一个域名，会冲突。

---

## 13. 日常维护：改设置、改口令、看日志、备份

### 13.1 改店铺名 / 欢迎语 / 客服名 / 口令

全部在「客服工作台 → 设置」里改，点保存后立即生效，**不用重新部署**。

### 13.2 忘记口令了怎么办（不用重新部署）

1. Cloudflare → Storage & Databases → D1 → 选中 `cf_kefu`
2. 点 **Console / 控制台**（有的界面在库详情页上方，叫 "Execute SQL" 或 "Query"）
3. 执行下面两句（逐条执行，或一起执行）：

```sql
DELETE FROM settings WHERE key = 'passcode_hash';
DELETE FROM agents;
```

4. 重新打开 `/agent`，再输入一次名称 + 口令，就等于重新设置了系统口令。**旧会话和聊天记录都还在。**

> 原理：系统里只存了口令的哈希，删掉它以后，下一次登录输入的口令就会被当作新口令写进去。

### 13.3 看运行日志（排查 500 用）

Worker 详情页 → **Logs / 日志**（本项目已在 `wrangler.toml` 里开了 `[observability]`）。打开后访问一下出问题的页面，日志里会打印具体错误（比如 `D1 未绑定`）。

### 13.4 备份聊天数据

D1 库详情页 → **Console** 执行：

```sql
SELECT id, conv_id, sender, sender_name, type, body, created_at FROM messages ORDER BY id;
```

结果可以全选复制出来存成表格。想做完整备份可以用 Cloudflare 的 D1 导出（库详情页有 Export 入口，或按官方文档操作）。

### 13.5 清空所有聊天记录（保留设置和口令）

```sql
DELETE FROM messages;
DELETE FROM conversations;
DELETE FROM files;
```

### 13.6 改撤回时限 / 图片大小上限

GitHub 打开 `wrangler.toml`，改这两行（单位：秒 / MB），提交后等待自动部署：

```toml
MAX_IMAGE_MB = "5"
RECALL_WINDOW_SEC = "120"
```

### 13.7 看存储用量 / 能发多少条 / 自动清理

这一版后台自带用量面板，**不用写 SQL 就能看**：

1. 打开 `/agent` → 左下角 **设置**
2. 弹窗最下面「存储用量」一节会显示：
   - `已用 4.4 KB / 共 5.0 GB（0%）· 剩余 5.0 GB`
   - 会话几个、消息几条、图片几张
   - 「按当前平均估算，还能发约 X 条文字，或约 Y 张图片」
   - 进度条：用量占比（超过 70% 就该考虑清理或开 R2）
3. 同一节里有「自动清理：只保留最近多少天（0 = 关闭）」
   - 填 `90` 表示只保留 90 天内的消息，更早的自动删除
   - 自动清理在后台打开设置页时检查，**最多每 6 小时执行一次**，不会频繁删数据
   - 保存设置后生效；填 0 就是关闭自动清理
4. 「立即清理」按钮：按当前填的天数马上删一次（会弹确认框，删了不能恢复）

**想手动看更细的数字**（D1 控制台 → 你的库 → Console，逐条执行）：

```sql
-- 消息总数
SELECT COUNT(*) AS 消息数 FROM messages;
-- 会话总数
SELECT COUNT(*) AS 会话数 FROM conversations;
-- 图片数量与总大小
SELECT COUNT(*) AS 图片数, SUM(file_size) AS 总字节 FROM messages WHERE type <> 'text';
-- 存在 D1 里的图片数据大小（没开 R2 时才有）
SELECT COUNT(*) AS 图片文件数, SUM(size) AS 占用字节 FROM files;
-- 最早和最新的消息时间
SELECT MIN(datetime(created_at/1000,'unixepoch')) AS 最早, MAX(datetime(created_at/1000,'unixepoch')) AS 最新 FROM messages;
```

Cloudflare 的 D1 库详情页也会显示这张库的总大小（不同界面入口略有差异，控制台 SQL 是最准的）。

**容量换算参考**（5GB = 5,368,709,120 字节）：

| 内容 | 单条占用 | 5GB 大约能放 |
|---|---|---|
| 纯文字消息 | 约 300～400 字节（含每行固定开销） | 约 1300 万～1800 万条 |
| 图片（存 D1，前端压缩到 400KB 左右） | 约 380～400 KB | 约 1.2 万～1.3 万张 |
| 图片（开了 R2） | 不占 D1 | 只受 R2 免费 10GB 限制 |

> 实际用不到这个量级：按每天 200 条消息算，文字要 100 多年才写满 5GB；图片是主要消耗项。

---

### 13.8 访客 IP / 归属地 / 来源网站

访客一打开聊天页，系统就会把 Cloudflare 边缘自带的访客信息记进这个会话里，**不用装统计插件，也不用第三方接口**：

- 访客 IP（`CF-Connecting-IP`）
- 归属地：国家 + 省份 + 城市（免费版只能到城市，街道级拿不到）
- 来源网站：来自哪个页面（直接打开就是本站地址；从别的网站嵌入进来会记对方的网址）

在哪里看：

1. 后台左侧会话列表，每行的访客名下面多了一行小字：`中国 江苏省 南京市`
2. 点开某个会话，标题栏下面多一条浅色信息条：`IP：1.2.3.4 · 位置：中国 江苏省 南京市 · 来源：https://你的网站页 · 联系：微信 xxx`

两条注意：

- **代理 / VPN / 苹果隐私中继的访客，位置会不准**，这是 IP 定位的固有误差，不是系统坏了
- IP 和位置属于个人信息，对外使用时建议在访客端顺手加一句隐私提示；自动清理删会话时，这些信息跟着会话一起删

### 13.9 关键词自动回复（在线 / 离线两套）

后台「设置」→「关键词自动回复」一节，**两套规则已经预置好，部署完就能用**：

| 状态 | 什么时候生效 | 预置内容 |
|---|---|---|
| 在线自动回复 | 接待状态为「在线」时 | 你好 / 您好 / 在吗 / 价格 / 多少钱 / 售后 各一条 |
| 离线自动回复 | 接待状态为「离线」时 | 在吗 / 你好 / 价格 / 售后 各一条（文案是"客服不在线，请留言"） |

怎么写规则：

- 一行一条，格式是 **`关键词=回复内容`**
- 匹配方式是「包含匹配」：访客发的话里带这个词就触发（不区分大小写）
- 从上往下匹配，**命中第一条就停**，不会连发一串
- 只有访客发的文字消息会触发；客服自己发的不触发；一条消息最多回一条

切换在线 / 离线：后台左下角有个「在线 / 离线」按钮，点一下立刻切换（不用关页面），状态会写进设置，手机电脑都一样。

自动回复发出的消息，聊天里会带一个「自动回复」小标签，方便你知道这条不是真人回的。

### 13.10 新消息提示音（可调次数、可自定义铃声）

后台「设置」→「新消息提示音」区：

| 项 | 说明 |
|---|---|
| 提示音开关 | 关掉完全不响 |
| **响铃次数** | 1～5 次，默认 3 次。每一轮是"叮—咚—嗡"三音，约 1 秒，间隔 1.25 秒再响下一轮 |
| **试听** | 改完不保存也能当场听效果 |
| **上传自定义提示音** | 换成你喜欢的铃声（比如门店广播音），支持 MP3 / M4A / OGG / WAV / AAC，≤400KB |
| **恢复默认铃声** | 删掉自定义铃声，回到内置"叮咚" |

**关于"声音小、只响一声"**——这两点这版都改过：

1. 内置铃声从单声"叮"改成**三音叠加、音量提到 0.6、总长约 0.95 秒**，比原来的 0.35 秒长一倍多
2. 加了**响铃次数**（1～5），忙的时候设成 3～5 次，不会错过
3. 系统音量仍然是手机/电脑自己控制的上限，浏览器不能超过系统音量；嫌小就把设备媒体音量调大

**为什么有时还是不响**：浏览器规定页面必须先被点击过一次才允许播放声音。打开后台后随便点一下空白处即可；手机切到后台常被系统冻结，这种情况靠下面的推送。

**自定义铃声为什么限 400KB**：音频存在你自己账号的 D1 数据库里（不用另建 R2），文件大自然占空间，2～5 秒的小片段足够用。上传后旧铃声文件会自动删除，不占空间。

### 13.11 访客留联系方式（手机号 / 微信 / QQ / 邮箱）

后台「设置」→「允许访客留联系方式」，开启后访客端右上角出现「留联系方式」按钮，点开可以填手机号、微信号、QQ、邮箱，**四项都可以不填，填哪项算哪项**。

- 手机号、邮箱有格式校验，乱填会被拦下
- 提交成功后，后台会话顶部那条信息里出现：`联系：手机 138xxxx / 微信 xxx / QQ xxx / 邮箱 xxx`
- 联系方式和会话绑在一起，自动清理删会话时一起删
- 不想收集就关掉开关，访客端按钮会消失

访客端只有「仅用于客服联系，不会外泄」这句提示，你可以按自己情况改措辞（改 `public/index.html` 里 `contact-note` 那一行文字）。

### 13.12 消息推送通知（5 个渠道，可同时开）

后台「设置」→「消息推送通知」。**填哪个就推哪个，可以同时开多个**，一个渠道也只是多发一条，不影响聊天。

| 渠道 | 去哪拿地址 | 适合谁 |
|---|---|---|
| ① Server酱 | `sct.ftqq.com` 微信扫码登录，复制 SendKey | 有微信、想最快配好 |
| ② PushPlus | `pushplus.plus` 微信扫码登录，复制 token | 有微信、想要更细的推送设置 |
| ③ 钉钉群机器人 | 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址 | 团队用钉钉、要推到工作群 |
| ④ 企业微信群机器人 | 企业微信群 → 右上角 → 群机器人 → 添加 → 复制 Webhook 地址 | 团队用企微，客户消息进群 |
| ⑤ Bark | iPhone 装 Bark App，App 里显示 `https://api.day.app/你的Key` | 只用 iPhone、不装微信助手 |

配置步骤（以钉钉为例）：

1. 钉钉群里添加"自定义机器人"，安全设置选**自定义关键词**时，把关键词填成"访客"或"客服"（推送标题里含"访客"，不填对会被拒收）
2. 复制出来的 Webhook 地址（`https://oapi.dingtalk.com/robot/send?access_token=...`）粘到后台第 ③ 栏
3. 打开「开启推送」→ 保存
4. 用访客端发一句话，手机/群里应立刻收到

推送内容统一包含：访客 IP、归属地、来源网站、联系方式（如果访客填了）、消息正文前 300 字。

限制说明：

- 同一个会话 **5 秒内最多推一条**，防止刷屏
- 只推访客发的消息（文字/图片/表情），关键词自动回复和客服自己的消息不推
- 后台会校验地址域名，防止填成乱七八糟的链接把内容外发（钉钉必须是 `oapi.dingtalk.com`、企微必须是 `qyapi.weixin.qq.com`、Bark 必须是 `api.day.app`）
- 推送是**异步**的，发消息不会等推送结果，聊天不卡
- 推送失败只写一条 warn 日志，不影响聊天

### 13.13 导出聊天记录（CSV，Excel 可直接打开）

- **单个会话**：点开某个会话，标题栏右边「导出」按钮，直接下载 `聊天记录-<会话ID>.csv`
- **全部会话**：目前是逐个会话导（一次最多 100 个会话，每个会话最多 2000 条消息），需要全量就挨个导出

表格里有：会话 ID、顾客备注、会话创建时间、访客 IP、归属地、来源网站、联系方式、消息时间、发送方、内容类型、内容、是否自动回复、已读状态。

> CSV 用 Excel / WPS / 手机自带表格都能直接打开，中文不会乱码（文件带 BOM）。图片消息导出的是图片链接 `/api/file/xxx`，不是图片本身。

### 13.14 把客服窗口嵌到自己网站

资源包里带了 `public/embed.js`，两种用法，都**不需要改你自己网站的后端**。

**① 悬浮按钮（推荐）**——放到你网站所有页面（比如主题的 footer / 公共底部）：

```html
<script>
window.cfKefuConfig = {
  url: "https://你的worker域名.workers.dev",  // 换成你自己的访问地址，不要带结尾斜杠
  btnText: "在线客服",
  btnColor: "#ff4a1f",
  position: "right"                          // right 或 left
};
</script>
<script src="https://你的worker域名.workers.dev/embed.js"></script>
```

页面右下角会出现一个圆形气泡按钮，点击弹出聊天窗（手机上自动全屏宽度）。访客在弹窗里发的消息，和直接打开域名是同一套系统。

**② iframe 直接嵌**——适合单独做一个"联系客服"页面：

```html
<iframe src="https://你的worker域名.workers.dev/"
        style="width:100%;height:640px;border:0;border-radius:12px"></iframe>
```

两个提示：

- 嵌入进来的访客，后台会记「来源：你网站的那个页面地址」，方便区分是哪个站点来的
- 如果访客的浏览器禁用了第三方 Cookie / 存储（个别 Safari 设置），系统会自动退化为"每次打开是新会话"，聊天本身不受影响

## 14. 报错排查表（按提示文字对号入座）

| 你看到的提示 | 真实原因 | 怎么修 |
|---|---|---|
| `{"error":"server_error","message":"服务暂时不可用：D1 未绑定..."}` | `wrangler.toml` 里的 `database_id` 还是 `REPLACE_WITH...`，或填错 | 回 GitHub 改 `database_id`，提交后到 Deployments 点 Retry |
| `no such table` / `SQLITE_ERROR` | 数据库是新的，表还没建；或者 `database_id` 指向了别的空库 | 正常访问一次首页让它自动建表；若仍报错，确认填的 ID 和建的库是同一个 |
| 构建日志里 `Could not find wrangler.toml` | 文件传到了子文件夹，或 Root directory 设错 | 确认 `wrangler.toml` 在仓库根目录；Root directory 填 `/` |
| 构建日志里 `Authentication error` / `10000` | Cloudflare 与仓库授权失效 | Workers & Pages → 该 Worker → Settings → Build → 重新连接 GitHub |
| 页面白屏、按钮全无反应 | 部署的是旧版或文件没覆盖全 | 用第 9 节检查点 1、3 判断；回 GitHub 确认 `public/assets/chat.js` 是新的 |
| 一直显示「正在连接客服…」 | 接口 500（多半是 D1 没绑好） | 直接打开 `/api/health`，看返回的错误文字，按上面对应处理 |
| 登录时提示「口令不正确」 | 之前已经设过口令，现在输的不对 | 按 13.2 重置口令 |
| 登录时提示「口令至少 4 位」 | 口令太短 | 换成 4 位以上 |
| 发图片提示「图片过大」 | 单张图超过上限 | 没开 R2 时建议 700KB 以内（前端已自动压缩，一般没问题）；要发大图就启用 R2（见下） |
| 发图片提示「图片仍然偏大，请...开启 R2」 | 压缩后仍超过 D1 单行限制 | 换一张小图，或启用 R2 |
| 客服端打不开只有 404 | `/agent` 路由没生效（旧版） | 确认部署的是新版（检查点 3） |
| 两个人互相看不到消息 | 一方开着代理/浏览器缓存了旧页面 | 强刷（Ctrl+Shift+R / 手机清缓存），再观察 2 秒 |

### 想启用 R2 存大图（可选）

1. Cloudflare 左侧 → **R2** → **Create bucket**，名字 `cf-kefu-files`（R2 首次开通可能要求绑定付款方式，免费额度 10GB）
2. GitHub 打开 `wrangler.toml`，把这三行前面的 `#` 去掉：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "cf-kefu-files"
```

3. 提交，等自动部署。之后 `/api/health` 会显示 `"storage":"r2+d1"`，图片自动存 R2，单张可到 5MB。

---

## 15. 费用与免费额度

全部在免费计划内，不需要付费：

| 项目 | 免费额度（足够小店用） | 本项目消耗 |
|---|---|---|
| Workers | 每天 10 万次请求 | 访客端 + 客服端各每 2 秒 1 次：单页全天开着约 4.3 万次/天，两页同时开着约 8.6 万次/天（已接近上限） |
| D1 | 5GB 存储（整个账号共享）、每天 500 万行读取、**每天 10 万行写入** | 每条消息约写 2 行（消息 1 行 + 会话更新 1 行），每天约 3～5 万条消息到顶；聊天量正常时远低于上限 |
| Workers Builds | 每月有免费构建分钟 | 每次部署 1～3 分钟，改动次数不多完全够 |
| 静态资源 | 免费、不限流量 | — |
| 自定义域名 | 免费绑定 | — |

**真实的瓶颈不是 5GB，而是"每天 10 万行写入"和"每天 10 万次请求"**，这两个是按天重置的。所以省额度比省空间更重要：

- 客服不忙时把工作台标签页关掉（后台不轮询就不消耗）
- 想让常开更省一点：把 `public/assets/chat.js` 顶部 `POLL_VISIBLE = 2000` 改成 `3000`（单页降到约 2.9 万次/天）
- 页面切到后台时程序已自动降到 8 秒一次（`POLL_HIDDEN`），这部分不用你管

---

## 附录 A：用 GitHub Actions 部署（备选）

不想用 Workers Builds，也可以用仓库里自带的 `.github/workflows/deploy.yml`。但**必须传 `.github` 文件夹**，并且要配两个密钥：

1. Cloudflare 右上角头像 → **My Profile** → **API Tokens** → **Create Token** → 模板选 **Edit Cloudflare Workers** → 创建后复制 token
2. Cloudflare 首页右侧复制 **Account ID**
3. GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → 新建两个 Secret：
   - `CLOUDFLARE_API_TOKEN` = 第 1 步的 token
   - `CLOUDFLARE_ACCOUNT_ID` = 第 2 步的 Account ID
4. 仓库 → **Actions** 标签页 → 左边 `Deploy to Cloudflare Workers` → **Run workflow** → 选 `main` → 运行

运行完同样是这个 workers.dev 地址。**建议只用一种方式部署**（Builds 或 Actions），两种同时跑会互相触发、白耗额度。

---

## 附录 B：本地想先预览（需要命令行，可选）

只有想在自己电脑上先看效果时才需要，**线上部署完全用不到**：

```bash
npm install
npx wrangler d1 migrations apply cf_kefu --local
npx wrangler dev
```

打开 `http://127.0.0.1:8787` 是访客端，`http://127.0.0.1:8787/agent` 是客服端。

---

## 交付文件对照

| 文件/目录 | 作用 |
|---|---|
| `src/index.js` | 后端：所有接口、自动建表、图片存储（R2 没有就用 D1） |
| `public/index.html` | 访客端页面 |
| `public/agent.html` | 客服工作台（登录 / 设置 / 备注） |
| `public/assets/chat.js` | 两端共用聊天核心（轮询、表情、图片压缩、撤回、已读） |
| `public/assets/app.css` | 两端样式 |
| `wrangler.toml` | Cloudflare 配置（**唯一要手填 database_id 的地方**） |
| `migrations/*.sql` | 建表语句（仅供参考，程序会自动建表） |
| `package.json` | 依赖声明（`wrangler`） |
| `部署说明.md` | 简版部署说明 |
| `预览/*.png` | 各页面真实截图 |

改完代码在 GitHub 提交，Cloudflare 自动部署生效。整个系统只有 6 张表、没有第三方服务，换电脑、换手机都能用。
