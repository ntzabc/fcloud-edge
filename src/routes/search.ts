/**
 * 搜索路由：GET /api/search、GET /api/suggest
 */

import { json } from "../index";
import { need } from "../http";
import { filtersFromQuery, search as doSearch, suggest as doSuggest } from "../search";
import { canRead } from "../sharing";
import { previewKind } from "../files";
import type { Ctx } from "../http";

export async function search(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const q = ctx.url.searchParams;
  const f = filtersFromQuery(q);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit") || 60)));
  const offset = Math.max(0, Number(q.get("offset") || 0));

  const r = await doSearch(ctx.env, f, limit, offset);
  const rows = [];
  for (const n of r.rows) {
    // 儿童看不到别人的加密文件 —— 搜索结果也要过滤
    if (!(await canRead(ctx.env, n as never, m))) continue;
    const node = n as Record<string, unknown>;
    rows.push({ ...node, preview: previewKind(String(node.name), String(node.mime ?? "")) });
  }
  return json({
    items: rows,
    total: r.total,
    ms: r.ms,
    query: r.query,
    reason: r.reason ?? "",
    suggest: await doSuggest(ctx.env, q.get("q") || "", 6),
  });
}

export async function suggest(ctx: Ctx): Promise<Response> {
  await need(ctx);
  return json({ items: await doSuggest(ctx.env, ctx.url.searchParams.get("q") || "", 8) });
}
