-- daily_outlines: 每日事件时间线
-- 每天归档时自动生成，用于世界书常驻注入 + MCP 搜索锚点

CREATE TABLE IF NOT EXISTS daily_outlines (
  id SERIAL PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,
  outline TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_outlines_date ON daily_outlines(date);
