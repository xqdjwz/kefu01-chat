-- 说明：Worker 首次请求时会自动建表，这个文件只是给想在 D1 控制台手动执行的人参考。
-- 在 D1 控制台里逐条执行即可（CREATE ... IF NOT EXISTS 重复执行也安全）。

CREATE TABLE IF NOT EXISTS conversations (
  id                    TEXT PRIMARY KEY,
  visitor_token         TEXT NOT NULL UNIQUE,
  visitor_name          TEXT,
  remark                TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  last_message_at       INTEGER,
  last_preview          TEXT,
  visitor_last_read_at  INTEGER NOT NULL DEFAULT 0,
  agent_last_read_at    INTEGER NOT NULL DEFAULT 0,
  visitor_seen_at       INTEGER NOT NULL DEFAULT 0,
  agent_seen_at         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id        TEXT NOT NULL,
  sender         TEXT NOT NULL,
  sender_name    TEXT,
  type           TEXT NOT NULL DEFAULT 'text',
  body           TEXT,
  file_key       TEXT,
  file_size      INTEGER,
  status         TEXT NOT NULL DEFAULT 'active',
  deleted_visitor INTEGER NOT NULL DEFAULT 0,
  deleted_agent   INTEGER NOT NULL DEFAULT 0,
  read_at        INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  token      TEXT PRIMARY KEY,
  name       TEXT,
  created_at INTEGER NOT NULL
);

-- 未配置 R2 时，图片就存在这张表里
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  mime       TEXT,
  size       INTEGER,
  data       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_upd ON messages(conv_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(conv_id, sender, read_at);
