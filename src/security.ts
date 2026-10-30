/**
 * 安全事件审计。
 *
 * ## 为什么单独一张表
 *
 * 原来的 audit 表记的是「谁在什么时候动了什么文件」——
 * 那是**业务操作**日志。安全事件是另一类：
 * 登录失败、暴力破解试探、主口令解锁、限流触发……
 * 这些在业务日志里看不到，但恰恰是出问题时唯一能查的东西。
 *
 * ## 注意
 *
 * 这一张表**不能**无限增长 —— 它会被攻击者当成写放大器
 * （每次失败登录都写一行，攻击者可以把 D1 写爆）。
 * 所以：
 *   1. 只记「值得记」的事件，不记每个请求
 *   2. 定时任务里清理过期记录
 */

import type { Env } from "./types";

/** 安全日志保留天数。 */
const RETENTION_DAYS = 90;

export interface SecurityEvent {
  kind: string;
  memberId?: number | null;
  username?: string;
  ip?: string;
  detail?: string;
  ok?: boolean;
}

export async function logSecurity(
  env: Env, ev: SecurityEvent,
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO security_log(at, kind, member_id, username, ip, detail, ok) " +
      "VALUES(?,?,?,?,?,?,?)")
      .bind(
        Date.now() / 1000,
        ev.kind.slice(0, 40),
        ev.memberId ?? null,
        (ev.username || "").slice(0, 60),
        (ev.ip || "").slice(0, 60),
        (ev.detail || "").slice(0, 500),
        ev.ok === false ? 0 : 1,
      )
      .run();
  } catch (e) {
    // 审计写失败绝不能影响主流程
    console.warn("[安全日志] 写入失败：", e instanceof Error ? e.message : String(e));
  }
}

/** 清理过期的安全日志。 */
export async function purgeSecurityLog(env: Env): Promise<number> {
  const since = Date.now() / 1000 - RETENTION_DAYS * 86400;
  const res = await env.DB.prepare("DELETE FROM security_log WHERE at < ?")
    .bind(since).run();
  return res.meta.changes ?? 0;
}

/** 读最近的安全事件（给管理员看）。 */
export async function recentSecurity(
  env: Env, limit = 50,
): Promise<Record<string, unknown>[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM security_log ORDER BY id DESC LIMIT ?")
    .bind(Math.max(1, Math.min(200, limit)))
    .all<Record<string, unknown>>();
  return res.results ?? [];
}
