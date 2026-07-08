/**
 * 夏以昼记忆 MCP 服务器
 *
 * 提供 search_supabase 工具给 Operit 远程 MCP 调用。
 * 挂载到 Express app 的 /mcp 路径（GET=SSE, POST=JSON-RPC）。
 * 无状态模式 — 每个请求独立处理。
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

/**
 * 在 Express app 上挂载 MCP 服务
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {object} deps.supabase — Supabase 客户端
 * @param {string} deps.cfAccountId — Cloudflare Account ID
 * @param {string} deps.cfApiToken — Cloudflare API Token
 */
async function mountMcp(app, { supabase, cfAccountId, cfApiToken }) {
  // ── embedding helper ──
  async function getEmbedding(text) {
    if (!cfAccountId || !cfApiToken) return null;
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/baai/bge-m3`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 4000) })
    });
    const j = await r.json();
    return j.result?.data?.[0] || null;
  }

  // ── core search logic (same as /api/memories/recall) ──
  async function searchSupabase({ query, date, limit }) {
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
          match_count: limitNum
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

  // ── MCP server ──
  const mcpServer = new McpServer(
    {
      name: 'xia-memory',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 注册 search_supabase 工具
  mcpServer.registerTool(
    'search_supabase',
    {
      description:
        '搜索夏以昼的记忆库，返回 Supabase 中存储的完整对话原文。' +
        '优先用 date 参数搜日期标签，再用 query 参数搜原文关键词，最后语义搜索。' +
        '禁止使用 query_memory，只使用此工具搜索记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词或语义查询。例："身体检查" / "年上医生" / "说到声音想起来的"',
          },
          date: {
            type: 'string',
            description: '日期标签 YYYY-MM-DD。查今天/昨天/某天的对话时优先用此参数。例："2026-07-07"',
          },
          limit: {
            type: 'number',
            description: '返回条数，默认10，最大20',
            default: 10,
          },
        },
      },
    },
    async (args) => {
      const { query, date, limit } = args;
      const { method, results } = await searchSupabase({ query, date, limit });

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: '记忆库中未找到相关记录。' }],
        };
      }

      // 返回原文内容（不做摘要）
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

      return {
        content: [{ type: 'text', text }],
      };
    }
  );

  // ── 无状态 Streamable HTTP 传输 ──
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态模式
  });

  await mcpServer.connect(transport);

  // ── 挂载到 Express ──
  // MCP Streamable HTTP 使用单一端点处理 GET (SSE) 和 POST (JSON-RPC)
  app.get('/mcp', async (req, res) => {
    await transport.handleRequest(req, res);
  });

  app.post('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });

  console.log('  MCP endpoint: /mcp (search_supabase tool)');

  return { mcpServer, transport };
}

module.exports = { mountMcp };
