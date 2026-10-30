/**
 * 加密路由：setup / unlock / status
 *
 * ## 主密钥在 Worker 里怎么存（2026-10-27 安全加固后）
 *
 * Python 版是进程内缓存（服务端常驻，锁一次就一直能用）。
 * Worker 是无状态的 —— 每个请求都是新 isolate，进程内缓存不存在。
 *
 * 现在的模型是**两层**：
 *
 *   MASTER_SECRET（Cloudflare Secret：不在 D1、不在 git）
 *      └─ HKDF-SHA256 → KEK
 *           └─ AES-GCM 加密主密钥 → settings.master_wrapped
 *
 * 为什么不能把主密钥明文存 D1：D1 会被备份、会被导出、可能因配置错误公开。
 * 明文存 = D1 泄露 = 全家加密文件裸奔，而用户以为设了口令就安全了。
 *
 * ## 口令的作用
 *
 * 口令不参与密钥推导，只做**授权**：
 * 口令正确 → 写一条 master_sessions 记录 → 这个空间才能用加密功能。
 * 记录带 TTL（8 小时），到期自动失效。
 *
 * ## 剩下的风险（必须诚实说）
 *
 * 攻陷 Cloudflare 账号本身 = 拿到 MASTER_SECRET = 拿到所有密钥。
 * 这一层挡不住 —— MASTER_SECRET 解密后就明文注入 env。
 * 要真正挡住得做「客户端持钥」（浏览器派生，服务端只见密文），另一个量级。
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import { require } from "../members";
import { log } from "../sharing";
import { logSecurity } from "../security";
import { CryptoError } from "../crypto";
import { ApiError } from "../types";
import type { Ctx } from "../http";

/** 解锁授权的有效期（秒）。8 小时 —— 够一家人用，也别永远挂着。 */
const UNLOCK_TTL = 8 * 3600;

export async function cryptoSetup(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "manage_master");
  const d = await jsonBody<{ passphrase?: string }>(ctx.req);
  try {
    await ctx.master.setPassphrase(d.passphrase || "");
  } catch (e) {
    if (e instanceof CryptoError) throw new ApiError(e.message);
    throw e;
  }
  // 改过主口令 → 之前的解锁授权全部作废（不然旧口令解锁的状态还在）
  await ctx.master.revokeUnlock();
  // 设置完直接给这个会话解锁授权 —— 不用再输一遍
  await ctx.master.grantUnlock(m.id, sessionTokenOf(ctx), UNLOCK_TTL);
  await log(ctx.env, m, "master_set", { ip: ctx.ip });
  return json({ ok: true, ...(await cryptoStatus(ctx)) });
}

export async function cryptoUnlock(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<{ passphrase?: string }>(ctx.req);
  let ok = false;
  try {
    ok = await ctx.master.checkPassphrase(d.passphrase || "");
  } catch (e) {
    if (e instanceof CryptoError) throw new ApiError(e.message);
    throw e;
  }
  if (ok) {
    await ctx.master.grantUnlock(m.id, sessionTokenOf(ctx), UNLOCK_TTL);
    await log(ctx.env, m, "master_unlock", { ip: ctx.ip });
    await logSecurity(ctx.env, {
      kind: "master_unlock", memberId: m.id, username: m.username,
      ip: ctx.ip, ok: true,
    });
  } else {
    await logSecurity(ctx.env, {
      kind: "master_unlock_fail", memberId: m.id, username: m.username,
      ip: ctx.ip, ok: false,
    });
  }
  return json({
    ok,
    error: ok ? "" : "主口令不对",
    ...(await cryptoStatus(ctx)),
  });
}

/** 加密状态。字段名跟 Python 版 crypto_box.status() 对齐。 */
export async function cryptoStatusRoute(ctx: Ctx): Promise<Response> {
  return json(await cryptoStatus(ctx));
}

/** 加密状态（内部用）。 */
export async function cryptoStatus(ctx: Ctx): Promise<{
  configured: boolean; unlocked: boolean; backend: string; aes: boolean; note: string;
}> {
  const configured = await ctx.master.configured();
  const unlocked = await ctx.master.unlocked();
  return {
    configured,
    unlocked,
    backend: "aes-256-gcm",
    aes: true,
    note: "使用 AES-256-GCM（WebCrypto 原生实现），主口令用 PBKDF2-SHA256 21 万轮派生",
  };
}

/** 从 Cookie 里取当前会话 token（解锁授权要记它）。 */
function sessionTokenOf(ctx: Ctx): string {
  const raw = ctx.req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === ctx.env.SESSION_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return "";
}
