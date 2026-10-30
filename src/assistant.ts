/**
 * 小f —— 家庭云里的智能助手（Edge / Worker 版）。
 *
 * ## 它是什么
 *
 * 一个会调用工具的对话助手。模型本身看不到你的文件系统，
 * 所有「我家文件在哪、有哪些、最近谁改了什么」都必须靠工具返回 ——
 * 所以这套工具定义 + 权限过滤是这个模块的核心，模型只是负责把话说得好听。
 *
 * ## 跟 Python 版的差异（这几条是 Worker 特有的）
 *
 * 1. **HTTP 客户端**：Python 用 urllib，Worker 用 fetch。
 * 2. **流式解析**：Python 逐行读，Worker 要读 ReadableStream 的 chunk，
 *    一个 chunk 里可能有半行、也可能有十几行 —— 得自己按 \n 切分，
 *    并且要用 TextDecoder(..., {stream:true}) 处理跨 chunk 的 UTF-8 边界。
 * 3. **图片 base64**：Python 一次 encode，Worker 也要，
 *    但大文件 base64 会顶爆 CPU —— 沿用「最多 3 张、单张 ≤3.5MB」的限制。
 * 4. **SSE 输出**：Python 是生成器，Worker 是 ReadableStream，
 *    而且**不能**用 EventSource（只能 GET 带不了 body），
 *    所以前端用 fetch + ReadableStream 读 SSE 帧。
 *
 * ## 权限（这是最容易出事的地方）
 *
 * 助手跑在服务端，拿到的是当前登录者的 Member。
 * 工具执行时统一过 TOOLS 里每个工具自己的 perm 检查：
 *   · 儿童 → 只拿到只读工具（list/search/read/stats），
 *           写操作工具根本不会出现在给模型的提示里
 *   · 加密文件 → 未解锁主密钥时任何工具都不返回正文
 *   · 共享权限 → 逐个节点走 sharing.canRead / effectiveWrite
 *
 * 助手不能「绕过」前端权限，也不能读到调用者本来就读不到的东西。
 */

import { ApiError, type Env, type Member } from "./types";
import { getMemberByName, getSetting, resolvePath, setSetting } from "./db";
import * as files from "./files";
import * as sharing from "./sharing";
import * as search from "./search";
import * as blobstore from "./blobstore";
import { storageStats, storeChunk } from "./storage";
import { memberCan } from "./db";
import type { MasterLike } from "./types";

// ---------------------------------------------------------------- 常量

export const API_URL = "https://openrouter.ai/api/v1/chat/completions";

const SITE = "https://ntzabc.github.io/my-ipad-webapp/";
const APP = "Fcloud";

/** 默认首选模型：多模态（文本/图像/视频）+ 支持工具调用。 */
export const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
export const FALLBACK_MODELS = [
  "openrouter/free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "thinkingmachines/inkling:free",
];

export const MAX_ROUNDS = 6;        // 工具调用循环上限，防止模型死循环
export const MAX_TOOL_ARGS = 8000;   // 单次工具参数长度上限
export const HISTORY_LIMIT = 24;     // 送给模型的最近对话条数
const SPACE_ID = 1;

export const SYSTEM_PROMPT = `你是「小f」，这个家庭云盘里的助手。

你的能力来自工具：搜索文件、浏览文件夹、读文件正文、看统计和操作记录，
以及（如果权限允许）创建文件夹、改名、移动、删除、新建文本笔记。

规矩：
1. 你只能通过工具了解这家人的文件。不要编造文件是否存在——不确定就先搜。
2. 中文回答，语气自然、简短。用户在 iPad 上用，一次说清一件事。
3. 动手之前先确认对象：删除/移动这类不可逆操作，先把要动的文件名列出来再问一句。
4. 工具报错时如实告诉用户，不要假装成功。
5. 数字要具体（大小用 MB/GB，时间用具体日期），不要说"一些""若干"。
`;

// ---------------------------------------------------------------- 配置

function masked(key: string): string {
  if (!key) return "";
  return key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…";
}

/**
 * API Key 优先级：数据库设置（管理员在界面里改的）> Worker secret。
 *
 * ## ⚠️ 源码里绝不能硬编码 key
 *
 * 这个仓库是**公开**的，GitHub 的 secret scanning 会直接拦下带 key 的提交 ——
 * 而且就算当时没拦，公开仓库里的 key 也等于公开的 key。
 *
 * 所以 key 只能从这两个地方来：
 *   1. 设置界面里填（存进 D1 的 settings.ai_api_key）
 *   2. `wrangler secret put FCLOUD_AI_KEY`（不进仓库、不进 CI 日志）
 *
 * 没有 key 时小f 就是不可用状态 —— 这是正确行为，
 * 总比「看起来能用但其实是别人家的 key」强。
 */
export async function apiKey(env: Env): Promise<string> {
  const s = await getSetting(env.DB, "ai_api_key");
  return s || env.FCLOUD_AI_KEY || "";
}

