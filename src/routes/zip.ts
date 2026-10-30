/**
 * 打包下载 + 空间设置。
 *
 * GET  /api/zip?ids=1,2,3   打包下载
 * POST /api/space           改空间设置
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import { requireNode } from "../files";
import { require, updateSpace } from "../members";
import { log } from "../sharing";
import { planZip, zipFilename, zipStream } from "../zip";
import { ApiError } from "../types";
import type { Ctx } from "../http";

const SPACE_ID = 1;

/**
 * 打包下载。
 *
 * 前端「打包当前文件夹下载」直接 location.href = '/api/zip?ids=' + S.parent
 * —— 所以这个接口必须能直接当普通 GET 用（带 Cookie 就行）。
 */
export async function zip(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "download");
  const raw = ctx.url.searchParams.get("ids") || "";
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) throw new ApiError("没有选择要下载的内容");

  const names: string[] = [];
  for (const i of ids) {
    const n = await requireNode(ctx.env, i, true);
    names.push(n.name);
  }
  const plan = await planZip(ctx.env, ids, m);
  if (!plan.length) throw new ApiError("没有可打包的内容");

  const filename = zipFilename(ids, names);
  await log(ctx.env, m, "zip_download", { detail: { ids }, ip: ctx.ip });

  const stream = await zipStream(ctx.env, ctx.master, plan);
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

/** 改空间设置（改名 / 配额）。 */
export async function spaceSettings(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "manage_space");
  const d = await jsonBody<{ name?: string; quota_bytes?: number }>(ctx.req);
  const sp = await updateSpace(
    ctx.env.DB, SPACE_ID, d.name, d.quota_bytes === undefined ? undefined : Number(d.quota_bytes));
  await log(ctx.env, m, "space_edit", {
    detail: { name: d.name, quota_bytes: d.quota_bytes }, ip: ctx.ip,
  });
  return json({ ok: true, space: sp });
}
