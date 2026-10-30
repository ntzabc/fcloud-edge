/**
 * 文件路由：列表 / 新建文件夹 / 改属性 / 删除 / 恢复 / 版本 / 预览 / 回收站。
 *
 * 接口契约跟 Python 版 server.py 完全一致 —— 前端一个字都不用改。
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import {
  applyMeta, breadcrumbs, byCategory, byMember, children, createFolder as createFolderNode,
  emptyTrash, get, move, previewKind, purge, recent, rename, requireNode, restore,
  restoreVersion, softDelete, starred, trashList as trashListOf, versionList,
} from "../files";
import { canRead, effectiveWrite, listFor, log } from "../sharing";
import { require, space } from "../members";
import { ApiError } from "../types";
import type { Ctx } from "../http";

const SPACE_ID = 1;

// ---------------------------------------------------------------- 列表

export async function listFiles(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const q = ctx.url.searchParams;
  const parent = Number(q.get("parent") || 0);
  const sp = Number(q.get("space") || SPACE_ID);
  const items = await children(ctx.env, sp, parent);
  const visible = [];
  for (const n of items) {
    if (!(await canRead(ctx.env, n, m))) continue;
    visible.push({
      ...n,
      preview: previewKind(n.name, n.mime),
      shares: n.kind === "file" ? (await listFor(ctx.env, n.id)).length : 0,
    });
  }
  return json({
    parent,
    breadcrumbs: await breadcrumbs(ctx.env, parent),
    items: visible,
    space: await space(ctx.env.DB, SPACE_ID),
  });
}

// ---------------------------------------------------------------- 新建文件夹

export async function createFolder(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "create_folder");
  const d = await jsonBody<{ space?: number; parent_id?: number; name?: string }>(ctx.req);
  const n = await createFolderNode(
    ctx.env, Number(d.space || SPACE_ID), Number(d.parent_id || 0),
    d.name || "新建文件夹", m);
  await log(ctx.env, m, "create_folder", {
    targetType: "folder", targetId: n.id, targetName: n.name, ip: ctx.ip,
  });
  return json({ ok: true, node: n });
}

// ---------------------------------------------------------------- 改属性

export async function patchNode(ctx: Ctx, nodeId: number): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<Record<string, unknown>>(ctx.req);
  let node = await requireNode(ctx.env, nodeId, true);

  if (typeof d.name === "string") {
    node = await rename(ctx.env, ctx.master, nodeId, d.name, m);
    await log(ctx.env, m, "rename", {
      targetType: node.kind, targetId: nodeId, targetName: node.name, ip: ctx.ip,
    });
  }
  if (d.parent_id !== undefined) {
    node = await move(ctx.env, nodeId, Number(d.parent_id), m);
    await log(ctx.env, m, "move", {
      targetType: node.kind, targetId: nodeId, targetName: node.name, ip: ctx.ip,
    });
  }
  if (["category", "tags", "note", "starred"].some((k) => k in d)) {
    if (!(await effectiveWrite(ctx.env, node, m))) {
      throw new ApiError("只能修改自己的文件", 403);
    }
    node = await applyMeta(ctx.env, ctx.master, nodeId, m, {
      category: d.category as string | undefined,
      tags: d.tags as string | undefined,
      note: d.note as string | undefined,
      starred: d.starred as boolean | undefined,
    });
    await log(ctx.env, m, "meta", {
      targetType: node.kind, targetId: nodeId, targetName: node.name,
      detail: Object.fromEntries(
        ["category", "tags", "note", "starred"].filter((k) => k in d).map((k) => [k, d[k]])),
      ip: ctx.ip,
    });
  }
  return json({ ok: true, node });
}

// ---------------------------------------------------------------- 删除 / 恢复

export async function deleteNode(ctx: Ctx, nodeId: number): Promise<Response> {
  const m = await need(ctx);
  const node = await requireNode(ctx.env, nodeId, true);
  if (ctx.url.searchParams.get("purge") === "1") {
    const r = await purge(ctx.env, nodeId, m);
    await log(ctx.env, m, "purge", {
      targetType: node.kind, targetId: nodeId, targetName: node.name, detail: r, ip: ctx.ip,
    });
    return json({ ok: true, ...r });
  }
  const r = await softDelete(ctx.env, nodeId, m);
  await log(ctx.env, m, "delete", {
    targetType: node.kind, targetId: nodeId, targetName: node.name, detail: r, ip: ctx.ip,
  });
  return json({ ...r, ok: true });
}

export async function restoreNode(ctx: Ctx, nodeId: number): Promise<Response> {
  const m = await need(ctx);
  const r = await restore(ctx.env, nodeId, m);
  const node = await get(ctx.env, nodeId);
  await log(ctx.env, m, "restore", {
    targetType: node?.kind ?? "", targetId: nodeId,
    targetName: node?.name ?? "", detail: r, ip: ctx.ip,
  });
  return json({ ok: true, ...r });
}

// ---------------------------------------------------------------- 版本

export async function versions(ctx: Ctx, nodeId: number): Promise<Response> {
  await need(ctx);
  const node = await requireNode(ctx.env, nodeId, true);
  return json({ node, versions: await versionList(ctx.env, nodeId) });
}

export async function rollback(ctx: Ctx, nodeId: number): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<{ version_id?: number }>(ctx.req);
  const r = await restoreVersion(ctx.env, ctx.master, nodeId, Number(d.version_id), m);
  const node = await get(ctx.env, nodeId);
  await log(ctx.env, m, "rollback", {
    targetType: "file", targetId: nodeId, targetName: node?.name ?? "", detail: r, ip: ctx.ip,
  });
  return json({ ...r, ok: true });
}

// ---------------------------------------------------------------- 预览

/**
 * 预览。返回文件元信息 + 正文（文本类）。
 *
 * 图片/视频/音频的字节流走 /api/file/<nid>?inline=1 —— 预览和下载共用一条路径，
 * 免得维护两份解密逻辑。
 */