export async function currentModel(env: Env): Promise<string> {
  const s = await getSetting(env.DB, "ai_model");
  return s || DEFAULT_MODEL;
}

export async function status(env: Env): Promise<Record<string, unknown>> {
  const k = await apiKey(env);
  const fromSettings = await getSetting(env.DB, "ai_api_key");
  return {
    configured: !!k,
    key_hint: masked(k),
    key_source: fromSettings ? "settings" : env.FCLOUD_AI_KEY ? "secret" : "none",
    model: await currentModel(env),
    models: [DEFAULT_MODEL, ...FALLBACK_MODELS],
    multimodal: true,
    tools: Object.keys(TOOLS).sort(),
    history: HISTORY_LIMIT,
    max_rounds: MAX_ROUNDS,
  };
}

export async function setKey(env: Env, key: string | null): Promise<Record<string, unknown>> {
  if (!key) {
    await setSetting(env.DB, "ai_api_key", "");
    return await status(env);
  }
  const k = key.trim();
  if (!k.startsWith("sk-")) {
    throw new ApiError("这看起来不是 OpenRouter 的 API Key（应以 sk- 开头）");
  }
  if (k.length < 20) throw new ApiError("Key 太短了，检查一下有没有复制全");
  await setSetting(env.DB, "ai_api_key", k);
  return await status(env);
}

export async function setModel(env: Env, m: string): Promise<Record<string, unknown>> {
  const model = (m || "").trim();
  const allowed = new Set([DEFAULT_MODEL, ...FALLBACK_MODELS]);
  if (!allowed.has(model)) throw new ApiError("不支持的模型");
  await setSetting(env.DB, "ai_model", model);
  return await status(env);
}

export async function resetKey(env: Env): Promise<Record<string, unknown>> {
  await setSetting(env.DB, "ai_api_key", "");
  return await status(env);
}

// ---------------------------------------------------------------- 工具实现

interface ToolCtx {
  env: Env;
  master: MasterLike;
  member: Member;
}

/** 节点的简要描述（喂给模型用，比整个 node 精简）。 */
function nodeBrief(n: Record<string, unknown>): Record<string, unknown> {
  return {
    id: n["id"], name: n["name"], kind: n["kind"],
    parent_id: n["parent_id"], size: n["size"],
    category: n["category"], mime: n["mime"],
    encrypted: !!n["encrypted"],
    starred: !!n["starred"],
    modified_at: n["modified_at"],
    owner: n["owner_name"] || n["uploader_name"],
  };
}

