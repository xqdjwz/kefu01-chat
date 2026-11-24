// cf-kefu-chat 在线客服系统 v3.4-2026-11-23
// Cloudflare Workers + D1 单文件后端。全免费栈，无付费依赖。
// 新增：同IP客户归并合并、AI托管智能回复、对话结束语（结束/重开）、视频/语音外部链接面板。

const VERSION = 'v3.4-2026-11-23';

const DEFAULT_SETTINGS = {
  shop_name: '在线客服',
  agent_name: '客服',
  welcome_message: '您好，请问有什么可以帮您？',
  offline_message: '当前客服不在线，请留下您的问题和联系方式，我们会尽快回复。',
  online_status: 'online',
  auto_reply_enabled: '1',
  keywords_online: '[]',
  keywords_offline: '[]',
  end_message: '本次咨询已结束，感谢来访，有问题随时再联系。',
  reopenable: '0',
  ai_enabled: '0',
  ai_provider: 'deepseek',
  ai_api_base: 'https://api.deepseek.com/chat/completions',
  ai_api_key: '',
  ai_model: 'deepseek-chat',
  ai_prompt: '你是本店客服，热情简洁回答，不知道就说稍后人工回复',
  ai_max_rounds: '6',
  sound_in: 'default',
  sound_out: 'default',
  sound_custom: '',
  sound_repeat: '1',
  push_serverchan: '',
  push_pushplus: '',
  push_dingtalk: '',
  push_wecom: '',
  push_bark: '',
  contact_phone: '',
  contact_wechat: '',
  contact_address: '',
  contact_hours: '',
  agent_avatar_key: '',
  admin_token: '',
};

