/**
 * 全文检索与多维筛选 —— Edge 版（中文自建倒排索引）。
 *
 * ## 为什么不用 D1 的 FTS5
 *   Python 版实测过：FTS5 的 trigram 分词器把中文字符全部当成分隔符，
 *   中文文档索引进去一个字都搜不到。D1 基于 SQLite，同样有这个问题。
 *   所以两边都自己建倒排索引 —— **分词策略必须完全一致**，
 *   否则迁移后同一个文件搜不到。
 *
 * ## 中文怎么切
 *   不建词典、不做最大匹配，直接用**二元组（bigram）**：
 *     「妈妈照片」-> 妈妈 / 妈 / 妈照 / 照片 / 照
 *   每个中文连续片段切出全部相邻二字组合，同时收录单字。
 *
 * ## 索引规模控制
 *   单文件最多索引 8000 个词条，超出的按词频截断。
 *   照片和视频不进索引，所以普通家庭不会撑爆数据库。
 */

import { tokenize } from "./http";
import { queryAll, queryOne, execute } from "./db";
import { plainStream } from "./blobstore";
import { ApiError, type Env, type MasterLike } from "./types";

export const MAX_TERMS_PER_FILE = 8000;

/** 正文抽取上限（字节）。 */
export const TEXT_EXTRACT_LIMIT = 256 * 1024;

export const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml",
  ".log", ".ini", ".conf", ".cfg", ".py", ".js", ".ts", ".html", ".htm", ".css",
  ".c", ".h", ".cpp", ".hpp", ".java", ".go", ".rs", ".sh", ".bat", ".ps1",
  ".sql", ".srt", ".vtt", ".tex", ".toml", ".env", ".gitignore",
]);

export const CATEGORIES = ["照片", "视频", "音频", "文档", "表格", "压缩包", "其他"];

/** 文件名后缀（小写，含点）。 */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

export function isTextFile(name: string, mime = ""): boolean {
  if (mime.startsWith("text/")) return true;
  return TEXT_EXT.has(extOf(name));
}

/** 词条 -> 次数。 */
export function termCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokenize(text || "")) {
    out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

/** 查询串 -> 必须全部命中的词条（AND 语义）。 */
export function queryTerms(q: string): string[] {
  return [...termCounts(q).keys()];
}

/** 是不是中文词条（中文不走前缀匹配）。 */
export function isCjkTerm(t: string): boolean {
  if (!t) return false;
  const cp = t.codePointAt(0)!;
  return (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0xf900 && cp <= 0xfaff);
}

// ---------------------------------------------------------------- 正文抽取

/**
 * 从存储里抽一段正文出来。严格限量，不会把大文件读进内存。
 */
export async function extractBody(
  env: Env, master: MasterLike,
  versionId: number, limit = TEXT_EXTRACT_LIMIT,
): Promise<string> {
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    const stream = await plainStream(env, master, versionId);
    const reader = stream.getReader();
    while (got < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (got >= limit) { await reader.cancel(); break; }
    }
  } catch {
    return "";
  }
  const raw = new Uint8Array(Math.min(got, limit));
  let o = 0;
  for (const p of parts) {
    const n = Math.min(p.length, raw.length - o);
    if (n <= 0) break;
    raw.set(p.subarray(0, n), o);
    o += n;
  }
  return decode(raw);
}

const TEXT_ENCODINGS = ["utf-8", "gb18030", "big5", "latin-1"];

/** 按常见编码依次尝试。国内家庭文件常见 GBK。 */
export function decode(raw: Uint8Array): string {
  for (const enc of TEXT_ENCODINGS) {
    try {
      const txt = new TextDecoder(enc, { fatal: true }).decode(raw);
      // 解出来一堆替换字符说明猜错了
      if (txt.split("�").length - 1 <= Math.max(2, Math.floor(txt.length / 200))) {
        return txt;
      }
    } catch {
      continue;
    }
  }
  return new TextDecoder("utf-8").decode(raw);
}

// ---------------------------------------------------------------- 建索引

/**
 * 给一个文件的当前版本建索引。返回写入的词条数。
 *
 * **加密文件的正文一律不入索引。**
 * 这是安全红线：索引表里存的是明文正文，如果把加密文件也抽出来建索引，
 * 那"加密"就只在 R2 的块上成立，数据库里全是明文 —— 别人拷走 D1
 * 就能读到所有重要文件的内容。加密文件只索引文件名。
 */