export async function preview(ctx: Ctx, nodeId: number): Promise<Response> {
  const m = await need(ctx);
  const node = await requireNode(ctx.env, nodeId, true);
  if (node.kind !== "file") throw new ApiError("这是文件夹", 400);
  if (!(await canRead(ctx.env, node, m))) throw new ApiError("没有权限查看", 403);

  const kind = previewKind(node.name, node.mime);
  const out: Record<string, unknown> = {
    node,
    kind,
    versions: (await versionList(ctx.env, nodeId)).length,
  };
  // 文本类：直接把正文抽出来给前端预览（限量 256KB）
  if (kind === "text" && !node.encrypted && node.current_version_id) {
    const { extractBody } = await import("../search");
    out.text = await extractBody(ctx.env, ctx.master, node.current_version_id);
  }
  return json(out);
}

// ---------------------------------------------------------------- 回收站

export async function trashList(ctx: Ctx): Promise<Response> {
  await need(ctx);
  const sp = Number(ctx.url.searchParams.get("space") || SPACE_ID);
  return json({ items: await trashListOf(ctx.env, sp) });
}

export async function emptyTrashRoute(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<{ space?: number }>(ctx.req);
  const r = await emptyTrash(ctx.env, Number(d.space || SPACE_ID), m);
  await log(ctx.env, m, "empty_trash", { detail: r, ip: ctx.ip });
  return json({ ok: true, ...r });
}

// ---------------------------------------------------------------- 分类 / 成员维度

export async function byCategoryRoute(ctx: Ctx): Promise<Response> {
  await need(ctx);
  return json({ items: await byCategory(ctx.env, SPACE_ID) });
}

export async function byMemberRoute(ctx: Ctx): Promise<Response> {
  await need(ctx);
  return json({ items: await byMember(ctx.env, SPACE_ID) });
}

export async function recentRoute(ctx: Ctx): Promise<Response> {
  await need(ctx);
  return json({ items: await recent(ctx.env, SPACE_ID) });
}

export async function starredRoute(ctx: Ctx): Promise<Response> {
  await need(ctx);
  return json({ items: await starred(ctx.env, SPACE_ID) });
}
