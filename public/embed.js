/*!
 * 在线客服悬浮窗嵌入脚本
 * 用法：
 * <script>window.cfKefuConfig = { url: 'https://你的域名', btnText: '在线客服', btnColor: '#ff4a1f' };</script>
 * <script src="https://你的域名/embed.js"></script>
 */
(function () {
  var cfg = window.cfKefuConfig || {};
  var url = String(cfg.url || '').replace(/\/+$/, '');
  if (!url) {
    console.warn('[kefu] 缺少 cfKefuConfig.url');
    return;
  }
  var btnText = String(cfg.btnText || '在线客服');
  var color = String(cfg.btnColor || '#ff4a1f');
  var width = Math.max(280, Math.min(460, Number(cfg.width) || 380));
  var height = Math.max(420, Math.min(760, Number(cfg.height) || 580));
  var position = cfg.position === 'left' ? 'left' : 'right';

  var iframeSrc = url + '/?ref=' + encodeURIComponent(location.href);

  var style = document.createElement('style');
  style.textContent =
    '.ckf-btn{position:fixed;bottom:18px;' +
    position +
    ':18px;z-index:2147483000;display:flex;align-items:center;gap:7px;padding:11px 16px;border:0;border-radius:999px;background:' +
    color +
    ';color:#fff;font-size:14px;line-height:1;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 8px 22px rgba(15,23,42,.22);cursor:pointer}' +
    '.ckf-btn:hover{filter:brightness(1.05)}' +
    '.ckf-btn svg{width:16px;height:16px;flex:0 0 auto}' +
    '.ckf-panel{position:fixed;bottom:76px;' +
    position +
    ':18px;z-index:2147483001;width:' +
    width +
    'px;height:' +
    height +
    'px;max-width:calc(100vw - 24px);max-height:calc(100vh - 110px);background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 18px 48px rgba(15,23,42,.28);display:none;flex-direction:column}' +
    '.ckf-panel.ckf-open{display:flex}' +
    '.ckf-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#fff;border-bottom:1px solid #eef1f6;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;color:#475569}' +
    '.ckf-close{border:0;background:transparent;font-size:16px;line-height:1;color:#94a3b8;cursor:pointer;padding:2px 4px}' +
    '.ckf-frame{flex:1;width:100%;border:0;display:block;background:#fff}' +
    '@media (max-width:520px){.ckf-panel{width:calc(100vw - 20px);height:calc(100vh - 120px);bottom:72px;' +
    position +
    ':10px}}';
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ckf-btn';
  btn.setAttribute('aria-label', btnText);
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 9 9 0 01-3.8-.9L3 20l1.1-3.3A8.4 8.4 0 0112 3.1a8.4 8.4 0 019 8.4z"/></svg><span>' +
    btnText +
    '</span>';

  var panel = document.createElement('div');
  panel.className = 'ckf-panel';
  var head = document.createElement('div');
  head.className = 'ckf-head';
  head.innerHTML = '<span>在线客服</span>';
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'ckf-close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';
  head.appendChild(close);
  panel.appendChild(head);

  var frame = document.createElement('iframe');
  frame.className = 'ckf-frame';
  frame.title = '在线客服';
  frame.setAttribute('allow', 'clipboard-write');
  panel.appendChild(frame);

  var loaded = false;
  btn.addEventListener('click', function () {
    var willOpen = !panel.classList.contains('ckf-open');
    if (willOpen && !loaded) {
      frame.src = iframeSrc;
      loaded = true;
    }
    panel.classList.toggle('ckf-open', willOpen);
  });
  close.addEventListener('click', function () {
    panel.classList.remove('ckf-open');
  });

  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
