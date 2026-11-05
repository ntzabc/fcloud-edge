/**
 * Pages Function —— 处理 /api/*。
 *
 * ## 为什么用 Pages 而不是 Workers
 *
 * `*.workers.dev` 在国内被 **DNS 污染**（解析到 Facebook 的 IP，连不上），
 * 而 `*.pages.dev` 是干净的。所以主站跑在 Pages 上。
 *
 * 目录名 `[[path]]` 是 Pages 的约定式路由，表示「匹配所有 /api/ 下的路径」，
 * 包括 /api/ 本身。
 *
 * ## 静态资源去哪了
 *
 * Pages 直接托管 `web/` 目录，不经过函数 ——
 * 所以这个函数只会收到 /api/* 的请求，其他路径根本到不了这里。
 */

import { handleApi } from "../../src/index";

interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  params: Record<string, string>;
  waitUntil(p: Promise<unknown>): void;
  next(): Promise<Response>;
}

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const url = new URL(context.request.url);
  return await handleApi(
    context.request,
    context.env as never,
    { waitUntil: (p) => context.waitUntil(p) } as never,
    url,
  );
};