export async function indexNode(
  env: Env, master: MasterLike,
  nodeId: number, versionId: number, name: string, mime: string,
  encrypted = false,
): Promise<number> {
  await execute(env.DB, "DELETE FROM fterms WHERE node_id=?", nodeId);

  let body = "";
  if (!encrypted && isTextFile(name, mime)) {
    body = await extractBody(env, master, versionId);
  }
  await env.DB.prepare(
    "INSERT INTO file_text(node_id,version_id,name,body,indexed_at) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id, " +
    "name=excluded.name, body=excluded.body, indexed_at=excluded.indexed_at")
    .bind(nodeId, versionId, name, body, Date.now() / 1000).run();

  const counter = termCounts(name);
  for (const [t, n] of termCounts(body)) {
    counter.set(t, (counter.get(t) ?? 0) + n);
  }
  // 文件名里的词加权，搜文件名时排前面
  for (const [t, n] of termCounts(name)) {
    counter.set(t, (counter.get(t) ?? 0) + n * 3);
  }

  let entries = [...counter.entries()];
  if (entries.length > MAX_TERMS_PER_FILE) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, MAX_TERMS_PER_FILE);
  }

  // 批量插入。ON CONFLICT 与 Python 版一致（重名覆盖 tf）。
  const stmts: D1PreparedStatement[] = entries.map(([t, n]) =>
    env.DB.prepare(
      "INSERT INTO fterms(term,node_id,tf) VALUES(?,?,?) " +
      "ON CONFLICT(term,node_id) DO UPDATE SET tf=excluded.tf")
      .bind(t, nodeId, n));
  for (let i = 0; i < stmts.length; i += 400) {
    await env.DB.batch(stmts.slice(i, i + 400));
  }
  return entries.length;
}

/** 删索引。 */
export async function unindexNode(env: Env, nodeId: number): Promise<void> {
  await execute(env.DB, "DELETE FROM fterms WHERE node_id=?", nodeId);
  await execute(env.DB, "DELETE FROM file_text WHERE node_id=?", nodeId);
}

/** 命中片段。优先在正文里找，找不到就退回文件名。 */
export async function snippet(env: Env, nodeId: number, q: string, width = 90): Promise<string> {
  const row = await queryOne<{ name: string; body: string }>(
    env.DB, "SELECT name, body FROM file_text WHERE node_id=?", nodeId);
  if (!row) return "";
  const hay = row.body || row.name || "";
  let pos = -1;
  for (const t of queryTerms(q)) {
    const p = hay.indexOf(t);
    if (p >= 0) { pos = p; break; }
  }
  if (pos < 0) return hay.length > width ? hay.slice(0, width) + "…" : hay;
  const lo = Math.max(0, pos - Math.floor(width / 3));
  const piece = hay.slice(lo, lo + width).replace(/\n/g, " ");
  return (lo ? "…" : "") + piece + (lo + width < hay.length ? "…" : "");
}

// ---------------------------------------------------------------- 筛选

export interface Filters {
  spaceId: number;
  name: string;
  text: string;
  kind: string;
  category: string;
  ext: string;
  mime: string;
  sizeMin: number | null;
  sizeMax: number | null;
  after: number | null;
  before: number | null;
  uploader: number | null;
  owner: number | null;
  encrypted: boolean | null;
  starred: boolean | null;
  tag: string;
  scope: string;
}

export function filtersFromQuery(q: URLSearchParams): Filters {
  const num = (k: string): number | null => {
    const v = q.get(k);
    return v === null || v === "" || v === "null" ? null : Number(v);
  };
  const bool = (k: string): boolean | null => {
    const v = q.get(k);
    return v === null || v === "" ? null : v === "1";
  };
  return {
    spaceId: Number(q.get("space") || 1),
    name: q.get("name") || "",
    text: q.get("q") || "",
    kind: q.get("kind") || "",
    category: q.get("category") || "",
    ext: q.get("ext") || "",
    mime: q.get("mime") || "",
    sizeMin: num("size_min"),
    sizeMax: num("size_max"),
    after: num("after"),
    before: num("before"),
    uploader: num("uploader"),
    owner: num("owner"),
    encrypted: bool("encrypted"),
    starred: bool("starred"),
    tag: q.get("tag") || "",
    scope: q.get("scope") || "",
  };
}