/** 读取版本的前 N 字节（明文）。 */
async function readRange(
  ctx: ToolCtx, versionId: number, start: number, end: number,
): Promise<Uint8Array> {
  const stream = await blobstore.plainStream(ctx.env, ctx.master, versionId, start, end);
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { parts.push(value); total += value.length; }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * 把一段数据变成「内容块列表」，供 createFile / commitVersion 使用。
 *
 * Worker 里没有 Python 版的 ChunkWriter，但流程一样：
 * 算 SHA-256 → 存 R2 → 在 blobs 表登记 → 返回 {seq, blobId, plainSize}。
 *
 * 用 storeChunk（不动引用计数）而不是 putBytes（自带持有）——
 * 引用计数由 attachVersion 统一管，避免这里多算一次。
 */
async function storeChunks(
  env: Env, data: Uint8Array,
): Promise<{ seq: number; blobId: number; plainSize: number }[]> {
  const chunkSize = Number(env.CHUNK_SIZE || 4 * 1024 * 1024);
  const out: { seq: number; blobId: number; plainSize: number }[] = [];
  if (!data.length) {
    // 空文件也要有一个块（否则版本没有内容块，下载会拿到空）
    const r = await storeChunk(env, new Uint8Array(0));
    out.push({ seq: 0, blobId: r.blobId, plainSize: 0 });
    return out;
  }
  let seq = 0;
  for (let off = 0; off < data.length; off += chunkSize) {
    const piece = data.subarray(off, Math.min(off + chunkSize, data.length));
    const r = await storeChunk(env, piece);
    out.push({ seq: seq++, blobId: r.blobId, plainSize: piece.length });
  }
  return out;
}

async function tListFiles(ctx: ToolCtx, path = "", limit = 60): Promise<Record<string, unknown>> {
  const parent = await resolvePath(ctx.env.DB, SPACE_ID, path || "");
  const rows = await files.children(ctx.env, SPACE_ID, parent);
  const out: Record<string, unknown>[] = [];
  const max = Math.max(1, Math.min(200, Number(limit) || 60));
  for (const r of rows) {
    if (!(await sharing.canRead(ctx.env, r, ctx.member))) continue;
    out.push(nodeBrief(r as unknown as Record<string, unknown>));
    if (out.length >= max) break;
  }
  return {
    path: path || "/", parent_id: parent, count: out.length,
    items: out,
    hint: out.length ? "" : "这里没有子文件夹了，换个路径再看",
  };
}

async function tSearchFiles(
  ctx: ToolCtx, q = "", kind = "", category = "", limit = 40,
): Promise<Record<string, unknown>> {
  const filters = search.filtersFromQuery(new URLSearchParams({
    q: q || "", kind: kind || "", category: category || "",
  }));
  filters.spaceId = SPACE_ID;
  filters.text = q || "";
  const r = await search.search(ctx.env, filters, Math.max(1, Math.min(100, Number(limit) || 40)));
  const items: Record<string, unknown>[] = [];
  for (const n of r.rows) {
    if (!(await sharing.canRead(ctx.env, n as never, ctx.member))) continue;
    const item = nodeBrief(n as unknown as Record<string, unknown>);
    if ((n as Record<string, unknown>)["snippet"]) item["snippet"] = (n as Record<string, unknown>)["snippet"];
    items.push(item);
  }
  return {
    query: q || "", total: r.total, ms: r.ms,
    reason: r.reason || "", items,
    suggest: await search.suggest(ctx.env, q || "", 5),
  };
}

async function tReadFile(ctx: ToolCtx, node_id: number): Promise<Record<string, unknown>> {
  const n = await files.requireNode(ctx.env, Number(node_id), true);
  if (!(await sharing.canRead(ctx.env, n, ctx.member))) {
    throw new ApiError("没有权限看这个文件", 403);
  }
  if (n.kind !== "file") {
    return {
      ...nodeBrief(n as unknown as Record<string, unknown>),
      kind: "folder",
      stats: await files.subtreeStats(ctx.env, n.id),
    };
  }
  if (n.encrypted) {
    // MasterLike 没有 unlocked()，用 mustKey 探测（失败说明没解锁）
    try {
      await ctx.master.mustKey();
    } catch {
      throw new ApiError("这个文件是加密的，主密钥还没解锁", 403);
    }
  } else if (files.previewKind(n.name, n.mime) !== "text") {
    return {
      ...nodeBrief(n as unknown as Record<string, unknown>),
      kind: files.previewKind(n.name, n.mime),
      note: "这个类型读不出正文，只有上面的元信息",
    };
  }
  if (!n.current_version_id) {
    throw new ApiError("这个文件还没有内容", 404);
  }
  const raw = await readRange(ctx, n.current_version_id, 0, 64 * 1024);
  const text = search.decode(raw).slice(0, 12000);
  return {
    ...nodeBrief(n as unknown as Record<string, unknown>),
    kind: "text", chars: text.length, text,
  };
}

async function tRecent(ctx: ToolCtx, limit = 15): Promise<Record<string, unknown>> {
  const rows = await files.recent(ctx.env, SPACE_ID, Math.max(1, Math.min(50, Number(limit) || 15)));
  const items: Record<string, unknown>[] = [];
  for (const n of rows) {
    if (!(await sharing.canRead(ctx.env, n as never, ctx.member))) continue;
    items.push(nodeBrief(n as unknown as Record<string, unknown>));
  }
  return { items };
}

async function tTrash(ctx: ToolCtx, limit = 20): Promise<Record<string, unknown>> {
  const rows = await files.trashList(ctx.env, SPACE_ID, Math.max(1, Math.min(50, Number(limit) || 20)));
  return {
    items: rows.map((n) => nodeBrief(n as unknown as Record<string, unknown>)),
    retention_days: ctx.env.TRASH_DAYS || 30,
  };
}

async function tGetStats(ctx: ToolCtx): Promise<Record<string, unknown>> {
  const sp = await ctx.env.DB.prepare("SELECT * FROM spaces WHERE id=?").bind(SPACE_ID).first();
  const cats = await files.byCategory(ctx.env, SPACE_ID);
  const who = await files.byMember(ctx.env, SPACE_ID);
  let total = 0;
  for (const c of cats) total += Number(c.bytes || 0);
  // 去重省了多少 —— 直接用 storageStats 算好的口径，别自己另算一套
  const st = await storageStats(ctx.env);
  return {
    space_name: sp?.["name"],
    quota_bytes: sp?.["quota_bytes"],
    used_bytes: total,
    dedup_saved: st.dedup_saved,
    by_category: cats.map((c) => ({
      category: c.category, count: c.count, bytes: c.bytes,
    })),
    by_member: who.map((c) => ({
      display_name: c.display_name, files: c.files, bytes: c.bytes,
    })),
    trash_days: ctx.env.TRASH_DAYS || 30,
  };
}

async function tActivity(ctx: ToolCtx, limit = 20): Promise<Record<string, unknown>> {
  const rows = await sharing.recentLog(ctx.env, {
    spaceId: SPACE_ID,
    limit: Math.max(1, Math.min(50, Number(limit) || 20)),
  });
  return { items: rows };
}

// ---------- 写操作（都需要权限） ----------

async function tCreateFolder(
  ctx: ToolCtx, name: string, path = "",
): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "create_folder");
  const parent = await resolvePath(ctx.env.DB, SPACE_ID, path || "");
  const n = await files.createFolder(ctx.env, SPACE_ID, parent, name, ctx.member);
  await sharing.log(ctx.env, ctx.member, "create_folder", {
    targetType: "folder", targetId: n.id, targetName: n.name,
    detail: { by: "小f" }, ip: "",
  });
  return { created: nodeBrief(n as unknown as Record<string, unknown>) };
}

