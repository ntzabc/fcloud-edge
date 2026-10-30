/**
 * 共享与操作记录 —— Edge 版。
 *
 * 跟 Python 版 sharing.py 的对应关系完全一致。
 *
 * ## 三档权限
 *   read  只读 —— 能看、能下，不能改
 *   write 可写 —— 能改内容、能新建子项，不能删除整个共享
 *   own   托管 —— 等于把所有权给出去，对方能改也能删
 *
 * ## 共享是叠加在原有权限之上的
 *   管理员和成人本来就能动所有文件，共享对他们是「额外打开」；
 *   共享真正解决的是「让某个人能看某个本来不该他看的东西」。
 */

import { execute, queryAll, queryOne } from "./db";
import { ApiError, type Env, type Member } from "./types";

export const PERM_LABEL: Record<string, string> = {
  read: "只读", write: "可编辑", own: "可托管",
};

export const PERM_RANK: Record<string, number> = {
  read: 1, write: 2, own: 3,
};

// ---------------------------------------------------------------- 共享

export async function grant(
  env: Env, nodeId: number, granteeId: number, permission: string,
  actor: Member, note = "",
): Promise<Record<string, unknown>[]> {
  if (!PERM_RANK[permission]) throw new ApiError("共享权限只能是 read / write / own");
  const node = await queryOne<{ id: number; owner_id: number }>(
    env.DB, "SELECT id, owner_id FROM nodes WHERE id=?", nodeId);
  if (!node) throw new ApiError("文件不存在或已被彻底删除", 404);
  if (granteeId === node.owner_id) {
    throw new ApiError("不能共享给文件的拥有者本人，他本来就有权限");
  }
  const ok = await queryOne(
    env.DB, "SELECT id FROM members WHERE id=? AND disabled=0", granteeId);
  if (!ok) throw new ApiError("这个成员不存在或已停用");

  await env.DB.prepare(
    "INSERT INTO shares(node_id,grantee_id,granted_by,permission,created_at,note) " +
    "VALUES(?,?,?,?,?,?) ON CONFLICT(node_id,grantee_id) DO UPDATE SET " +
    "permission=excluded.permission, granted_by=excluded.granted_by, note=excluded.note")
    .bind(nodeId, granteeId, actor.id, permission, Date.now() / 1000, note.slice(0, 200)).run();
  return await listFor(env, nodeId);
}

export async function revoke(
  env: Env, nodeId: number, granteeId: number,
): Promise<Record<string, unknown>[]> {
  await execute(env.DB, "DELETE FROM shares WHERE node_id=? AND grantee_id=?", nodeId, granteeId);
  return await listFor(env, nodeId);
}

export async function listFor(
  env: Env, nodeId: number,
): Promise<Record<string, unknown>[]> {
  const rows = await queryAll<Record<string, unknown>>(
    env.DB,
    "SELECT s.*, m.display_name, m.color, m.role FROM shares s " +
    "JOIN members m ON m.id=s.grantee_id WHERE s.node_id=? ORDER BY s.created_at",
    nodeId);
  return rows.map((d) => ({
    ...d,
    permission_label: PERM_LABEL[String(d.permission)] ?? String(d.permission),
  }));
}

/** 别人共享给我的东西。 */
export async function sharedWithMe(
  env: Env, member: Member, spaceId = 1,
): Promise<Record<string, unknown>[]> {
  return await queryAll(
    env.DB,
    "SELECT n.*, s.permission, s.note AS share_note, m.display_name AS owner_name, " +
    "       m.color AS owner_color " +
    "FROM shares s JOIN nodes n ON n.id=s.node_id " +
    "JOIN members m ON m.id=n.owner_id " +
    "WHERE s.grantee_id=? AND n.deleted_at IS NULL AND n.space_id=? " +
    "ORDER BY s.created_at DESC", member.id, spaceId);
}

/** 我共享给别人的东西。 */
export async function sharedByMe(
  env: Env, member: Member, spaceId = 1,
): Promise<Record<string, unknown>[]> {
  return await queryAll(
    env.DB,
    "SELECT n.*, s.permission, m.display_name, m.color FROM shares s " +
    "JOIN nodes n ON n.id=s.node_id JOIN members m ON m.id=s.grantee_id " +
    "WHERE s.granted_by=? AND n.deleted_at IS NULL AND n.space_id=? " +
    "ORDER BY s.created_at DESC", member.id, spaceId);
}

/** 这个人在这个节点上通过共享拿到的最高权限。没有共享就是 null。 */
export async function permissionFor(
  env: Env, nodeId: number, member: Member,
): Promise<string | null> {
  const row = await queryOne<{ permission: string }>(
    env.DB, "SELECT permission FROM shares WHERE node_id=? AND grantee_id=?", nodeId, member.id);
  return row?.permission ?? null;
}

/** 能不能写这个节点（不含删除）。 */
export async function effectiveWrite(
  env: Env, node: { id: number; owner_id: number }, member: Member,
): Promise<boolean> {
  if (node.owner_id === member.id) return true;
  if (member.can.includes("delete_any")) return true;
  const p = await permissionFor(env, node.id, member);
  return p === "write" || p === "own";
}

/** 能不能删除这个节点。 */
export async function effectiveDelete(
  env: Env, node: { id: number; owner_id: number }, member: Member,
): Promise<boolean> {
  if (node.owner_id === member.id) return true;
  if (member.can.includes("delete_any")) return true;
  return (await permissionFor(env, node.id, member)) === "own";
}

