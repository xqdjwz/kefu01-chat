-- 会话表：一个访客 token 对应一条会话
CREATE TABLE IF NOT EXISTS conversations (
  id                    TEXT PRIMARY KEY,
  visitor_token         TEXT NOT NULL UNIQUE,
  visitor_name          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  last_message_at       INTEGER,
  last_preview          TEXT,
  visitor_last_read_at  INTEGER NOT NULL DEFAULT 0,
  agent_last_read_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id        TEXT NOT NULL,
  sender         TEXT NOT NULL,              -- visitor | agent
  sender_name    TEXT,
  type           TEXT NOT NULL,              -- text | image
  body           TEXT,                       -- 文本内容 / 图片说明
  file_key       TEXT,                       -- R2 对象 key
  file_size      INTEGER,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | recalled
  deleted_visitor INTEGER NOT NULL DEFAULT 0,
  deleted_agent   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  read_at        INTEGER                     -- 对方已读时间，NULL 表示未读
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_upd  ON messages(conv_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(conv_id, sender, read_at);
