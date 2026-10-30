/**
 * 维护路由：垃圾回收 / 定时清理。
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import { require } from "../members";
import { log } from "../sharing";
import { gc, storageStats } from "../storage";
import { purgeExpired as purgeExpiredNodes } from "../files";
import { cleanupStale } from "../transfer";
import { purgeExpiredSessions } from "../db";
import { purgeSecurityLog } from "../security";
import type { Ctx } from "../http";
import type { Env } from "../types";

export async function runGc(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "run_backup");
  // 默认 dry_run（只看会清多少，不真删）—— 跟 Python 版一致
  const dry = (await jsonBody<{ dry_run?: boolean }>(ctx.req)).dry_run !== false;
  const r = dry
    ? { purged: 0, freed: 0, dry_run: true }
    : await gc(ctx.env);
  if (!dry) {
    await log(ctx.env, m, "gc", { detail: r, ip: ctx.ip });
  }
  return json({ ok: true, ...r, stats: await storageStats(ctx.env) });
}

/**
 * 定时任务入口。
 * 回收站过期清理 + 过期会话清理 + 过期上传会话清理 + 安全日志清理。
 */
export async function purgeExpired(env: Env): Promise<Record<string, unknown>> {
  const trash = await purgeExpiredNodes(env);
  const sessions = await purgeExpiredSessions(env.DB);
  const uploads = await cleanupStale(env);
  const g = await gc(env);
  // 解锁授权过期了也要清 —— 不然「已解锁」的状态会永久挂着
  const unlocks = await env.DB.prepare(
    "DELETE FROM master_sessions WHERE expires_at < ?").bind(Date.now() / 1000).run();
  const secLog = await purgeSecurityLog(env);
  const r = {
    ...trash, sessions, uploads, gc: g,
    unlocks: unlocks.meta.changes ?? 0,
    security_log: secLog,
  };
  console.log("定时任务完成:", JSON.stringify(r));
  return r;
}
