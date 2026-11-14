/**
 * 在线客服聊天 · Cloudflare Workers + D1（图片可选 R2）
 *
 * 设计要点：
 * 1. 第一次请求时自动建表、自动写默认设置 —— 不需要在终端跑任何数据库命令；
 * 2. 客服口令、客服名称、店铺名称、欢迎语都存在 D1 里 —— 部署后在网页上就能改；
 * 3. 图片优先存 R2；没有配置 R2 时自动存进 D1（小于 700KB 的图都能正常收发）。
 *
 * 接口一览：
 *   GET  /api/health
 *   POST /api/session                 访客建立/恢复会话
 *   POST /api/login                   客服登录（名称 + 口令；首次口令即初始化）
 *   GET  /api/me                      当前客服信息
 *   POST /api/agent/profile           修改客服名称
 *   GET  /api/settings                读取设置
 *   POST /api/settings                修改设置（店铺名 / 欢迎语 / 口令）
 *   GET  /api/conversations           会话列表（含未读、在线、备注）
 *   POST /api/conversations/:id/remark 备注顾客
 *   GET  /api/messages                拉消息（after 增量 / since 状态变化）
 *   POST /api/messages                发消息
 *   POST /api/messages/:id/recall     撤回
 *   POST /api/messages/:id/delete     删除（只对自己隐藏）
 *   POST /api/upload                  上传图片
 *   GET  /api/file/:key               读图片
 *   POST /api/read                    标记已读
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const AUDIO_TYPES = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
};

const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const MAX_TEXT_LEN = 1000;
// D1 单行数据有体积上限，没配 R2 时用它兜底存图
const D1_MAX_FILE_BYTES = 700 * 1024;

// 免费额度口径（用于后台显示百分比，不是硬编码限制）
const D1_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const ROW_OVERHEAD_BYTES = 120; // 每行索引与元数据的估算开销

// 默认值优先取 wrangler.toml 的 [vars]，取不到再用兜底文案
// 预置关键词（后台可改可删）：包含匹配、不区分大小写
const DEFAULT_KEYWORDS = [
  { k: '你好', r: '您好😊，欢迎咨询！请问有什么可以帮您？' },
  { k: '您好', r: '您好😊，欢迎咨询！请问有什么可以帮您？' },
  { k: '在吗', r: '我在的，请直接说明您的问题，我马上回复您~' },
  { k: '价格', r: '方便说下您要咨询的项目吗？我给你详细报价~' },
  { k: '多少钱', r: '方便说下您要咨询的项目吗？我给你详细报价~' },
  { k: '售后', r: '麻烦描述一下遇到的问题，最好附带截图或订单号，我这边帮你处理。' },
];

const DEFAULT_OFFLINE_KEYWORDS = [
  { k: '在吗', r: '您好，当前客服不在线⏰，您可以直接留言，上线后第一时间回复您！' },
  { k: '你好', r: '您好😊，客服暂未上线，请留下您的问题，我们看到后会联系您。' },
  { k: '价格', r: '客服暂时离线，报价信息请留言，上线后单独发给您。' },
  { k: '售后', r: '当前无客服在线，麻烦留下订单号，上线后优先处理售后。' },
];

const baseSettings = (env) => ({
  shop_name: (env && env.SHOP_NAME) || '在线客服',
  welcome_enabled: '1',
  welcome_text: (env && env.WELCOME_MESSAGE) || '您好！欢迎光临，请问有什么可以帮您？',
  welcome_from: (env && env.AGENT_NAME) || '客服',
  passcode_hash: '',
  auto_clean_days: '0',
  last_clean_at: '0',
  agent_avatar_key: '',
  agent_online: '1',
  auto_reply_enabled: '1',
  offline_reply_enabled: '1',
  keywords: JSON.stringify(DEFAULT_KEYWORDS),
  offline_keywords: JSON.stringify(DEFAULT_OFFLINE_KEYWORDS),
  sound_enabled: '1',
  contact_enabled: '1',
  contact_prompt: '需要的话可以留下联系方式，方便我们主动联系您',
  wechat_push_enabled: '0',
  wechat_sendkey: '',
  pushplus_token: '',
  dingtalk_webhook: '',
  wecom_webhook: '',
  bark_url: '',
  sound_repeat: '3',
  sound_key: '',
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const fail = (message, status = 400, code = 'bad_request') => json({ error: code, message }, status);

const now = () => Date.now();

const uid = (len = 32) => {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(len / 2)));
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out.slice(0, len);
};

const sha256 = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const base64ToBytes = (b64) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
};

const bytesToBase64 = (buffer) => {
  const arr = new Uint8Array(buffer);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(bin);
};

/* ------------------------------- 自动建表 ------------------------------- */

let schemaReady = false;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     visitor_token TEXT NOT NULL UNIQUE,
     visitor_name TEXT,
     remark TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_message_at INTEGER,
     last_preview TEXT,
     visitor_last_read_at INTEGER NOT NULL DEFAULT 0,
     agent_last_read_at INTEGER NOT NULL DEFAULT 0,
     visitor_seen_at INTEGER NOT NULL DEFAULT 0,
     agent_seen_at INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     conv_id TEXT NOT NULL,
     sender TEXT NOT NULL,
     sender_name TEXT,
     type TEXT NOT NULL DEFAULT 'text',
     body TEXT,
     file_key TEXT,
     file_size INTEGER,
     status TEXT NOT NULL DEFAULT 'active',
     deleted_visitor INTEGER NOT NULL DEFAULT 0,
     deleted_agent INTEGER NOT NULL DEFAULT 0,
     read_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS agents (
     token TEXT PRIMARY KEY,
     name TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS files (
     id TEXT PRIMARY KEY,
     mime TEXT,
     size INTEGER,
     data TEXT,
     created_at INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_msg_upd ON messages(conv_id, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(conv_id, sender, read_at)',
];

// 老版本升级过来的库可能缺列，逐条补，已经存在就跳过
const ALTERS = [
  'ALTER TABLE conversations ADD COLUMN remark TEXT',
  'ALTER TABLE conversations ADD COLUMN visitor_seen_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE conversations ADD COLUMN agent_seen_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE conversations ADD COLUMN geo_ip TEXT',
  'ALTER TABLE conversations ADD COLUMN geo_location TEXT',
  'ALTER TABLE conversations ADD COLUMN geo_referer TEXT',
  'ALTER TABLE conversations ADD COLUMN contact TEXT',
  'ALTER TABLE messages ADD COLUMN auto_reply INTEGER NOT NULL DEFAULT 0',
];

async function ensureSchema(env) {
  if (schemaReady) return;
  const db = env.DB;
  if (!db) throw new Error('D1 未绑定：请在 wrangler.toml 的 [[d1_databases]] 里填好 database_id');

  for (const sql of TABLES) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      // "already exists" 之类的报错直接忽略
      console.warn('schema:', String(e && e.message));
    }
  }
  for (const sql of ALTERS) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* 列已存在 */
    }
  }
  for (const [key, value] of Object.entries(baseSettings(env))) {
    try {
      await db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
    } catch (e) {
      console.warn('seed settings:', String(e && e.message));
    }
  }
  schemaReady = true;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = { ...baseSettings(env) };
  for (const row of results || []) out[row.key] = row.value;
  return out;
}

