/**
 * 夏以昼记忆 MCP 服务器（轻量实现）
 *
 * 实现 MCP Streamable HTTP 协议子集：
 *   - POST /mcp → JSON-RPC 2.0
 *   - GET  /mcp → SSE（server→client notifications）
 *
 * 无需 @modelcontextprotocol/sdk 依赖。
 */

const http = require('http');

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
          description: '返回条数，默认10，最大20。搜具体关键词但没命中时，先检查limit是否太小（数据量大时旧记录可能排在后面），加大limit或去掉date只靠query搜。',
        },
        snippet: {
          type: 'number',
          description: '关键词上下文截取长度（字符）。设为 300 则每个关键词命中处返回前后各300字，避免读35KB大chunk。不设或为0则返回全文。',
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

// ── Content snippet extraction ──
function extractSnippets(content, keyword, snippetSize = 300) {
  if (!keyword || !keyword.trim()) return null;
  const lower = content.toLowerCase();
  const kw = keyword.trim().toLowerCase();
  const positions = [];
  let idx = 0;
  while ((idx = lower.indexOf(kw, idx)) !== -1) {
    positions.push(idx);
    idx += kw.length;
  }
  if (positions.length === 0) return null;

  // Take first 3 matches, extract context around each
  const snippets = positions.slice(0, 3).map((pos) => {
    const start = Math.max(0, pos - snippetSize);
    const end = Math.min(content.length, pos + kw.length + snippetSize);
    let text = content.slice(start, end);
    if (start > 0) text = '…' + text;
    if (end < content.length) text = text + '…';
    return text;
  });
  return snippets;
}

// ── Date distribution summary ──
function buildDateSummary(results) {
  const dateCount = {};
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  for (const r of results) {
    for (const tag of (r.tags || [])) {
      if (datePattern.test(tag)) {
        dateCount[tag] = (dateCount[tag] || 0) + 1;
      }
    }
  }
  const dates = Object.keys(dateCount).sort();
  if (dates.length === 0) return '';
  const parts = dates.map(d => `${d.slice(5)}(${dateCount[d]})`);
  return `命中 ${results.length} 条，分布日期：${parts.join(', ')}`;
}

function formatResult(item, i, method, query, snippetSize) {
  const snippets = query ? extractSnippets(item.content, query, snippetSize) : null;
  let header = `--- 记忆 ${i + 1} ---\n标签: ${item.tags.join(', ')}`;

  if (snippets) {
    header += `\n关键词命中 ${snippets.length} 处（原文 ${item.content.length} 字符）`;
    return header + '\n' + snippets.map((s, j) => `[命中 ${j + 1}]\n${s}`).join('\n\n') + '\n';
  }
  return header + '\n' + item.content + '\n';
}

// ── Search logic ──
async function searchSupabase(supabase, getEmbedding, { query, date, limit, snippet }) {
  const limitNum = Math.min(parseInt(limit) || 10, 20);
  const snippetSize = (snippet !== undefined && snippet !== null && snippet !== '') ? parseInt(snippet) : 400; // default 400 chars context
  let results = [];
  let method = 'none';

  // Tier 1: date tag (with optional keyword filter)
  // Both filters pushed to Supabase — avoids JS-side filtering that only
  // sees the first limitNum rows and misses hits deeper in the date bucket.
  if (date && date.trim()) {
    let q = supabase
      .from('memories')
      .select('*')
      .contains('tags', [date.trim()]);
    if (query && query.trim()) {
      q = q.ilike('content', `%${query.trim()}%`);
    }
    // tag+keyword: scan up to 100 internally so keyword hits aren't
    // cut off by a small limit, then return top N.
    const scanLimit = (query && query.trim()) ? 100 : limitNum;
    q = q.order('created_at', { ascending: false }).range(0, scanLimit - 1);
    const { data, error } = await q;
    if (!error && data && data.length > 0) {
      results = data.slice(0, limitNum);
      method = query && query.trim()
        ? `tag:${date.trim()}+keyword:"${query.trim()}"（命中${data.length}条，返回${results.length}条）`
        : `tag:${date.trim()}`;
    }
  }

  // Tier 2: keyword (only if no results from tag+keyword)
  if (results.length === 0 && query && query.trim()) {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .ilike('content', `%${query.trim()}%`)
      .order('created_at', { ascending: false })
      .range(0, 99);  // scan up to 100
    if (!error && data && data.length > 0) {
      results = data.slice(0, limitNum);
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
    return (j.result && j.result.data && j.result.data[0]) || null;
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

      const { query, date, limit, snippet } = args || {};
      const snippetSize = (snippet !== undefined && snippet !== null && snippet !== '') ? parseInt(snippet) : 400;
      const { method, results } = await searchSupabase(supabase, getEmbedding, { query, date, limit, snippet });

      // Auto-attach daily_outline for the searched date
      let outlineText = '';
      if (date && date.trim()) {
        try {
          const outlineData = await new Promise((resolve) => {
            const port = process.env.PORT || 3000;
            const url = `http://localhost:${port}/api/outline/recent?date=${encodeURIComponent(date.trim())}`;
            const opts = { headers: { 'x-api-key': process.env.API_SECRET || 'xia-memory-2024' } };
            http.get(url, opts, (res) => {
              let body = '';
              res.on('data', chunk => body += chunk);
              res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
            }).on('error', () => resolve(null));
          });
          if (outlineData && outlineData.outlines && outlineData.outlines[0] && outlineData.outlines[0].outline) {
            outlineText = outlineData.outlines[0].outline;
          }
        } catch(e) {
          console.error('outline fetch error:', e.message);
        }
      }

      if (results.length === 0) {
        let msg = '记忆库中未找到相关记录。';
        if (outlineText) msg += '\n\n但该日有大纲：\n' + outlineText;
        return { content: [{ type: 'text', text: msg }] };
      }

      const dateSummary = buildDateSummary(results);
      const parts = [];
      if (outlineText) parts.push('📅 该日大纲:\n' + outlineText + '\n');
      parts.push(`搜索方式: ${method}`);
      parts.push(dateSummary || `找到 ${results.length} 条记忆:`);
      const allParts = parts.concat([''], results.map(function(item, i) { return formatResult(item, i, method, query, snippetSize); }));
      const text = allParts.join('\n');

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
