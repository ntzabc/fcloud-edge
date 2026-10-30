/**
 * D1 数据访问层。
 *
 * ## 跟 Python 版 sqlite3 的差异（这几条必须记住）
 *
 * 1. **没有事务语句**。`BEGIN` / `COMMIT` / `ROLLBACK` 在 D1 上不被支持。
 *    多语句原子性用 `db.batch([...])` —— 它把整批语句当一个事务执行。
 *    Python 版的 `db.tx()` 上下文管理器在这里对应 `batch()`。
 *
 * 2. **没有 lastrowid**。`run()` 返回 `{ meta: { last_row_id, changes } }`，
 *    要用这个拿自增 id。
 *
 * 3. **一次调用上限**：100 条绑定参数、1000 条查询/invocation。
 *    批量操作要拆批。
 *
 * 4. **外键永远开启**，`PRAGMA foreign_keys = OFF` 会被静默忽略。
 *    所以删除时要自己按顺序删（先子后父）。
 *
 * 5. **BLOB 变 TEXT**。D1 只支持 TEXT / INTEGER / REAL / BLOB，
 *    但 BLOB 存字节不方便，统一用 base64 字符串。
 */

import { ApiError, type Member, type Node, type Version } from "./types";

// ---------------------------------------------------------------- 基础查询

export async function queryAll<T = Record<string, unknown>>(
  db: D1Database, sql: string, ...params: unknown[]
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  const res = await bound.all<T>();
  return res.results ?? [];
}

export async function queryOne<T = Record<string, unknown>>(
  db: D1Database, sql: string, ...params: unknown[]
): Promise<T | null> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  return await bound.first<T>();
}

export async function execute(
  db: D1Database, sql: string, ...params: unknown[]
): Promise<D1Result> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  return await bound.run();
}

/** 插入并返回自增 id。D1 的 run() 结果里带 last_row_id。 */
export async function insert(
  db: D1Database, sql: string, ...params: unknown[]
): Promise<number> {
  const res = await execute(db, sql, ...params);
  return Number(res.meta.last_row_id ?? 0);
}

/**
 * 批量执行，整批当一个事务。
 * Python 版 db.tx() 的等价物 —— D1 没有显式事务，只有 batch。
 */
export async function tx(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (!stmts.length) return [];
  return await db.batch(stmts);
}

// ---------------------------------------------------------------- 设置

export async function getSetting(
  db: D1Database, key: string, def: string | null = null,
): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    db, "SELECT value FROM settings WHERE key=?", key);
  return row?.value ?? def;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await execute(db,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    key, value, Date.now() / 1000);
}

// ---------------------------------------------------------------- 成员

export interface MemberRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  pwd_hash: string | null;
  pwd_salt: string | null;
  pwd_algo: string | null;
  color: string;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

/**
 * 角色 → 允许的动作。
 *
 * ⚠️ 必须跟 Python 版 members.PERMISSIONS **一字不差**。
 * 前端 `S.me.can.includes('manage_members')` 直接吃这个列表，
 * 后端 `require(m, 'create_folder')` 也吃它 —— 两边口径必须同源。
 * 早先这里写成了一套「看起来更合理」的精简版（少了 browse/preview/
 * create_folder/delete_own/use_encryption/manage_master/view_audit/
 * run_backup/share），结果儿童点「新建文件夹」会 403。
 */
export const PERMISSIONS: Record<string, string[]> = {
  // 基础
  browse: ["admin", "adult", "child"],
  download: ["admin", "adult", "child"],
  preview: ["admin", "adult", "child"],
  // 写入
  upload: ["admin", "adult", "child"],
  create_folder: ["admin", "adult", "child"],
  edit_meta: ["admin", "adult", "child"],
  // 删除
  delete_own: ["admin", "adult", "child"],
  delete_any: ["admin", "adult"],
  purge: ["admin"],
  restore_any: ["admin", "adult"],
  // 加密
  use_encryption: ["admin", "adult"],
  manage_master: ["admin"],
  // 成员与空间
  manage_members: ["admin"],
  manage_space: ["admin"],
  // 审计与备份
  view_audit: ["admin", "adult"],
  run_backup: ["admin"],
  // 分享
  share: ["admin", "adult"],
};

