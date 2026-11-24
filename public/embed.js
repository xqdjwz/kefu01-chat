/* embed.js v3.4 —— 把客服挂件嵌入您的网站
   用法：在您网站页面 </body> 前加入
   <script src="https://您的Worker域名/embed.js"></script>
   即可出现悬浮客服按钮，点击打开聊天窗口。
*/
(function () {
  var BASE = (function () {
    var s = document.querySelector('script[src*="embed.js"]');
    return s ? new URL(s.src).origin : location.origin;
  })();

  var fab = document.createElement('div');
  fab.id = 'kefu-fab';
  fab.textContent = '💬';
  fab.style.cssText = 'position:fixed;right:18px;bottom:24px;width:56px;height:56px;border-radius:50%;' +
    'background:#2f6fed;color:#fff;font-size:26px;display:flex;align-items:center;justify-content:center;' +
    'box-shadow:0 6px 18px rgba(47,111,237,.4);cursor:pointer;z-index:99999;border:none;';

  var frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:18px;bottom:96px;width:360px;max-width:calc(100vw - 32px);' +
    'height:560px;max-height:calc(100vh - 140px);border:none;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.2);' +
    'background:#fff;z-index:99999;display:none;';
  frame.src = BASE + '/?embed=1';

  fab.addEventListener('click', function () {
    frame.style.display = frame.style.display === 'none' ? 'block' : 'none';
  });
  document.body.appendChild(fab);
  document.body.appendChild(frame);
})();
