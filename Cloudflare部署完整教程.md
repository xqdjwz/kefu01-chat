# Cloudflare 部署完整教程（Fork 方式 · v3.4）

本教程面向只在浏览器里操作、不用命令行的用户。全程零付费：Cloudflare 免费 Workers + 免费 D1 数据库。

## 第 0 步：准备账号
- 一个 GitHub 账号（免费注册：github.com）。
- 一个 Cloudflare 账号（免费注册：dash.cloudflare.com）。
- 想用 AI 自动回复时：一个大模型平台的 API Key（DeepSeek / 通义 / Kimi / 智谱任选，见第 7 节）。

## 第 1 步：Fork 项目到自己的 GitHub
1. 打开本项目的 GitHub 仓库页面。
2. 点页面右上角的 **Fork** 按钮。
3. 保持默认选项，点 **Create fork**。
4. 稍等片刻，你账号下就会得到一份和本项目完全相同的仓库，后面所有操作都在**你自己的这份 Fork** 里进行。

## 第 2 步：创建 D1 数据库
1. 登录 Cloudflare 控制台 → 左侧「Workers & Pages」→ 顶部「D1 SQL Database」→「Create」。
2. 数据库名填 `cf_kefu`，区域选默认（Automatic）→ 点 Create。
3. 建好后进入数据库页，复制顶部的 **Database ID**（一长串），下一步要填。

> 不需要自己建表：Worker 首次运行会自动建表、自动补列。

## 第 3 步：在自己的 Fork 里填入 Database ID
1. 打开你 GitHub 上 Fork 的仓库，找到根目录的 `wrangler.toml`，点进去。
2. 右上角点铅笔图标（Edit file），把这一行里的占位符替换成第 2 步复制的 Database ID：

```toml
database_id = "填写你的Database_ID"
```

3. 右上角点 **Commit changes** 保存。

## 第 4 步：连接 Fork 并自动部署
1. 回到 Cloudflare 控制台 →「Workers & Pages」→「Create application」→「Workers Builds」→「Import a repository」。
2. 首次使用按提示授权 Cloudflare 访问你的 GitHub，勾选你 Fork 的这份仓库并安装。
3. 选中该仓库后按提示创建：构建命令留空（项目自带 `wrangler.toml`，会自动识别部署）。
4. 点 **Deploy**，等待构建完成（一两分钟）。之后你在 GitHub 上的每次提交都会自动重新部署，无需手动操作。

## 第 5 步：访问与首次登录
1. 部署完成后，Worker 会分配一个 `https://cf-kefu-chat.你的子域.workers.dev` 地址。
2. 打开 `/agent.html`（如 `https://xxx.workers.dev/agent.html`），首次登录输入的口令会直接设为系统口令，**请牢记**。
3. 打开 `/` 即访客聊天页，可直接发给客户测试。

## 第 6 步：基础设置（后台 ⚙ 设置）
- **店铺名称 / 客服名称**：显示在访客页头部。
- **欢迎语**：访客首次进入自动发送。
- **关键词自动回复**：在线 / 离线两套，命中即自动回。
- **五渠道推送**：Server酱、PushPlus、钉钉、企微、Bark 的 Key / Webhook 填入后，新访客消息推送到你手机。
- **提示音**：新消息响铃，可选重复、可上传自定义提示音。
- **联系方式**：显示在访客页供客户填写。

## 第 7 步：AI 托管配置（可选，v3.4 新增）
1. 后台 ⚙ 设置 → 找到「AI 托管智能回复」区，勾选「启用 AI 自动回复」。
2. **API 地址**：默认 DeepSeek `https://api.deepseek.com/chat/completions`。
3. **API Key**：去对应平台申请：
   - **DeepSeek**：platform.deepseek.com → 注册 →「API Keys」→ 创建，复制 `sk-` 开头的 Key（新用户有免费额度）。
   - **通义千问**：dashscope.aliyun.com → 百炼 → API-KEY，地址 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，模型 `qwen-turbo`。
   - **Kimi**：platform.moonshot.cn → API Key，地址 `https://api.moonshot.cn/v1/chat/completions`，模型 `moonshot-v1-8k`。
   - **智谱 GLM**：open.bigmodel.cn，地址 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，模型 `glm-4-flash`（免费）。
4. **模型名**：填平台要求的模型 ID（默认 `deepseek-chat`）。
5. **系统提示词**：告诉 AI 你的店铺话术风格，默认"你是本店客服，热情简洁回答，不知道就说稍后人工回复"。
6. **上下文轮数**：默认 6（带最近 6 轮对话记忆），1-20 可调。
7. 点「测试回复」，发一句"你好"，看到 AI 回复即配置成功 → 保存设置。

> 安全说明：API Key 只保存在你自己的 D1 里，绝不下发给访客；AI 失败 / 超时（8 秒）会静默回退人工，不会把报错甩给客户。

## 第 8 步：把客服挂到自己网站（embed.js）
在你网站页面 `</body>` 前加一行：

```html
<script src="https://你的Worker域名/embed.js"></script>
```

页面右下角会出现悬浮客服按钮，点击即可打开聊天窗口。

## 第 9 步：v3.4 新功能怎么用
### 9.1 同客户归并
- 同一客户换浏览器 / 换设备再来，出口 IP 相同，列表出现「同IP×2」徽标。
- 点该会话的「合并为同一客户」→ 确认，两个会话折叠为一个客户组（客户组×2），后续在同一组里跟进，不重复接待。
- 点「拆分取消合并」可还原。

### 9.2 结束对话 / 重新打开
- 会话顶栏点「结束对话」：访客看到结束文案，输入框变灰；客服不再被打扰。
- 需要继续时点「重新打开」。设置里可开「结束后允许重新发起」，客户再发消息自动重开。

### 9.3 视频 / 语音链接
- 顶栏点「📹 视频/语音」→ 填会议标题和链接（腾讯会议、微信视频号、电话、二维码页都行）→ 发送，访客收到卡片，点一下新标签打开。
- 注意：这是外部会议链接入口，免费 Workers 不能跑平台内视频通话。

## 常见问题 FAQ
**Q：部署后打开 500？** 检查 `wrangler.toml` 里的 Database ID 是否填对、D1 库是否已创建。
**Q：访客发消息客服手机不响？** 检查推送渠道 Key / Webhook 是否填对、是否已保存；AI / 自动回复接管的消息不推送（设计如此）。
**Q：AI 不回复？** 先点「测试回复」看报错；多半是 Key 错、地址错、模型名错或余额不足；未配置时保持人工，不影响使用。
**Q：同IP徽标没出现？** 本地测试无真实 IP；两个会话必须来自同一出口 IP 且都未合并。
**Q：之后更新代码怎么办？** 在你自己的 Fork 仓库里修改并提交，Workers Builds 会自动重新部署，数据库和设置都保留在 D1 里，不会丢。