/**
 * 新建一个文本文件。
 *
 * Worker 里没有 ChunkWriter，但逻辑一样：算 SHA-256 → 存 R2 → 记 blobs → 绑版本。
 */
async function tCreateNote(
  ctx: ToolCtx, name: string, content: string, path = "",
): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "upload");
  const parent = await resolvePath(ctx.env.DB, SPACE_ID, path || "");
  const data = new TextEncoder().encode(content);
  if (!(await checkQuota(ctx.env, data.length))) {
    throw new ApiError("空间配额不够了", 400);
  }
  // Worker 里没有 ChunkWriter，手工走一遍：算哈希 → 存 R2 → 记 blobs → 绑版本。
  const chunks = await storeChunks(ctx.env, data);
  const n = await files.createFile(ctx.env, ctx.master, chunks, {
    spaceId: SPACE_ID, parentId: parent, name,
    size: data.length, mime: "text/markdown", member: ctx.member,
    category: "文档", note: "小f 创建",
  });
  await sharing.log(ctx.env, ctx.member, "upload", {
    targetType: "file", targetId: n.id, targetName: n.name,
    detail: { by: "小f" }, ip: "",
  });
  return {
    created: nodeBrief(n as unknown as Record<string, unknown>),
    bytes: data.length,
  };
}

async function checkQuota(env: Env, add: number): Promise<boolean> {
  const sp = await env.DB.prepare("SELECT quota_bytes FROM spaces WHERE id=?").bind(SPACE_ID).first<{ quota_bytes: number }>();
  const quota = Number(sp?.quota_bytes || 0);
  if (!quota) return true;  // 0 = 不限
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(size),0) AS used FROM nodes WHERE deleted_at IS NULL").first<{ used: number }>();
  return Number(row?.used || 0) + add <= quota;
}

async function tAppendNote(
  ctx: ToolCtx, node_id: number, content: string,
): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "upload");
  const n = await files.requireNode(ctx.env, Number(node_id));
  if (!(await sharing.effectiveWrite(ctx.env, n, ctx.member))) {
    throw new ApiError("只能改自己创建或被授权写的文件", 403);
  }
  if (files.previewKind(n.name, n.mime) !== "text") {
    throw new ApiError("只能追加到文本文件", 400);
  }
  if (!n.current_version_id) throw new ApiError("这个文件还没有内容", 404);
  const old = await readRange(ctx, n.current_version_id, 0, n.size);
  const oldText = search.decode(old);
  const body = oldText + (oldText && !oldText.endsWith("\n") ? "\n" : "") + content;
  const data = new TextEncoder().encode(body);
  const chunks = await storeChunks(ctx.env, data);
  const out = await files.commitVersion(ctx.env, ctx.master, n.id, chunks, {
    size: data.length, mime: "text/markdown", member: ctx.member,
    note: "小f 追加", category: "文档",
  });
  await sharing.log(ctx.env, ctx.member, "meta", {
    targetType: "file", targetId: n.id, targetName: out.name,
    detail: { by: "小f", append: content.length }, ip: "",
  });
  return {
    updated: nodeBrief(out as unknown as Record<string, unknown>),
    bytes: data.length,
  };
}

async function tRename(ctx: ToolCtx, node_id: number, name: string): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "edit_meta");
  const n = await files.rename(ctx.env, ctx.master, Number(node_id), name, ctx.member);
  await sharing.log(ctx.env, ctx.member, "rename", {
    targetType: n.kind, targetId: n.id, targetName: n.name,
    detail: { by: "小f" }, ip: "",
  });
  return { renamed: nodeBrief(n as unknown as Record<string, unknown>) };
}

async function tMove(ctx: ToolCtx, node_id: number, to_path = ""): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "edit_meta");
  const dest = await resolvePath(ctx.env.DB, SPACE_ID, to_path || "");
  const n = await files.move(ctx.env, Number(node_id), dest, ctx.member);
  await sharing.log(ctx.env, ctx.member, "move", {
    targetType: n.kind, targetId: n.id, targetName: n.name,
    detail: { by: "小f", to: to_path }, ip: "",
  });
  return {
    moved: nodeBrief(n as unknown as Record<string, unknown>),
    to: to_path || "/",
  };
}

