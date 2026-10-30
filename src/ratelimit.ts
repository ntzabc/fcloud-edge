/**
 * 通用速率限制（KV 计数）。
 *
 * ## 为什么用 KV 而不是 D1
 *
 * D1 免费版每次写入都要花一次查询配额，而且限流是**高频写**操作 ——
 * 每次请求都写一行 D1 会把配额烧光。KV 的写不计入 D1 查询。
 *
 * ## KV 的坑：不是强一致
 *
 * Cloudflare KV 是最终一致的，全球各地副本可能有几秒延迟。
 * 所以这里的限流是「尽力而为」，能挡住暴力破解这种量级，
 * 但挡不住分布式攻击。对家庭云盘这种自用场景够用了。
 *
 * ## 为什么不全站都限
 *
 * 浏览/下载是正常操作，限了反而碍事。
 * 只限**有代价或可被滥用**的端点：
 *   - 写操作（上传、创建、改名、删除…）
 *   - AI 对话（烧 OpenRouter 的免费额度）
 *   - 登录（已有独立的失败次数限制）
 *   - 打包下载（一次可能拉全库，费流量）
 */

import type { Env } from "./types";

export interface LimitRule {
  /** 时间窗口（秒）。 */
  window: number;
  /** 窗口内最多几次。 */
  max: number;
}

/** 各类操作的限流规则。 */
export const LIMITS = {
  /** 一般写操作。 */
  write: { window: 60, max: 120 } as LimitRule,
  /** AI 对话 —— 一次可能几十秒 + 烧额度，得限狠一点。 */
  ai: { window: 60, max: 10 } as LimitRule,
  /** 打包下载 —— 一次可能拉整个家。 */
  zip: { window: 300, max: 10 } as LimitRule,
  /** 上传初始化 —— 开一堆空会话也占资源。 */
  upload: { window: 60, max: 40 } as LimitRule,
  /** 搜索 —— 全文检索跑索引，CPU 消耗大。 */
  search: { window: 60, max: 120 } as LimitRule,
} as const;

export type LimitKind = keyof typeof LIMITS;

/**
 * 检查并记一次。
 *
 * 返回 true = 放行；false = 超限。
 *
 * 注意 KV 没有原子自增，所以这里是「读 → 加 → 写」，
 * 并发下可能少数几次漏计。对限流来说可接受。
 */
export async function hit(
  env: Env, kind: LimitKind, identity: string,
): Promise<boolean> {
  const rule = LIMITS[kind];
  const key = `rl:${kind}:${identity}`;
  const raw = await env.RATE.get(key);
  let n = 1;
  let until = Date.now() + rule.window * 1000;
  if (raw) {
    try {
      const rec = JSON.parse(raw) as { n: number; until: number };
      if (rec.until > Date.now()) {
        n = rec.n + 1;
        until = rec.until;
      }
    } catch {
      // 记录坏了就当新的
    }
  }
  if (n > rule.max) {
    // 超限了也写回去，让窗口自然滑过去
    await env.RATE.put(key, JSON.stringify({ n, until }), {
      expirationTtl: Math.max(60, rule.window),
    });
    return false;
  }
  await env.RATE.put(key, JSON.stringify({ n, until }), {
    expirationTtl: Math.max(60, rule.window),
  });
  return true;
}

/** 剩余可用次数（用于返回 Retry-After 之类）。 */
export async function remaining(
  env: Env, kind: LimitKind, identity: string,
): Promise<number> {
  const rule = LIMITS[kind];
  const raw = await env.RATE.get(`rl:${kind}:${identity}`);
  if (!raw) return rule.max;
  try {
    const rec = JSON.parse(raw) as { n: number; until: number };
    if (rec.until <= Date.now()) return rule.max;
    return Math.max(0, rule.max - rec.n);
  } catch {
    return rule.max;
  }
}