async function setSettings(env, patch) {
  for (const [key, value] of Object.entries(patch)) {
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
      .bind(key, String(value))
      .run();
  }
}

/* --------------------------------- 入口 --------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        await ensureSchema(env);
        return await handleApi(request, env, url, ctx);
      } catch (e) {
        console.error('api error', e && e.stack ? e.stack : e);
        return fail(`服务暂时不可用：${(e && e.message) || '未知错误'}`, 500, 'server_error');
      }
    }

    return serveAsset(request, env, url);
  },
};

/* -------------------------------- 静态资源 -------------------------------- */

async function serveAsset(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!env.ASSETS) {
    return new Response('静态资源未绑定：请保留 wrangler.toml 中的 [assets] 配置', { status: 500 });
  }

  let path = url.pathname;
  if (path === '/' || path === '') path = '/index.html';
  else if (path === '/agent' || path === '/agent/') path = '/agent.html';

  const target = new Request(new URL(path + url.search, url.origin).toString(), request);
  const res = await env.ASSETS.fetch(target);

  if (!res) return new Response('Not Found', { status: 404 });

  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  if (path.endsWith('.html') || path === '/') headers.set('cache-control', 'no-cache');
  return new Response(res.body, { status: res.status, headers });
}

/* -------------------------------- 身份识别 -------------------------------- */

async function identify(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const row = await env.DB.prepare('SELECT token, name FROM agents WHERE token = ?').bind(token).first();
      if (row) return { role: 'agent', token, name: row.name || '客服' };
    }
  }

  const vt = (request.headers.get('x-visitor-token') || '').trim();
  if (vt) {
    const conv = await env.DB.prepare(
      'SELECT id, visitor_token, visitor_name, remark FROM conversations WHERE visitor_token = ?'
    )
      .bind(vt)
      .first();
    if (conv) {
      return {
        role: 'visitor',
        token: vt,
        convId: conv.id,
        name: conv.visitor_name || '访客',
        remark: conv.remark || '',
      };
    }
  }
  return null;
}

async function resolveConvId(request, ident, url, body) {
  if (!ident) return null;
  const asked = (body && (body.conv || body.convId)) || url.searchParams.get('conv') || null;
  // 访客不传会话就用自己那条；传了别的会话号交给调用方做 403 判断
  if (ident.role === 'visitor') return asked || ident.convId;
  return asked;
}

/* --------------------------------- 路由 --------------------------------- */

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') {
    return json({
      ok: true,
      ts: now(),
      version: 'v3-2026-11-14',
      features: ['avatar', 'geo', 'autoReply', 'sound', 'customSound', 'contact', 'pushMulti', 'export', 'embed'],
      storage: env.BUCKET ? 'r2+d1' : 'd1',
    });
  }

  if (path === '/api/login' && method === 'POST') return handleLogin(request, env);

  if (path === '/api/me' && method === 'GET') {
    const ident = await identify(request, env);
    if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');
    const s = await getSettings(env);
    return json({ name: ident.name, shopName: s.shop_name, ...publicSettings(s) });
  }

  if (path === '/api/agent/profile' && method === 'POST') return handleAgentProfile(request, env);

  if (path === '/api/settings' && method === 'GET') return handleGetSettings(request, env);
  if (path === '/api/settings' && method === 'POST') return handleSaveSettings(request, env);

  if (path === '/api/stats' && method === 'GET') return handleStats(request, env);
  if (path === '/api/cleanup' && method === 'POST') return handleCleanup(request, env);

  if (path === '/api/session' && method === 'POST') return handleSession(request, env);

  if (path === '/api/conversations' && method === 'GET') {
    const ident = await identify(request, env);
    if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');
    return handleConversationList(env);
  }

  if (path === '/api/messages' && method === 'GET') return handleListMessages(request, env, url);
  if (path === '/api/messages' && method === 'POST') return handleSendMessage(request, env, url, ctx);

  const msgAction = path.match(/^\/api\/messages\/(\d+)\/(recall|delete)$/);
  if (msgAction && method === 'POST') return handleMessageAction(request, env, Number(msgAction[1]), msgAction[2]);

  const remarkMatch = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/remark$/);
  if (remarkMatch && method === 'POST') return handleRemark(request, env, remarkMatch[1]);

  // 兼容旧接口名
  const renameMatch = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/rename$/);
  if (renameMatch && method === 'POST') return handleRemark(request, env, renameMatch[1]);

  if (path === '/api/upload' && method === 'POST') return handleUpload(request, env, url, ctx);
  if (path === '/api/avatar/agent' && method === 'GET') return handleAgentAvatar(env);
  if (path === '/api/avatar' && method === 'POST') return handleAvatar(request, env);
  if (path === '/api/avatar/clear' && method === 'POST') return handleAvatarClear(request, env);
  if (path === '/api/sound' && method === 'POST') return handleSoundUpload(request, env);
  if (path.startsWith('/api/file/') && method === 'GET') return handleFile(env, path.slice('/api/file/'.length));

  if (path === '/api/read' && method === 'POST') return handleRead(request, env, url);

  if (path === '/api/contact' && method === 'POST') return handleContact(request, env);
  if (path === '/api/export' && method === 'GET') return handleExport(request, env, url);

  return fail('接口不存在', 404, 'not_found');
}

