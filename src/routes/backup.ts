/**
 * 备份路由。
 *
 * ## Edge 版备份跟 Python 版不一样（要说清楚）
 *
 * Python 版：把整个 blobs 目录 + 数据库打成一个 ZIP 放本地。
 * Edge 版：数据本来就躺在 R2 里（R2 本身就有版本化/持久性保证），
 * 所以真正需要备份的是 **D1 里的元数据**（文件树、成员、共享关系）。
 *
 * 这里的做法：把 D1 的关键表导出成一个 JSON，存到 R2 的 backups/ 前缀下。
 * 恢复的时候把它读回来，逐表 INSERT OR REPLACE。
 *
 * 块数据（blobs）不重复备份 —— 它们在 R2 里，本来就不会丢。
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import { require } from "../members";
import { log } from "../sharing";
import { getSetting, queryAll, setSetting } from "../db";
import { needBlob } from "../storage";
import { ApiError, type Env } from "../types";
import type { Ctx } from "../http";

/**
 * 要备份的表。**顺序很重要** —— 恢复时按这个顺序插，要满足外键依赖。
 *
 * 依赖关系：
 *   members  ← spaces ← space_members
 *   members  ← nodes.owner_id / uploader_id
 *   spaces   ← nodes.space_id
 *   nodes    ← versions.node_id
 *   versions ← nodes.current_version_id   ← 循环！见下面 RESTORE_ORDER 的说明
 *   blobs    ← version_chunks.blob_id
 *   nodes    ← version_chunks? 不，version_chunks → versions
 *   nodes    ← file_text / fterms / shares
 *   uploads  ← upload_parts
 */
const TABLES = [
  "members", "spaces", "space_members", "blobs", "nodes", "versions",
  "version_chunks", "version_crypto", "uploads", "upload_parts",
  "shares", "tombstones", "settings", "file_text", "fterms", "audit",
];

function backupKey(name: string): string {
  return `backups/${name}`;
}

export async function backupNow(ctx: Ctx): Promise<Response> {
  const blob = needBlob(ctx.env);
  const m = await need(ctx);
  require(m, "run_backup");
  const d = await jsonBody<{ note?: string }>(ctx.req);

  const dump: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    try {
      dump[t] = await queryAll(ctx.env.DB, `SELECT * FROM ${t}`);
    } catch {
      dump[t] = [];
    }
  }
  // ⚠️ settings 里的主密钥材料（master_derived）**不能进备份**。
  // 它一旦被恢复，全家的加密文件就得用旧口令才能解开 ——
  // 而用户很可能已经换了口令。恢复时保留当前的 master_derived。
  if (Array.isArray(dump["settings"])) {
    dump["settings"] = dump["settings"].filter(
      (r) => String((r as Record<string, unknown>)["key"]) !== "master_derived");
  }
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const name = `fcloud-${stamp}.json`;
  const payload = JSON.stringify({
    name,
    created_at: now.toISOString(),
    note: d.note || "",
    by: m.display_name,
    tables: dump,
  });

  await blob.put(backupKey(name), payload, {
    httpMetadata: { contentType: "application/json" },
  });
  await setSetting(ctx.env.DB, "last_backup_at", String(Date.now() / 1000));
  await log(ctx.env, m, "backup", {
    detail: { name, size: payload.length }, ip: ctx.ip,
  });
  return json({ ok: true, name, size: payload.length });
}

