/**
 * 成员路由：GET/POST /api/members、PATCH/DELETE /api/member/<mid>
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import {
  PERMISSIONS, ROLE_LABEL, createMember, deleteMember, require,
  spaceMembers, updateMember,
} from "../members";
import { log } from "../sharing";
import { getMember } from "../db";
import type { Ctx } from "../http";

const SPACE_ID = 1;

export async function members(ctx: Ctx): Promise<Response> {
  await need(ctx);
  const list = await spaceMembers(ctx.env.DB, SPACE_ID);
  return json({
    items: list,
    permissions: PERMISSIONS,
    role_label: ROLE_LABEL,
  });
}

export async function addMember(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "manage_members");
  const d = await jsonBody<{
    username?: string; display_name?: string; password?: string; role?: string;
  }>(ctx.req);
  const nm = await createMember(
    ctx.env.DB, d.username || "", d.display_name || "", d.password || "",
    d.role || "child", SPACE_ID, true);
  await log(ctx.env, m, "member_add", {
    targetType: "member", targetId: nm.id, targetName: nm.display_name,
    detail: { role: nm.role }, ip: ctx.ip,
  });
  return json({ ok: true, member: nm });
}

export async function patchMember(ctx: Ctx, mid: number): Promise<Response> {
  const m = await need(ctx);
  require(m, "manage_members");
  const d = await jsonBody<{
    display_name?: string; role?: string; password?: string; disabled?: boolean;
  }>(ctx.req);
  const nm = await updateMember(ctx.env.DB, mid, {
    display_name: d.display_name,
    role: d.role,
    password: d.password || undefined,
    disabled: d.disabled,
  });
  await log(ctx.env, m, "member_edit", {
    targetType: "member", targetId: nm.id, targetName: nm.display_name,
    detail: Object.fromEntries(
      ["display_name", "role", "disabled"].filter((k) => k in d).map((k) => [k, (d as never)[k]])),
    ip: ctx.ip,
  });
  return json({ ok: true, member: nm });
}

export async function deleteMemberRoute(ctx: Ctx, mid: number): Promise<Response> {
  const m = await need(ctx);
  require(m, "manage_members");
  const row = await getMember(ctx.env.DB, mid);
  await deleteMember(ctx.env.DB, mid);
  await log(ctx.env, m, "member_del", {
    targetType: "member", targetId: mid, targetName: row?.display_name ?? "", ip: ctx.ip,
  });
  return json({ ok: true });
}