async function tDelete(ctx: ToolCtx, node_id: number): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "delete_any");
  const node = await files.requireNode(ctx.env, Number(node_id));
  const r = await files.softDelete(ctx.env, Number(node_id), ctx.member);
  await sharing.log(ctx.env, ctx.member, "delete", {
    targetType: node.kind, targetId: Number(node_id), targetName: node.name,
    detail: { by: "小f", mode: "回收站" }, ip: "",
  });
  return {
    deleted: node.name, kind: node.kind,
    items: Number(r.deleted || 0),
    restore_hint: `回收站保留 ${ctx.env.TRASH_DAYS || 30} 天，之后自动清理`,
  };
}

async function tRestore(ctx: ToolCtx, node_id: number): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "restore_any");
  const before = await files.requireNode(ctx.env, Number(node_id), true);
  const r = await files.restore(ctx.env, Number(node_id), ctx.member);
  const after = (await files.get(ctx.env, Number(node_id))) || before;
  await sharing.log(ctx.env, ctx.member, "restore", {
    targetType: after.kind, targetId: Number(node_id), targetName: after.name,
    detail: { by: "小f" }, ip: "",
  });
  return {
    restored: nodeBrief(after as unknown as Record<string, unknown>),
    items: Number(r.restored || 0),
    parent_id: r.parent_id ?? 0,
  };
}

async function tStar(ctx: ToolCtx, node_id: number, starred = true): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "edit_meta");
  const n = await files.applyMeta(ctx.env, ctx.master, Number(node_id), ctx.member, { starred: !!starred });
  return {
    starred: !!starred,
    file: nodeBrief(n as unknown as Record<string, unknown>),
  };
}