async function safeBody(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

const publicSettings = (s) => ({
  shopName: s.shop_name || '在线客服',
  welcomeEnabled: s.welcome_enabled === '1',
  welcomeText: s.welcome_text || '',
  welcomeFrom: s.welcome_from || '客服',
  agentAvatarUrl: s.agent_avatar_key ? '/api/file/' + s.agent_avatar_key : '',
  contactEnabled: s.contact_enabled === '1',
  contactPrompt: s.contact_prompt || '需要的话可以留下联系方式，方便我们主动联系您',
});

/* --------------------------------- 登录 --------------------------------- */

async function handleLogin(request, env) {
  const body = await safeBody(request);
  const passcode = String(body.passcode || body.token || '').trim();
  const name = String(body.name || '').trim().slice(0, 16);

  if (passcode.length < 4) return fail('口令至少 4 位', 400, 'weak_passcode');
  if (passcode.length > 64) return fail('口令太长', 400, 'passcode_too_long');

  const s = await getSettings(env);
  const hash = await sha256(passcode);
  let firstTime = false;

  if (!s.passcode_hash) {
    // 第一次登录：把这次输入的口令设为系统口令，不用去 Cloudflare 后台配密钥
    await setSettings(env, { passcode_hash: hash });
    firstTime = true;
  } else if (s.passcode_hash !== hash) {
    return fail('口令不正确', 401, 'unauthorized');
  }

  const agentName = name || '客服';
  const token = uid(40);
  await env.DB.prepare('INSERT INTO agents (token, name, created_at) VALUES (?, ?, ?)')
    .bind(token, agentName, now())
    .run();

  return json({
    ok: true,
    token,
    name: agentName,
    firstTime,
    ...publicSettings(s),
  });
}

async function handleAgentProfile(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const name = String(body.name || '').trim().slice(0, 16);
  if (!name) return fail('客服名称不能为空', 400, 'empty');

  await env.DB.prepare('UPDATE agents SET name = ? WHERE token = ?').bind(name, ident.token).run();
  return json({ ok: true, name });
}

/* --------------------------------- 设置 --------------------------------- */

async function handleGetSettings(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');
  const s = await getSettings(env);
  return json({
    ...publicSettings(s),
    agentName: ident.name,
    passcodeSet: !!s.passcode_hash,
    recallWindow: Number(env.RECALL_WINDOW_SEC || 120),
    imageStorage: env.BUCKET ? 'R2 + D1' : 'D1',
    autoCleanDays: Number(s.auto_clean_days) || 0,
    agentOnline: s.agent_online === '1',
    autoReplyEnabled: s.auto_reply_enabled === '1',
    offlineReplyEnabled: s.offline_reply_enabled === '1',
    keywords: parseRules(s.keywords),
    offlineKeywords: parseRules(s.offline_keywords),
    soundEnabled: s.sound_enabled === '1',
    wechatPushEnabled: s.wechat_push_enabled === '1',
    wechatSendKey: s.wechat_sendkey || '',
    pushplusToken: s.pushplus_token || '',
    dingtalkWebhook: s.dingtalk_webhook || '',
    wecomWebhook: s.wecom_webhook || '',
    barkUrl: s.bark_url || '',
    soundRepeat: Number(s.sound_repeat) || 3,
    soundUrl: s.sound_key ? '/api/file/' + s.sound_key : '',
  });
}

async function handleSaveSettings(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const patch = {};

  if (body.shopName !== undefined) {
    const v = String(body.shopName).trim().slice(0, 24);
    if (!v) return fail('店铺名称不能为空', 400, 'empty');
    patch.shop_name = v;
  }
  if (body.welcomeText !== undefined) patch.welcome_text = String(body.welcomeText).slice(0, 500);
  if (body.welcomeEnabled !== undefined) patch.welcome_enabled = body.welcomeEnabled ? '1' : '0';
  if (body.welcomeFrom !== undefined) {
    const v = String(body.welcomeFrom).trim().slice(0, 16);
    patch.welcome_from = v || '客服';
  }
  if (body.newPasscode !== undefined && String(body.newPasscode).trim()) {
    const v = String(body.newPasscode).trim();
    if (v.length < 4) return fail('新口令至少 4 位', 400, 'weak_passcode');
    patch.passcode_hash = await sha256(v);
  }
  if (body.agentName !== undefined) {
    const v = String(body.agentName).trim().slice(0, 16);
    if (!v) return fail('客服名称不能为空', 400, 'empty');
    await env.DB.prepare('UPDATE agents SET name = ? WHERE token = ?').bind(v, ident.token).run();
    ident.name = v;
  }
  if (body.autoCleanDays !== undefined) {
    const n = Math.floor(Number(body.autoCleanDays));
    if (!Number.isFinite(n) || n < 0 || n > 3650) return fail('自动清理天数需在 0～3650 之间', 400, 'bad_range');
    patch.auto_clean_days = String(n);
  }
  if (body.agentOnline !== undefined) patch.agent_online = body.agentOnline ? '1' : '0';
  if (body.autoReplyEnabled !== undefined) patch.auto_reply_enabled = body.autoReplyEnabled ? '1' : '0';
  if (body.offlineReplyEnabled !== undefined) patch.offline_reply_enabled = body.offlineReplyEnabled ? '1' : '0';
  if (body.soundEnabled !== undefined) patch.sound_enabled = body.soundEnabled ? '1' : '0';
  if (body.contactEnabled !== undefined) patch.contact_enabled = body.contactEnabled ? '1' : '0';
  if (body.wechatPushEnabled !== undefined) patch.wechat_push_enabled = body.wechatPushEnabled ? '1' : '0';
  if (body.wechatSendKey !== undefined) {
    const v = String(body.wechatSendKey).trim().slice(0, 60);
    if (v && !/^[A-Za-z0-9_-]{6,60}$/.test(v)) return fail('SendKey 格式不正确（应为一串字母数字）', 400, 'bad_sendkey');
    patch.wechat_sendkey = v;
  }
  const urlOk = (v, prefix) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && (!prefix || v.includes(prefix));
    } catch {
      return false;
    }
  };
  if (body.pushplusToken !== undefined) {
    const v = String(body.pushplusToken).trim().slice(0, 60);
    if (v && !/^[A-Za-z0-9]{6,60}$/.test(v)) return fail('PushPlus token 格式不正确', 400, 'bad_pushplus');
    patch.pushplus_token = v;
  }
  if (body.dingtalkWebhook !== undefined) {
    const v = String(body.dingtalkWebhook).trim().slice(0, 300);
    if (!urlOk(v, 'oapi.dingtalk.com')) return fail('钉钉机器人地址不对（应为 https://oapi.dingtalk.com/robot/send?access_token=...）', 400, 'bad_dingtalk');
    patch.dingtalk_webhook = v;
  }
  if (body.wecomWebhook !== undefined) {
    const v = String(body.wecomWebhook).trim().slice(0, 300);
    if (!urlOk(v, 'qyapi.weixin.qq.com')) return fail('企业微信机器人地址不对（应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）', 400, 'bad_wecom');
    patch.wecom_webhook = v;
  }
  if (body.barkUrl !== undefined) {
    const v = String(body.barkUrl).trim().slice(0, 300);
    if (!urlOk(v, 'api.day.app')) return fail('Bark 地址不对（应为 https://api.day.app/你的Key）', 400, 'bad_bark');
    patch.bark_url = v;
  }
  if (body.soundRepeat !== undefined) {
    const n = Math.floor(Number(body.soundRepeat));
    if (!Number.isFinite(n) || n < 1 || n > 5) return fail('提示音次数需在 1～5 之间', 400, 'bad_repeat');
    patch.sound_repeat = String(n);
  }
  if (body.clearSound) {
    const s0 = await getSettings(env);
    await removeStoredFile(env, s0.sound_key);
    patch.sound_key = '';
  }
  if (body.keywords !== undefined || body.offlineKeywords !== undefined) {
    const build = (input) => {
      if (Array.isArray(input)) {
        return parseRules(JSON.stringify(input));
      }
      const lines = String(input || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const out = [];
      for (const line of lines) {
        const m = line.split(/\s*[=＝|｜]\s*/);
        if (m.length < 2) continue;
        const k = m[0].slice(0, 30);
        const r = m.slice(1).join('=').slice(0, 300);
        if (k && r) out.push({ k, r });
      }
      return out.slice(0, 60);
    };
    if (body.keywords !== undefined) patch.keywords = JSON.stringify(build(body.keywords));
    if (body.offlineKeywords !== undefined) patch.offline_keywords = JSON.stringify(build(body.offlineKeywords));
  }

  if (Object.keys(patch).length) await setSettings(env, patch);

  const s = await getSettings(env);
  return json({
    ok: true,
    ...publicSettings(s),
    agentName: ident.name,
    autoCleanDays: Number(s.auto_clean_days) || 0,
    agentOnline: s.agent_online === '1',
    autoReplyEnabled: s.auto_reply_enabled === '1',
    offlineReplyEnabled: s.offline_reply_enabled === '1',
    keywords: parseRules(s.keywords),
    offlineKeywords: parseRules(s.offline_keywords),
    soundEnabled: s.sound_enabled === '1',
    wechatPushEnabled: s.wechat_push_enabled === '1',
    wechatSendKey: s.wechat_sendkey || '',
    pushplusToken: s.pushplus_token || '',
    dingtalkWebhook: s.dingtalk_webhook || '',
    wecomWebhook: s.wecom_webhook || '',
    barkUrl: s.bark_url || '',
    soundRepeat: Number(s.sound_repeat) || 3,
    soundUrl: s.sound_key ? '/api/file/' + s.sound_key : '',
  });
}