export async function backupList(ctx: Ctx): Promise<Response> {
  const blob = needBlob(ctx.env);
  await need(ctx);
  require(ctx.member!, "run_backup");
  const items: { name: string; size: number; uploaded: string }[] = [];
  let cursor: R2ListOptions["cursor"] | undefined = undefined;
  do {
    const page = await blob.list({ prefix: "backups/", cursor, limit: 1000 });
    for (const o of page.objects) {
      items.push({
        name: o.key.replace(/^backups\//, ""),
        size: o.size,
        uploaded: o.uploaded.toISOString(),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1));
  return json({ items, last_backup_at: await getSetting(ctx.env.DB, "last_backup_at") });
}

export async function backupRestore(ctx: Ctx): Promise<Response> {
  const blob = needBlob(ctx.env);
  const m = await need(ctx);
  require(m, "run_backup");
  const d = await jsonBody<{ name?: string }>(ctx.req);
  const name = (d.name || "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!name) throw new ApiError("没指定要恢复哪个备份");
  const obj = await blob.get(backupKey(name));
  if (!obj) throw new ApiError("找不到这个备份文件", 404);

  let payload: { tables?: Record<string, Record<string, unknown>[]> };
  try {
    payload = JSON.parse(await obj.text());
  } catch {
    throw new ApiError("备份文件损坏了，读不出来");
  }
  const tables = payload.tables || {};

  // ---- 第 1 步：清空现有数据（按反向依赖顺序）----
  // D1 的外键永远开启，且 INSERT OR REPLACE 等于「删了再插」——
  // 直接 REPLACE nodes 会触发 ON DELETE CASCADE 把 versions 全删掉。
  // 所以老老实实先 DELETE 再 INSERT，语义跟 Python 版「整库替换」一致。
  try {
    await clearTables(ctx.env);
  } catch (e) {
    throw new ApiError(`清空旧数据失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 第 2 步：按依赖顺序插回去 ----
  const perTable: Record<string, number> = {};
  let restored = 0;
  for (const t of TABLES) {
    const rows = tables[t];
    if (!Array.isArray(rows) || !rows.length) continue;
    try {
      await restoreTable(ctx.env, t, rows);
    } catch (e) {
      throw new ApiError(`恢复表 ${t} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
    perTable[t] = rows.length;
    restored += rows.length;
  }

  // ---- 第 3 步：补回 nodes.current_version_id ----
  // nodes.current_version_id → versions.id，versions.node_id → nodes.id，
  // 是个循环外键。插的时候先把 current_version_id 置 NULL，
  // 等 versions 都进去了再回填。
  let cur = 0;
  try {
    cur = await restoreCurrentVersions(ctx.env, tables);
  } catch (e) {
    throw new ApiError(`回填当前版本失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (cur) restored += cur;

  await log(ctx.env, m, "backup", { detail: { restored, name }, ip: ctx.ip });
  return json({ ok: true, restored, name, per_table: perTable, current_versions: cur });
}

/**
 * 清空所有业务表（保留 sessions？不保留 —— 恢复后强制重新登录更安全）。
 *
 * 顺序是 TABLES 的**反向**：先删被引用的，后删引用别人的。
 */
async function clearTables(env: Env): Promise<void> {
  // ⚠️ nodes.current_version_id → versions.id 和 versions.node_id → nodes.id
  // 是个**循环外键**，而 D1 的外键永远开启且立即检查。
  // 直接按顺序 DELETE 会炸：
  //   删了 versions 之后，nodes.current_version_id 还指着它 → 删 nodes 时报
  //   FOREIGN KEY constraint failed。
  // 所以第一步先把引用断开。
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE nodes SET current_version_id = NULL"),
  ];
  // 之后按「被引用的先删」顺序
  const order = [
    "fterms", "file_text", "shares", "upload_parts", "uploads",
    "version_crypto", "version_chunks", "versions", "nodes",
    "space_members", "spaces", "blobs", "tombstones", "sessions",
    "audit", "members",
  ];
  for (const t of order) stmts.push(env.DB.prepare(`DELETE FROM ${t}`));
  // settings 只删 master_derived 以外的行 —— 主密钥材料必须留着，
  // 不然恢复完全家加密文件就再也解不开了。
  stmts.push(env.DB.prepare("DELETE FROM settings WHERE key <> 'master_derived'"));
  await env.DB.batch(stmts);
}

/**
 * 把一张表的数据灌回去。
 *
 * 用 INSERT（不是 INSERT OR REPLACE）：表已经清空了，不存在冲突，
 * 而 REPLACE 的「先删后插」语义会触发级联删除，把别的表搞坏。
 *
 * 绑定参数上限 100 —— 一行 N 列就是 N 个参数，所以一行一条语句，
 * 再用 batch() 把多条语句合并成一次往返。
 */
async function restoreTable(
  env: Env, table: string, rows: Record<string, unknown>[],
): Promise<void> {
  const cols = Object.keys(rows[0]);
  if (!cols.length) return;
  // nodes 的 current_version_id 是循环外键，插的时候先置空。
  // settings 里的 master_derived 是主密钥材料，恢复时保留当前值（不覆盖）。
  const useCols = table === "nodes"
    ? cols.filter((c) => c !== "current_version_id")
    : cols;
  const usePh = useCols.map(() => "?").join(",");
  // settings 用 OR REPLACE（主键是 key，可能已存在 master_derived 之外的行）；
  // 其它表已经清空过，普通 INSERT 就行（REPLACE 会触发级联删除，不用）。
  const verb = table === "settings" ? "INSERT OR REPLACE" : "INSERT";
  const useSql = `${verb} INTO ${table}(${useCols.join(",")}) VALUES(${usePh})`;

  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const part = rows.slice(i, i + BATCH_ROWS);
    const stmts = part.map((r) =>
      env.DB.prepare(useSql).bind(...useCols.map((c) => r[c] ?? null)));
    await env.DB.batch(stmts);
  }
}

/** 回填 nodes.current_version_id（备份里 is_current=1 的那个版本）。 */
async function restoreCurrentVersions(
  env: Env, tables: Record<string, Record<string, unknown>[]>,
): Promise<number> {
  const rows = tables["versions"];
  if (!Array.isArray(rows)) return 0;
  const cur = rows.filter((v) => v["is_current"]);
  if (!cur.length) return 0;
  const stmts = cur.map((v) =>
    env.DB.prepare("UPDATE nodes SET current_version_id=? WHERE id=?")
      .bind(Number(v["id"]), Number(v["node_id"])));
  for (let i = 0; i < stmts.length; i += BATCH_ROWS) {
    await env.DB.batch(stmts.slice(i, i + BATCH_ROWS));
  }
  return cur.length;
}

/**
 * 一次 batch 放多少行。
 *
 * D1 免费版每个 Worker invocation 最多 50 条查询，所以 batch 不能太大；
 * 同时单条语句绑定参数上限 100，nodes 有 24 列 → 一行就是 24 个参数，
 * 一条语句一行是安全的，50 行一批正好用满查询配额。
 */
const BATCH_ROWS = 50;
