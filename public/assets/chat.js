/**
 * 聊天核心：消息渲染 + 输入框 + 表情面板 + 图片 + 轮询同步 + 撤回/删除/已读
 * 访客端与客服端共用，靠 role 区分视角。
 */

const ICONS = {
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l5 5L16 8"/><path d="M11 12.5l3 3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l4.6-4.4a2 2 0 012.7 0L16 17"/><path d="M15 14l1.6-1.5a2 2 0 012.7 0L21 14"/></svg>',
  emoji: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="8.8" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.2" cy="10" r="1.1" fill="currentColor" stroke="none"/><path d="M8.2 14.4c.9 1.7 2.3 2.5 3.8 2.5s2.9-.8 3.8-2.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 11.6l15-6.8a.7.7 0 01.95.95l-6.8 15a.7.7 0 01-1.3 0l-2.4-5.7-5.7-2.4a.7.7 0 010-1.3z"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 9 9 0 01-3.8-.9L3 20l1.1-3.3A8.4 8.4 0 0112 3.1a8.4 8.4 0 019 8.4z"/></svg>',
};

/* 表情面板：常用一组，点一下插到光标处 */
const EMOJI_LIST = [
  '😀','😃','😄','😁','😆','😅','😂','🤣','😊','🙂','😉','😍','🥰','😘','😋','😎',
  '🤩','🥳','😏','😢','😭','😤','😡','🤔','🤗','🤭','😴','😷','🤒','🥺','😳','😱',
  '👍','👎','👏','🙏','🤝','💪','👌','✌️','🤞','👋','🙋','🫡','👀','💯','🔥','✨',
  '❤️','💔','💗','💖','🌹','🎉','🎁','🌟','⭐','🌈','☀️','🌙','☕','🍰','🍜','🍎',
];

const pad2 = (n) => String(n).padStart(2, '0');

