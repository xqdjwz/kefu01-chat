/**
 * 聊天核心：消息列表渲染 + 输入框 + 轮询同步 + 撤回/删除/已读
 * 访客端与客服端共用，靠 role 区分视角。
 */

const ICONS = {
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l5 5L16 8"/><path d="M11 12.5l3 3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l4.6-4.4a2 2 0 012.7 0L16 17"/><path d="M15 14l1.6-1.5a2 2 0 012.7 0L21 14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 11.6l15-6.8a.7.7 0 01.95.95l-6.8 15a.7.7 0 01-1.3 0l-2.4-5.7-5.7-2.4a.7.7 0 010-1.3z"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 9 9 0 01-3.8-.9L3 20l1.1-3.3A8.4 8.4 0 0112 3.1a8.4 8.4 0 019 8.4z"/></svg>',
};

const pad = (n) => String(n).padStart(2, '0');

// 轮询间隔（毫秒）。调大可省免费额度里的请求数，调小更实时。
const POLL_INTERVAL = 2500;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
    new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7 && diff > 1) return `${diff} 天前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

const clockTime = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* 图片压缩：手机原图动辄 5MB，压到长边 1600 再传，省流量也省 R2 空间 */
async function shrinkImage(file, maxDim = 1600, quality = 0.82) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 400 * 1024) {
    return file;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return blob && blob.size < file.size ? blob : file;
}

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function openLightbox(src) {
  let box = document.getElementById('lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    const img = document.createElement('img');
    img.alt = '';
    box.appendChild(img);
    box.addEventListener('click', () => box.classList.remove('open'));
    document.body.appendChild(box);
  }
  box.querySelector('img').src = src;
  box.classList.add('open');
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root   容器（将是 flex column）
 * @param {'visitor'|'agent'} opts.role
 * @param {string} opts.token       访客 token 或客服口令
 * @param {string} [opts.convId]    客服端打开的会话
 * @param {number} [opts.recallWindow] 撤回时限（秒）
 * @param {(conv)=>void} [opts.onMeta] 会话元信息回调（未读数等）
 * @param {string} [opts.emptyText]
 */
export function createChatHost(opts) {
  const {
    root,
    role,
    token,
    recallWindow = 120,
    onMeta,
    emptyText =
      role === 'agent'
        ? '选择左侧会话开始回复'
        : '有任何问题都可以在这里留言，我们会尽快回复',
  } = opts;

  let convId = opts.convId || null;
  let messages = [];
  let lastId = 0;
  let since = 0;
  let lastSig = '';
  let timer = null;
  let sending = false;
  let stick = true; // 用户是否停留在底部（用于自动吸底）

  /* ------------------------------ DOM ------------------------------ */
  root.innerHTML = `
    <div class="chat-scroll" role="log" aria-live="polite"><div class="chat-list"></div></div>
    <div class="composer">
      <div class="composer-inner">
        <button class="icon-btn" type="button" data-act="pick" title="发送图片" aria-label="发送图片">${ICONS.image}</button>
        <div class="composer-field">
          <textarea rows="1" placeholder="输入消息，Enter 发送" aria-label="消息输入框"></textarea>
        </div>
        <button class="send-btn" type="button" data-act="send" title="发送" aria-label="发送" disabled>${ICONS.send}</button>
        <input type="file" accept="image/*" hidden>
      </div>
    </div>
  `;

  const scroll = root.querySelector('.chat-scroll');
  const list = root.querySelector('.chat-list');
  const composer = root.querySelector('.composer');
  const textarea = composer.querySelector('textarea');
  const sendBtn = composer.querySelector('[data-act="send"]');
  const pickBtn = composer.querySelector('[data-act="pick"]');
  const fileInput = composer.querySelector('input[type="file"]');

  /* ------------------------------ 请求 ------------------------------ */
  function authHeaders(extra = {}) {
    if (role === 'visitor') return { 'x-visitor-token': token, ...extra };
    return { authorization: `Bearer ${token}`, ...extra };
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
    return data;
  }

  async function upload(file) {
    const blob = await shrinkImage(file);
    const fd = new FormData();
    const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    fd.append('file', blob, `photo-${Date.now()}.${ext}`);
    const res = await fetch(`/api/upload?conv=${encodeURIComponent(convId)}`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '图片上传失败');
    return data;
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function emptyNode() {
    const div = document.createElement('div');
    div.className = 'chat-empty';
    div.innerHTML = `${ICONS.empty}<p>${emptyText}</p>`;
    return div;
  }

  function needDaySep(prevTs, ts) {
    return !prevTs || dayKey(prevTs) !== dayKey(ts);
  }

  function messageNode(m) {
    const mine = m.sender === role;

    if (m.status === 'recalled') {
      const line = document.createElement('div');
      line.className = 'sys-line';
      line.textContent = mine ? '你撤回了一条消息' : `${m.senderName}撤回了一条消息`;
      line.dataset.id = m.id;
      return line;
    }

    const wrap = document.createElement('div');
    wrap.className = `msg ${mine ? 'me' : 'other'}`;
    wrap.dataset.id = m.id;

    const av = document.createElement('div');
    av.className = 'avatar-sm';
    av.textContent = mine ? (role === 'agent' ? '客' : '我') : (m.senderName || '客').slice(0, 1);

    const main = document.createElement('div');
    main.className = 'msg-main';

    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (m.type === 'image' ? ' img-bubble' : '');

    if (m.type === 'image' && m.fileKey) {
      const img = document.createElement('img');
      img.src = `/api/file/${m.fileKey}`;
      img.alt = '聊天图片';
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(img.src));
      img.addEventListener('load', () => {
        if (stick) toBottom();
      });
      bubble.appendChild(img);
      if (m.body) {
        const cap = document.createElement('div');
        cap.style.cssText = 'font-size:13px;padding:4px 6px 2px;line-height:1.5;';
        cap.textContent = m.body;
        bubble.appendChild(cap);
      }
    } else {
      bubble.textContent = m.body || '';
    }

    main.appendChild(bubble);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = document.createElement('span');
    time.textContent = clockTime(m.createdAt);
    meta.appendChild(time);

    if (mine) {
      const state = document.createElement('span');
      state.className = 'state-pill ' + (m.readAt ? 'read' : 'unread');
      state.innerHTML = m.readAt ? `${ICONS.check}<span>已读</span>` : '';
      if (!m.readAt) state.textContent = '未读';
      meta.appendChild(state);
    }
    main.appendChild(meta);

    /* 操作按钮 */
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const dots = document.createElement('button');
    dots.type = 'button';
    dots.className = 'btn-dots';
    dots.setAttribute('aria-label', '消息操作');
    dots.innerHTML = ICONS.more;
    dots.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu(main, m);
    });
    actions.appendChild(dots);

    wrap.appendChild(av);
    wrap.appendChild(main);
    main.appendChild(actions);
    return wrap;
  }

  function buildMenu(m) {
    const menu = document.createElement('div');
    menu.className = 'pop-menu';

    const canRecall =
      m.sender === role && m.status === 'active' && Date.now() - m.createdAt <= recallWindow * 1000;

    if (canRecall) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '撤回';
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeMenus();
        if (!confirm('撤回后对方将看不到这条消息，确定撤回？')) return;
        try {
          await api(`/api/messages/${m.id}/recall`, { method: 'POST' });
          patchLocal(m.id, { status: 'recalled', body: '', fileKey: '', updatedAt: Date.now() });
          toast('已撤回');
          render(true);
        } catch (err) {
          toast(err.message);
        }
      });
      menu.appendChild(b);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenus();
      try {
        await api(`/api/messages/${m.id}/delete`, { method: 'POST' });
        messages = messages.filter((x) => x.id !== m.id);
        render(true);
      } catch (err) {
        toast(err.message);
      }
    });
    menu.appendChild(del);
    return menu;
  }

  function toggleMenu(container, m) {
    const existing = container.querySelector('.pop-menu');
    closeMenus();
    if (existing) return;
    const menu = buildMenu(m);
    container.appendChild(menu);

    // 靠近底部时向上弹出，避免被输入框遮住
    const menuRect = menu.getBoundingClientRect();
    const visible = scroll.getBoundingClientRect();
    if (menuRect.bottom > visible.bottom - 8) menu.classList.add('up');
  }

  function closeMenus() {
    document.querySelectorAll('.pop-menu').forEach((n) => n.remove());
  }

  document.addEventListener('click', closeMenus);

  function isNearBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  }

  scroll.addEventListener('scroll', () => {
    stick = isNearBottom();
  });

  function toBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function render(force = false) {
    const sig =
      messages.map((m) => `${m.id}:${m.updatedAt}:${m.readAt}:${m.status}`).join('|') + `#${convId}`;
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const wasStick = stick;
    list.innerHTML = '';

    if (!messages.length) {
      list.appendChild(emptyNode());
      return;
    }

    let prevTs = 0;
    for (const m of messages) {
      if (needDaySep(prevTs, m.createdAt)) {
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.textContent = dayLabel(m.createdAt);
        list.appendChild(sep);
      }
      prevTs = m.createdAt;
      list.appendChild(messageNode(m));
    }

    // 首次渲染、发送后、或用户本来就在底部时，吸到底部
    if (wasStick || force) {
      toBottom();
      requestAnimationFrame(toBottom);
    }
  }

  function patchLocal(id, patch) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) messages[idx] = { ...messages[idx], ...patch };
    lastSig = '';
  }

  function pushMessages(list) {
    let changed = false;
    for (const m of list) {
      if (messages.some((x) => x.id === m.id)) continue;
      messages.push(m);
      changed = true;
    }
    if (changed) {
      messages.sort((a, b) => a.id - b.id);
      lastId = Math.max(lastId, ...messages.map((m) => m.id));
      lastSig = '';
    }
  }

  function mergeMessages(list) {
    let changed = false;
    for (const m of list) {
      const idx = messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) {
        if (messages[idx].updatedAt !== m.updatedAt || messages[idx].readAt !== m.readAt) {
          messages[idx] = m;
          changed = true;
        }
      }
    }
    if (changed) lastSig = '';
  }

  /* ------------------------------ 同步 ------------------------------ */
  async function pull(initial = false) {
    if (!convId) return;
    const q = new URLSearchParams({ conv: convId });
    if (!initial) {
      q.set('after', String(lastId));
      if (since > 0) q.set('since', String(since));
    }
    const data = await api(`/api/messages?${q.toString()}`);

    if (data.messages && data.messages.length) pushMessages(data.messages);
    if (data.updates && data.updates.length) {
      mergeMessages(data.updates);
      since = Math.max(since, ...data.updates.map((m) => m.updatedAt || 0));
    }
    if (data.messages && data.messages.length) {
      since = Math.max(since, ...data.messages.map((m) => m.updatedAt || 0));
    }

    render();
    if (onMeta && data.conv) onMeta(data.conv);

    if (data.conv && data.conv.unread > 0 && document.visibilityState === 'visible') {
      await markRead();
    }
  }

  async function markRead() {
    if (!convId) return;
    try {
      await api('/api/read', { method: 'POST', body: { conv: convId } });
    } catch {
      /* 忽略 */
    }
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      pull().catch(() => {});
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && convId) pull().catch(() => {});
  });

  /* ------------------------------ 发送 ------------------------------ */
  function resize() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    sendBtn.disabled = !textarea.value.trim() || sending;
  }

  textarea.addEventListener('input', resize);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendText();
    }
  });

  sendBtn.addEventListener('click', sendText);

  async function sendText() {
    const text = textarea.value.trim();
    if (!text || sending || !convId) return;
    sending = true;
    sendBtn.disabled = true;
    try {
      const res = await api('/api/messages', {
        method: 'POST',
        body: { conv: convId, type: 'text', body: text },
      });
      textarea.value = '';
      resize();
      if (res.message) {
        pushMessages([res.message]);
        render(true);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      sending = false;
      resize();
    }
  }

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file || !convId) return;
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件');
      return;
    }
    pickBtn.disabled = true;
    try {
      const up = await upload(file);
      const res = await api('/api/messages', {
        method: 'POST',
        body: { conv: convId, type: 'image', fileKey: up.key, fileSize: up.size },
      });
      if (res.message) {
        pushMessages([res.message]);
        render(true);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      pickBtn.disabled = false;
    }
  });

  /* ------------------------------ 对外 ------------------------------ */
  function setConv(id) {
    if (convId === id) return;
    convId = id;
    messages = [];
    lastId = 0;
    since = 0;
    lastSig = '';
    render(true);
    if (id) {
      pull(true).catch((e) => toast(e.message));
      startPolling();
    } else {
      stopPolling();
    }
  }

  function refresh() {
    return pull(true);
  }

  function destroy() {
    stopPolling();
  }

  if (convId) {
    render(true);
    pull(true).catch((e) => toast(e.message));
    startPolling();
  } else {
    render(true);
  }

  return { setConv, refresh, destroy };
}

export { toast };