/* ------------------------------ 用量与清理 ------------------------------ */

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
};

async function measureUsage(env) {
  const pick = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first()) || {};
  const conv = await pick('SELECT COUNT(*) AS c FROM conversations');
  const msg = await pick(
    "SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS a FROM messages"
  );
  const text = await pick("SELECT COALESCE(SUM(LENGTH(COALESCE(body, ''))), 0) AS s FROM messages");
  const imgs = await pick("SELECT COUNT(*) AS c, COALESCE(SUM(COALESCE(file_size, 0)), 0) AS s FROM messages WHERE type <> 'text'");
  const files = await pick('SELECT COUNT(*) AS c, COALESCE(SUM(COALESCE(size, 0)), 0) AS s FROM files');
  const span = await pick('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM messages');

  const convCount = conv.c || 0;
  const msgCount = msg.c || 0;
  const fileCount = files.c || 0;
  const rows = convCount + msgCount + fileCount;
  // 文字正文 + D1 里实际存放的图片数据 + 每行固定开销
  const usedBytes = (text.s || 0) + (files.s || 0) + rows * ROW_OVERHEAD_BYTES;

  const avgMsgBytes = msgCount > 0 ? Math.max(200, Math.round(usedBytes / msgCount)) : 300;
  const remainingBytes = Math.max(0, D1_FREE_BYTES - usedBytes);
  const storageMode = env.BUCKET ? 'r2+d1' : 'd1';
  const avgImageBytes = (imgs.c || 0) > 0 ? Math.round((imgs.s || 0) / imgs.c) : 380 * 1024;

  return {
    storageMode,
    usedBytes,
    usedHuman: fmtBytes(usedBytes),
    usedPercent: Number(((usedBytes / D1_FREE_BYTES) * 100).toFixed(3)),
    limitBytes: D1_FREE_BYTES,
    limitHuman: fmtBytes(D1_FREE_BYTES),
    remainingBytes,
    remainingHuman: fmtBytes(remainingBytes),
    counts: {
      conversations: convCount,
      messages: msgCount,
      activeMessages: msg.a || 0,
      images: imgs.c || 0,
      storedFiles: fileCount,
    },
    bytes: {
      text: text.s || 0,
      filesInD1: files.s || 0,
      imagesTotal: imgs.s || 0,
      rowOverhead: rows * ROW_OVERHEAD_BYTES,
    },
    estimate: {
      avgMessageBytes: avgMsgBytes,
      avgImageBytes,
      // R2 模式下图片不占 D1，容量主要看文字消息
      textMessagesLeft: Math.floor(remainingBytes / avgMsgBytes),
      imagesLeft: storageMode === 'd1' ? Math.floor(remainingBytes / Math.max(avgImageBytes, 1)) : null,
    },
    firstMessageAt: span.first || 0,
    lastMessageAt: span.last || 0,
  };
}

async function runCleanup(env, days) {
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const msgs = await env.DB.prepare('DELETE FROM messages WHERE created_at < ?').bind(cutoff).run();
  // 清掉没有任何消息再引用的图片（撤回的、删除过的都会变成孤儿）
  const files = await env.DB.prepare(
    "DELETE FROM files WHERE id NOT IN (SELECT file_key FROM messages WHERE file_key IS NOT NULL AND file_key <> '')"
  ).run();
  const convs = await env.DB.prepare(
    'DELETE FROM conversations WHERE updated_at < ? AND id NOT IN (SELECT DISTINCT conv_id FROM messages)'
  )
    .bind(cutoff)
    .run();
  return {
    days,
    cutoff,
    messages: (msgs.meta && msgs.meta.changes) || 0,
    files: (files.meta && files.meta.changes) || 0,
    conversations: (convs.meta && convs.meta.changes) || 0,
  };
}

async function handleStats(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const s = await getSettings(env);
  const autoCleanDays = Number(s.auto_clean_days) || 0;
  let cleanup = null;

  // 自动清理：到点了才跑，最多每 6 小时一次，避免每次刷新都删数据
  if (autoCleanDays > 0) {
    const last = Number(s.last_clean_at) || 0;
    if (now() - last > 6 * 60 * 60 * 1000) {
      cleanup = await runCleanup(env, autoCleanDays);
      await setSettings(env, { last_clean_at: String(now()) });
      s.last_clean_at = String(now());
    }
  }

  const usage = await measureUsage(env);
  return json({
    ok: true,
    ...usage,
    autoCleanDays,
    lastCleanAt: Number(s.last_clean_at) || 0,
    cleanup,
  });
}

