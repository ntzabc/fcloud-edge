/**
 * 鉴权路由：bootstrap / setup / login / logout / me
 *
 * 跟 Python 版 server.py 的对应接口契约完全一致。
 */

import { json } from "../index";
import { logSecurity } from "../security";
import {
  clearCookie, cookie, isSecureCtx, jsonBody, need, sessionCookie,
} from "../http";
import {
  createSession, deleteSession, getMemberByName, getSetting,
  insert, listMembers, memberToDict, queryOne,
} from "../db";
import { b64d, b64e, randomBytes } from "../crypto";
import { ApiError } from "../types";
import type { Ctx } from "../http";
import type { Env } from "../types";

const SPACE_ID = 1;

/** 口令哈希参数。WebCrypto 只有 PBKDF2，用 21 万轮。 */
const PBKDF2_ROUNDS = 210_000;

/** 密码哈希。 */
export async function hashPassword(pw: string, salt: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pw) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    base, 256);
  return b64e(new Uint8Array(bits));
}

export async function verifyPassword(
  pw: string, saltB64: string, hashB64: string,
): Promise<boolean> {
  const salt = b64d(saltB64);
  const got = await hashPassword(pw, salt);
  // 常量时间比较
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 空间是否已经初始化过。 */
export async function isInitialized(db: D1Database): Promise<boolean> {
  const row = await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM members");
  return (row?.c ?? 0) > 0;
}

/** 登录失败限流。KV 计数，5 分钟内失败 10 次就锁。 */
async function tooManyAttempts(env: Env, key: string): Promise<boolean> {
  const raw = await env.RATE.get("login_fail:" + key);
  if (!raw) return false;
  const rec = JSON.parse(raw) as { n: number; until: number };
  if (rec.until < Date.now()) {
    await env.RATE.delete("login_fail:" + key);
    return false;
  }
  return rec.n >= 10;
}

async function recordFailure(env: Env, key: string): Promise<void> {
  const k = "login_fail:" + key;
  const raw = await env.RATE.get(k);
  const rec = raw
    ? (JSON.parse(raw) as { n: number; until: number })
    : { n: 0, until: Date.now() + 300_000 };
  if (rec.until < Date.now()) {
    rec.n = 0;
    rec.until = Date.now() + 300_000;
  }
  rec.n += 1;
  await env.RATE.put(k, JSON.stringify(rec), { expirationTtl: 300 });
}

async function clearFailures(env: Env, key: string): Promise<void> {
  await env.RATE.delete("login_fail:" + key);
}

// ---------------------------------------------------------------- 接口

export async function bootstrap(ctx: Ctx): Promise<Response> {
  const initialized = await isInitialized(ctx.env.DB);
  const cfg = {
    trash_days: Number(await getSetting(ctx.env.DB, "trash_days", "30")) || 30,
    chunk_size: Number(ctx.env.CHUNK_SIZE) || 4 * 1024 * 1024,
  };
  const space = await queryOne<{ id: number; name: string }>(
    ctx.env.DB, "SELECT id, name FROM spaces WHERE id=?", SPACE_ID);

  if (!initialized) {
    return json({ initialized: false, me: null, members: [], space: null, config: cfg });
  }
  if (!ctx.member) {
    return json({ initialized: true, me: null, members: [], space, config: cfg });
  }
  const rows = await listMembers(ctx.env.DB, SPACE_ID);
  return json({
    initialized: true,
    me: ctx.member,
    members: rows.map(memberToDict),
    space,
    config: cfg,
  });
}

export async function setup(ctx: Ctx): Promise<Response> {
  if (await isInitialized(ctx.env.DB)) {
    throw new ApiError("这个空间已经初始化过了", 400);
  }
  const d = await jsonBody<{
    username?: string; display_name?: string; password?: string; space_name?: string;
  }>(ctx.req);

  const username = (d.username || "").trim();
  const displayName = (d.display_name || "").trim();
  const password = d.password || "";
  const spaceName = (d.space_name || "我们一家").trim();

  if (!username) throw new ApiError("用户名不能为空");
  if (!displayName) throw new ApiError("显示名字不能为空");
  if (password.length < 4) throw new ApiError("密码至少 4 位");

  const salt = randomBytes(16);
  const hash = await hashPassword(password, salt);
  const now = Date.now() / 1000;

  const memberId = await insert(ctx.env.DB,
    "INSERT INTO members(username, display_name, role, pwd_hash, pwd_salt, pwd_algo, " +
    "color, disabled, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    username, displayName, "admin", hash, b64e(salt), "pbkdf2",
    "#5B9BFF", 0, now);

  await insert(ctx.env.DB,
    "INSERT INTO spaces(id, name, owner_id, quota_bytes, created_at) VALUES(?,?,?,?,?)",
    SPACE_ID, spaceName, memberId, 0, now);

  await insert(ctx.env.DB,
    "INSERT INTO space_members(space_id, member_id, role) VALUES(?,?,?)",
    SPACE_ID, memberId, "admin");

  return json({ ok: true, member_id: memberId });
}

export async function login(ctx: Ctx): Promise<Response> {
  const d = await jsonBody<{ username?: string; password?: string }>(ctx.req);
  const username = (d.username || "").trim();

  // 限流：同一用户名 + 同一 IP 都算
  const rateKey = `${username}|${ctx.ip}`;
  if (await tooManyAttempts(ctx.env, rateKey)) {
    throw new ApiError("尝试太多次了，请 5 分钟后再试", 429);
  }

  const row = await getMemberByName(ctx.env.DB, username);
  if (!row || !row.pwd_hash || !row.pwd_salt) {
    await recordFailure(ctx.env, rateKey);
    // ⚠️ 用户名不存在 vs 密码错，回同一个错 —— 别泄露「这个用户存在」
    await logSecurity(ctx.env, {
      kind: "login_fail", username, ip: ctx.ip, ok: false,
      detail: row ? "" : "用户名不存在",
    });
    throw new ApiError("用户名或密码不对", 401);
  }
  const ok = await verifyPassword(d.password || "", row.pwd_salt, row.pwd_hash);
  if (!ok) {
    await recordFailure(ctx.env, rateKey);
    await logSecurity(ctx.env, {
      kind: "login_fail", username, ip: ctx.ip, ok: false, detail: "密码不对",
    });
    throw new ApiError("用户名或密码不对", 401);
  }
  await clearFailures(ctx.env, rateKey);

  if (row.disabled) throw new ApiError("这个账号已被停用", 403);

  const token = b64e(randomBytes(32));
  const ttl = Number(ctx.env.SESSION_TTL) || 7 * 24 * 3600;
  await createSession(ctx.env.DB, token, row.id, ttl,
    ctx.req.headers.get("User-Agent") || "", ctx.ip);
  await ctx.env.DB.prepare("UPDATE members SET last_login_at=? WHERE id=?")
    .bind(Date.now() / 1000, row.id).run();

  const space = await queryOne<{ id: number; name: string }>(
    ctx.env.DB, "SELECT id, name FROM spaces WHERE id=?", SPACE_ID);
  const members = await listMembers(ctx.env.DB, SPACE_ID);

  const secure = isSecureCtx(ctx.req, ctx.url);
  return json(
    {
      me: memberToDict(row),
      members: members.map(memberToDict),
      space,
    },
    200,
    { "Set-Cookie": sessionCookie(ctx.env, token, ttl, secure) },
  );
}

export async function logout(ctx: Ctx): Promise<Response> {
  const token = cookie(ctx.req, ctx.env.SESSION_COOKIE);
  if (token) await deleteSession(ctx.env.DB, token);
  const secure = isSecureCtx(ctx.req, ctx.url);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(ctx.env, secure) });
}

export async function me(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const members = await listMembers(ctx.env.DB, SPACE_ID);
  const space = await queryOne<{ id: number; name: string }>(
    ctx.env.DB, "SELECT id, name FROM spaces WHERE id=?", SPACE_ID);
  return json({ me: m, members: members.map(memberToDict), space });
}
