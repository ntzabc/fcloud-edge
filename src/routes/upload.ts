/**
 * 上传路由：init / status / part / finish / abort / my uploads。
 *
 * 契约跟 Python 版 server.py 一致：
 *   POST   /api/upload/init
 *   GET    /api/upload/<uid>
 *   PUT    /api/upload/<uid>/part/<seq>
 *   POST   /api/upload/<uid>/finish
 *   DELETE /api/upload/<uid>
 *   GET    /api/uploads
 */

import { json } from "../index";
import { jsonBody, need, rawBody } from "../http";
import {
  abort, createUpload, finish, myUploads, putPart, status,
} from "../transfer";
import { log } from "../sharing";
import { ApiError } from "../types";
import type { Ctx } from "../http";

export async function uploadInit(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<{
    parent_id?: number; name?: string; total_size?: number; mime?: string;
    encrypted?: boolean; category?: string; note?: string; chunk_size?: number;
    replace_node_id?: number; space?: number;
  }>(ctx.req);
  const st = await createUpload(ctx.env, ctx.master, m, {
    parentId: Number(d.parent_id || 0),
    name: d.name || "未命名",
    totalSize: Number(d.total_size || 0),
    mime: d.mime || "",
    encrypted: !!d.encrypted,
    category: d.category || "",
    note: d.note || "",
    chunkSize: d.chunk_size ?? null,
    replaceNodeId: d.replace_node_id ?? null,
    spaceId: Number(d.space || 1),
  });
  return json(st);
}

export async function uploadStatus(ctx: Ctx, uid: string): Promise<Response> {
  const m = await need(ctx);
  return json(await status(ctx.env, uid, m));
}

export async function uploadPart(ctx: Ctx, uid: string, seq: number): Promise<Response> {
  const m = await need(ctx);
  const data = await rawBody(ctx.req);
  if (!data.length) throw new ApiError("分片内容是空的");
  return json(await putPart(ctx.env, ctx.master, uid, seq, data, m));
}

export async function uploadFinish(ctx: Ctx, uid: string): Promise<Response> {
  const m = await need(ctx);
  const r = await finish(ctx.env, ctx.master, uid, m);
  const node = r.node as { id: number; name: string; size: number; encrypted: number };
  await log(ctx.env, m, "upload", {
    targetType: "file", targetId: node.id, targetName: node.name,
    detail: { size: node.size, encrypted: node.encrypted }, ip: ctx.ip,
  });
  return json(r);
}

export async function uploadAbort(ctx: Ctx, uid: string): Promise<Response> {
  const m = await need(ctx);
  return json(await abort(ctx.env, uid, m));
}

export async function myUploadsRoute(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  return json({ items: await myUploads(ctx.env, m) });
}
