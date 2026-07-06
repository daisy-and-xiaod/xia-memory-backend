-- 语义搜索函数，在 Supabase SQL Editor 中执行

-- 余弦相似度匹配
create or replace function match_memories(
  query_embedding vector(1536),
  match_threshold float default 0.3,
  match_count int default 10
)
returns table (
  id uuid,
  role text,
  content text,
  source text,
  tags text[],
  metadata jsonb,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    id, role, content, source, tags, metadata, created_at,
    1 - (embedding <=> query_embedding) as similarity
  from memories
  where embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