async function handleCleanup(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const days = Math.floor(Number(body.days));
  if (!Number.isFinite(days) || days < 0 || days > 3650) return fail('清理天数需在 0～3650 之间', 400, 'bad_range');
  if (body.confirm !== true) return fail('请先确认再清理', 400, 'confirm_required');

  const result = await runCleanup(env, days);
  await setSettings(env, { last_clean_at: String(now()) });
  return json({ ok: true, ...result, usage: await measureUsage(env) });
}

/* --------------------------------- 会话 --------------------------------- */

const parseContact = (raw) => {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
};

const mapConv = (row) => {
  const t = now();
  return {
    id: row.id,
    name: row.remark || row.visitor_name || '访客',
    visitorName: row.visitor_name || '访客',
    remark: row.remark || '',
    preview: row.last_preview || '',
    lastMessageAt: row.last_message_at || row.created_at,
    createdAt: row.created_at,
    unread: row.unread || 0,
    online: (row.agent_seen_at || 0) > t - 90 * 1000,
    ip: row.geo_ip || '',
    location: row.geo_location || '',
    referer: row.geo_referer || '',
    contact: parseContact(row.contact),
  };
};

function geoOf(request, body) {
  const cf = (request && request.cf) || {};
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  const parts = [];
  if (cf.country) parts.push(cf.country === 'CN' ? '中国' : String(cf.country));
  if (cf.region) parts.push(String(cf.region));
  if (cf.city) parts.push(String(cf.city));
  const location = parts.join(' ');
  let referer = '';
  if (typeof body.referer === 'string') referer = body.referer.slice(0, 200);
  if (!referer) referer = (request.headers.get('referer') || '').slice(0, 200);
  if (referer && referer.includes('same-origin')) referer = '';
  return {
    ip: String(ip || '').split(',')[0].trim().slice(0, 64),
    location: location.slice(0, 80),
    referer,
  };
}


async function handleSession(request, env) {
  const body = await safeBody(request);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 24);

  const s = await getSettings(env);
  const shop = s.shop_name || '在线客服';
  const geo = geoOf(request, body);

  if (token) {
    const conv = await env.DB.prepare('SELECT * FROM conversations WHERE visitor_token = ?').bind(token).first();
    if (conv) {
      const t = now();
      if (name && name !== conv.visitor_name) {
        await env.DB.prepare('UPDATE conversations SET visitor_name = ?, updated_at = ? WHERE id = ?')
          .bind(name, t, conv.id)
          .run();
        conv.visitor_name = name;
      }
      const patch = { visitor_seen_at: t };
      if (!conv.geo_ip && geo.ip) patch.geo_ip = geo.ip;
      if (!conv.geo_location && geo.location) patch.geo_location = geo.location;
      const keepReferer = conv.geo_referer && !conv.geo_referer.includes('localhost');
      if (!keepReferer && geo.referer) patch.geo_referer = geo.referer;
      const sets = Object.keys(patch)
        .map((k) => `${k} = ?`)
        .join(', ');
      await env.DB.prepare(`UPDATE conversations SET ${sets} WHERE id = ?`)
        .bind(...Object.values(patch), conv.id)
        .run();
      return json({
        token,
        conv: {
          id: conv.id,
          name: conv.visitor_name || '访客',
          visitorName: conv.visitor_name || '访客',
          remark: '',
          preview: conv.last_preview || '',
          lastMessageAt: conv.last_message_at || conv.created_at,
          createdAt: conv.created_at,
          unread: 0,
        },
        shop,
        welcome: { enabled: s.welcome_enabled === '1', text: s.welcome_text },
        contactEnabled: s.contact_enabled === '1',
      });
    }
  }

  const newToken = token || uid(40);
  const id = uid(16);
  const t = now();
  const visitorName = name || '访客';

  await env.DB.prepare(
    'INSERT INTO conversations (id, visitor_token, visitor_name, created_at, updated_at, visitor_seen_at, geo_ip, geo_location, geo_referer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, newToken, visitorName, t, t, t, geo.ip || null, geo.location || null, geo.referer || null)
    .run();

  // 自动欢迎语：只在新会话时发一条
  let preview = '';
  if (s.welcome_enabled === '1' && (s.welcome_text || '').trim()) {
    try {
      await env.DB.prepare(
        `INSERT INTO messages (conv_id, sender, sender_name, type, body, created_at, updated_at)
         VALUES (?, 'agent', ?, 'text', ?, ?, ?)`
      )
        .bind(id, s.welcome_from || '客服', s.welcome_text.trim().slice(0, 500), t, t)
        .run();
      preview = `客服: ${s.welcome_text.trim().slice(0, 40)}`;
      await env.DB.prepare(
        'UPDATE conversations SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?'
      )
        .bind(t, preview, t, id)
        .run();
    } catch (e) {
      console.error('welcome insert failed', e);
    }
  }

  return json({
    token: newToken,
    conv: { id, name: visitorName, visitorName, remark: '', preview, lastMessageAt: t, createdAt: t, unread: 0 },
    shop,
    welcome: { enabled: s.welcome_enabled === '1', text: s.welcome_text },
    contactEnabled: s.contact_enabled === '1',
  });
}