// 前台可见时 2 秒同步一次；切到后台降频到 8 秒（不停摆，回来立刻补拉）
const POLL_VISIBLE = 2000;
const POLL_HIDDEN = 8000;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
      new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000
  );
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 1 && diff < 7) return `${diff} 天前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

const clockTime = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\u200d\uFE0F\s]+$/u;

/* 图片压缩：手机原图常 5MB，压到长边 1400、控制在 400KB 内 */
async function shrinkImage(file, maxDim = 1400, targetBytes = 400 * 1024) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  if (!bitmap.width || !bitmap.height) return file;

  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= targetBytes) return file;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  let quality = 0.82;
  let blob = null;
  for (let i = 0; i < 5; i++) {
    blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) break;
    if (blob.size <= targetBytes) break;
    quality -= 0.12;
  }
  if (blob && (blob.size < file.size || file.size > targetBytes)) {
    blob.name = 'photo.jpg';
    return blob;
  }
  return file;
}

export function toast(msg) {
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
 * @param {HTMLElement} opts.root
 * @param {'visitor'|'agent'} opts.role
 * @param {string} opts.token
 * @param {string|null} [opts.convId]
 * @param {number} [opts.recallWindow]
 * @param {(conv)=>void} [opts.onMeta]
 * @param {()=>void} [opts.onChange]
 * @param {string} [opts.emptyText]
 */
export function createChatHost(opts) {
  const {
    root,
    role,
    token,
    recallWindow = 120,
    onMeta,
    onChange,
    emptyText =
      role === 'agent' ? '选择左侧会话开始回复' : '有任何问题都可以在这里留言，我们会尽快回复',
    selfName = '',
    selfAvatarUrl = '',
    peerAvatarUrl = '',
  } = opts;

  let convId = opts.convId || null;
  let messages = [];
  let lastId = 0;
  let since = 0;
  let lastSig = '';
  let timer = null;
  let sending = false;
  let stick = true;

  /* ------------------------------- 骨架 ------------------------------- */
  root.innerHTML = `
    <div class="chat-scroll" role="log" aria-live="polite"><div class="chat-list"></div></div>
    <div class="composer">
      <div class="emoji-panel" hidden></div>
      <div class="composer-inner">
        <button class="icon-btn" type="button" data-act="pick" title="发送图片" aria-label="发送图片">${ICONS.image}</button>
        <button class="icon-btn" type="button" data-act="emoji" title="表情" aria-label="表情">${ICONS.emoji}</button>
        <div class="composer-field">
          <textarea rows="1" placeholder="输入消息，Enter 发送" aria-label="消息输入框" maxlength="1000"></textarea>
        </div>
        <button class="send-btn" type="button" data-act="send" title="发送" aria-label="发送" disabled>${ICONS.send}</button>
        <input type="file" accept="image/*" hidden>
      </div>
    </div>
  `;

  const scroll = root.querySelector('.chat-scroll');
  const list = root.querySelector('.chat-list');
  const composer = root.querySelector('.composer');
  const emojiPanel = composer.querySelector('.emoji-panel');
  const textarea = composer.querySelector('textarea');
  const sendBtn = composer.querySelector('[data-act="send"]');
  const pickBtn = composer.querySelector('[data-act="pick"]');
  const emojiBtn = composer.querySelector('[data-act="emoji"]');
  const fileInput = composer.querySelector('input[type="file"]');

  /* ------------------------------- 请求 ------------------------------- */
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
    if (!res.ok) {
      const err = new Error(data.message || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function upload(file) {
    const blob = await shrinkImage(file);
    const fd = new FormData();
    const ext = ((blob.type || 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
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

  /* ------------------------------- 渲染 ------------------------------- */
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
      line.textContent = mine ? '你撤回了一条消息' : `${m.senderName || '对方'}撤回了一条消息`;
      line.dataset.id = m.id;
      return line;
    }

    const wrap = document.createElement('div');
    wrap.className = `msg ${mine ? 'me' : 'other'}`;
    wrap.dataset.id = m.id;

    const myName = selfName || (role === 'agent' ? '客服' : '我');
    const otherName = m.senderName || (role === 'agent' ? '访客' : '客服');
    const displayName = mine ? myName : otherName;
    const avatarUrl = mine ? selfAvatarUrl : peerAvatarUrl;

    const av = document.createElement('div');
    av.className = 'avatar-sm';
    if (avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar-img';
      img.src = avatarUrl;
      img.alt = displayName;
      img.onerror = () => {
        av.textContent = displayName.slice(0, 1);
      };
      av.appendChild(img);
    } else {
      av.textContent = displayName.slice(0, 1);
    }

    const main = document.createElement('div');
    main.className = 'msg-main';

    if (!mine && otherName) {
      const name = document.createElement('div');
      name.className = 'msg-name';
      name.textContent = otherName;
      main.appendChild(name);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (m.type === 'image' ? ' img-bubble' : '');
    if (m.type === 'text' && m.body && EMOJI_ONLY.test(m.body) && m.body.length <= 8) {
      bubble.classList.add('emoji-bubble');
    }

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
        cap.className = 'img-cap';
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
      state.innerHTML = m.readAt ? `${ICONS.check}<span>已读</span>` : '<span>未读</span>';
      meta.appendChild(state);
    }
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

    main.appendChild(meta);
    meta.appendChild(actions);

    wrap.appendChild(av);
    wrap.appendChild(main);
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
        if (!confirm('撤回后双方都看不到这条消息，确定撤回？')) return;
        try {
          await api(`/api/messages/${m.id}/recall`, { method: 'POST' });
          patchLocal(m.id, { status: 'recalled', body: '', fileKey: '', updatedAt: Date.now() });
          render(true);
          toast('已撤回');
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
        lastSig = '';
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

    const menuRect = menu.getBoundingClientRect();
    const visible = scroll.getBoundingClientRect();
    if (menuRect.bottom > visible.bottom - 8) menu.classList.add('up');
  }

  function closeMenus() {
    root.querySelectorAll('.pop-menu').forEach((n) => n.remove());
  }

  root.addEventListener('click', (e) => {
    if (!e.target.closest('.msg-actions') && !e.target.closest('.pop-menu')) closeMenus();
  });

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

  function pushMessages(items) {
    let changed = false;
    for (const m of items) {
      if (messages.some((x) => x.id === m.id)) continue;
      messages.push(m);
      changed = true;
    }
    if (changed) {
      messages.sort((a, b) => a.id - b.id);
      lastId = Math.max(lastId, ...messages.map((m) => m.id));
      lastSig = '';
    }
    return changed;
  }

  function mergeMessages(items) {
    let changed = false;
    for (const m of items) {
      const idx = messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) {
        if (messages[idx].updatedAt !== m.updatedAt || messages[idx].readAt !== m.readAt) {
          messages[idx] = m;
          changed = true;
        }
      }
    }
    if (changed) lastSig = '';
    return changed;
  }

  /* ------------------------------- 同步 ------------------------------- */
  let pulling = false;

  async function pull(initial = false) {
    if (!convId || pulling) return;
    pulling = true;
    const snapshot = convId;
    try {
      const q = new URLSearchParams({ conv: convId });
      if (!initial) {
        q.set('after', String(lastId));
        if (since > 0) q.set('since', String(since));
      }
      const data = await api(`/api/messages?${q.toString()}`);

      // 期间切换了会话，这批结果直接丢弃
      if (snapshot !== convId) return;

      let changed = false;
      if (data.messages && data.messages.length) {
        changed = pushMessages(data.messages) || changed;
        since = Math.max(since, ...data.messages.map((m) => m.updatedAt || 0));
      }
      if (data.updates && data.updates.length) {
        changed = mergeMessages(data.updates) || changed;
        since = Math.max(since, ...data.updates.map((m) => m.updatedAt || 0));
      }

      if (changed) {
        render();
        if (onChange) onChange();
      }
      if (onMeta && data.conv) onMeta(data.conv);

      if (data.conv && data.conv.unread > 0 && document.visibilityState === 'visible') {
        await markRead();
      }
    } finally {
      pulling = false;
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

  function schedule() {
    stopPolling();
    const delay = document.visibilityState === 'visible' ? POLL_VISIBLE : POLL_HIDDEN;
    timer = setTimeout(async () => {
      try {
        await pull();
      } catch {
        /* 断网时下一轮自动重试 */
      }
      schedule();
    }, delay);
  }

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!convId) return;
    if (document.visibilityState === 'visible') pull().catch(() => {});
    schedule();
  });

  /* ------------------------------- 输入 ------------------------------- */
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

  function buildEmojiPanel() {
    const frag = document.createDocumentFragment();
    for (const emoji of EMOJI_LIST) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-item';
      b.textContent = emoji;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        insertAtCursor(emoji);
      });
      frag.appendChild(b);
    }
    emojiPanel.appendChild(frag);
  }
  buildEmojiPanel();

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPanel.hidden = !emojiPanel.hidden;
    if (!emojiPanel.hidden) textarea.focus();
  });

  composer.addEventListener('click', (e) => {
    if (!e.target.closest('.emoji-panel') && !e.target.closest('[data-act="emoji"]')) {
      emojiPanel.hidden = true;
    }
  });

  function insertAtCursor(text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    const pos = start + text.length;
    try {
      textarea.setSelectionRange(pos, pos);
    } catch {}
    textarea.focus();
    resize();
  }

  async function sendText() {
    const text = textarea.value.trim();
    if (!text || sending || !convId) return;
    sending = true;
    sendBtn.disabled = true;
    emojiPanel.hidden = true;
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
      } else {
        await pull();
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
    const oldTitle = pickBtn.title;
    pickBtn.title = '上传中…';
    try {
      const up = await upload(file);
      const res = await api('/api/messages', {
        method: 'POST',
        body: { conv: convId, type: 'image', fileKey: up.key, fileSize: up.size },
      });
      if (res.message) {
        pushMessages([res.message]);
        render(true);
      } else {
        await pull();
      }
    } catch (err) {
      toast(err.message);
    } finally {
      pickBtn.disabled = false;
      pickBtn.title = oldTitle;
    }
  });

  /* ------------------------------- 对外 ------------------------------- */
  function setConv(id) {
    if (convId === id) return;
    convId = id;
    messages = [];
    lastId = 0;
    since = 0;
    lastSig = '';
    emojiPanel.hidden = true;
    textarea.value = '';
    resize();
    render(true);
    if (id) {
      pull(true).catch((e) => toast(e.message));
      schedule();
    } else {
      stopPolling();
    }
  }

  function refresh() {
    return pull(true);
  }

  function destroy() {
    stopPolling();
    closeMenus();
  }

  if (convId) {
    render(true);
    pull(true).catch(() => {});
    schedule();
  } else {
    render(true);
  }

  return { setConv, refresh, destroy };
}