async function tShare(
  ctx: ToolCtx, node_id: number, username: string, permission = "read",
): Promise<Record<string, unknown>> {
  requirePerm(ctx.member, "share");
  const target = await getMemberByName(ctx.env.DB, username);
  if (!target) throw new ApiError(`没有这个成员：${username}`, 404);
  if (!["read", "write", "own"].includes(permission)) {
    throw new ApiError("权限只能是 read / write / own", 400);
  }
  await sharing.grant(ctx.env, Number(node_id), target.id, permission, ctx.member);
  const node = await files.requireNode(ctx.env, Number(node_id));
  await sharing.log(ctx.env, ctx.member, "share_grant", {
    targetType: "file", targetId: Number(node_id), targetName: node.name,
    detail: { by: "小f", to: target.display_name, permission }, ip: "",
  });
  return {
    shared_with: target.display_name, permission,
    file: nodeBrief(node as unknown as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------- 工具表

interface ToolDef {
  name: string;
  desc: string;
  params: Record<string, unknown>;
  perm: string;
  write: boolean;
  roles: string[];
  fn: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const TOOLS: Record<string, ToolDef> = {};

/** 导出工具表（前端要显示每个工具是不是写操作）。 */
export { TOOLS };

const S = { type: "string" };
const I = { type: "integer" };
const B = { type: "boolean" };

function obj(
  props: Record<string, unknown>, required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties: props, required, additionalProperties: false };
}

function tool(
  name: string, desc: string, params: Record<string, unknown>,
  fn: ToolDef["fn"], opts: { perm?: string; write?: boolean; roles?: string[] } = {},
): void {
  TOOLS[name] = {
    name, desc, params, fn,
    perm: opts.perm || "read",
    write: !!opts.write,
    roles: opts.roles || ["admin", "adult"],
  };
}

/** 权限检查（跟 Python 版 members.require 同义）。 */
function requirePerm(m: Member | null, action: string): Member {
  if (!m) throw new ApiError("请先登录", 401);
  if (!memberCan(m.role, action)) {
    throw new ApiError("没有权限做这件事", 403);
  }
  return m;
}

function registerAll(): void {
  tool("list_files", "列出某个文件夹里的内容。path 用相对路径，空字符串表示根目录。",
    obj({
      path: { ...S, description: "相对路径，如 照片/2024；空为根目录" },
      limit: { ...I, description: "最多返回多少条，默认 60" },
    }, ["path"]),
    (c, a) => tListFiles(c, String(a["path"] ?? ""), Number(a["limit"] ?? 60)));

  tool("search_files", "搜索文件。q 会同时匹配文件名和文件正文里的字，中文可以直接搜。",
    obj({
      q: { ...S, description: "关键词" },
      kind: { ...S, enum: ["file", "folder"], description: "只看文件或文件夹" },
      category: { ...S, description: "分类：照片/视频/音频/文档/表格/压缩包/其他" },
      limit: { ...I, description: "默认 40" },
    }, ["q"]),
    (c, a) => tSearchFiles(c, String(a["q"] ?? ""), String(a["kind"] ?? ""),
      String(a["category"] ?? ""), Number(a["limit"] ?? 40)));

  tool("read_file", "读一个文件（node_id）的正文。只支持文本类。",
    obj({ node_id: { ...I, description: "文件 id" } }, ["node_id"]),
    (c, a) => tReadFile(c, Number(a["node_id"])));

  tool("recent_files", "最近修改过的文件列表。",
    obj({ limit: { ...I, description: "默认 15" } }),
    (c, a) => tRecent(c, Number(a["limit"] ?? 15)));

  tool("list_trash", "回收站里的文件。",
    obj({ limit: { ...I, description: "默认 20" } }),
    (c, a) => tTrash(c, Number(a["limit"] ?? 20)));

  tool("get_stats", "空间统计：容量、分类占比、谁上传得最多、去重省了多少。",
    obj({}),
    (c) => tGetStats(c));

  tool("activity_log", "最近的操作记录（谁在什么时候动了什么）。",
    obj({ limit: { ...I, description: "默认 20" } }),
    (c, a) => tActivity(c, Number(a["limit"] ?? 20)));

  tool("create_folder", "新建一个文件夹。",
    obj({
      name: { ...S, description: "文件夹名" },
      path: { ...S, description: "建在哪，默认根目录" },
    }, ["name"]),
    (c, a) => tCreateFolder(c, String(a["name"]), String(a["path"] ?? "")),
    { perm: "create_folder", write: true });

  tool("create_note", "新建一个文本文件并写入内容。",
    obj({
      name: { ...S, description: "文件名，建议带 .md 或 .txt" },
      content: { ...S, description: "文件内容" },
      path: { ...S, description: "建在哪，默认根目录" },
    }, ["name", "content"]),
    (c, a) => tCreateNote(c, String(a["name"]), String(a["content"]), String(a["path"] ?? "")),
    { perm: "upload", write: true });

  tool("append_note", "往已有文本文件末尾追加内容（生成新版本，可回滚）。",
    obj({ node_id: { ...I }, content: { ...S } }, ["node_id", "content"]),
    (c, a) => tAppendNote(c, Number(a["node_id"]), String(a["content"])),
    { perm: "upload", write: true });

  tool("rename_file", "改文件名。",
    obj({ node_id: { ...I }, name: { ...S } }, ["node_id", "name"]),
    (c, a) => tRename(c, Number(a["node_id"]), String(a["name"])),
    { perm: "edit_meta", write: true });

  tool("move_file", "把文件或文件夹移到另一个目录。",
    obj({
      node_id: { ...I },
      to_path: { ...S, description: "目标目录的相对路径，空为根目录" },
    }, ["node_id", "to_path"]),
    (c, a) => tMove(c, Number(a["node_id"]), String(a["to_path"] ?? "")),
    { perm: "edit_meta", write: true });

  tool("delete_file", "把文件/文件夹移到回收站（可恢复，不是彻底删除）。",
    obj({ node_id: { ...I } }, ["node_id"]),
    (c, a) => tDelete(c, Number(a["node_id"])),
    { perm: "delete_any", write: true });

  tool("restore_file", "从回收站恢复。",
    obj({ node_id: { ...I } }, ["node_id"]),
    (c, a) => tRestore(c, Number(a["node_id"])),
    { perm: "restore_any", write: true });

  tool("star_file", "收藏 / 取消收藏。",
    obj({ node_id: { ...I }, starred: { ...B } }, ["node_id"]),
    (c, a) => tStar(c, Number(a["node_id"]), a["starred"] === undefined ? true : !!a["starred"]),
    { perm: "edit_meta", write: true });

  tool("share_file", "把文件共享给某个成员。",
    obj({
      node_id: { ...I }, username: { ...S },
      permission: { ...S, enum: ["read", "write", "own"] },
    }, ["node_id", "username"]),
    (c, a) => tShare(c, Number(a["node_id"]), String(a["username"]),
      String(a["permission"] ?? "read")),
    { perm: "share", write: true });
}

registerAll();

/**
 * 按角色裁剪工具表。
 *
 * 儿童只会拿到只读工具 —— 不是「调用了再拒绝」，
 * 而是压根不告诉模型有这些工具存在，这样它就不会先许诺再失败。
 */
export function toolsFor(member: Member): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of Object.values(TOOLS)) {
    if (t.perm === "read") {
      out.push({
        type: "function",
        function: { name: t.name, description: t.desc, parameters: t.params },
      });
    } else if (t.roles.includes(member.role) && memberCan(member.role, t.perm)) {
      out.push({
        type: "function",
        function: { name: t.name, description: t.desc, parameters: t.params },
      });
    }
  }
  return out;
}

/** 执行一个工具。返回 (给模型看的 JSON 文本, 给前端看的中文摘要)。 */
export async function runTool(
  ctx: ToolCtx, name: string, args: Record<string, unknown>,
): Promise<[string, string]> {
  const t = TOOLS[name];
  if (!t) {
    return [JSON.stringify({ error: `没有叫 ${name} 的工具` }), `未知工具 ${name}`];
  }
  if (JSON.stringify(args).length > MAX_TOOL_ARGS) {
    return [JSON.stringify({ error: "参数太长" }), "参数过长"];
  }
  // 第二道防线：执行期再查一次角色（第一道是 toolsFor 裁剪工具表）
  if (t.perm !== "read" && !t.roles.includes(ctx.member.role)) {
    return [JSON.stringify({ error: "没有权限做这件事" }), "权限不足"];
  }
  try {
    const r = await t.fn(ctx, args);
    return [JSON.stringify(r), summarize(name, r)];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [JSON.stringify({ error: msg }), `失败：${msg}`];
  }
}

/** 给前端看的中文摘要。 */
export function summarize(name: string, r: Record<string, unknown>): string {
  const s = r as Record<string, any>;
  switch (name) {
    case "search_files": {
      const n = (s.items || []).length;
      return n ? `搜索「${s.query}」找到 ${n} 个结果` : `没找到「${s.query}」`;
    }
    case "list_files": return `打开「${s.path}」，${s.count} 项`;
    case "read_file": return `读了「${s.name}」`;
    case "get_stats": return "查了空间统计";
    case "create_folder": return `新建了文件夹「${s.created?.name}」`;
    case "create_note": return `写入了「${s.created?.name}」`;
    case "append_note": return `写入了「${s.updated?.name}」`;
    case "delete_file": return `把「${s.deleted}」移到了回收站`;
    case "restore_file": return `恢复了「${s.restored?.name}」`;
    case "move_file": return `移动了「${s.moved?.name}」`;
    case "rename_file": return `改名为「${s.renamed?.name}」`;
    case "star_file": return "更新了收藏";
    case "share_file": return `共享给了 ${s.shared_with}`;
    default: return `用了 ${name}`;
  }
}

// ---------------------------------------------------------------- 调模型

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

/**
 * 调 OpenRouter。返回 Response（流式）。
 *
 * 429/5xx 由调用方判断后换模型；400 直接抛。
 */
async function postModel(
  model: string, payload: Record<string, unknown>, key: string, signal?: AbortSignal,
): Promise<Response> {
  const body = { ...payload, model, stream: true };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
      "HTTP-Referer": SITE,
      "X-Title": APP,
    },
    body: JSON.stringify(body),
    signal,
  });
  return res;
}