/** 生成 WHERE 子句和参数。 */
export function whereOf(f: Filters): { sql: string; args: unknown[] } {
  const sql: string[] = ["n.space_id = ?"];
  const args: unknown[] = [f.spaceId];
  if (f.scope === "trash") sql.push("n.deleted_at IS NOT NULL");
  else if (f.scope !== "all") sql.push("n.deleted_at IS NULL");
  if (f.kind) { sql.push("n.kind = ?"); args.push(f.kind); }
  if (f.category) { sql.push("n.category = ?"); args.push(f.category); }
  if (f.ext) { sql.push("lower(n.name) LIKE ?"); args.push("%" + f.ext.toLowerCase() + "%"); }
  if (f.mime) { sql.push("n.mime LIKE ?"); args.push("%" + f.mime + "%"); }
  if (f.sizeMin !== null) { sql.push("n.size >= ?"); args.push(f.sizeMin); }
  if (f.sizeMax !== null) { sql.push("n.size <= ?"); args.push(f.sizeMax); }
  if (f.after !== null) { sql.push("n.modified_at >= ?"); args.push(f.after); }
  if (f.before !== null) { sql.push("n.modified_at <= ?"); args.push(f.before); }
  if (f.uploader !== null) { sql.push("n.uploader_id = ?"); args.push(f.uploader); }
  if (f.owner !== null) { sql.push("n.owner_id = ?"); args.push(f.owner); }
  if (f.encrypted !== null) { sql.push("n.encrypted = ?"); args.push(f.encrypted ? 1 : 0); }
  if (f.starred !== null) { sql.push("n.starred = ?"); args.push(f.starred ? 1 : 0); }
  if (f.tag) {
    sql.push("(',' || replace(n.tags, ' ', '') || ',') LIKE ?");
    args.push("%," + f.tag + ",%");
  }
  if (f.name) { sql.push("n.name LIKE ?"); args.push("%" + f.name + "%"); }
  return { sql: sql.join(" AND "), args };
}

/** 词条 -> {节点 id: 权重}。 */
async function weightMap(
  env: Env, term: string, prefix = false,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (prefix) {
    const rows = await queryAll<{ node_id: number; w: number }>(
      env.DB,
      "SELECT node_id, MAX(tf) AS w FROM fterms WHERE term >= ? AND term < ? GROUP BY node_id",
      term, term + "￿");
    for (const r of rows) out.set(r.node_id, Number(r.w));
  } else {
    const rows = await queryAll<{ node_id: number; w: number }>(
      env.DB, "SELECT node_id, tf AS w FROM fterms WHERE term=?", term);
    for (const r of rows) out.set(r.node_id, Number(r.w));
  }
  return out;
}

export interface SearchResult {
  rows: Record<string, unknown>[];
  total: number;
  ms: number;
  query: string;
  reason?: string;
}

/**
 * AND 语义的多维检索。
 *
 * 没有文本条件时就是普通的条件查询 —— 这样「按大小/时间/上传者筛选」
 * 和「全文搜索」走的是同一条代码路径。
 */
