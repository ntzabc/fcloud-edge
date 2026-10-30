/**
 * Worker 入口。
 *
 * 路由策略：
 *   /api/*        → 业务 API（自己处理）
 *   其余          → 静态资源，走 ASSETS binding（Cloudflare 边缘缓存，不计 Workers 请求配额）
 *
 * 为什么静态资源走 ASSETS 而不是 Worker 里读文件：
 *   Workers 免费版 10 万请求/天，静态资源请求**不计入**这个配额
 *   （只有 Pages Functions 才计）。走 ASSETS binding 由 Cloudflare 的
 *   静态资源层直接服务，图片、JS、CSS 都不过 Worker。
 */

import { ApiError, type Env } from "./types";
import { route } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        const res = await route(request, env, ctx, url);
        // HSTS 统一在这里加（json() 里加不了，它不知道是不是 https）
        for (const [k, v] of Object.entries(hstsHeader(url))) {
          res.headers.set(k, v);
        }
        return res;
      } catch (e) {
        if (e instanceof ApiError) {
          return json({ error: e.message }, e.status);
        }
        console.error("未处理的异常:", e);
        return json({ error: "服务器内部错误" }, 500);
      }
    }

    // 静态资源
    const res = await env.ASSETS.fetch(request);
    for (const [k, v] of Object.entries(hstsHeader(url))) {
      res.headers.set(k, v);
    }
    // 静态资源也要有防嗅探和防嵌套
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  },

  // 定时任务：回收站清理 + 会话清理 + 块回收
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};

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
function securityHeaders(): Record<string, string> {
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