/** 能不能看这个节点。 */
export async function canRead(
  env: Env, node: { id: number; owner_id: number; encrypted: number },
  member: Member,
): Promise<boolean> {
  if (node.owner_id === member.id) return true;
  if (member.role === "admin" || member.role === "adult") return true;
  if (await permissionFor(env, node.id, member)) return true;
  // 儿童只看得到自己的文件和未被加密的公共文件
  return !node.encrypted;
}

/**
 * 把共享下沉到整个子树（文件夹共享时用）。
 *
 * 注意要带上 deleted_at IS NULL 的过滤 —— 回收站里的东西不该被重新授权。
 */
export async function descendantsShare(
  env: Env, nodeId: number, granteeId: number, permission: string, actor: Member,
): Promise<number> {
  const ids: number[] = [nodeId];
  let frontier = [nodeId];
  let guard = 0;
  while (frontier.length && guard < 100000) {
    guard++;
    const ph = frontier.map(() => "?").join(",");
    const rows = await queryAll<{ id: number }>(
      env.DB,
      `SELECT id FROM nodes WHERE parent_id IN (${ph}) AND deleted_at IS NULL`, ...frontier);
    frontier = rows.map((r) => r.id);
    ids.push(...frontier);
  }
  const now = Date.now() / 1000;
  const stmts = ids.map((nid) =>
    env.DB.prepare(
      "INSERT INTO shares(node_id,grantee_id,granted_by,permission,created_at) " +
      "VALUES(?,?,?,?,?) ON CONFLICT(node_id,grantee_id) DO UPDATE SET " +
      "permission=excluded.permission")
      .bind(nid, granteeId, actor.id, permission, now));
  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }
  return ids.length;
}

// ---------------------------------------------------------------- 操作记录

export const ACTION_LABEL: Record<string, string> = {
  login: "登录", logout: "退出", login_fail: "登录失败",
  create_folder: "新建文件夹", upload: "上传", replace: "替换文件",
  rename: "重命名", move: "移动", delete: "删除", restore: "恢复",
  purge: "彻底删除", empty_trash: "清空回收站", download: "下载",
  preview: "预览", share_grant: "共享", share_revoke: "取消共享",
  meta: "修改信息", rollback: "版本回滚", encrypt: "加密上传",
  member_add: "新增成员", member_edit: "修改成员", member_del: "移除成员",
  master_set: "设置主口令", master_unlock: "解锁主密钥",
  space_edit: "修改空间设置", gc: "垃圾回收", backup: "备份",
  extract: "解压", zip_download: "打包下载", encrypt_toggle: "切换加密",
  ai_chat: "小f对话",
};

export function actionLabel(a: string): string {
  return ACTION_LABEL[a] ?? a;
}

/** 写一条操作记录。 */
export async function log(
  env: Env, actor: Member | null, action: string,
  opts: {
    targetType?: string; targetId?: number | null; targetName?: string;
    detail?: unknown; spaceId?: number; ip?: string;
  } = {},
): Promise<void> {
  const detail = typeof opts.detail === "string"
    ? opts.detail
    : opts.detail === undefined ? "" : JSON.stringify(opts.detail);
  await execute(env.DB,
    "INSERT INTO audit(space_id,actor_id,actor_name,action,target_type,target_id," +
    "target_name,detail,ip,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    opts.spaceId ?? 1, actor?.id ?? null, actor?.display_name ?? "系统", action,
    opts.targetType ?? "", opts.targetId ?? null, (opts.targetName ?? "").slice(0, 200),
    String(detail).slice(0, 2000), opts.ip ?? "", Date.now() / 1000);
}

export interface AuditFilter {
  spaceId?: number;
  limit?: number;
  actorId?: number | null;
  action?: string;
  since?: number | null;
  keyword?: string;
}

export async function recentLog(
  env: Env, f: AuditFilter = {},
): Promise<Record<string, unknown>[]> {
  let sql = "SELECT * FROM audit WHERE space_id=?";
  const args: unknown[] = [f.spaceId ?? 1];
  if (f.actorId !== null && f.actorId !== undefined) {
    sql += " AND actor_id=?"; args.push(f.actorId);
  }
  if (f.action) { sql += " AND action=?"; args.push(f.action); }
  if (f.since !== null && f.since !== undefined) {
    sql += " AND created_at>=?"; args.push(f.since);
  }
  if (f.keyword) {
    sql += " AND (target_name LIKE ? OR detail LIKE ? OR actor_name LIKE ?)";
    args.push(`%${f.keyword}%`, `%${f.keyword}%`, `%${f.keyword}%`);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(f.limit ?? 100);
  const rows = await queryAll<Record<string, unknown>>(env.DB, sql, ...args);
  return rows.map((d) => ({ ...d, action_label: actionLabel(String(d.action)) }));
}

export async function logStats(
  env: Env, spaceId = 1, days = 7,
): Promise<Record<string, number>> {
  const since = Date.now() / 1000 - days * 86400;
  const rows = await queryAll<{ action: string; n: number }>(
    env.DB,
    "SELECT action, COUNT(*) AS n FROM audit WHERE space_id=? AND created_at>=? " +
    "GROUP BY action ORDER BY n DESC", spaceId, since);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.action] = r.n;
  return out;
}