export async function search(
  env: Env, f: Filters, limit = 60, offset = 0,
): Promise<SearchResult> {
  const t0 = Date.now();
  const { sql: where, args } = whereOf(f);

  const scores = new Map<number, number>();
  if (f.text) {
    const terms = queryTerms(f.text);
    if (terms.length) {
      const sets: Map<number, number>[] = [];
      let missing = false;
      for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        // 最后一个词走前缀匹配，输入一半也能搜到
        const isLast = i === terms.length - 1;
        const usePrefix = isLast && !isCjkTerm(t) && t.length >= 2;
        const wm = await weightMap(env, t, usePrefix);
        if (!wm.size) { missing = true; break; }
        sets.push(wm);
      }
      if (missing) {
        // 只要有一个词在全库里找不到，就一定没有命中。
        // 这里必须直接返回空 —— 早先写成 sets=[] 后落到下面的
        // 「无文本条件」分支，等于把全库文件都返回了。
        return {
          rows: [], total: 0, ms: Date.now() - t0, query: f.text,
          reason: "有词在索引里不存在",
        };
      }
      // 词太多时只用最「稀有」的那几个求交集
      let use = sets;
      if (use.length > 8) {
        use = [...use].sort((a, b) => a.size - b.size).slice(0, 8);
      }
      let common: Set<number> | null = null;
      for (const d of use) {
        if (common === null) common = new Set(d.keys());
        else for (const k of [...common]) if (!d.has(k)) common.delete(k);
      }
      if (!common || !common.size) {
        return {
          rows: [], total: 0, ms: Date.now() - t0, query: f.text,
          reason: "词的交集为空",
        };
      }
      for (const nid of common) {
        let s = 0;
        for (const d of use) s += d.get(nid) ?? 0;
        scores.set(nid, s);
      }
    }
  }

  const out: Record<string, unknown>[] = [];

  if (scores.size) {
    const ids = [...scores.keys()];
    // D1 绑定参数上限 100 → 分批查
    const rowsAll: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const ph = part.map(() => "?").join(",");
      const rs = await queryAll<Record<string, unknown>>(
        env.DB,
        `SELECT n.*, m.display_name AS uploader_name FROM nodes n ` +
        `LEFT JOIN members m ON m.id = n.uploader_id ` +
        `WHERE n.id IN (${ph}) AND ${where}`,
        ...part, ...args);
      rowsAll.push(...rs);
    }
    rowsAll.sort((a, b) =>
      (scores.get(Number(b.id)) ?? 0) - (scores.get(Number(a.id)) ?? 0));
    const total = rowsAll.length;
    for (const r of rowsAll.slice(offset, offset + limit)) {
      const d: Record<string, unknown> = {
        ...r, score: Math.round((scores.get(Number(r.id)) ?? 0) * 100) / 100,
      };
      if (f.text) d.snippet = await snippet(env, Number(r.id), f.text);
      out.push(d);
    }
    return { rows: out, total, ms: Date.now() - t0, query: f.text };
  }

  // 没有文本条件时走分页查询，避免把整张表拉出来
  const countRow = await queryOne<{ c: number }>(
    env.DB, `SELECT COUNT(*) AS c FROM nodes n WHERE ${where}`, ...args);
  const total = countRow?.c ?? 0;
  const rows = await queryAll<Record<string, unknown>>(
    env.DB,
    `SELECT n.*, m.display_name AS uploader_name FROM nodes n ` +
    `LEFT JOIN members m ON m.id = n.uploader_id ` +
    `WHERE ${where} ORDER BY n.kind='folder' DESC, n.name COLLATE NOCASE ASC ` +
    `LIMIT ? OFFSET ?`,
    ...args, Math.max(1, limit), Math.max(0, offset));
  for (const r of rows) {
    out.push({ ...r, score: 0 });
  }
  return { rows: out, total, ms: Date.now() - t0, query: f.text };
}

/** 按词条前缀给候选词，输错字时用得上。 */
export async function suggest(env: Env, prefix: string, limit = 8): Promise<string[]> {
  if (!prefix) return [];
  const p = prefix.toLowerCase();
  const rows = await queryAll<{ term: string }>(
    env.DB,
    "SELECT term, SUM(tf) AS w FROM fterms WHERE term >= ? AND term < ? " +
    "GROUP BY term ORDER BY w DESC LIMIT ?",
    p, p + "￿", limit);
  return rows.map((r) => r.term);
}

/** 索引统计。 */
export async function indexStats(env: Env): Promise<{
  files_indexed: number; terms: number; distinct_terms: number; bytes_indexed: number;
}> {
  const a = await queryOne<{ c: number }>(
    env.DB, "SELECT COUNT(*) AS c FROM file_text");
  const b = await queryOne<{ c: number }>(
    env.DB, "SELECT COUNT(*) AS c FROM fterms");
  const c = await queryOne<{ c: number }>(
    env.DB, "SELECT COUNT(DISTINCT term) AS c FROM fterms");
  const d = await queryOne<{ s: number }>(
    env.DB, "SELECT COALESCE(SUM(LENGTH(body)),0) AS s FROM file_text");
  return {
    files_indexed: a?.c ?? 0,
    terms: b?.c ?? 0,
    distinct_terms: c?.c ?? 0,
    bytes_indexed: d?.s ?? 0,
  };
}

/** 分类合法性检查用。 */
export function isCategory(c: string): boolean {
  if (!CATEGORIES.includes(c)) throw new ApiError("分类不合法");
  return true;
}
