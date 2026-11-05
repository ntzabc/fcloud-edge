/**
 * 成员、角色权限、空间 —— Edge 版。
 *
 * 跟 Python 版 members.py 的对应关系：
 *   Member dataclass  →  这里直接用 D1 行 + memberToDict
 *   PERMISSIONS       →  db.ts 里已定义（值必须完全一致）
 *   space()/check_quota → 这里
 *
 * ## 口令哈希的差异
 *   Python 版优先 scrypt，退回 PBKDF2。
 *   Edge 版只用 PBKDF2-SHA256 21 万轮 —— Workers 有 10ms CPU 硬限制，
 *   纯 JS 的 scrypt 一定撞墙，而 WebCrypto 的 PBKDF2 是原生实现。
 *
 * ## 会话 token
 *   Python 版存 token 的 SHA-256；Edge 版直接存随机 token。
 *   差别：Edge 的 session token 是 b64(32 字节随机数)，256 位熵，
 *   数据库被拖走也无法暴力枚举，额外哈希一层意义不大。
 */

import {
  PERMISSIONS, ROLE_LABEL, getMember, insert, memberToDict,
  queryAll, queryOne, execute,
} from "./db";
import { b64d, b64e, derivePbkdf2, randomBytes } from "./crypto";
import { ApiError, type Member } from "./types";
import type { MemberRow } from "./db";

export { PERMISSIONS, ROLE_LABEL };

export const ROLES = ["admin", "adult", "child"] as const;

export const COLORS = [
  "#5B9BFF", "#7CFFC8", "#FFC46B", "#FF8FA3", "#B79CFF", "#6FE3D2", "#FFA45B", "#8FD3FF",
];

/** 口令哈希（PBKDF2-SHA256，21 万轮）。 */
export async function hashPassword(pw: string, salt: Uint8Array): Promise<string> {
  // 分段派生 —— Cloudflare 的 WebCrypto 单次迭代上限是 10 万，
  // 21 万轮必须拆成三段跑。详见 crypto.ts 的 derivePbkdf2 注释。
  const raw = await derivePbkdf2(pw, salt, PASSWORD_PBKDF2_ROUNDS);
  return b64e(raw.slice(0, 32));
}

/**
 * 密码哈希的 PBKDF2 轮数。
 *
 * 21 万轮 = 分三段（10万 + 10万 + 1万）。
 * OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议是 60 万轮，
 * 21 万略低但对这个场景够用（自建服务 + 登录失败限流）。
 */
export const PASSWORD_PBKDF2_ROUNDS = 210_000;