/**
 * 解析 OpenRouter 的 SSE 流。
 *
 * ⚠️ Worker 里一个 chunk 可能含半行、也可能含十几行 —— 必须自己按 \n 切。
 * 而且要用 TextDecoder(..., {stream:true})，否则跨 chunk 的 UTF-8 边界会乱码
 * （一个中文字符被劈成两个字节）。
 */
export async function* parseSSE(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;  // 半行/坏 JSON，跳过
      }
    }
  }
  // 收尾：flush 掉 decoder 里的残余字节，再处理最后一行
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail.startsWith("data:") && tail.slice(5).trim() !== "[DONE]") {
    try {
      yield JSON.parse(tail.slice(5).trim()) as Record<string, unknown>;
    } catch { /* ignore */ }
  }
}

/** 历史消息瘦身：只保留文本，丢掉已经被工具结果覆盖掉的中间轮。 */
export function briefHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history.slice(-HISTORY_LIMIT * 2)) {
    const role = m.role;
    const content = m.content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.slice(0, 4000) });
    }
  }
  return out.slice(-HISTORY_LIMIT);
}

/**
 * 把云盘里的图片取出来塞进多模态消息。
 *
 * 限三张、单张 ≤3.5MB —— 再大 base64 会撑爆上下文。
 * 加密文件的图片不读出去（那等于把密文+密钥一起发到外部）。
 */
