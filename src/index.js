/**
 * 在线客服聊天 —— Cloudflare Workers + D1 + R2
 *
 * 接口一览（全部同源，无需单独域名）：
 *   POST /api/session                 访客建立/恢复会话
 *   GET  /api/messages                拉取消息（支持增量：after / since）
 *   POST /api/messages                发送消息（文本 / 图片）
 *   POST /api/messages/:id/recall     撤回消息（发送方，限时限内）
 *   POST /api/messages/:id/delete     删除消息（仅对自己隐藏）
 *   POST /api/upload                  上传图片到 R2
 *   GET  /api/file/:key               读取图片
 *   POST /api/read                    标记已读
 *   GET  /api/conversations           客服侧：会话列表 + 未读数
 *   POST /api/login                   客服侧：校验口令
 *   GET  /api/health                  健康检查
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const fail = (message, status = 400, code = 'bad_request') =>
  json({ error: code, message }, status);

const now = () => Date.now();

const uid = (len = 32) => {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(len / 2)));
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out.slice(0, len);
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error('api error', e && e.stack ? e.stack : e);
        return fail('服务暂时不可用，请稍后重试', 500, 'server_error');
      }
    }

    return serveAsset(request, env, url);
  },
};

/* ---------------------------------- 静态资源 ---------------------------------- */

async function serveAsset(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let path = url.pathname;
  if (path === '/' || path === '') path = '/index.html';
  else if (path === '/agent' || path === '/agent/') path = '/agent.html';

  const target = new Request(new URL(path + url.search, url.origin).toString(), request);
  const res = await env.ASSETS.fetch(target);

  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  if (path.endsWith('.html')) headers.set('cache-control', 'no-cache');

  return new Response(res.body, { status: res.status, headers });
}

/* ---------------------------------- 身份识别 ---------------------------------- */

async function identify(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ') && env.AGENT_TOKEN && auth.slice(7).trim() === env.AGENT_TOKEN) {
    return { role: 'agent', name: env.AGENT_NAME || '客服' };
  }

  const token = request.headers.get('x-visitor-token') || '';
  if (token) {
    const conv = await env.DB.prepare(
      'SELECT id, visitor_token, visitor_name FROM conversations WHERE visitor_token = ?'
    )
      .bind(token)
      .first();
    if (conv) {
      return { role: 'visitor', token, convId: conv.id, name: conv.visitor_name || '访客' };
    }
  }
  return null;
}

/**
 * 解析本次请求要操作的会话：
 * 访客只能操作自己的会话；客服可指定 conv。
 */
async function resolveConvId(request, ident, url, body) {
  if (!ident) return null;
  if (ident.role === 'visitor') return ident.convId;
  const convId = body ? body.conv || body.convId : null;
  return convId || url.searchParams.get('conv') || null;
}

/* ---------------------------------- 路由 ---------------------------------- */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') return json({ ok: true, ts: now() });

  // 客服口令校验（仅用于登录体验，实际写操作仍走 Bearer 校验）
  if (path === '/api/login' && method === 'POST') {
    const body = await safeBody(request);
    if (!env.AGENT_TOKEN) return fail('服务端未配置 AGENT_TOKEN', 500, 'not_configured');
    if (!body.token || body.token !== env.AGENT_TOKEN) return fail('口令不正确', 401, 'unauthorized');
    return json({ ok: true, name: env.AGENT_NAME || '客服', shop: env.SHOP_NAME || '在线客服' });
  }

  if (path === '/api/session' && method === 'POST') {
    return handleSession(request, env);
  }

  if (path === '/api/conversations' && method === 'GET') {
    const ident = await identify(request, env);
    if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');
    return handleConversationList(env);
  }

  if (path === '/api/messages' && method === 'GET') {
    return handleListMessages(request, env, url);
  }
  if (path === '/api/messages' && method === 'POST') {
    return handleSendMessage(request, env, url);
  }

  const msgAction = path.match(/^\/api\/messages\/(\d+)\/(recall|delete)$/);
  if (msgAction && method === 'POST') {
    return handleMessageAction(request, env, Number(msgAction[1]), msgAction[2]);
  }

  // 客服修改访客备注
  const renameMatch = path.match(/^\/api\/conversations\/([a-z0-9]+)\/rename$/);
  if (renameMatch && method === 'POST') {
    return handleRenameConv(request, env, renameMatch[1]);
  }

  if (path === '/api/upload' && method === 'POST') {
    return handleUpload(request, env, url);
  }
  if (path.startsWith('/api/file/') && method === 'GET') {
    return handleFile(env, url, path.slice('/api/file/'.length));
  }

  if (path === '/api/read' && method === 'POST') {
    return handleRead(request, env, url);
  }

  return fail('接口不存在', 404, 'not_found');
}