const TABLES = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_token TEXT, visitor_name TEXT, remark TEXT,
    created_at TEXT, updated_at TEXT, last_message_at TEXT, last_preview TEXT,
    visitor_last_read_at TEXT, agent_last_read_at TEXT,
    visitor_seen_at TEXT, agent_seen_at TEXT,
    geo_ip TEXT, geo_location TEXT, geo_referer TEXT, geo_device TEXT,
    contact TEXT, blocked INTEGER DEFAULT 0,
    customer_id TEXT, status TEXT DEFAULT 'open'
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id INTEGER, sender TEXT, sender_name TEXT, type TEXT DEFAULT 'text',
    body TEXT, file_key TEXT, file_size INTEGER, status TEXT DEFAULT 'sent',
    deleted_visitor INTEGER DEFAULT 0, deleted_agent INTEGER DEFAULT 0,
    read_at TEXT, created_at TEXT, updated_at TEXT,
    auto_reply INTEGER DEFAULT 0, ai_reply INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS agents (token TEXT PRIMARY KEY, name TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, mime TEXT, size INTEGER, data TEXT, created_at TEXT)`,
];

// 旧库自动补列，禁止要求用户手工 SQL
const ALTERS = [
  ['conversations', 'customer_id TEXT'],
  ['conversations', "status TEXT DEFAULT 'open'"],
  ['messages', 'ai_reply INTEGER DEFAULT 0'],
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at)',
  'CREATE INDEX IF NOT EXISTS idx_conv_ip ON conversations(geo_ip)',
];

// ---------- 工具 ----------
function now() { return new Date().toISOString(); }

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('cookie') || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return '';
}

function clientIp(req) {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = req.headers.get('x-forwarded-for') || '';
  const first = xff.split(',')[0].trim();
  return first || '';
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 建表 ----------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of TABLES) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在 */ }
  }
  for (const sql of INDEXES) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 已存在 */ }
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    try { await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(k, v).run(); } catch (e) {}
  }
  for (const [table, col] of ALTERS) {
    try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run(); } catch (e) { /* 列已存在 */ }
  }
  schemaReady = true;
}

// ---------- 设置读取 ----------
async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows.results) out[r.key] = r.value;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (out[k] === undefined) out[k] = v;
  return out;
}

// 下发给访客的公开设置（绝不含 ai_api_key / admin_token）
function publicSettings(s) {
  const keep = ['shop_name', 'agent_name', 'welcome_message', 'offline_message', 'end_message',
    'reopenable', 'online_status', 'contact_phone', 'contact_wechat', 'contact_address', 'contact_hours'];
  const out = {};
  for (const k of keep) out[k] = s[k];
  return out;
}

// ---------- 鉴权 ----------
async function agentTokenFromReq(req, env) {
  const t = bearer(req) || parseCookies(req).agent_token || '';
  if (!t) return null;
  const s = await getSettings(env);
  const h = await sha256(t);
  if (s.admin_token && h === s.admin_token) return t;
  const row = await env.DB.prepare('SELECT token FROM agents WHERE token = ?').bind(h).first();
  if (row) return t;
  return null;
}

async function requireAgent(req, env) {
  const t = await agentTokenFromReq(req, env);
  return t ? t : null;
}

// ---------- AI ----------
async function callAI(env, s, history, userMsg) {
  if (!s.ai_api_key || !s.ai_api_base) return null;
  const msgs = [{ role: 'system', content: s.ai_prompt || '你是本店客服，热情简洁回答，不知道就说稍后人工回复' },
    ...history, { role: 'user', content: userMsg }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(s.ai_api_base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.ai_api_key },
      body: JSON.stringify({ model: s.ai_model, messages: msgs, temperature: 0.7, stream: false }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return reply ? String(reply).trim() : null;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// ---------- 关键词自动回复 ----------
function matchKeywords(s, text, online) {
  let list = [];
  try { list = JSON.parse(online ? s.keywords_online : s.keywords_offline) || []; } catch { list = []; }
  for (const item of list) {
    if (!item || !item.kw) continue;
    if (text.includes(String(item.kw))) return item.reply || '';
  }
  return null;
}

// ---------- 推送五渠道 ----------
async function pushNotify(env, s, conv, text) {
  const title = `【${s.shop_name || '在线客服'}】新咨询`;
  const body = `会话#${conv.id} ${conv.visitor_name || '访客'}：${text}`;
  const tasks = [];
  if (s.push_serverchan) {
    tasks.push(fetch(`https://sctapi.ftqq.com/${s.push_serverchan}.send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, desp: body }),
    }).catch(() => {}));
  }
  if (s.push_pushplus) {
    tasks.push(fetch('http://www.pushplus.plus/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: s.push_pushplus, title, content: body }),
    }).catch(() => {}));
  }
  if (s.push_dingtalk) {
    tasks.push(fetch(s.push_dingtalk, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: body } }),
    }).catch(() => {}));
  }
  if (s.push_wecom) {
    tasks.push(fetch(s.push_wecom, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: body } }),
    }).catch(() => {}));
  }
  if (s.push_bark) {
    tasks.push(fetch(`${s.push_bark}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`).catch(() => {}));
  }
  await Promise.allSettled(tasks);
}

// ---------- 会话/消息写入 ----------
async function insertMessage(env, convId, fields) {
  const t = now();
  const defaults = {
    sender: 'visitor', sender_name: '', type: 'text', body: '', file_key: '', file_size: 0,
    status: 'sent', deleted_visitor: 0, deleted_agent: 0, read_at: null,
    created_at: t, updated_at: t, auto_reply: 0, ai_reply: 0,
  };
  const f = { ...defaults, ...fields };
  const r = await env.DB.prepare(
    `INSERT INTO messages (conv_id, sender, sender_name, type, body, file_key, file_size, status,
      deleted_visitor, deleted_agent, read_at, created_at, updated_at, auto_reply, ai_reply)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(convId, f.sender, f.sender_name, f.type, f.body, f.file_key, f.file_size, f.status,
    f.deleted_visitor, f.deleted_agent, f.read_at, f.created_at, f.updated_at, f.auto_reply, f.ai_reply).run();
  return r.meta.last_row_id;
}

async function touchConv(env, conv, preview) {
  const t = now();
  await env.DB.prepare('UPDATE conversations SET last_message_at=?, last_preview=?, updated_at=? WHERE id=?')
    .bind(t, preview, t, conv.id).run();
}

// ---------- 路由 ----------
export default {
  async fetch(request, env, ctx) {
    await ensureSchema(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // 健康检查（无需鉴权）
      if (path === '/api/health' && method === 'GET') {
        return json({
          version: VERSION,
          ok: true,
          features: [
            '访客会话与轮询收发', '关键词在线/离线自动回复', '五渠道推送', '提示音',
            '文件图片上传落D1', '联系方式', '导出CSV', '网站嵌入', '设备/IP识别', '拉黑', '删除会话',
            '同IP客户归并与一键合并/拆分', 'AI托管智能回复', '对话结束语（结束/重新打开）', '视频/语音外部链接面板',
          ],
        });
      }

      // 静态资源（生产由 wrangler assets 提供；本地自测由 server.mjs 提供）
      if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/agent.html' || path.startsWith('/assets/') || path === '/embed.js')) {
        if (env.ASSETS) {
          const asset = await env.ASSETS.fetch(request);
          if (asset && asset.status !== 404) return asset;
        }
        return text('Not found', 404);
      }

      // ---------- 访客会话 ----------
      if (path === '/api/session' && method === 'POST') {
        const body = await readBody(request);
        const s = await getSettings(env);
        const ip = clientIp(request);
        let conv = null;
        if (body.token) {
          conv = await env.DB.prepare('SELECT * FROM conversations WHERE visitor_token = ? ORDER BY id DESC LIMIT 1')
            .bind(body.token).first();
        }
        if (!conv) {
          const token = body.token || ('v_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36));
          const t = now();
          const r = await env.DB.prepare(
            `INSERT INTO conversations (visitor_token, visitor_name, created_at, updated_at, last_message_at, last_preview, geo_ip, geo_referer, geo_device, status)
             VALUES (?,?,?,?,?,?,?,?,?, 'open')`
          ).bind(token, body.name || '', t, t, t, '', ip, body.referer || '', body.device || '').run();
          const convId = r.meta.last_row_id;
          await insertMessage(env, convId, {
            sender: 'agent', sender_name: s.agent_name, body: s.welcome_message, auto_reply: 1, status: 'read',
          });
          conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
          return json({ ok: true, token, conv, settings: publicSettings(s), welcome: s.welcome_message });
        }
        return json({ ok: true, token: conv.visitor_token, conv, settings: publicSettings(s) });
      }

      // ---------- 消息 ----------
      if (path === '/api/messages' && method === 'GET') {
        const convId = Number(url.searchParams.get('conv'));
        const token = bearer(request) || parseCookies(request).visitor_token || '';
        const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
        if (!conv) return json({ error: '会话不存在' }, 404);
        const isAgent = await requireAgent(request, env);
        if (!isAgent && conv.visitor_token !== token) return json({ error: '无权访问' }, 403);

        const after = Number(url.searchParams.get('after') || 0);
        const since = url.searchParams.get('since') || '0';
        let rows;
        if (after > 0) {
          rows = await env.DB.prepare(
            'SELECT * FROM messages WHERE conv_id = ? AND id > ? AND deleted_visitor = 0 ORDER BY id ASC'
          ).bind(convId, after).all();
        } else {
          rows = await env.DB.prepare(
            'SELECT * FROM messages WHERE conv_id = ? AND deleted_visitor = 0 ORDER BY id ASC LIMIT 200'
          ).bind(convId).all();
        }
        const updates = await env.DB.prepare(
          'SELECT id, status, read_at, updated_at, deleted_visitor, deleted_agent FROM messages WHERE conv_id = ? AND updated_at > ? ORDER BY id ASC'
        ).bind(convId, since).all();
        const s = await getSettings(env);
        return json({
          messages: rows.results,
          updates: updates.results,
          conv: { id: conv.id, status: conv.status, blocked: conv.blocked, last_preview: conv.last_preview },
          settings: publicSettings(s),
        });
      }

      if (path === '/api/messages' && method === 'POST') {
        const body = await readBody(request);
        const s = await getSettings(env);
        const convId = Number(body.conv);
        const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
        if (!conv) return json({ error: '会话不存在' }, 404);
        const isAgent = await requireAgent(request, env);
        const token = bearer(request) || parseCookies(request).visitor_token || '';

        if (isAgent) {
          // 客服发送（文本/链接卡片）
          const type = body.type || 'text';
          if (type === 'link') {
            const urlStr = String(body.url || '');
            if (!/^https?:\/\//i.test(urlStr)) return json({ error: '链接必须以 http:// 或 https:// 开头' }, 400);
            if (String(body.title || '').length > 60) return json({ error: '标题过长（最多60字）' }, 400);
            const mid = await insertMessage(env, convId, {
              sender: 'agent', sender_name: s.agent_name, type: 'link',
              body: JSON.stringify({ title: body.title || '会议链接', url: urlStr }), status: 'read',
            });
            await touchConv(env, conv, `[链接]${body.title || '会议链接'}`);
            return json({ ok: true, id: mid });
          }
          const textBody = String(body.body || '').trim();
          if (!textBody) return json({ error: '内容为空' }, 400);
          const mid = await insertMessage(env, convId, {
            sender: 'agent', sender_name: s.agent_name, body: textBody, status: 'read',
          });
          await touchConv(env, conv, textBody);
          return json({ ok: true, id: mid });
        }

        // 访客发送
        if (conv.visitor_token !== token) return json({ error: '无权访问' }, 403);
        if (conv.blocked) return json({ ok: false, blocked: true, error: '您已被禁止发言' }, 403);

        // 已结束会话：按 reopenable 决定是否自动重开
        if (conv.status === 'closed') {
          if (s.reopenable === '1') {
            await env.DB.prepare("UPDATE conversations SET status='open', updated_at=? WHERE id=?").bind(now(), convId).run();
          } else {
            return json({ ok: false, closed: true, end_message: s.end_message }, 409);
          }
        }

        const textBody = String(body.body || '').trim();
        const fileKey = body.file_key || '';
        if (!textBody && !fileKey) return json({ error: '内容为空' }, 400);
        if (textBody.length > 2000) return json({ error: '消息过长（最多2000字）' }, 400);

        const mid = await insertMessage(env, convId, {
          sender: 'visitor', sender_name: conv.visitor_name || '访客',
          body: textBody, file_key: fileKey, file_size: Number(body.file_size || 0),
        });
        await touchConv(env, conv, textBody || '[图片]');

        let handled = false; // 已被自动回复/AI接管，不再响铃推送

        // 1) 关键词自动回复（在线/离线两套）
        if (s.auto_reply_enabled === '1' && textBody) {
          const online = s.online_status === 'online';
          const reply = matchKeywords(s, textBody, online);
          if (reply) {
            await insertMessage(env, convId, {
              sender: 'agent', sender_name: s.agent_name, body: reply, auto_reply: 1, status: 'read',
            });
            await touchConv(env, conv, reply);
            handled = true;
          }
        }

        // 2) AI 托管智能回复
        if (!handled && s.ai_enabled === '1' && !conv.blocked) {
          const rounds = Math.max(1, Number(s.ai_max_rounds || 6));
          const histRows = await env.DB.prepare(
            'SELECT sender, body FROM messages WHERE conv_id = ? AND type = \'text\' AND deleted_visitor = 0 AND id < ? ORDER BY id DESC LIMIT ?'
          ).bind(convId, mid, rounds * 2).all();
          const history = histRows.results.reverse().map(r => ({
            role: r.sender === 'agent' ? 'assistant' : 'user', content: r.body,
          }));
          const aiReply = await callAI(env, s, history, textBody);
          if (aiReply) {
            await insertMessage(env, convId, {
              sender: 'agent', sender_name: s.agent_name, body: aiReply, ai_reply: 1, status: 'read',
            });
            await touchConv(env, conv, aiReply);
            handled = true;
          }
          // AI 失败/超时静默回退到关键词规则（关键词已在上面尝试过），继续走人工
        }

        // 3) 未被接管：推送五渠道（AI/自动回复不推送、不响铃）
        if (!handled) {
          ctx.waitUntil ? ctx.waitUntil(pushNotify(env, s, conv, textBody || '[图片]')) : pushNotify(env, s, conv, textBody || '[图片]');
        }
        return json({ ok: true, id: mid, handled });
      }

      // 撤回 / 删除
      if (path.match(/^\/api\/messages\/\d+\/(recall|delete)$/) && method === 'POST') {
        const m = path.match(/^\/api\/messages\/(\d+)\/(recall|delete)$/);
        const mid = Number(m[1]); const action = m[2];
        const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(mid).first();
        if (!msg) return json({ error: '消息不存在' }, 404);
        const isAgent = await requireAgent(request, env);
        const token = bearer(request) || parseCookies(request).visitor_token || '';
        const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(msg.conv_id).first();
        if (!isAgent && conv.visitor_token !== token) return json({ error: '无权访问' }, 403);

        if (action === 'recall') {
          if (!isAgent && msg.sender !== 'visitor') return json({ error: '只能撤回自己的消息' }, 403);
          await env.DB.prepare("UPDATE messages SET status='recalled', updated_at=? WHERE id=?").bind(now(), mid).run();
          return json({ ok: true });
        }
        // delete：按侧软删除
        const col = isAgent ? 'deleted_agent' : 'deleted_visitor';
        await env.DB.prepare(`UPDATE messages SET ${col}=1, updated_at=? WHERE id=?`).bind(now(), mid).run();
        return json({ ok: true });
      }

      // ---------- 客服会话列表 ----------
      if (path === '/api/conversations' && method === 'GET') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const rows = await env.DB.prepare(
          'SELECT * FROM conversations ORDER BY last_message_at DESC, id DESC'
        ).all();
        const list = rows.results;
        // 同IP聚类统计（未合并、IP非空）
        const ipGroups = {};
        for (const c of list) {
          if (c.geo_ip && !c.customer_id) {
            ipGroups[c.geo_ip] = (ipGroups[c.geo_ip] || 0) + 1;
          }
        }
        // 合并客户组统计
        const custGroups = {};
        for (const c of list) {
          if (c.customer_id) {
            if (!custGroups[c.customer_id]) custGroups[c.customer_id] = [];
            custGroups[c.customer_id].push(c);
          }
        }
        const out = [];
        for (const c of list) {
          const unread = (await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM messages m WHERE m.conv_id = ? AND m.sender='visitor' AND m.deleted_agent=0 AND m.created_at > COALESCE((SELECT agent_last_read_at FROM conversations WHERE id=?),'0000')"
          ).bind(c.id, c.id).first()).n;
          const item = { ...c, unread, groupCount: c.geo_ip ? (ipGroups[c.geo_ip] || 0) : 0 };
          if (c.customer_id && custGroups[c.customer_id]) {
            item.memberCount = custGroups[c.customer_id].length;
            item.primaryId = Math.min(...custGroups[c.customer_id].map(x => x.id));
          }
          out.push(item);
        }
        return json({ ok: true, conversations: out });
      }

      // 备注
      if (path.match(/^\/api\/conversations\/\d+\/remark$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        const body = await readBody(request);
        await env.DB.prepare('UPDATE conversations SET remark=?, updated_at=? WHERE id=?')
          .bind(String(body.remark || '').slice(0, 100), now(), convId).run();
        return json({ ok: true });
      }

      // 拉黑
      if (path.match(/^\/api\/conversations\/\d+\/block$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        const body = await readBody(request);
        await env.DB.prepare('UPDATE conversations SET blocked=?, updated_at=? WHERE id=?')
          .bind(body.blocked ? 1 : 0, now(), convId).run();
        return json({ ok: true, blocked: !!body.blocked });
      }

      // 删除会话
      if (path.match(/^\/api\/conversations\/\d+$/) && method === 'DELETE') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        await env.DB.prepare('DELETE FROM messages WHERE conv_id=?').bind(convId).run();
        await env.DB.prepare('DELETE FROM conversations WHERE id=?').bind(convId).run();
        return json({ ok: true });
      }

      // ---------- 新功能1：同IP合并 / 拆分 ----------
      if (path.match(/^\/api\/conversations\/\d+\/merge$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        const body = await readBody(request);
        const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(convId).first();
        if (!conv) return json({ error: '会话不存在' }, 404);
        if (!conv.geo_ip) return json({ error: '该会话无IP，无法按IP合并' }, 400);
        const peers = await env.DB.prepare(
          'SELECT * FROM conversations WHERE geo_ip=? AND customer_id IS NULL ORDER BY id ASC'
        ).bind(conv.geo_ip).all();
        if (peers.results.length < 2) return json({ error: '同IP会话不足2个，无需合并' }, 400);
        const customerId = body.customer_id || ('cust_' + peers.results[0].id + '_' + Date.now().toString(36));
        for (const p of peers.results) {
          await env.DB.prepare('UPDATE conversations SET customer_id=?, updated_at=? WHERE id=?')
            .bind(customerId, now(), p.id).run();
        }
        return json({ ok: true, customer_id: customerId, merged: peers.results.map(p => p.id) });
      }

      if (path.match(/^\/api\/conversations\/\d+\/split$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(convId).first();
        if (!conv) return json({ error: '会话不存在' }, 404);
        if (!conv.customer_id) return json({ error: '该会话未合并' }, 400);
        await env.DB.prepare('UPDATE conversations SET customer_id=NULL, updated_at=? WHERE customer_id=?')
          .bind(now(), conv.customer_id).run();
        return json({ ok: true });
      }

      // ---------- 新功能3：结束对话 / 重新打开 ----------
      if (path.match(/^\/api\/conversations\/\d+\/close$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        await env.DB.prepare("UPDATE conversations SET status='closed', updated_at=? WHERE id=?").bind(now(), convId).run();
        return json({ ok: true, status: 'closed' });
      }

      if (path.match(/^\/api\/conversations\/\d+\/reopen$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        await env.DB.prepare("UPDATE conversations SET status='open', updated_at=? WHERE id=?").bind(now(), convId).run();
        return json({ ok: true, status: 'open' });
      }

      // ---------- 新功能4：视频/语音链接卡片 ----------
      if (path.match(/^\/api\/conversations\/\d+\/link$/) && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convId = Number(path.match(/\d+/)[0]);
        const body = await readBody(request);
        const urlStr = String(body.url || '');
        if (!/^https?:\/\//i.test(urlStr)) return json({ error: '链接必须以 http:// 或 https:// 开头' }, 400);
        if (urlStr.length > 500) return json({ error: '链接过长' }, 400);
        const title = String(body.title || '会议链接').slice(0, 60);
        const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(convId).first();
        if (!conv) return json({ error: '会话不存在' }, 404);
        const s = await getSettings(env);
        const mid = await insertMessage(env, convId, {
          sender: 'agent', sender_name: s.agent_name, type: 'link',
          body: JSON.stringify({ title, url: urlStr }), status: 'read',
        });
        await touchConv(env, conv, `[视频/语音]${title}`);
        return json({ ok: true, id: mid });
      }

      // ---------- AI 测试回复 ----------
      if (path === '/api/ai/test' && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const body = await readBody(request);
        const s = await getSettings(env);
        const merged = { ...s, ...body };
        if (!merged.ai_api_key) return json({ ok: false, error: '请先填写 AI API Key' }, 400);
        const reply = await callAI(env, merged, [], String(body.message || '你好'));
        if (!reply) return json({ ok: false, error: 'AI 请求失败或超时（8秒），请检查 API 地址/Key/模型名' }, 502);
        return json({ ok: true, reply });
      }

      // ---------- 登录 / 登出 / 我 ----------
      if (path === '/api/login' && method === 'POST') {
        const body = await readBody(request);
        const password = String(body.password || '');
        if (!password) return json({ error: '请输入口令' }, 400);
        const s = await getSettings(env);
        const agentCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first()).n;
        if (!s.admin_token && agentCount === 0) {
          // 首次登录：把本次口令设为系统口令
          const h = await sha256(password);
          await env.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind(h, 'admin_token').run();
          await env.DB.prepare('INSERT OR IGNORE INTO agents (token, name, created_at) VALUES (?,?,?)')
            .bind(h, body.name || '管理员', now()).run();
          return json({ ok: true, token: password, firstLogin: true, name: body.name || '管理员' });
        }
        const h = await sha256(password);
        if (s.admin_token && h === s.admin_token) {
          const name = (await env.DB.prepare('SELECT name FROM agents WHERE token=? LIMIT 1').bind(h).first())?.name || '管理员';
          return json({ ok: true, token: password, name });
        }
        const row = await env.DB.prepare('SELECT name FROM agents WHERE token=?').bind(h).first();
        if (row) return json({ ok: true, token: password, name: row.name });
        return json({ error: '口令错误' }, 401);
      }

      if (path === '/api/logout' && method === 'POST') {
        return json({ ok: true });
      }

      if (path === '/api/me' && method === 'GET') {
        const t = await agentTokenFromReq(request, env);
        if (!t) return json({ error: '未登录' }, 401);
        const h = await sha256(t);
        const row = await env.DB.prepare('SELECT name FROM agents WHERE token=? LIMIT 1').bind(h).first();
        return json({ ok: true, name: row?.name || '管理员' });
      }

      // ---------- 设置 ----------
      if (path === '/api/settings' && method === 'GET') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        return json({ ok: true, settings: await getSettings(env) });
      }

      if (path === '/api/settings' && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const body = await readBody(request);
        const s = await getSettings(env);
        const allowed = Object.keys(DEFAULT_SETTINGS);
        for (const [k, v] of Object.entries(body)) {
          if (!allowed.includes(k)) continue;
          let val = v == null ? '' : String(v);
          // 校验
          if (k === 'ai_api_base' && val && !/^https?:\/\//i.test(val)) return json({ error: 'AI API 地址必须以 http:// 或 https:// 开头' }, 400);
          if (k === 'ai_max_rounds') { const n = Number(val); val = (Number.isFinite(n) && n >= 1 && n <= 20) ? String(Math.floor(n)) : '6'; }
          if (k === 'ai_api_key' && val.length > 200) return json({ error: 'API Key 过长' }, 400);
          if (k === 'ai_prompt' && val.length > 2000) return json({ error: '系统提示词过长（2000字内）' }, 400);
          if (k === 'end_message' && val.length > 200) return json({ error: '结束语文案过长（200字内）' }, 400);
          await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .bind(k, val).run();
        }
        return json({ ok: true, settings: await getSettings(env) });
      }

      // ---------- 统计 / 清理 ----------
      if (path === '/api/stats' && method === 'GET') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convs = (await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations').first()).n;
        const msgs = (await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n;
        const unread = (await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON m.conv_id=c.id WHERE m.sender='visitor' AND m.deleted_agent=0 AND m.created_at > COALESCE(c.agent_last_read_at,'0000')"
        ).first()).n;
        return json({ ok: true, conversations: convs, messages: msgs, unread });
      }

      if (path === '/api/cleanup' && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        await env.DB.prepare("DELETE FROM messages WHERE status='recalled' AND created_at < datetime('now','-7 day')").run().catch(() => {});
        return json({ ok: true });
      }

      // ---------- 文件 ----------
      if (path === '/api/upload' && method === 'POST') {
        const body = await readBody(request);
        const data = String(body.data || '');
        const size = Math.ceil(data.length * 3 / 4);
        if (size > 700 * 1024) return json({ error: '图片过大（700KB内）' }, 400);
        const r = await env.DB.prepare('INSERT INTO files (mime, size, data, created_at) VALUES (?,?,?,?)')
          .bind(body.mime || 'image/png', size, data, now()).run();
        return json({ ok: true, key: String(r.meta.last_row_id), size });
      }

      if (path.match(/^\/api\/file\/.+$/) && method === 'GET') {
        const key = path.split('/').pop();
        const row = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(Number(key)).first();
        if (!row) return text('Not found', 404);
        const b64 = row.data.replace(/^data:[^;]+;base64,/, '');
        const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        return new Response(bin, { headers: { 'Content-Type': row.mime || 'image/png', 'Cache-Control': 'public, max-age=86400' } });
      }

      // 头像
      if (path === '/api/avatar/agent' && method === 'GET') {
        const s = await getSettings(env);
        if (!s.agent_avatar_key) return text('No avatar', 404);
        const row = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(Number(s.agent_avatar_key)).first();
        if (!row) return text('No avatar', 404);
        const b64 = row.data.replace(/^data:[^;]+;base64,/, '');
        return new Response(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { headers: { 'Content-Type': row.mime || 'image/png' } });
      }
      if (path === '/api/avatar' && method === 'POST') {
        const body = await readBody(request);
        const r = await env.DB.prepare('INSERT INTO files (mime, size, data, created_at) VALUES (?,?,?,?)')
          .bind(body.mime || 'image/png', Number(body.size || 0), String(body.data || ''), now()).run();
        await env.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind(String(r.meta.last_row_id), 'agent_avatar_key').run();
        return json({ ok: true, key: String(r.meta.last_row_id) });
      }
      if (path === '/api/avatar/clear' && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        await env.DB.prepare("UPDATE settings SET value='' WHERE key='agent_avatar_key'").run();
        return json({ ok: true });
      }

      // ---------- 已读 / 联系方式 / 导出 / 提示音 / 赞赏 ----------
      if (path === '/api/read' && method === 'POST') {
        const body = await readBody(request);
        const convId = Number(body.conv);
        const isAgent = await requireAgent(request, env);
        const t = now();
        if (isAgent) {
          await env.DB.prepare('UPDATE conversations SET agent_last_read_at=?, agent_seen_at=? WHERE id=?').bind(t, t, convId).run();
          await env.DB.prepare("UPDATE messages SET read_at=? WHERE conv_id=? AND sender='visitor' AND read_at IS NULL").bind(t, convId).run();
        } else {
          await env.DB.prepare('UPDATE conversations SET visitor_last_read_at=?, visitor_seen_at=? WHERE id=?').bind(t, t, convId).run();
          await env.DB.prepare("UPDATE messages SET read_at=? WHERE conv_id=? AND sender='agent' AND read_at IS NULL").bind(t, convId).run();
        }
        return json({ ok: true });
      }

      if (path === '/api/contact' && method === 'POST') {
        const body = await readBody(request);
        const convId = Number(body.conv);
        const contact = String(body.contact || '').slice(0, 200);
        await env.DB.prepare('UPDATE conversations SET contact=?, updated_at=? WHERE id=?').bind(contact, now(), convId).run();
        return json({ ok: true });
      }

      if (path === '/api/export' && method === 'GET') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const convs = await env.DB.prepare('SELECT * FROM conversations ORDER BY id ASC').all();
        let csv = '会话ID,访客,备注,IP,状态,拉黑,联系方式,创建时间,最后消息,预览\n';
        for (const c of convs.results) {
          csv += [c.id, c.visitor_name || '', c.remark || '', c.geo_ip || '', c.status || 'open',
            c.blocked ? '是' : '否', c.contact || '', c.created_at || '', c.last_message_at || '',
            (c.last_preview || '').replace(/[,\n]/g, ' ')].join(',') + '\n';
        }
        return new Response('﻿' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=conversations.csv' } });
      }

      if (path === '/api/sound' && method === 'POST') {
        if (!(await requireAgent(request, env))) return json({ error: '未登录' }, 401);
        const body = await readBody(request);
        for (const k of ['sound_in', 'sound_out', 'sound_custom', 'sound_repeat']) {
          if (body[k] !== undefined) {
            await env.DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
              .bind(k, String(body[k])).run();
          }
        }
        return json({ ok: true });
      }

      if (path === '/api/reward' && method === 'POST') {
        const body = await readBody(request);
        const log = await env.DB.prepare("SELECT value FROM settings WHERE key='reward_log'").first();
        let arr = [];
        try { arr = JSON.parse(log?.value || '[]'); } catch { arr = []; }
        arr.push({ channel: body.channel || 'wechat', at: now() });
        await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('reward_log',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .bind(JSON.stringify(arr.slice(-100))).run();
        return json({ ok: true });
      }

      // embed.js
      if (path === '/embed.js' && method === 'GET') {
        const js = `(function(){var d=document,s=d.createElement('script');s.src=(location.origin||'')+'/?embed=1';d.body.appendChild(s);})();`;
        return new Response(js, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
      }

      return json({ error: '接口不存在', path }, 404);
    } catch (e) {
      return json({ error: '服务器错误', detail: String(e && e.message || e) }, 500);
    }
  },
};