export const ROLE_LABEL: Record<string, string> = {
  admin: "管理员", adult: "成人", child: "儿童",
};

export function memberCan(role: string, action: string): boolean {
  const roles = PERMISSIONS[action];
  return roles ? roles.includes(role) : false;
}

/**
 * 把 MemberRow 变成给前端的对象。
 *
 * 字段名必须跟 Python 版 Member.to_dict() 完全一致，前端要吃：
 *   role_label（成员列表里显示「儿童（成人）」）
 *   initial（头像里的首字）
 *   can（权限数组）
 */
export function memberToDict(m: MemberRow): Member {
  const name = m.display_name || m.username || "?";
  return {
    id: m.id,
    username: m.username,
    display_name: m.display_name,
    role: m.role as Member["role"],
    role_label: ROLE_LABEL[m.role] ?? m.role,
    initial: name.slice(0, 1).toUpperCase(),
    color: m.color,
    disabled: m.disabled,
    created_at: m.created_at,
    last_login_at: m.last_login_at,
    can: Object.keys(PERMISSIONS).filter((a) => memberCan(m.role, a)).sort(),
  };
}

export async function getMember(db: D1Database, id: number): Promise<MemberRow | null> {
  return await queryOne<MemberRow>(db, "SELECT * FROM members WHERE id=?", id);
}

export async function getMemberByName(
  db: D1Database, username: string,
): Promise<MemberRow | null> {
  return await queryOne<MemberRow>(db, "SELECT * FROM members WHERE username=?", username);
}

export async function listMembers(db: D1Database, spaceId = 1): Promise<MemberRow[]> {
  return await queryAll<MemberRow>(
    db,
    "SELECT m.* FROM members m JOIN space_members sm ON sm.member_id = m.id " +
    "WHERE sm.space_id=? AND m.disabled=0 ORDER BY m.id", spaceId);
}

// ---------------------------------------------------------------- 节点

export async function getNode(db: D1Database, id: number): Promise<Node | null> {
  return await queryOne<Node>(db, "SELECT * FROM nodes WHERE id=?", id);
}

export async function requireNode(db: D1Database, id: number): Promise<Node> {
  const n = await getNode(db, id);
  if (!n) throw new ApiError("文件不存在", 404);
  return n;
}

/** 目录下的直接子项（不含回收站里的）。 */
export async function children(
  db: D1Database, spaceId: number, parentId: number,
): Promise<Node[]> {
  return await queryAll<Node>(
    db,
    "SELECT n.*, m.display_name AS owner_name, u.display_name AS uploader_name " +
    "FROM nodes n LEFT JOIN members m ON m.id=n.owner_id " +
    "LEFT JOIN members u ON u.id=n.uploader_id " +
    "WHERE n.space_id=? AND n.parent_id=? AND n.deleted_at IS NULL " +
    "ORDER BY n.kind='folder' DESC, " +
    "CASE n.category WHEN '照片' THEN 0 WHEN '视频' THEN 1 WHEN '音频' THEN 2 " +
    "WHEN '文档' THEN 3 WHEN '表格' THEN 4 WHEN '压缩包' THEN 5 ELSE 6 END, " +
    "n.name COLLATE NOCASE", spaceId, parentId);
}

/** 节点及其所有后代（用于递归删除）。 */
export async function descendants(
  db: D1Database, spaceId: number, rootId: number,
): Promise<Node[]> {
  const out: Node[] = [];
  const stack = [rootId];
  while (stack.length) {
    const pid = stack.pop()!;
    const kids = await queryAll<Node>(
      db,
      "SELECT n.* FROM nodes n WHERE n.space_id=? AND n.parent_id=? AND n.deleted_at IS NULL",
      spaceId, pid);
    for (const k of kids) {
      out.push(k);
      stack.push(k.id);
    }
  }
  return out;
}

