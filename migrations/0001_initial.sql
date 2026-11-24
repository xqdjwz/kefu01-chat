-- 0001_initial.sql 参考建表（线上由 Worker 运行时 ensureSchema 自动建表/补列，本文件仅供查阅）
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_token TEXT, visitor_name TEXT, remark TEXT,
  created_at TEXT, updated_at TEXT, last_message_at TEXT, last_preview TEXT,
  visitor_last_read_at TEXT, agent_last_read_at TEXT,
  visitor_seen_at TEXT, agent_seen_at TEXT,
  geo_ip TEXT, geo_location TEXT, geo_referer TEXT, geo_device TEXT,
  contact TEXT, blocked INTEGER DEFAULT 0,
  customer_id TEXT, status TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER, sender TEXT, sender_name TEXT, type TEXT DEFAULT 'text',
  body TEXT, file_key TEXT, file_size INTEGER, status TEXT DEFAULT 'sent',
  deleted_visitor INTEGER DEFAULT 0, deleted_agent INTEGER DEFAULT 0,
  read_at TEXT, created_at TEXT, updated_at TEXT,
  auto_reply INTEGER DEFAULT 0, ai_reply INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS agents (token TEXT PRIMARY KEY, name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, mime TEXT, size INTEGER, data TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_conv_ip ON conversations(geo_ip);