async function handleConversationList(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.*, (
       SELECT COUNT(*) FROM messages m
       WHERE m.conv_id = c.id AND m.sender = 'visitor'
         AND m.read_at IS NULL AND m.deleted_agent = 0 AND m.status = 'active'
     ) AS unread
     FROM conversations c
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
     LIMIT 100`
  ).all();

  return json({ conversations: (results || []).map(mapConv) });
}

async function handleRemark(request, env, convId) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const remark = String(body.remark !== undefined ? body.remark : body.name || '')
    .trim()
    .slice(0, 24);

  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
  if (!conv) return fail('会话不存在', 404, 'not_found');

  await env.DB.prepare('UPDATE conversations SET remark = ?, updated_at = ? WHERE id = ?')
    .bind(remark, now(), convId)
    .run();

  return json({ ok: true, id: convId, remark, name: remark || conv.visitor_name || '访客' });
}

/* --------------------------------- 消息 --------------------------------- */

const mapMessage = (row) => ({
  id: row.id,
  convId: row.conv_id,
  sender: row.sender,
  senderName: row.sender_name || (row.sender === 'agent' ? '客服' : '访客'),
  type: row.type,
  body: row.body || '',
  fileKey: row.file_key || '',
  fileSize: row.file_size || 0,
  status: row.status || 'active',
  autoReply: !!row.auto_reply,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  readAt: row.read_at || 0,
});

async function handleListMessages(request, env, url) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const convId = await resolveConvId(request, ident, url, null);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');
  if (ident.role === 'visitor' && convId !== ident.convId) return fail('无权访问该会话', 403, 'forbidden');

  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
  if (!conv) return fail('会话不存在', 404, 'not_found');

  const after = Number(url.searchParams.get('after') || 0) || 0;
  const since = Number(url.searchParams.get('since') || 0) || 0;
  const limit = 200;
  const hideColumn = ident.role === 'visitor' ? 'deleted_visitor' : 'deleted_agent';

  const fresh = await env.DB.prepare(
    `SELECT * FROM messages WHERE conv_id = ? AND id > ? AND ${hideColumn} = 0 ORDER BY id ASC LIMIT ?`
  )
    .bind(convId, after, limit)
    .all();

  let updates = [];
  if (since > 0) {
    const res = await env.DB.prepare(
      `SELECT * FROM messages
       WHERE conv_id = ? AND updated_at > ? AND id <= ? AND ${hideColumn} = 0
       ORDER BY id ASC LIMIT ?`
    )
      .bind(convId, since, after, limit)
      .all();
    updates = res.results || [];
  }

  const unreadRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE conv_id = ? AND sender <> ? AND read_at IS NULL AND ${hideColumn} = 0 AND status = 'active'`
  )
    .bind(convId, ident.role)
    .first();

  // 在线状态心跳：最多 1 分钟写一次，省 D1 写入额度
  const seenCol = ident.role === 'visitor' ? 'visitor_seen_at' : 'agent_seen_at';
  if (now() - (conv[seenCol] || 0) > 60 * 1000) {
    try {
      await env.DB.prepare(`UPDATE conversations SET ${seenCol} = ? WHERE id = ?`).bind(now(), convId).run();
    } catch {
      /* 忽略 */
    }
  }

  return json({
    messages: (fresh.results || []).map(mapMessage),
    updates: updates.map(mapMessage),
    conv: {
      id: conv.id,
      name: conv.visitor_name || '访客',
      remark: conv.remark || '',
      unread: (unreadRow && unreadRow.n) || 0,
      lastReadAt: ident.role === 'visitor' ? conv.visitor_last_read_at : conv.agent_last_read_at,
    },
    now: now(),
  });
}

function parseRules(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && String(x.k || '').trim())
      .map((x) => ({ k: String(x.k).trim().slice(0, 30), r: String(x.r || '').slice(0, 300) }))
      .slice(0, 60);
  } catch {
    return [];
  }
}

function matchRule(rules, text) {
  const lower = String(text || '').toLowerCase();
  for (const rule of rules) {
    if (!rule.r) continue;
    if (lower.includes(rule.k.toLowerCase())) return rule;
  }
  return null;
}

const pushCooldown = new Map();

const plainOf = (lines) =>
  lines
    .join('\n')
    .replace(/\*\*/g, '');

async function pushWeChat(env, conv, text) {
  const s = await getSettings(env);
  if (s.wechat_push_enabled !== '1') return;

  const last = pushCooldown.get(conv.id) || 0;
  if (now() - last < 5000) return;
  pushCooldown.set(conv.id, now());

  const c = parseContact(conv.contact);
  const contactText = c
    ? [
        c.phone && '手机 ' + c.phone,
        c.wechat && '微信 ' + c.wechat,
        c.qq && 'QQ ' + c.qq,
        c.email && '邮箱 ' + c.email,
      ]
        .filter(Boolean)
        .join(' / ')
    : '';

  const title = '收到新的访客消息';
  const lines = [
    `**访客IP**：${conv.geo_ip || '未知'}`,
    `**位置**：${conv.geo_location || '未知'}`,
    conv.geo_referer ? `**来源**：${conv.geo_referer}` : '',
    contactText ? `**联系方式**：${contactText}` : '',
    `**消息**：${String(text || '').slice(0, 300)}`,
  ].filter(Boolean);

  const plain = plainOf(lines);
  const html = lines.map((l) => l.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')).join('<br>');

  const jobs = [];

  const sendServerChan = String(s.wechat_sendkey || '').trim();
  if (sendServerChan) {
    jobs.push(
      fetch(`https://sctapi.ftqq.com/${encodeURIComponent(sendServerChan)}.send`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: lines.join('\n\n') }).toString(),
      })
    );
  }

  const pushplus = String(s.pushplus_token || '').trim();
  if (pushplus) {
    jobs.push(
      fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: pushplus, title, content: html, template: 'html' }),
      })
    );
  }

  const ding = String(s.dingtalk_webhook || '').trim();
  if (ding) {
    jobs.push(
      fetch(ding, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title, text: lines.join('\n\n') },
        }),
      })
    );
  }

  const wecom = String(s.wecom_webhook || '').trim();
  if (wecom) {
    jobs.push(
      fetch(wecom, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: plain } }),
      })
    );
  }

  const bark = String(s.bark_url || '').trim();
  if (bark) {
    const base = bark.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(plain.slice(0, 900))}?group=客服消息`;
    jobs.push(fetch(url));
  }

  if (!jobs.length) return;

  await Promise.all(
    jobs.map((p) =>
      Promise.resolve(p)
        .then((res) => {
          if (!res || !res.ok) console.warn('push status', res && res.status);
        })
        .catch((e) => console.warn('push failed', String(e && e.message)))
    )
  );
}

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

async function handleContact(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'visitor') return fail('未登录', 401, 'unauthorized');

  const s = await getSettings(env);
  if (s.contact_enabled !== '1') return fail('未开启联系方式收集', 403, 'disabled');

  const body = await safeBody(request);
  const phone = String(body.phone || '').trim().slice(0, 20);
  const wechat = String(body.wechat || '').trim().slice(0, 40);
  const qq = String(body.qq || '').trim().slice(0, 20);
  const email = String(body.email || '').trim().slice(0, 60);

  if (!phone && !wechat && !qq && !email) return fail('请至少填写一项联系方式', 400, 'empty_contact');
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) return fail('手机号格式不太对', 400, 'invalid_phone');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('邮箱格式不太对', 400, 'invalid_email');

  const contact = { phone, wechat, qq, email, at: now() };
  await env.DB.prepare('UPDATE conversations SET contact = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(contact), now(), ident.convId)
    .run();
  return json({ ok: true, contact });
}

async function handleExport(request, env, url) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const convId = url.searchParams.get('conv') || '';
  let convs = [];
  if (convId) {
    const c = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
    convs = c ? [c] : [];
  } else {
    const r = await env.DB.prepare(
      'SELECT * FROM conversations ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 100'
    ).all();
    convs = r.results || [];
  }
  if (!convs.length) return fail('没有可导出的会话', 404, 'no_conv');

  const rows = [
    [
      '会话ID',
      '顾客备注',
      '会话创建时间',
      '访客IP',
      '归属地',
      '来源网站',
      '联系方式',
      '消息时间',
      '发送方',
      '内容类型',
      '内容',
      '是否自动回复',
      '已读状态',
    ],
  ];

  for (const c of convs) {
    const contact = parseContact(c.contact);
    const contactText = contact
      ? [
          contact.phone && '手机:' + contact.phone,
          contact.wechat && '微信:' + contact.wechat,
          contact.qq && 'QQ:' + contact.qq,
          contact.email && '邮箱:' + contact.email,
        ]
          .filter(Boolean)
          .join(' / ')
      : '';
    const { results } = await env.DB.prepare(
      `SELECT * FROM messages WHERE conv_id = ? AND status = 'active' ORDER BY id ASC LIMIT 2000`
    )
      .bind(c.id)
      .all();
    const msgs = results || [];
    const base = [
      c.id,
      c.remark || '',
      fmtTime(c.created_at),
      c.geo_ip || '',
      c.geo_location || '',
      c.geo_referer || '',
      contactText,
    ];
    if (!msgs.length) {
      rows.push([...base, '', '（暂无消息）', '', '', '', '']);
      continue;
    }
    for (const m of msgs) {
      rows.push([
        ...base,
        fmtTime(m.created_at),
        m.sender === 'agent' ? '客服' : '访客',
        m.type === 'image' ? '图片' : '文字',
        m.type === 'image' ? '/api/file/' + (m.file_key || '') : m.body || '',
        m.auto_reply ? '是' : '否',
        m.read_at ? '已读' : '未读',
      ]);
    }
  }

  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const name = convId ? `聊天记录-${convId}.csv` : `聊天记录-全部-${fmtTime(now()).slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="chat-log.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    },
  });
}