export async function verifyPassword(
  pw: string, saltB64: string, hashB64: string,
): Promise<boolean> {
  const got = await hashPassword(pw, b64d(saltB64));
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------- 成员 CRUD

export async function createMember(
  db: D1Database, username: string, displayName: string, password: string,
  role = "child", spaceId = 1, joinSpace = true,
): Promise<Member> {
  const uname = (username || "").trim().toLowerCase();
  const dname = (displayName || "").trim() || uname;
  if (!uname || uname.length < 2) throw new ApiError("用户名至少 2 个字符");
  if (!password || password.length < 4) throw new ApiError("密码至少 4 位");
  if (!ROLES.includes(role as never)) {
    throw new ApiError(`角色只能是 ${ROLES.join(", ")}`);
  }
  if (await queryOne(db, "SELECT id FROM members WHERE username=?", uname)) {
    throw new ApiError("这个用户名已经被占用了");
  }
  const cnt = await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM members");
  const color = COLORS[(cnt?.c ?? 0) % COLORS.length];
  const salt = randomBytes(16);
  const hash = await hashPassword(password, salt);
  const now = Date.now() / 1000;

  const mid = await insert(db,
    "INSERT INTO members(username,display_name,role,pwd_hash,pwd_salt,pwd_algo,color,created_at) " +
    "VALUES(?,?,?,?,?,?,?,?)",
    uname, dname, role, hash, b64e(salt), "pbkdf2", color, now);
  if (joinSpace) {
    await execute(db,
      "INSERT OR REPLACE INTO space_members(space_id,member_id,role) VALUES(?,?,?)",
      spaceId, mid, role);
  }
  const row = await getMember(db, mid);
  return memberToDict(row!);
}

export async function updateMember(
  db: D1Database, memberId: number,
  opts: {
    display_name?: string; role?: string; password?: string; disabled?: boolean;
  },
): Promise<Member> {
  const m = await getMember(db, memberId);
  if (!m) throw new ApiError("成员不存在");
  const stmts: D1PreparedStatement[] = [];
  if (opts.role !== undefined) {
    if (!ROLES.includes(opts.role as never)) throw new ApiError("角色不合法");
    if (m.role === "admin" && opts.role !== "admin") await ensureNotLastAdmin(db, memberId);
    stmts.push(db.prepare("UPDATE members SET role=? WHERE id=?").bind(opts.role, memberId));
    stmts.push(db.prepare("UPDATE space_members SET role=? WHERE member_id=?")
      .bind(opts.role, memberId));
  }
  if (opts.display_name) {
    stmts.push(db.prepare("UPDATE members SET display_name=? WHERE id=?")
      .bind(opts.display_name.trim(), memberId));
  }
  if (opts.password) {
    if (opts.password.length < 4) throw new ApiError("密码至少 4 位");
    const salt = randomBytes(16);
    const hash = await hashPassword(opts.password, salt);
    stmts.push(db.prepare("UPDATE members SET pwd_hash=?, pwd_salt=?, pwd_algo=? WHERE id=?")
      .bind(hash, b64e(salt), "pbkdf2", memberId));
  }
  if (opts.disabled !== undefined) {
    await ensureNotLastAdmin(db, memberId);
    stmts.push(db.prepare("UPDATE members SET disabled=? WHERE id=?")
      .bind(opts.disabled ? 1 : 0, memberId));
  }
  if (stmts.length) await db.batch(stmts);
  // 改密码或停用 → 踢掉所有会话
  if (opts.password || opts.disabled) {
    await execute(db, "DELETE FROM sessions WHERE member_id=?", memberId);
  }
  const row = await getMember(db, memberId);
  return memberToDict(row!);
}

/** 删成员。其名下文件保留（转成「已删除成员」），避免连坐删掉家庭资料。 */
export async function deleteMember(db: D1Database, memberId: number): Promise<void> {
  await ensureNotLastAdmin(db, memberId);
  await db.batch([
    db.prepare("DELETE FROM space_members WHERE member_id=?").bind(memberId),
    db.prepare("DELETE FROM shares WHERE grantee_id=? OR granted_by=?").bind(memberId, memberId),
    db.prepare("DELETE FROM sessions WHERE member_id=?").bind(memberId),
    db.prepare("UPDATE members SET disabled=1 WHERE id=?").bind(memberId),
  ]);
}

async function ensureNotLastAdmin(db: D1Database, memberId: number): Promise<void> {
  const m = await getMember(db, memberId);
  if (m?.role !== "admin") return;
  const row = await queryOne<{ c: number }>(
    db, "SELECT COUNT(*) AS c FROM members WHERE role='admin' AND disabled=0 AND id<>?", memberId);
  if (!row || !row.c) throw new ApiError("至少要保留一个管理员");
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await queryOne<{ c: number }>(
    db, "SELECT COUNT(*) AS c FROM members WHERE role='admin' AND disabled=0");
  return row?.c ?? 0;
}

/** 列出空间成员（按角色排：管理员 → 成人 → 儿童）。 */
export async function spaceMembers(db: D1Database, spaceId = 1): Promise<Member[]> {
  const rows = await queryAll<MemberRow>(
    db,
    "SELECT m.* FROM members m JOIN space_members sm ON sm.member_id=m.id " +
    "WHERE sm.space_id=? AND m.disabled=0 ORDER BY " +
    "CASE m.role WHEN 'admin' THEN 0 WHEN 'adult' THEN 1 ELSE 2 END, m.id",
    spaceId);
  return rows.map(memberToDict);
}

// ---------------------------------------------------------------- 空间

export interface SpaceInfo {
  id: number;
  name: string;
  owner_id: number;
  quota_bytes: number;
  used_bytes: number;
  free_bytes: number | null;
  created_at?: number;
}

export async function space(db: D1Database, spaceId = 1): Promise<SpaceInfo> {
  const row = await queryOne<{
    id: number; name: string; owner_id: number; quota_bytes: number; created_at: number;
  }>(db, "SELECT * FROM spaces WHERE id=?", spaceId);
  if (!row) {
    return {
      id: spaceId, name: "我们一家", owner_id: 0, quota_bytes: 0,
      used_bytes: 0, free_bytes: null,
    };
  }
  const used = await queryOne<{ s: number }>(
    db,
    "SELECT COALESCE(SUM(size),0) AS s FROM nodes WHERE space_id=? " +
    "AND kind='file' AND deleted_at IS NULL", spaceId);
  const usedBytes = used?.s ?? 0;
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    quota_bytes: row.quota_bytes,
    used_bytes: usedBytes,
    free_bytes: row.quota_bytes ? Math.max(0, row.quota_bytes - usedBytes) : null,
    created_at: row.created_at,
  };
}

export async function updateSpace(
  db: D1Database, spaceId: number, name?: string, quotaBytes?: number,
): Promise<SpaceInfo> {
  const stmts: D1PreparedStatement[] = [];
  if (name) stmts.push(db.prepare("UPDATE spaces SET name=? WHERE id=?").bind(name.trim(), spaceId));
  if (quotaBytes !== undefined) {
    stmts.push(db.prepare("UPDATE spaces SET quota_bytes=? WHERE id=?")
      .bind(Math.trunc(quotaBytes), spaceId));
  }
  if (stmts.length) await db.batch(stmts);
  return await space(db, spaceId);
}

/** 空间够不够。 */
export async function checkQuota(
  db: D1Database, spaceId: number, extra: number,
): Promise<boolean> {
  const sp = await space(db, spaceId);
  if (!sp.quota_bytes) return true;
  return sp.used_bytes + extra <= sp.quota_bytes;
}

// ---------------------------------------------------------------- 权限

/** 要求某项权限。 */
export function require(m: Member | null, action: string): Member {
  if (!m) throw new ApiError("请先登录", 401);
  if (!m.can.includes(action)) {
    throw new ApiError(`「${ROLE_LABEL[m.role] ?? m.role}」没有这个操作的权限`, 403);
  }
  return m;
}

/** 要么是自己的东西，要么角色允许动别人的。 */
export function requireOwnerOr(
  m: Member, nodeOwnerId: number, action: string,
): void {
  if (nodeOwnerId === m.id) return;
  if (!m.can.includes(action)) throw new ApiError("只能操作自己创建的文件", 403);
}
