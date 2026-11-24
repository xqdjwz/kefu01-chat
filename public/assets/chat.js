// chat.js v3.4 访客端 + 客服端共用
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = localStorage.getItem('agent_token') || localStorage.getItem('visitor_token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !opts.allowError) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============== 访客端 ==============
const Visitor = {
  conv: null, settings: null, lastId: 0, since: '0', timer: null, closed: false,

  async init() {
    const token = localStorage.getItem('visitor_token') || '';
    const r = await api('/api/session', { method: 'POST', body: { token, referer: location.href, device: navigator.userAgent.slice(0, 80) } });
    localStorage.setItem('visitor_token', r.token);
    this.conv = r.conv; this.settings = r.settings;
    if (this.settings.shop_name) $('.v-title').textContent = this.settings.shop_name;
    await this.poll(true);
    this.timer = setInterval(() => this.poll(false), 3000);
    $('#send-btn').addEventListener('click', () => this.send());
    $('#msg-input').addEventListener('keydown', e => { if (e.key === 'Enter') this.send(); });
  },

  async poll(initial) {
    if (!this.conv) return;
    try {
      const r = await api(`/api/messages?conv=${this.conv.id}&after=${this.lastId}&since=${encodeURIComponent(this.since)}`, { allowError: true });
      if (r.messages) {
        for (const m of r.messages) this.appendMsg(m);
        if (r.messages.length) this.lastId = Math.max(this.lastId, ...r.messages.map(x => x.id));
      }
      if (r.updates) this.applyUpdates(r.updates);
      if (r.conv) this.applyConvState(r.conv);
      if (r.settings) this.settings = r.settings;
      if (!initial) api('/api/read', { method: 'POST', body: { conv: this.conv.id } }).catch(() => {});
      this.scrollBottom();
    } catch (e) { /* 静默 */ }
  },

  applyConvState(conv) {
    this.closed = conv.status === 'closed';
    const banner = $('#closed-banner');
    const input = $('#msg-input'), btn = $('#send-btn');
    if (this.closed) {
      banner.textContent = (this.settings && this.settings.end_message) || '本次咨询已结束。';
      banner.classList.add('show');
      input.disabled = true; btn.disabled = true;
    } else {
      banner.classList.remove('show');
      input.disabled = false; btn.disabled = false;
    }
  },

  applyUpdates(updates) {
    for (const u of updates) {
      const el = document.querySelector(`[data-mid="${u.id}"]`);
      if (!el) continue;
      if (u.status === 'recalled') { el.querySelector('.bubble').innerHTML = '<i>消息已撤回</i>'; }
      if (u.deleted_visitor) el.remove();
    }
  },

  appendMsg(m) {
    if (m.deleted_visitor) return;
    const list = $('#messages');
    let el = document.querySelector(`[data-mid="${m.id}"]`);
    if (el) return;
    el = document.createElement('div');
    el.dataset.mid = m.id;
    el.className = 'msg ' + (m.sender === 'visitor' ? 'mine' : 'other');
    const avatar = m.sender === 'visitor' ? '我' : (this.settings?.agent_name || '客');
    let bodyHtml = '';
    if (m.type === 'link') {
      try {
        const lk = JSON.parse(m.body);
        bodyHtml = `<a class="link-card" href="${escapeHtml(lk.url)}" target="_blank" rel="noopener">
          <div class="lc-icon">📹</div><div><div class="lc-title">${escapeHtml(lk.title)}</div><div class="lc-url">${escapeHtml(lk.url)}</div></div></a>`;
      } catch { bodyHtml = escapeHtml(m.body); }
    } else if (m.file_key) {
      bodyHtml = `<img src="/api/file/${m.file_key}" alt="图片">`;
    } else if (m.status === 'recalled') {
      bodyHtml = '<i>消息已撤回</i>';
    } else {
      bodyHtml = escapeHtml(m.body);
    }
    let tags = '';
    if (m.ai_reply) tags = '<span class="tag ai">AI</span> ';
    else if (m.auto_reply) tags = '<span class="tag auto">自动回复</span> ';
    el.innerHTML = `<div class="avatar-sm">${escapeHtml(avatar)}</div><div class="msg-main">
      <div class="bubble">${bodyHtml}</div>
      <div class="meta">${tags}${fmtTime(m.created_at)}</div></div>`;
    list.appendChild(el);
    this.scrollBottom();
  },

  scrollBottom() {
    const list = $('#messages');
    list.scrollTop = list.scrollHeight;
  },

  async send() {
    const input = $('#msg-input');
    const text = input.value.trim();
    if (!text || this.closed) return;
    input.value = '';
    try {
      const r = await api('/api/messages', { method: 'POST', body: { conv: this.conv.id, body: text } });
      if (r.closed) { toast(r.end_message || '对话已结束'); this.applyConvState({ status: 'closed' }); return; }
      if (r.ok) this.poll(false);
    } catch (e) { toast(e.message); }
  },
};

// ============== 客服端 ==============
const Agent = {
  convs: [], current: null, lastVisitorAt: 0, timer: null, settings: {},

  async login(password, name) {
    const r = await api('/api/login', { method: 'POST', body: { password, name } });
    localStorage.setItem('agent_token', r.token);
    $('#login-screen').style.display = 'none';
    $('#app').style.display = 'flex';
    await this.loadSettings();
    await this.loadConvs();
    this.timer = setInterval(() => this.loadConvs(true), 5000);
  },

  async loadSettings() {
    const r = await api('/api/settings');
    this.settings = r.settings;
  },

  async loadConvs(poll = false) {
    const r = await api('/api/conversations', { allowError: true });
    if (!r.conversations) return;
    this.convs = r.conversations;
    this.renderList();
    if (poll && this.current) {
      const fresh = this.convs.find(c => c.id === this.current.id);
      if (fresh) {
        const last = fresh.last_message_at || '';
        if (last > this.lastVisitorAt && fresh.unread > 0 && fresh.status === 'open' && !fresh.blocked) {
          this.playRing();
        }
      }
    }
  },

  playRing() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.08;
      o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 300);
    } catch {}
  },

  renderList() {
    const list = $('#conv-list');
    list.innerHTML = '';
    // 合并客户组折叠：同一 customer_id 只显示主会话
    const shown = new Set();
    for (const c of this.convs) {
      if (c.customer_id) {
        if (c.id !== c.primaryId) continue;
        if (shown.has(c.customer_id)) continue;
        shown.add(c.customer_id);
      }
      list.appendChild(this.convItem(c));
    }
  },

  convItem(c) {
    const el = document.createElement('div');
    el.className = 'conv-item' + (this.current && this.current.id === c.id ? ' active' : '');
    const badges = [];
    if (c.groupCount >= 2) badges.push(`<span class="badge ip" data-ip-badge>同IP×${c.groupCount}</span>`);
    if (c.customer_id) badges.push(`<span class="badge cust">客户组×${c.memberCount || 1}</span>`);
    if (c.status === 'closed') badges.push('<span class="badge closed">已结束</span>');
    if (c.blocked) badges.push('<span class="badge blocked">已拉黑</span>');
    const actions = [];
    if (c.groupCount >= 2 && !c.customer_id) actions.push(`<button data-act="merge">合并为同一客户</button>`);
    if (c.customer_id) actions.push(`<button data-act="split">拆分取消合并</button>`);
    actions.push(`<button data-act="remark">备注</button>`);
    actions.push(`<button data-act="block" class="danger">${c.blocked ? '解除拉黑' : '拉黑'}</button>`);
    actions.push(`<button data-act="del" class="danger">删除会话</button>`);
    el.innerHTML = `
      <div class="c-row1"><span class="c-name">${escapeHtml(c.remark || c.visitor_name || ('访客#' + c.id))}</span>
        ${c.unread ? `<span class="unread-dot">${c.unread}</span>` : ''}</div>
      <div class="c-preview">${escapeHtml(c.last_preview || '（暂无消息）')}</div>
      <div class="c-meta">${badges.join(' ')}<span>${c.geo_ip ? 'IP:' + escapeHtml(c.geo_ip) : '无IP'}</span><span>${fmtTime(c.last_message_at)}</span></div>
      <div class="c-actions">${actions.join('')}</div>`;
    el.addEventListener('click', e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act) { e.stopPropagation(); this.itemAction(act, c); return; }
      this.selectConv(c);
    });
    return el;
  },

  async itemAction(act, c) {
    try {
      if (act === 'merge') {
        if (!confirm('将同IP的多个会话合并为同一客户？（不删消息、不删会话）')) return;
        await api(`/api/conversations/${c.id}/merge`, { method: 'POST' });
        toast('已合并为同一客户'); this.loadConvs();
      } else if (act === 'split') {
        if (!confirm('取消合并，拆分为独立会话？')) return;
        await api(`/api/conversations/${c.id}/split`, { method: 'POST' });
        toast('已拆分'); this.loadConvs();
      } else if (act === 'remark') {
        const remark = prompt('填写客户备注：', c.remark || '');
        if (remark === null) return;
        await api(`/api/conversations/${c.id}/remark`, { method: 'POST', body: { remark } });
        this.loadConvs();
      } else if (act === 'block') {
        await api(`/api/conversations/${c.id}/block`, { method: 'POST', body: { blocked: !c.blocked } });
        this.loadConvs();
      } else if (act === 'del') {
        if (!confirm('确定删除该会话及其全部消息？')) return;
        await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
        if (this.current && this.current.id === c.id) { this.current = null; $('#messages').innerHTML = ''; }
        this.loadConvs();
      }
    } catch (e) { toast(e.message); }
  },

  async selectConv(c) {
    this.current = c;
    this.lastVisitorAt = c.last_message_at || '';
    $$('.conv-item').forEach(x => x.classList.remove('active'));
    this.renderList();
    $('#chat-title').textContent = c.remark || c.visitor_name || ('访客#' + c.id);
    await this.loadMessages();
    this.renderTopbar();
    api('/api/read', { method: 'POST', body: { conv: c.id } }).catch(() => {});
  },

  renderTopbar() {
    const c = this.current;
    const box = $('#topbar-btns');
    if (!c) { box.innerHTML = ''; return; }
    const closed = c.status === 'closed';
    box.innerHTML = `
      <button class="tbtn ${closed ? 'primary' : 'warn'}" data-top="close">${closed ? '重新打开' : '结束对话'}</button>
      <button class="tbtn" data-top="link">📹 视频/语音</button>
      <button class="tbtn" data-top="block">${c.blocked ? '解除拉黑' : '拉黑'}</button>
      <button class="tbtn danger" data-top="del">删除会话</button>
      <button class="tbtn" data-top="export">导出CSV</button>
      <button class="tbtn" data-top="settings">⚙ 设置</button>`;
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => this.topAction(b.dataset.top)));
  },

  async topAction(act) {
    const c = this.current; if (!c) return;
    try {
      if (act === 'close') {
        if (c.status === 'closed') {
          await api(`/api/conversations/${c.id}/reopen`, { method: 'POST' });
          toast('已重新打开对话');
        } else {
          if (!confirm('结束对话？结束后访客将看到结束提示，不再响铃/推送/触发AI。')) return;
          await api(`/api/conversations/${c.id}/close`, { method: 'POST' });
          toast('对话已结束');
        }
        await this.loadConvs(); this.selectConv({ ...c, status: c.status === 'closed' ? 'open' : 'closed' });
      } else if (act === 'link') {
        this.openLinkPanel();
      } else if (act === 'block') {
        await api(`/api/conversations/${c.id}/block`, { method: 'POST', body: { blocked: !c.blocked } });
        this.loadConvs(); this.selectConv(c);
      } else if (act === 'del') {
        if (!confirm('确定删除该会话及其全部消息？')) return;
        await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
        this.current = null; $('#messages').innerHTML = ''; $('#chat-title').textContent = '选择会话';
        this.loadConvs();
      } else if (act === 'export') {
        location.href = '/api/export';
      } else if (act === 'settings') {
        this.openSettings();
      }
    } catch (e) { toast(e.message); }
  },

  async loadMessages() {
    const r = await api(`/api/messages?conv=${this.current.id}`);
    const list = $('#messages');
    list.innerHTML = '';
    for (const m of r.messages || []) this.appendAgentMsg(m);
    list.scrollTop = list.scrollHeight;
  },

  appendAgentMsg(m) {
    if (m.deleted_agent) return;
    const list = $('#messages');
    let el = document.querySelector(`[data-mid="${m.id}"]`);
    if (el) return;
    el = document.createElement('div');
    el.dataset.mid = m.id;
    el.className = 'msg ' + (m.sender === 'agent' ? 'mine' : 'other');
    let bodyHtml = '';
    if (m.type === 'link') {
      try {
        const lk = JSON.parse(m.body);
        bodyHtml = `<a class="link-card" href="${escapeHtml(lk.url)}" target="_blank" rel="noopener">
          <div class="lc-icon">📹</div><div><div class="lc-title">${escapeHtml(lk.title)}</div><div class="lc-url">${escapeHtml(lk.url)}</div></div></a>`;
      } catch { bodyHtml = escapeHtml(m.body); }
    } else if (m.file_key) {
      bodyHtml = `<img src="/api/file/${m.file_key}">`;
    } else {
      bodyHtml = escapeHtml(m.body);
    }
    let tags = '';
    if (m.ai_reply) tags = '<span class="tag ai">AI回复</span> ';
    else if (m.auto_reply) tags = '<span class="tag auto">自动回复</span> ';
    el.innerHTML = `<div class="avatar-sm">${m.sender === 'agent' ? '客' : '访'}</div><div class="msg-main">
      <div class="bubble">${bodyHtml}</div><div class="meta">${tags}${fmtTime(m.created_at)}</div></div>`;
    list.appendChild(el);
  },

  async sendReply() {
    const input = $('#a-input');
    const text = input.value.trim();
    if (!text || !this.current) return;
    input.value = '';
    await api('/api/messages', { method: 'POST', body: { conv: this.current.id, body: text } });
    this.loadMessages(); this.loadConvs();
  },

  // ---------- 链接面板 ----------
  openLinkPanel() {
    $('#link-modal').classList.add('show');
    $('#link-title').value = ''; $('#link-url').value = '';
  },

  async sendLink() {
    const title = $('#link-title').value.trim();
    const url = $('#link-url').value.trim();
    try {
      await api(`/api/conversations/${this.current.id}/link`, { method: 'POST', body: { title, url } });
      $('#link-modal').classList.remove('show');
      toast('链接卡片已发送');
      this.loadMessages(); this.loadConvs();
    } catch (e) { toast(e.message); }
  },

  // ---------- 设置弹窗 ----------
  openSettings() {
    const s = this.settings;
    $('#set-shop').value = s.shop_name || '';
    $('#set-agentname').value = s.agent_name || '';
    $('#set-endmsg').value = s.end_message || '';
    $('#set-reopenable').checked = s.reopenable === '1';
    $('#ai-enabled').checked = s.ai_enabled === '1';
    $('#ai-base').value = s.ai_api_base || '';
    $('#ai-key').value = s.ai_api_key || '';
    $('#ai-model').value = s.ai_model || '';
    $('#ai-prompt').value = s.ai_prompt || '';
    $('#ai-rounds').value = s.ai_max_rounds || '6';
    $('#settings-modal').classList.add('show');
  },

  async saveSettings() {
    const body = {
      shop_name: $('#set-shop').value,
      agent_name: $('#set-agentname').value,
      end_message: $('#set-endmsg').value,
      reopenable: $('#set-reopenable').checked ? '1' : '0',
      ai_enabled: $('#ai-enabled').checked ? '1' : '0',
      ai_api_base: $('#ai-base').value.trim(),
      ai_api_key: $('#ai-key').value.trim(),
      ai_model: $('#ai-model').value.trim(),
      ai_prompt: $('#ai-prompt').value,
      ai_max_rounds: $('#ai-rounds').value,
    };
    try {
      await api('/api/settings', { method: 'POST', body });
      await this.loadSettings();
      toast('设置已保存');
    } catch (e) { toast(e.message); }
  },

  async aiTest() {
    const out = $('#ai-test-out');
    out.classList.add('show'); out.textContent = '正在调用 AI…';
    try {
      const r = await api('/api/ai/test', { method: 'POST', body: { message: '你好' } });
      out.textContent = r.ok ? 'AI回复：' + r.reply : ('失败：' + (r.error || ''));
    } catch (e) { out.textContent = '失败：' + e.message; }
  },
};

// ---------- 启动 ----------
document.addEventListener('DOMContentLoaded', () => {
  const role = document.body.dataset.role;
  if (role === 'visitor') {
    Visitor.init().catch(e => toast(e.message));
  } else if (role === 'agent') {
    $('#login-btn').addEventListener('click', () => {
      Agent.login($('#login-password').value, $('#login-name').value).catch(e => toast(e.message));
    });
    $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') $('#login-btn').click(); });
    $('#a-send').addEventListener('click', () => Agent.sendReply());
    $('#a-input').addEventListener('keydown', e => { if (e.key === 'Enter') Agent.sendReply(); });
    $('#save-settings').addEventListener('click', () => Agent.saveSettings());
    $('#ai-test-btn').addEventListener('click', () => Agent.aiTest());
    $('#send-link-btn').addEventListener('click', () => Agent.sendLink());
    $('#close-settings').addEventListener('click', () => $('#settings-modal').classList.remove('show'));
    $('#close-link').addEventListener('click', () => $('#link-modal').classList.remove('show'));
    $$('.modal-mask').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
  }
});
