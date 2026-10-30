/**
 * 共享与审计路由。
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import { requireNode } from "../files";
import { require } from "../members";
import {
  descendantsShare, grant, listFor, log, logStats, recentLog, revoke,
  sharedByMe, sharedWithMe,
} from "../sharing";
import { ApiError } from "../types";
import type { Ctx } from "../http";

const SPACE_ID = 1;

export async function nodeShares(ctx: Ctx, nid: number): Promise<Response> {
  await need(ctx);
  await requireNode(ctx.env, nid, true);
  return json({ items: await listFor(ctx.env, nid) });
}

export async function shareNode(ctx: Ctx, nid: number): Promise<Response> {
  const m = await need(ctx);
  require(m, "share");
  const node = await requireNode(ctx.env, nid);
  if (!(node.owner_id === m.id || m.can.includes("delete_any"))) {
    throw new ApiError("只能共享自己创建的文件", 403);
  }
  const d = await jsonBody<{
    grantee_id?: number; permission?: string; note?: string; with_children?: boolean;
  }>(ctx.req);
  const granteeId = Number(d.grantee_id);
  const permission = d.permission || "read";
  const items = await grant(ctx.env, nid, granteeId, permission, m, d.note || "");
  if (d.with_children) {
    await descendantsShare(ctx.env, nid, granteeId, permission, m);
  }
  await log(ctx.env, m, "share_grant", {
    targetType: node.kind, targetId: nid, targetName: node.name, detail: d, ip: ctx.ip,
  });
  return json({ ok: true, items });
}

export async function unshareNode(ctx: Ctx, nid: number, gid: number): Promise<Response> {
  const m = await need(ctx);
  require(m, "share");
  const node = await requireNode(ctx.env, nid, true);
  if (!(node.owner_id === m.id || m.can.includes("delete_any"))) {
    throw new ApiError("只能取消自己创建的文件的共享", 403);
  }
  await revoke(ctx.env, nid, gid);
  await log(ctx.env, m, "share_revoke", {
    targetType: node.kind, targetId: nid, targetName: node.name,
    detail: { grantee: gid }, ip: ctx.ip,
  });
  return json({ ok: true, items: await listFor(ctx.env, nid) });
}

export async function sharedWithMeRoute(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  return json({
    for_me: await sharedWithMe(ctx.env, m, SPACE_ID),
    by_me: await sharedByMe(ctx.env, m, SPACE_ID),
  });
}

export async function auditLog(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "view_audit");
  const q = ctx.url.searchParams;
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") || 120)));
  const days = q.get("days");
  const since = days ? Date.now() / 1000 - Number(days) * 86400 : null;
  return json({
    items: await recentLog(ctx.env, {
      spaceId: Number(q.get("space") || SPACE_ID),
      limit,
      actorId: q.get("actor") ? Number(q.get("actor")) : null,
      action: q.get("action") || "",
      since,
      keyword: q.get("q") || "",
    }),
    stats: await logStats(ctx.env, Number(q.get("space") || SPACE_ID)),
  });
}
