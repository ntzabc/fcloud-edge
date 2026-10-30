/**
 * 下载路由：GET /api/file/<nid>
 *
 * 支持 Range（断点续传、视频拖进度条）。
 *
 * ## 加密文件怎么下
 * 加密版本的块在 R2 里是密文，下载时逐块解密再拼成明文流。
 * 内存里任何时刻只有一块 —— 128MB 的内存上限扛得住 4K 视频。
 */

import { need } from "../http";
import { plainStream } from "../blobstore";
import { requireNode, touchDownload } from "../files";
import { canRead, log, permissionFor } from "../sharing";
import { ApiError } from "../types";
import type { Ctx } from "../http";

export async function download(ctx: Ctx, nodeId: number): Promise<Response> {
  const m = await need(ctx);
  const node = await requireNode(ctx.env, nodeId, true);
  if (node.kind !== "file") throw new ApiError("这是文件夹，请用打包下载", 400);

  // 权限：自己 / 有 download 权限 / 有共享
  const perm = await permissionFor(ctx.env, nodeId, m);
  if (!(m.can.includes("download") || node.owner_id === m.id || perm)) {
    throw new ApiError("没有下载权限", 403);
  }
  if (!(await canRead(ctx.env, node, m))) {
    throw new ApiError("没有下载权限", 403);
  }
  if (node.encrypted && !(await ctx.master.unlocked())) {
    throw new ApiError("这个文件是加密的，请先在设置里解锁主密钥", 423);
  }
  if (!node.current_version_id) throw new ApiError("这个文件没有内容", 404);

  const total = node.size;
  const inline = ctx.url.searchParams.get("inline") === "1";
  const ctype = inline ? (node.mime || "application/octet-stream") : "application/octet-stream";
  const disp = inline ? "inline" : "attachment";
  const fname = node.name.replace(/"/g, "");

  const headers: Record<string, string> = {
    "Content-Type": ctype,
    "Content-Disposition": contentDisposition(disp, fname),
    "Accept-Ranges": "bytes",
  };

  // ---- Range 解析 ----
  let start = 0;
  let end = total - 1;
  let partial = false;
  const rng = ctx.req.headers.get("Range") || "";
  if (rng.startsWith("bytes=")) {
    const mm = /^bytes=(\d*)-(\d*)$/.exec(rng.trim());
    if (mm) {
      const s = mm[1];
      const e = mm[2];
      if (s === "" && e) {
        // bytes=-500 最后 500 字节
        start = Math.max(0, total - Number(e));
        end = total - 1;
      } else if (s) {
        start = Number(s);
        end = e ? Number(e) : total - 1;
      }
      end = Math.min(end, total - 1);
      if (start <= end) partial = true;
    }
  }
  if (!partial) { start = 0; end = total - 1; }
  const length = Math.max(0, end - start + 1);

  await touchDownload(ctx.env, nodeId);
  if (!partial) {
    await log(ctx.env, m, inline ? "preview" : "download", {
      targetType: "file", targetId: nodeId, targetName: node.name, ip: ctx.ip,
    });
  }

  const stream = await plainStream(
    ctx.env, ctx.master, node.current_version_id, start, end + 1);

  if (partial) {
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    headers["Content-Length"] = String(length);
    return new Response(stream, { status: 206, headers });
  }
  headers["Content-Length"] = String(length);
  return new Response(stream, { status: 200, headers });
}

/**
 * Content-Disposition。
 * 中文文件名必须用 RFC 5987 的 filename*=UTF-8'' 形式，
 * 直接塞进 filename="..." 的话浏览器会显示乱码。
 */
function contentDisposition(disp: string, fname: string): string {
  // 只有 ASCII 才用 filename=
  if (/^[\x20-\x7e]*$/.test(fname)) {
    return `${disp}; filename="${fname}"`;
  }
  return `${disp}; filename*=UTF-8''${encodeURIComponent(fname)}`;
}