export async function attachImages(
  ctx: ToolCtx, ids: number[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const nid of ids.slice(0, 3)) {
    try {
      const n = await files.requireNode(ctx.env, Number(nid));
      if (!(await sharing.canRead(ctx.env, n as never, ctx.member))) continue;
      if (n.encrypted) continue;
      if (files.previewKind(n.name, n.mime) !== "image") continue;
      if (n.size > 3_500_000) continue;
      if (!n.current_version_id) continue;
      const raw = await readRange(ctx, n.current_version_id, 0, n.size);
      const mime = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(n.mime)
        ? n.mime : "image/jpeg";
      const b64 = b64encode(raw);
      out.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` },
      });
    } catch (e) {
      // ⚠️ 不能静默吞掉 —— 图片挂不上是小事，但不能让真正的 bug 无声消失。
      console.warn("[小f] 图片", nid, "附加失败：", e instanceof Error ? e.message : String(e));
      continue;
    }
  }
  return out;
}

/** Uint8Array → base64（分块，避免 apply 超大参数）。 */
function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------- 对话主循环

export interface ChatEvent {
  event: "stage" | "delta" | "tool" | "done" | "error";
  data: Record<string, unknown>;
}

/**
 * 跑完整个工具循环，边跑边吐事件。
 *
 * 模型切换策略：首选模型免费额满会 429，那就按备选顺序顶替；
 * 全部失败才报错。所以一次请求里模型可能会换，事件里的 model 字段是当前在用的。
 */
export async function* chatStream(
  ctx: ToolCtx, history: ChatMessage[], message: string,
  imageNodes: number[] = [], preferModel?: string,
): AsyncGenerator<ChatEvent> {
  const key = await apiKey(ctx.env);
  if (!key) {
    yield { event: "error", data: { error: "还没配置 API Key" } };
    return;
  }

  let userContent: unknown = message;
  const images = await attachImages(ctx, imageNodes);
  if (images.length) {
    // 有些多模态端点不接受空 text 段，只发图时给一句占位
    const text = message || "（用户只发了图，没打字）";
    userContent = [{ type: "text", text }, ...images];
  }

  const msgs: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  msgs.push(...briefHistory(history));
  msgs.push({ role: "user", content: userContent });

  const specs = toolsFor(ctx.member);
  const cur = await currentModel(ctx.env);
  const order = preferModel
    ? [preferModel, cur, ...FALLBACK_MODELS]
    : [cur, ...FALLBACK_MODELS];
  const seen = new Set<string>();
  const models = order.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));

  let lastErr = "";
  for (const md of models) {
    try {
      yield* oneModel(ctx, md, key, msgs, specs);
      return;
    } catch (e) {
      if (e instanceof HttpStatusError) {
        lastErr = e.message;
        // 429/5xx 才值得换模型；400 这种是自己参数写错了，换谁都一样
        if (![408, 409, 429, 500, 502, 503, 504].includes(e.status)) {
          yield { event: "error", data: { error: e.message || `模型返回 ${e.status}` } };
          return;
        }
      } else {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
  }
  yield { event: "error", data: { error: `所有模型都没能应答（${lastErr || "未知原因"}）` } };
}

/** 带 HTTP 状态码的错误（用来判断该不该换模型）。 */
export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpStatusError";
  }
}

/** 在单个模型上跑完整个工具循环。 */
async function* oneModel(
  ctx: ToolCtx, md: string, key: string,
  msgs: ChatMessage[], specs: Record<string, unknown>[],
): AsyncGenerator<ChatEvent> {
  const tools = specs.length ? specs : undefined;
  for (let rnd = 0; rnd < MAX_ROUNDS; rnd++) {
    const payload: Record<string, unknown> = {
      messages: msgs, tool_choice: "auto", temperature: 0.2,
    };
    if (tools) payload.tools = tools;

    const res = await postModel(md, payload, key);
    if (!res.ok) {
      const raw = (await res.text()).slice(0, 400);
      let msg = raw;
      try {
        const j = JSON.parse(raw) as any;
        msg = j?.error?.message || raw;
      } catch { /* 保留原文 */ }
      throw new HttpStatusError(res.status, msg);
    }

    const textParts: string[] = [];
    const calls: Record<number, { id: string; name: string; args: string }> = {};

    for await (const ev of parseSSE(res)) {
      if (ev.error) {
        const e = ev.error as any;
        throw new HttpStatusError(502, String(e?.message || e));
      }
      const choices = (ev.choices as any[]) || [];
      for (const ch of choices) {
        const d = ch.delta || {};
        const piece = d.content;
        if (piece) {
          textParts.push(piece);
          yield { event: "delta", data: { text: piece } };
        }
        for (const tc of (d.tool_calls || [])) {
          const i = Number(tc.index || 0);
          if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
          if (tc.id) calls[i].id = tc.id;
          const fnc = tc.function || {};
          if (fnc.name) calls[i].name = fnc.name;
          if (fnc.arguments) calls[i].args += fnc.arguments;
        }
      }
    }

    const text = textParts.join("").trim();
    const callList = Object.keys(calls).map(Number).sort((a, b) => a - b);

    if (!callList.length) {
      yield {
        event: "done",
        data: {
          model: md, text, rounds: rnd + 1,
          tools_used: msgs.filter((m) => m.role === "tool")
            .map((m) => (m as any).name).filter(Boolean),
        },
      };
      return;
    }

    msgs.push({
      role: "assistant",
      content: text || null,
      tool_calls: callList.map((i, idx) => {
        const c = calls[i];
        return {
          id: c.id || `call_${idx}`,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        };
      }),
    });

    for (const i of callList) {
      const c = calls[i];
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(c.args || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch { /* 参数不是合法 JSON → 用空对象 */ }

      const [payloadText, summary] = await runTool(ctx, c.name, args);
      msgs.push({
        role: "tool",
        tool_call_id: c.id || "call_0",
        name: c.name,
        content: payloadText.slice(0, MAX_TOOL_ARGS),
      });
      yield {
        event: "tool",
        data: {
          name: c.name, summary, args,
          ok: !payloadText.includes('"error"'),
        },
      };
    }
  }

  yield {
    event: "done",
    data: {
      model: md,
      text: "我绕了几轮还没理清，先停一下。你可以直接说「搜一下 xxx」这类更具体的问题。",
      rounds: MAX_ROUNDS, truncated: true,
    },
  };
}
