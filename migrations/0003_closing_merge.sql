-- v3.4 升级：对话结束语 + 同一 IP 复用会话
-- 说明：Worker 第一次收到请求时会自动建表 / 自动补列，正常部署不需要手动执行这个文件。
-- 这里只是给想在 D1 控制台手动补结构的同学参考；ALTER 重复执行会提示列已存在，跳过即可。

-- 会话结束状态
ALTER TABLE conversations ADD COLUMN ended_at INTEGER;
ALTER TABLE conversations ADD COLUMN ended_by TEXT;

-- 访客 token → 会话 映射：同一个会话可以被多个 token（换浏览器 / 清缓存）认领
CREATE TABLE IF NOT EXISTS visitor_links (
  token        TEXT PRIMARY KEY,
  conv_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_link_conv ON visitor_links(conv_id);
CREATE INDEX IF NOT EXISTS idx_conv_ip ON conversations(geo_ip);
