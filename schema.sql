-- ============================================
-- 夏以昼记忆库 — Supabase 建表脚本
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 1. 扩展：模糊搜索索引
create extension if not exists pg_trgm;

-- 2. 建表
create table if not exists memories (
  id         uuid default gen_random_uuid() primary key,
  role       text not null check (role in ('user', 'ai', 'system')),
  content    text not null,
  source     text default 'chat' check (source in ('chat', 'diary')),
  tags       text[] default '{}',
  metadata   jsonb default '{}',
  created_at timestamptz default now()
);

-- 3. 索引
create index if not exists idx_tags         on memories using gin (tags);
create index if not exists idx_created_at   on memories (created_at);
create index if not exists idx_content_trgm on memories using gin (content gin_trgm_ops);

-- 4. 元数据常用字段索引（按情绪/天气筛选）
create index if not exists idx_metadata_mood on memories ((metadata->>'mood'));