async function safeBody(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

/* ---------------------------------- 会话 ---------------------------------- */

const mapConv = (row) => ({
  id: row.id,
  name: row.visitor_name || '访客',
  preview: row.last_preview || '',
  lastMessageAt: row.last_message_at || row.created_at,
  createdAt: row.created_at,
  unread: row.unread || 0,
});

async function handleSession(request, env) {
  const body = await safeBody(request);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 24);

  if (token) {
    const conv = await env.DB.prepare('SELECT * FROM conversations WHERE visitor_token = ?')
      .bind(token)
      .first();
    if (conv) {
      if (name && name !== conv.visitor_name) {
        await env.DB.prepare('UPDATE conversations SET visitor_name = ?, updated_at = ? WHERE id = ?')
          .bind(name, now(), conv.id)
          .run();
        conv.visitor_name = name;
      }
      return json({ token, conv: mapConv(conv), shop: env.SHOP_NAME || '在线客服' });
    }
  }

  const newToken = token || uid(40);
  const id = uid(16);
  const t = now();
  const visitorName = name || '访客';

  await env.DB.prepare(
    'INSERT INTO conversations (id, visitor_token, visitor_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, newToken, visitorName, t, t)
    .run();

  // 新会话自动发送一条客服欢迎语（可在环境变量 WELCOME_MESSAGE 中自定义，留空则不发送）
  // 写入失败只记录日志，不阻断会话创建，访客仍可正常聊天
  const welcomeText = (env.WELCOME_MESSAGE || '您好！欢迎来到小旗搭建在线客服，请问有什么可以帮您？').trim();
  let preview = '';
  if (welcomeText) {
    try {
      await env.DB.prepare(
        `INSERT INTO messages (conv_id, sender, sender_name, type, body, created_at, updated_at)
         VALUES (?, 'agent', ?, 'text', ?, ?, ?)`
      )
        .bind(id, env.AGENT_NAME || '客服', welcomeText, t, t)
        .run();
      preview = `客服: ${welcomeText.slice(0, 40)}`;
      await env.DB.prepare(
        'UPDATE conversations SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?'
      )
        .bind(t, preview, t, id)
        .run();
    } catch (e) {
      console.error('welcome message insert failed', e);
    }
  }

  return json({
    token: newToken,
    conv: { id, name: visitorName, preview, lastMessageAt: t, createdAt: t, unread: 0 },
    shop: env.SHOP_NAME || '在线客服',
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

// 客服修改访客备注（仅客服身份可调用）
async function handleRenameConv(request, env, convId) {
  const ident = await identify(request, env);
  if (!ident || ident.role !== 'agent') return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const newName = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 24);
  if (!newName) return fail('备注不能为空', 400, 'empty');

  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ?')
    .bind(convId)
    .first();
  if (!conv) return fail('会话不存在', 404, 'not_found');

  await env.DB.prepare(
    'UPDATE conversations SET visitor_name = ?, updated_at = ? WHERE id = ?'
  )
    .bind(newName, now(), convId)
    .run();

  return json({ ok: true, name: newName });
}

/* ---------------------------------- 消息 ---------------------------------- */

async function handleListMessages(request, env, url) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const convId = await resolveConvId(request, ident, url, null);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');

  // 访客只能拉自己的会话
  if (ident.role === 'visitor' && convId !== ident.convId) {
    return fail('无权访问该会话', 403, 'forbidden');
  }

  const after = Number(url.searchParams.get('after') || 0) || 0;
  const since = Number(url.searchParams.get('since') || 0) || 0;
  const limit = 200;
  const hideColumn = ident.role === 'visitor' ? 'deleted_visitor' : 'deleted_agent';

  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
  if (!conv) return fail('会话不存在', 404, 'not_found');

  const fresh = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE conv_id = ? AND id > ? AND ${hideColumn} = 0
     ORDER BY id ASC LIMIT ?`
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
     WHERE conv_id = ? AND sender <> ? AND read_at IS NULL
       AND ${hideColumn} = 0 AND status = 'active'`
  )
    .bind(convId, ident.role)
    .first();

  return json({
    messages: (fresh.results || []).map(mapMessage),
    updates: updates.map(mapMessage),
    conv: {
      id: conv.id,
      name: conv.visitor_name || '访客',
      unread: (unreadRow && unreadRow.n) || 0,
      lastReadAt:
        ident.role === 'visitor' ? conv.visitor_last_read_at : conv.agent_last_read_at,
    },
    now: now(),
  });
}

const mapMessage = (row) => ({
  id: row.id,
  convId: row.conv_id,
  sender: row.sender,
  senderName: row.sender_name || (row.sender === 'agent' ? '客服' : '访客'),
  type: row.type,
  body: row.body || '',
  fileKey: row.file_key || '',
  fileSize: row.file_size || 0,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  readAt: row.read_at || 0,
});

async function handleSendMessage(request, env, url) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const body = await safeBody(request);
  const convId = await resolveConvId(request, ident, url, body);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');
  if (ident.role === 'visitor' && convId !== ident.convId) {
    return fail('无权访问该会话', 403, 'forbidden');
  }

  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
  if (!conv) return fail('会话不存在', 404, 'not_found');

  const type = body.type === 'image' ? 'image' : 'text';
  const text = (body.body || '').toString().trim();

  if (type === 'text') {
    if (!text) return fail('消息内容不能为空', 400, 'empty');
    if (text.length > 2000) return fail('消息过长（最多 2000 字）', 400, 'too_long');
  } else {
    const key = (body.fileKey || '').toString();
    if (!key || !key.startsWith(`${convId}/`)) return fail('图片标识无效', 400, 'invalid_file');
  }

  const t = now();
  const preview = type === 'image' ? '[图片]' : text.slice(0, 40);

  const row = await env.DB.prepare(
    `INSERT INTO messages (conv_id, sender, sender_name, type, body, file_key, file_size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(
      convId,
      ident.role,
      ident.name,
      type,
      text,
      type === 'image' ? body.fileKey : null,
      Number(body.fileSize) || 0,
      t,
      t
    )
    .first();

  await env.DB.prepare(
    'UPDATE conversations SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?'
  )
    .bind(t, `${ident.role === 'agent' ? '客服: ' : ''}${preview}`, t, convId)
    .run();

  return json({ message: mapMessage(row) });
}

async function handleMessageAction(request, env, id, action) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!msg) return fail('消息不存在', 404, 'not_found');

  if (ident.role === 'visitor' && msg.conv_id !== ident.convId) {
    return fail('无权操作该消息', 403, 'forbidden');
  }

  const hideColumn = ident.role === 'visitor' ? 'deleted_visitor' : 'deleted_agent';
  const t = now();

  if (action === 'delete') {
    await env.DB.prepare(`UPDATE messages SET ${hideColumn} = 1, updated_at = ? WHERE id = ?`)
      .bind(t, id)
      .run();
    return json({ ok: true, id, action: 'delete' });
  }

  // 撤回：只有发送方可以，且在时间窗内
  if (msg.sender !== ident.role) return fail('只能撤回自己发送的消息', 403, 'forbidden');
  if (msg.status === 'recalled') return json({ ok: true, id });

  const windowSec = Number(env.RECALL_WINDOW_SEC || 120);
  if (t - msg.created_at > windowSec * 1000) {
    return fail(`超过 ${windowSec} 秒，无法撤回`, 400, 'recall_expired');
  }

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
  if (ident.role === 'visitor' && convId !== ident.convId) {
    return fail('无权访问该会话', 403, 'forbidden');
  }

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

/* ---------------------------------- 图片 ---------------------------------- */

async function handleUpload(request, env, url) {
  const ident = await identify(request, env);
  if (!ident) return fail('未登录', 401, 'unauthorized');

  const convId = await resolveConvId(request, ident, url, null);
  if (!convId) return fail('缺少会话标识', 400, 'missing_conv');
  if (ident.role === 'visitor' && convId !== ident.convId) {
    return fail('无权访问该会话', 403, 'forbidden');
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('未收到文件', 400, 'no_file');

  const maxMb = Number(env.MAX_IMAGE_MB || 5);
  if (file.size > maxMb * 1024 * 1024) {
    return fail(`图片过大，请压缩到 ${maxMb}MB 以内`, 413, 'too_large');
  }

  const ext = IMAGE_TYPES[file.type];
  if (!ext) return fail('只支持 JPG / PNG / GIF / WebP 图片', 415, 'unsupported_type');

  const key = `${convId}/${uid(28)}.${ext}`;
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  });

  return json({ key, size: file.size, type: file.type });
}

async function handleFile(env, url, encodedKey) {
  const key = decodeURIComponent(encodedKey);
  if (!key || !/^[a-zA-Z0-9-]+\/[a-f0-9]+\.(jpg|png|gif|webp|avif)$/.test(key)) {
    return new Response('Not Found', { status: 404 });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');

  return new Response(obj.body, { headers });
}
