# Operit 自定义 Tool 注册方案 — search_supabase

> 替代 `query_memory`，直接读取 Supabase 原文

---

## Tool 定义

```
名称: search_supabase
描述: 搜索夏以昼的记忆库。返回 Supabase 中存储的完整对话原文（非AI摘要）。优先用 tag 搜日期，再关键词搜原文，最后语义搜索。

方法: HTTP GET
URL: https://xia-memory-backend.onrender.com/api/memories/recall
Headers:
  x-api-key: xyyr24xyzr

参数:
  query  (可选, string) — 搜索关键词或语义查询
  date   (可选, string) — 日期标签，格式 YYYY-MM-DD（如 2026-07-07）
  limit  (可选, number) — 返回条数，默认10，最大20
```

## 使用示例

```
# 查今天说了什么
search_supabase(date="2026-07-08", limit=10)

# 查具体场景关键词
search_supabase(query="身体检查", limit=10)

# 日期 + 关键词组合（日期优先）
search_supabase(date="2026-07-07", query="浴室", limit=10)

# 模糊语义联想
search_supabase(query="说到声音就想到什么东西", limit=5)

# 最近记忆
search_supabase(limit=10)
```

## 服务端回退策略（自动，AI 无需关心）

| 优先级 | 条件 | 行为 |
|--------|------|------|
| 1 | date 参数存在 | `tag=date` 精确匹配 |
| 2 | 上一步无结果 + query 存在 | `ilike content` 关键词模糊搜索 |
| 3 | 上一步无结果 + query 存在 | pgvector 语义搜索 |
| 4 | 以上均无结果 | 返回最新记录 |

## 响应格式

```json
{
  "method": "tag:2026-07-07",
  "total": 3,
  "items": [
    {
      "content": "[ai] ... [user] ... [ai] ...",
      "tags": ["2026-07-07", "topic_archive"],
      "metadata": {},
      "role": "system"
    }
  ]
}
```

## 世界书规则对照

世界书已写入的硬规则和此 tool 的回退策略一致：
- ⚠️ 禁止使用 query_memory
- 只使用 search_supabase
- 日期查询 → date 参数
- 关键词查询 → query 参数
- 语义联想 → query 参数（服务端自动降级到语义）