/** 节点路径（如 "照片/2024/xxx.jpg"）。 */
export async function pathOf(db: D1Database, id: number): Promise<string> {
  const parts: string[] = [];
  let cur = await getNode(db, id);
  let guard = 0;
  while (cur && cur.parent_id && guard++ < 64) {
    parts.unshift(cur.name);
    cur = await getNode(db, cur.parent_id);
  }
  return parts.join("/");
}

/** 解析相对路径 → 父节点 id。找不到抛错。 */
export async function resolvePath(
  db: D1Database, spaceId: number, path: string,
): Promise<number> {
  const p = (path || "").replace(/^\/+|\/+$/g, "");
  if (!p) return 0;
  let parent = 0;
  for (const seg of p.split("/")) {
    if (!seg) continue;
    if (seg === "." || seg === "..") continue;
    const row = await queryOne<{ id: number }>(
      db,
      "SELECT id FROM nodes WHERE space_id=? AND parent_id=? AND name=? AND deleted_at IS NULL",
      spaceId, parent, seg);
    if (!row) throw new ApiError(`找不到路径：${path}`);
    parent = row.id;
  }
  return parent;
}

// ---------------------------------------------------------------- 版本

export async function getVersion(
  db: D1Database, id: number,
): Promise<Version | null> {
  return await queryOne<Version>(db, "SELECT * FROM versions WHERE id=?", id);
}

export async function versionChunks(
  db: D1Database, versionId: number,
): Promise<{ seq: number; blob_id: number; offset: number; size: number }[]> {
  return await queryAll(
    db,
    "SELECT seq, blob_id, offset, size FROM version_chunks WHERE version_id=? ORDER BY seq",
    versionId);
}

// ---------------------------------------------------------------- 会话

export async function createSession(
  db: D1Database, token: string, memberId: number, ttlSeconds: number,
  ua: string, ip: string,
): Promise<void> {
  const now = Date.now() / 1000;
  await execute(db,
    "INSERT INTO sessions(token, member_id, created_at, expires_at, ua, ip) VALUES(?,?,?,?,?,?)",
    token, memberId, now, now + ttlSeconds, ua, ip);
}

export async function getSession(
  db: D1Database, token: string,
): Promise<{ member_id: number; expires_at: number } | null> {
  if (!token) return null;
  const row = await queryOne<{ member_id: number; expires_at: number }>(
    db, "SELECT member_id, expires_at FROM sessions WHERE token=?", token);
  if (!row) return null;
  if (row.expires_at < Date.now() / 1000) {
    await execute(db, "DELETE FROM sessions WHERE token=?", token);
    return null;
  }
  return row;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await execute(db, "DELETE FROM sessions WHERE token=?", token);
}

export async function purgeExpiredSessions(db: D1Database): Promise<number> {
  const res = await execute(db, "DELETE FROM sessions WHERE expires_at < ?", Date.now() / 1000);
  return res.meta.changes ?? 0;
}

// ---------------------------------------------------------------- 审计

export async function log(
  db: D1Database, m: Member | { id: number; display_name: string },
  action: string,
  targetType = "", targetId: number | null = null, targetName = "",
  detail: unknown = {}, ip = "",
): Promise<void> {
  await execute(db,
    "INSERT INTO audit(space_id, actor_id, actor_name, action, target_type, target_id, " +
    "target_name, detail, ip, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    1, m.id, m.display_name, action, targetType, targetId, targetName,
    typeof detail === "string" ? detail : JSON.stringify(detail), ip, Date.now() / 1000);
}

export async function recentLog(
  db: D1Database, spaceId: number, limit = 20,
): Promise<Record<string, unknown>[]> {
  return await queryAll(
    db,
    "SELECT * FROM audit WHERE space_id=? ORDER BY created_at DESC LIMIT ?", spaceId, limit);
}
