/**
 * 入口 —— 同一套业务逻辑，两个宿主。
 *
 * ## 为什么有两个入口
 *
 * ### Workers（`*.workers.dev`）
 *   原计划的主方案。但 **workers.dev 在国内被 DNS 污染** ——
 *   域名会被解析到 Facebook 的 IP（31.13.x.x），根本连不上。
 *   实测：`fcloud.fcloud-kaixin.workers.dev` → 31.13.86.21（Facebook）。
 *
 *   现在只用来挂 **cron 定时任务**（回收站清理、内容块 GC）——
 *   cron 是 Cloudflare 内部触发的，不经过公网 DNS，所以不受影响。
 *   而且定时任务不需要对外暴露网址。
 *
 * ### Pages（`*.pages.dev`）
 *   真正给用户用的。**pages.dev 没有被污染**（实测解析到 104.18.x.x，
 *   Cloudflare 自己的 IP），国内能正常访问。
 *
 *   静态资源由 Pages 直接托管（不过函数，不计函数调用配额），
 *   `/api/*` 走 Pages Function → 这里的同一套路由逻辑。
 *
 * ## 路由策略
 *
 *   /api/*        → 业务 API（自己处理）
 *   其余          → 静态资源
 *     · Pages 宿主：Pages 的静态资源层直接服务（不过函数）
 *     · Worker 宿主：走 ASSETS binding（也是边缘缓存，不计 Worker 请求配额）
 */

import { ApiError, type Env } from "./types";
import { route } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(request, env, ctx, url);
    }

    // 静态资源
    if (!env.ASSETS) {
      return new Response("静态资源还没配置", { status: 503 });
    }
    const res = await env.ASSETS.fetch(request);
    applySecurityHeaders(res, url);
    return res;
  },

  // 定时任务：回收站清理 + 会话清理 + 块回收
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};

/**
 * 处理 /api/* 请求。
 *
 * 抽出来是为了让 Worker 和 Pages 两个宿主共用同一套逻辑。
 */
export async function handleApi(
  request: Request, env: Env, ctx: ExecutionContext, url: URL,
): Promise<Response> {
  try {
    const res = await route(request, env, ctx, url);
    applySecurityHeaders(res, url);
    return res;
  } catch (e) {
    if (e instanceof ApiError) {
      return json({ error: e.message }, e.status);
    }
    console.error("未处理的异常:", e);
    return json({ error: "服务器内部错误" }, 500);
  }
}

/** 给响应加上安全头。 */
export function applySecurityHeaders(res: Response, url: URL): void {
  // HSTS 只在 HTTPS 下发 —— http 下发会让浏览器直接拒绝访问
  for (const [k, v] of Object.entries(hstsHeader(url))) {
    res.headers.set(k, v);
  }
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders(),
      ...headers,
    },
  });
}

/**
 * 安全响应头。
 *
 * ## 为什么每个都要
 *
 * - `X-Content-Type-Options: nosniff`
 *   防止浏览器把 JSON 响应当成 HTML 渲染（XSS 的经典起点）。
 * - `X-Frame-Options: DENY`
 *   禁止被 iframe 嵌套 → 防点击劫持。
 *   有人可能把云盘页面嵌在自己网站里，诱导你点「删除」。
 * - `Referrer-Policy: no-referrer`
 *   不把 URL（含路径信息）泄露给第三方。
 * - `Content-Security-Policy`
 *   限定脚本/样式来源，禁止内联脚本和 eval → 挡住大部分 XSS 注入。
 * - `Permissions-Policy`
 *   关掉用不到的浏览器能力（摄像头、麦克风、地理位置）。
 * - `Cross-Origin-Opener-Policy`
 *   防止被别的页面用 window.opener 操控。
 * - `Strict-Transport-Security`
 *   强制浏览器以后只用 HTTPS 访问。**只在 HTTPS 下发** ——
 *   在 http 上发这个头，浏览器会拒绝访问你的站点。
 */
export function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** HSTS。只在 HTTPS 下发 —— http 下发会让浏览器直接拒绝访问。 */
function hstsHeader(url: URL): Record<string, string> {
  if (url.protocol !== "https:") return {};
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

async function runCron(env: Env): Promise<void> {
  const { purgeExpired } = await import("./routes/maintenance");
  try {
    const r = await purgeExpired(env);
    console.log("定时任务完成:", JSON.stringify(r));
  } catch (e) {
    console.error("定时任务失败:", e);
  }
}
