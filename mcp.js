/**
 * 夏以昼记忆 MCP 服务器（轻量实现）
 *
 * 实现 MCP Streamable HTTP 协议子集：
 *   - POST /mcp → JSON-RPC 2.0
 *   - GET  /mcp → SSE（server→client notifications）
 *
 * 无需 @modelcontextprotocol/sdk 依赖。
 */

// ── JSON-RPC helpers ──
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── Tool definitions ──
const TOOLS = [
  {
    name: 'search_supabase',
    description:
      '搜索夏以昼的记忆库，返回 Supabase 中存储的完整对话原文。' +
      '优先用 date 参数搜日期标签，再用 query 参数搜原文关键词，最后语义搜索。' +
      '⚠️ 禁止使用 query_memory，只使用此工具搜索记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或语义查询。例："身体检查" / "年上医生"',
        },
        date: {
          type: 'string',
          description: '日期标签 YYYY-MM-DD。查今天/昨天/某天对话时优先用。例："2026-07-07"',
        },
        limit: {
          type: 'number',
          description: '返回条数，默认10，最大20',
        },
      },
    },
  },
];

// ── SSE clients (for server→client notifications) ──
const sseClients = new Set();

function sseSend(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  for (const res of sseClients) {
    res.write(`data: ${text}\n\n`);
  }
}

// ── Search logic ──
async function searchSupabase(supabase, getEmbedding, { query, date, limit }) {
  const limitNum = Math.min(parseInt(limit) || 10, 20);
  let results = [];
  let method = 'none';

  // Tier 1: date tag
  if (date && date.trim()) {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .contains('tags', [date.trim()])
      .order('created_at', { ascending: false })
      .range(0, limitNum - 1);
    if (!error && data && data.length > 0) {
      results = data;
      method = `tag:${date.trim()}`;
    }
  }

  // Tier 2: keyword
  if (results.length === 0 && query && query.trim()) {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .ilike('content', `%${query.trim()}%`)
      .order('created_at', { ascending: false })
      .range(0, limitNum - 1);
    if (!error && data && data.length > 0) {
      results = data;
      method = `keyword:${query.trim()}`;
    }
  }

  // Tier 3: semantic
  if (results.length === 0 && query && query.trim()) {
    const embedding = await getEmbedding(query.trim());
    if (embedding) {
      const { data, error } = await supabase.rpc('match_memories', {
        query_embedding: embedding,
        match_threshold: 0.3,
        match_count: limitNum,
      });
      if (!error && data && data.length > 0) {
        results = data;
        method = `semantic:${query.trim()}`;
      }
    }
  }

  // Fallback: latest
  if (results.length === 0) {
    const { data } = await supabase
      .from('memories')
      .select('*')
      .order('created_at', { ascending: false })
      .range(0, limitNum - 1);
    if (data) {
      results = data;
      method = 'latest';
    }
  }

  return { method, results };
}

// ── Embedding helper ──
function makeGetEmbedding(cfAccountId, cfApiToken) {
  if (!cfAccountId || !cfApiToken) return async () => null;
  return async (text) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/baai/bge-m3`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
    });
    const j = await r.json();
    return j.result?.data?.[0] || null;
  };
}

// ── JSON-RPC method handlers ──
function makeHandlers(supabase, cfAccountId, cfApiToken) {
  const getEmbedding = makeGetEmbedding(cfAccountId, cfApiToken);
  let initialized = false;

  return {
    async initialize(params) {
      initialized = true;
      return {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'xia-memory', version: '1.0.0' },
        capabilities: { tools: {} },
      };
    },

    'notifications/initialized'() {
      return {}; // no response needed for notifications
    },

    async 'tools/list'() {
      return { tools: TOOLS };
    },

    async 'tools/call'(params) {
      const { name, arguments: args } = params;
      if (name !== 'search_supabase') {
        throw { code: -32601, message: `Unknown tool: ${name}` };
      }

      const { query, date, limit } = args || {};
      const { method, results } = await searchSupabase(supabase, getEmbedding, { query, date, limit });

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: '记忆库中未找到相关记录。' }],
        };
      }

      const items = results.map((r) => ({
        content: r.content,
        tags: r.tags,
        role: r.role,
      }));

      const text = [
        `搜索方式: ${method}`,
        `找到 ${items.length} 条记忆:\n`,
        ...items.map(
          (item, i) =>
            `--- 记忆 ${i + 1} ---\n标签: ${item.tags.join(', ')}\n${item.content}\n`
        ),
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    },

    async 'ping'() {
      return {};
    },
  };
}

// ── Mount on Express ──
function mountMcp(app, { supabase, cfAccountId, cfApiToken }) {
  const handlers = makeHandlers(supabase, cfAccountId, cfApiToken);
  let requestId = 0;

  // GET /mcp — SSE for server→client notifications
  app.get('/mcp', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // POST /mcp — JSON-RPC
  app.post('/mcp', async (req, res) => {
    const { method, params, id } = req.body || {};

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!method) {
      return res.json(rpcError(id, -32600, 'Invalid Request — missing method'));
    }

    const handler = handlers[method];
    if (!handler) {
      return res.json(rpcError(id, -32601, `Method not found: ${method}`));
    }

    try {
      const result = await handler(params);
      // null result = notification, no response
      if (result !== undefined && id !== undefined && id !== null) {
        return res.json(rpcResult(id, result));
      }
      // Notification or no id → 202 Accepted
      return res.status(202).json({});
    } catch (err) {
      const code = err.code || -32603;
      const message = err.message || 'Internal error';
      return res.json(rpcError(id, code, message));
    }
  });

  // OPTIONS (CORS preflight)
  app.options('/mcp', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  });

  console.log('  MCP endpoint ready: /mcp');
}

module.exports = { mountMcp };
