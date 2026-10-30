/**
 * HTTP 基础层：请求解析、鉴权、响应helper。
 *
 * 跟 Python 版 server.py 的 Handler 对应。
 */

import { ApiError, type Env, type Member } from "./types";
import {
  getMember, getSession, memberToDict, memberCan,
} from "./db";
import { MasterKey } from "./crypto";

export interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  ip: string;
  /** 已鉴权的成员（没登录是 null）。 */
  member: Member | null;
  master: MasterKey;
  /**
   * 路由正则的命名捕获组，比如 /api/node/<nid>/versions → { nid: "3" }。
   *
   * 不要在 handler 里用 pathname.match(/\d+$/) 重新提 ID ——
   * 那种写法对 /api/node/3/versions 这类「数字不在结尾」的路径必然取不到，
   * match 返回 null 后 `!` 直接抛 TypeError，表现为 500。
   */
  params: Record<string, string>;
}

/** 从 Cookie 头里取一个值。 */
export function cookie(req: Request, name: string): string {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return "";
}

/** 取客户端 IP。CF-Connecting-IP 是 Cloudflare 设的头。 */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "";
}

/**
 * 解析当前请求的登录身份。
 * 没登录返回 null（不抛错 —— 大部分接口自己判断）。
 */
export async function whoami(env: Env, req: Request): Promise<Member | null> {
  const token = cookie(req, env.SESSION_COOKIE);
  if (!token) return null;
  const s = await getSession(env.DB, token);
  if (!s) return null;
  const row = await getMember(env.DB, s.member_id);
  if (!row || row.disabled) return null;
  return memberToDict(row);
}

/** 要求已登录，否则 401。 */
export async function need(ctx: Ctx): Promise<Member> {
  if (!ctx.member) throw new ApiError("请先登录", 401);
  return ctx.member;
}

/** 要求某项权限，否则 403。 */
export function needPerm(ctx: Ctx, action: string): Member {
  const m = ctx.member;
  if (!m) throw new ApiError("请先登录", 401);
  if (!memberCan(m.role, action)) {
    throw new ApiError("没有权限做这件事", 403);
  }
  return m;
}

/** 读 JSON 请求体。 */
export async function jsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  const ct = req.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) {
    throw new ApiError("请求内容不是合法的 JSON");
  }
  try {
    return await req.json<T>();
  } catch {
    throw new ApiError("请求内容不是合法的 JSON");
  }
}

/** 读原始字节（上传分片用）。 */
export async function rawBody(req: Request): Promise<Uint8Array> {
  const buf = await req.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * CSRF 防护：同源检查。
 *
 * ## 为什么需要
 *
 * Cookie 里的会话是浏览器的，浏览器会自动带上。
 * 如果不做检查，别的网站可以发一个跨站 POST 到
 * `https://xxx.workers.dev/api/node/1`（DELETE /api/...），
 * 用户的浏览器会乖乖带着会话 cookie 去执行 —— 这就是 CSRF。
 *
 * ## 怎么挡
 *
 * 检查 `Origin`（有就必须是同源）或 `Referer`（回退）。
 * 现代浏览器发跨站写请求**一定**带 Origin，所以这个检查很可靠。
 *
 * ## 为什么不用 token
 *
 * 经典方案是发一个 CSRF token 塞进表单，提交时校验。
 * 但那要改前端（每个请求都带上 token），
 * 而这里的接口是 JSON API（不是表单），前端一行都不用改。
 *
 * ## 注意
 *
 * 同源检查挡不住「同源内的 XSS」—— 那本来就是更大的洞，
 * 靠 CSP 和转义来防，不是 CSRF 能解决的。
 */
export function checkSameOrigin(req: Request, url: URL): void {
  // 只管写操作。GET 应该是幂等的（真要做到「GET 无副作用」）。
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return;
  }
  const origin = req.headers.get("Origin");
  if (origin) {
    // 明确的跨站 → 拒绝
    if (origin !== url.origin) {
      throw new ApiError("跨站请求被拒绝", 403);
    }
    return;
  }
  // 没有 Origin：老浏览器 / 某些客户端会这样。
  // 退一步看 Referer。
  const referer = req.headers.get("Referer");
  if (referer) {
    try {
      const r = new URL(referer);
      if (r.origin !== url.origin) throw new ApiError("跨站请求被拒绝", 403);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // Referer 解析不了就放过（不能因为格式怪就拒绝正常请求）
    }
  }
}

/** 构造登录 Cookie。
 *
 * Secure 标志：**上公网必须开**。Python 版是局域网，没加 Secure
 * （加了局域网 http 也用不了）。这里默认开，localhost 本地开发时
 * 通过 config 判断关掉。
 */
export function sessionCookie(
  env: Env, token: string, maxAge: number, secure: boolean,
): string {
  const parts = [
    `${env.SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(env: Env, secure: boolean): string {
  const parts = [`${env.SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** 判断当前是不是安全上下文（HTTPS 或 localhost）。 */
export function isSecureCtx(_req: Request, url: URL): boolean {
  return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

// ---------------------------------------------------------------- 分词

/**
 * 中文倒排索引的分词。
 *
 * 跟 Python 版 search.py 的策略一致（必须一致，否则迁移后搜不到）：
 *   中文连续片段 -> 全部二元组（bigram）+ 单字
 *   英文/数字   -> 整词转小写
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = (text || "").toLowerCase();
  let i = 0;
  while (i < s.length) {
    const c = s.codePointAt(i)!;
    if (isCJK(c)) {
      // 收集连续的中文片段
      let j = i;
      while (j < s.length && isCJK(s.codePointAt(j)!)) j++;
      const seg = Array.from(s.slice(i, j));
      for (const ch of seg) out.push(ch);
      for (let k = 0; k + 1 < seg.length; k++) out.push(seg[k] + seg[k + 1]);
      i = j;
    } else if (/[a-z0-9_]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[a-z0-9_]/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function isCJK(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||    // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) ||    // 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff)       // 兼容表意
  );
}
