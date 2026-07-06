require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

// ============================================
// 环境变量校验
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_SECRET = process.env.API_SECRET || 'xia-memory-2024';
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺少 SUPABASE_URL 或 SUPABASE_KEY 环境变量');
  process.exit(1);
}

// ============================================
// Supabase 客户端（service_role key）
// ============================================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ============================================
// Express 应用
// ============================================
const app = express();

// ---- 基础中间件 ----
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// ---- 鉴权中间件 ----
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — 无效的 API key' });
  }
  next();
}

// ---- 限流 ----
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 2000,                // 导入期间临时提高，之后改回 300                  // 最多 300 次请求
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too Many Requests — 请求太频繁' },
});

// ============================================
// 健康检查（无需鉴权，给 UptimeRobot 用）
// GET /api/health
// ============================================
app.get('/api/health', async (_req, res) => {
  try {
    const { error } = await supabase
      .from('memories')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    res.json({ status: 'ok', supabase: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', detail: err.message });
  }
});

// ---- 鉴权 + 限流（所有写操作接口） ----
app.use('/api', limiter);
app.use('/api', auth);

// ============================================
// 存记忆
// POST /api/memories
// ============================================
app.post('/api/memories', async (req, res) => {
  try {
    const { role, content, source, tags, metadata } = req.body;

    // 字段校验
    if (!role || !['user', 'ai', 'system'].includes(role)) {
      return res.status(400).json({ error: 'role 必须是 "user"、"ai" 或 "system"' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'content 不能为空' });
    }

    const { data, error } = await supabase
      .from('memories')
      .insert({
        role,
        content: content.trim(),
        source: source || 'chat',
        tags: Array.isArray(tags) ? tags : [],
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /api/memories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 搜索记忆（关键词 + 标签 + 分页）
// GET /api/memories?q=&tag=&limit=10&offset=0
// ============================================
app.get('/api/memories', async (req, res) => {
  try {
    const { q, tag, limit = '10', offset = '0' } = req.query;
    const limitNum = Math.min(parseInt(limit) || 10, 100); // 最多 100 条
    const offsetNum = parseInt(offset) || 0;

    let query = supabase
      .from('memories')
      .select('*', { count: 'exact' });

    // 关键词模糊搜索（内容）
    if (q && q.trim()) {
      query = query.ilike('content', `%${q.trim()}%`);
    }

    // 标签精确过滤
    if (tag && tag.trim()) {
      query = query.contains('tags', [tag.trim()]);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offsetNum, offsetNum + limitNum - 1);

    const { data, error, count } = await query;

    if (error) throw error;
    res.json({ data: data || [], total: count, limit: limitNum, offset: offsetNum });
  } catch (err) {
    console.error('GET /api/memories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 语义搜索
// GET /api/memories/search?semantic=说到声音就想到ElevenLabs&limit=10
// ============================================
const EMBEDDING_KEY = process.env.EMBEDDING_KEY || '';
const EMBEDDING_URL = process.env.EMBEDDING_URL || 'https://openrouter.ai/api/v1/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'baai/bge-m3';

async function getEmbedding(text) {
  const r = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${EMBEDDING_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text })
  });
  const j = await r.json();
  const emb = j.data?.[0]?.embedding;
  if (!emb) return null;
  return emb;
}

app.get('/api/memories/search', async (req, res) => {
  try {
    const { semantic, limit = '10' } = req.query;

    if (!semantic) {
      return res.status(400).json({ error: '需要 semantic 参数' });
    }

    if (!EMBEDDING_KEY) {
      return res.status(500).json({ error: '未配置 EMBEDDING_KEY 环境变量' });
    }

    const embedding = await getEmbedding(semantic);
    if (!embedding) {
      return res.status(500).json({ error: '生成 embedding 失败' });
    }

    const { data, error } = await supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: parseInt(limit) || 10
    });

    if (error) throw error;
    res.json({ data: data || [], query: semantic, total: (data || []).length });
  } catch (err) {
    console.error('Semantic search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 更新/压缩单条记忆
// PATCH /api/memories/:id
// ============================================
app.patch('/api/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, tags, metadata } = req.body;

    const updates = {};
    if (content !== undefined) updates.content = content.trim();
    if (tags !== undefined) updates.tags = tags;
    if (metadata !== undefined) updates.metadata = metadata;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '至少需要一个更新字段: content / tags / metadata' });
    }

    const { data, error } = await supabase
      .from('memories')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: '未找到该记忆' });
    res.json(data);
  } catch (err) {
    console.error('PATCH /api/memories/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 删除单条记忆
// DELETE /api/memories/:id
// ============================================
app.delete('/api/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('memories')
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: '未找到该记忆' });
    res.json({ deleted: data });
  } catch (err) {
    console.error('DELETE /api/memories/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 404
// ============================================
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ============================================
// 全局错误处理
// ============================================
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ============================================
// 启动
// ============================================
app.listen(PORT, () => {
  console.log(`🧠 夏以昼记忆后端已启动 → http://localhost:${PORT}`);
  console.log(`  健康检查: http://localhost:${PORT}/api/health`);
});