async function handleSendMessage(request, env, url, ctx) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const convId = await resolveConvId(request, ident, url, body);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');
  if (ident.role === 'visitor' && convId !== ident.convId) return fail('无权访问该会话', 403, 'forbidden');

  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
  if (!conv) return fail('会话不存在', 404, 'not_found');

  const type = body.type === 'image' ? 'image' : 'text';
  const text = String(body.body || '').trim();
  let fileKey = '';

  if (type === 'text') {
    if (!text) return fail('消息内容不能为空', 400, 'empty');
    if (text.length > MAX_TEXT_LEN) return fail(`消息过长（最多 ${MAX_TEXT_LEN} 字）`, 400, 'too_long');
  } else {
    fileKey = String(body.fileKey || '').trim();
    if (!fileKey || !fileKey.startsWith(`${convId}/`)) return fail('图片标识无效', 400, 'invalid_file');
    const file = await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(fileKey).first();
    if (!file && !env.BUCKET) return fail('图片不存在，请重新上传', 400, 'invalid_file');
  }

  const t = now();
  const preview = type === 'image' ? '[图片]' : text.slice(0, 40);
  const senderName = ident.role === 'agent' ? ident.name : conv.visitor_name || '访客';

  const res = await env.DB.prepare(
    `INSERT INTO messages (conv_id, sender, sender_name, type, body, file_key, file_size, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  )
    .bind(convId, ident.role, senderName, type, text, type === 'image' ? fileKey : null, Number(body.fileSize) || 0, t, t)
    .run();

  const id = Number(res.meta && res.meta.last_row_id) || 0;
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();

  await env.DB.prepare(
    'UPDATE conversations SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?'
  )
    .bind(t, `${ident.role === 'agent' ? '客服: ' : ''}${preview}`, t, convId)
    .run();

  let autoReply = null;

  if (ident.role === 'visitor' && type === 'text') {
    const s2 = await getSettings(env);
    const online = s2.agent_online === '1';
    const enabled = online ? s2.auto_reply_enabled === '1' : s2.offline_reply_enabled === '1';
    if (enabled) {
      const rules = parseRules(online ? s2.keywords : s2.offline_keywords);
      const hit = matchRule(rules, text);
      if (hit && hit.r) {
        try {
          const t2 = now();
          const ins = await env.DB.prepare(
            `INSERT INTO messages (conv_id, sender, sender_name, type, body, created_at, updated_at, auto_reply)
             VALUES (?, 'agent', ?, 'text', ?, ?, ?, 1)`
          )
            .bind(convId, s2.welcome_from || '客服', hit.r, t2, t2)
            .run();
          const rid = Number(ins.meta && ins.meta.last_row_id) || 0;
          const row2 = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(rid).first();
          autoReply = row2 ? mapMessage(row2) : null;
          await env.DB.prepare(
            'UPDATE conversations SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?'
          )
            .bind(t2, `客服: ${hit.r.slice(0, 40)}`, t2, convId)
            .run();
        } catch (e) {
          console.error('auto reply failed', e);
        }
      }
    }
    const job = pushWeChat(env, conv, preview);
    if (ctx && ctx.waitUntil) ctx.waitUntil(job.catch(() => {}));
  }

  return json({ message: row ? mapMessage(row) : null, id, autoReply });
}

async function handleMessageAction(request, env, id, action) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!msg) return fail('消息不存在', 404, 'not_found');
  if (ident.role === 'visitor' && msg.conv_id !== ident.convId) return fail('无权操作该消息', 403, 'forbidden');

  const hideColumn = ident.role === 'visitor' ? 'deleted_visitor' : 'deleted_agent';
  const t = now();

  if (action === 'delete') {
    await env.DB.prepare(`UPDATE messages SET ${hideColumn} = 1, updated_at = ? WHERE id = ?`).bind(t, id).run();
    return json({ ok: true, id, action: 'delete' });
  }

  if (msg.sender !== ident.role) return fail('只能撤回自己发送的消息', 403, 'forbidden');
  if (msg.status === 'recalled') return json({ ok: true, id, status: 'recalled' });

  const windowSec = Number(env.RECALL_WINDOW_SEC || 120);
  if (t - msg.created_at > windowSec * 1000) return fail(`超过 ${windowSec} 秒，无法撤回`, 400, 'recall_expired');

  await env.DB.prepare(
    `UPDATE messages SET status = 'recalled', body = '', file_key = NULL, updated_at = ? WHERE id = ?`
  )
    .bind(t, id)
    .run();

  await env.DB.prepare('UPDATE conversations SET last_preview = ?, updated_at = ? WHERE id = ? AND last_message_at <= ?')
    .bind('[消息已撤回]', t, msg.conv_id, msg.created_at)
    .run();

  return json({ ok: true, id, action: 'recall', status: 'recalled' });
}

async function handleRead(request, env, url) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const convId = await resolveConvId(request, ident, url, body);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');
  if (ident.role === 'visitor' && convId !== ident.convId) return fail('无权访问该会话', 403, 'forbidden');

  const t = now();
  await env.DB.prepare(
    `UPDATE messages SET read_at = ?, updated_at = ?
     WHERE conv_id = ? AND sender <> ? AND read_at IS NULL AND status = 'active'`
  )
    .bind(t, t, convId, ident.role)
    .run();

  const col = ident.role === 'visitor' ? 'visitor_last_read_at' : 'agent_last_read_at';
  await env.DB.prepare(`UPDATE conversations SET ${col} = ?, updated_at = ? WHERE id = ?`)
    .bind(t, t, convId)
    .run();

  return json({ ok: true, readAt: t });
}

/* --------------------------------- 图片 --------------------------------- */

async function storeImageBuffer(env, key, mime, buffer) {
  if (env.BUCKET) {
    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
      });
      return 'r2';
    } catch (e) {
      console.warn('R2 put failed, fallback to D1:', String(e && e.message));
    }
  }
  if (buffer.byteLength > D1_MAX_FILE_BYTES) return 'too_large';
  await env.DB.prepare('INSERT INTO files (id, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(key, mime, buffer.byteLength, bytesToBase64(buffer), now())
    .run();
  return 'd1';
}

async function removeStoredFile(env, key) {
  if (!key) return;
  if (env.BUCKET) {
    try {
      await env.BUCKET.delete(key);
    } catch (e) {
      console.warn('R2 delete failed:', String(e && e.message));
    }
  }
  await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(key).run();
}

async function serveStoredFile(env, key) {
  const commonHeaders = {
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  };
  if (env.BUCKET) {
    try {
      const obj = await env.BUCKET.get(key);
      if (obj) {
        const headers = new Headers(commonHeaders);
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        return new Response(obj.body, { headers });
      }
    } catch (e) {
      console.warn('R2 get failed, try D1:', String(e && e.message));
    }
  }
  const row = await env.DB.prepare('SELECT mime, data FROM files WHERE id = ?').bind(key).first();
  if (!row || !row.data) return new Response('Not Found', { status: 404 });
  return new Response(base64ToBytes(row.data), {
    headers: { ...commonHeaders, 'content-type': row.mime || 'image/jpeg' },
  });
}

async function handleUpload(request, env, url, ctx) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const convId = await resolveConvId(request, ident, url, null);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');
  if (ident.role === 'visitor' && convId !== ident.convId) return fail('无权访问该会话', 403, 'forbidden');

  let form;
  try {
    form = await request.formData();
  } catch {
    return fail('上传数据解析失败，请重试', 400, 'bad_form');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('未收到文件', 400, 'no_file');

  const maxMb = Number(env.MAX_IMAGE_MB || 5);
  if (file.size > maxMb * 1024 * 1024) return fail(`图片过大，请压缩到 ${maxMb}MB 以内`, 413, 'too_large');

  const mime = file.type || 'image/jpeg';
  const ext = IMAGE_TYPES[mime];
  if (!ext) return fail('只支持 JPG / PNG / GIF / WebP 图片', 415, 'unsupported_type');

  const key = `${convId}/${uid(28)}.${ext}`;
  const buffer = await file.arrayBuffer();
  const storage = await storeImageBuffer(env, key, mime, buffer);
  if (storage === 'too_large') {
    return fail('图片仍然偏大，请换一张小一点的图或开启 R2 存储', 413, 'too_large_for_d1');
  }
  return json({ key, size: file.size, type: mime, storage });
}

async function handleFile(env, encodedKey) {
  let key = '';
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (!key || !/^[a-zA-Z0-9-]+\/[a-f0-9]+\.(jpg|png|gif|webp|avif|mp3|m4a|ogg|wav|aac)$/.test(key)) {
    return new Response('Not Found', { status: 404 });
  }
  return serveStoredFile(env, key);
}

async function handleAvatar(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  let form;
  try {
    form = await request.formData();
  } catch {
    return fail('上传数据解析失败，请重试', 400, 'bad_form');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('未收到图片', 400, 'no_file');

  const maxMb = Number(env.MAX_IMAGE_MB || 5);
  if (file.size > maxMb * 1024 * 1024) return fail(`图片过大，请压缩到 ${maxMb}MB 以内`, 413, 'too_large');
  const mime = file.type || 'image/jpeg';
  const ext = IMAGE_TYPES[mime];
  if (!ext) return fail('只支持 JPG / PNG / GIF / WebP 图片', 415, 'unsupported_type');

  const buffer = await file.arrayBuffer();
  const key = `avatar/${uid(28)}.${ext}`;
  const storage = await storeImageBuffer(env, key, mime, buffer);
  if (storage === 'too_large') return fail('图片仍然偏大，请换一张小一点的图或开启 R2 存储', 413, 'too_large_for_d1');

  const s = await getSettings(env);
  await removeStoredFile(env, s.agent_avatar_key);
  await setSettings(env, { agent_avatar_key: key });
  return json({ ok: true, avatarUrl: '/api/file/' + key });
}

async function handleAvatarClear(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');
  const s = await getSettings(env);
  await removeStoredFile(env, s.agent_avatar_key);
  await setSettings(env, { agent_avatar_key: '' });
  return json({ ok: true, avatarUrl: '' });
}

async function handleSoundUpload(request, env) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  let form;
  try {
    form = await request.formData();
  } catch {
    return fail('上传数据解析失败，请重试', 400, 'bad_form');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('未收到音频文件', 400, 'no_file');
  if (file.size > 400 * 1024) return fail('提示音文件请小于 400KB（建议截取 2～5 秒）', 413, 'too_large');

  const mime = (file.type || '').toLowerCase();
  const ext = AUDIO_TYPES[mime];
  if (!ext) return fail('只支持 MP3 / M4A / OGG / WAV / AAC 音频', 415, 'unsupported_type');

  const buffer = await file.arrayBuffer();
  const key = `sound/${uid(28)}.${ext}`;
  const storage = await storeImageBuffer(env, key, mime, buffer);
  if (storage === 'too_large') return fail('文件偏大，请换小一点的音频', 413, 'too_large_for_d1');

  const s = await getSettings(env);
  await removeStoredFile(env, s.sound_key);
  await setSettings(env, { sound_key: key, sound_enabled: '1' });
  return json({ ok: true, soundUrl: '/api/file/' + key });
}

async function handleAgentAvatar(env) {
  const s = await getSettings(env);
  const key = s.agent_avatar_key;
  if (!key) return new Response('Not Found', { status: 404 });
  return serveStoredFile(env, key);
}
