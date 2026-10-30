/**
 * 文件树、版本历史、回收站 —— Edge 版。
 *
 * 跟 Python 版 files.py 一一对应。
 *
 * ## 设计要点
 * **文件夹和文件在同一张表里** —— 文件夹没有 current_version_id，靠这个区分。
 * **删除永远是软删除** —— deleted_at 一填，数据块一个都没动，恢复零成本。
 * **版本历史靠内容寻址白拿** —— 旧版本继续持有老块的引用。
 *
 * ## D1 上的差异
 *   - 没有事务语句 → 用 db.batch()
 *   - 没有 lastrowid → run() 的 meta.last_row_id
 *   - 绑定参数上限 100 → 所有 IN (...) 查询都要分批
 */

import {
  children as dbChildren, execute, insert, queryAll, queryOne,
} from "./db";
import { attachVersion, detachVersion, markCurrent } from "./blobstore";
import { indexNode, CATEGORIES } from "./search";
import { b64e, encryptChunk, randomBytes } from "./crypto";
import { ApiError, type Env, type MasterLike, type Member, type Node } from "./types";

// ---------------------------------------------------------------- 分类推断

const IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".avif", ".tiff",
]);
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".3gp",
]);
const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma", ".opus",
]);
const DOC_EXT = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".md",
  ".rtf", ".odt", ".epub", ".pages",
]);
const SHEET_EXT = new Set([
  ".csv", ".tsv", ".xls", ".xlsx", ".numbers", ".ods",
]);
const ARCHIVE_EXT = new Set([
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
]);

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml",
  ".zip": "application/zip", ".gz": "application/gzip",
};

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

export function guessMime(name: string): string {
  const ext = extOf(name);
  if (MIME_MAP[ext]) return MIME_MAP[ext];
  if (IMAGE_EXT.has(ext)) return "image/" + ext.slice(1);
  if (VIDEO_EXT.has(ext)) return "video/" + ext.slice(1);
  if (AUDIO_EXT.has(ext)) return "audio/" + ext.slice(1);
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  return "application/octet-stream";
}

export function guessCategory(name: string): string {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "照片";
  if (VIDEO_EXT.has(ext)) return "视频";
  if (AUDIO_EXT.has(ext)) return "音频";
  if (SHEET_EXT.has(ext)) return "表格";
  if (DOC_EXT.has(ext)) return "文档";
  if (ARCHIVE_EXT.has(ext)) return "压缩包";
  return "其他";
}

export function previewKind(name: string, mime: string): string {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext) || mime.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || mime.startsWith("video/")) return "video";
  if (AUDIO_EXT.has(ext) || mime.startsWith("audio/")) return "audio";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  if ([".txt", ".md", ".log", ".csv", ".json", ".xml", ".yaml", ".yml"].includes(ext)) return "text";
  return "none";
}

// ---------------------------------------------------------------- 名称

const BAD_CHARS = '\\/:*?"<>|\r\n\t';

/** 清掉危险字符。Windows 里这些字符会让文件没法落地。 */
export function sanitizeName(name: string): string {
  let n = (name || "").trim().replace(/\0/g, "");
  for (const ch of BAD_CHARS) n = n.split(ch).join("_");
  n = n.replace(/^[. ]+|[. ]+$/g, "");
  if (!n) n = "未命名";
  return n.slice(0, 200);
}

/**
 * 同名时自动加 (1)(2)，而不是直接报错。
 * 家里太容易出现「新建文件夹」重名了，直接报错会让人很挫败。
 */
export async function uniqueName(
  env: Env, spaceId: number, parentId: number, name: string,
): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> =>
    (await queryOne(
      env.DB,
      "SELECT id FROM nodes WHERE space_id=? AND parent_id=? AND name=? AND deleted_at IS NULL",
      spaceId, parentId, candidate)) !== null;

  if (!(await taken(name))) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot + 1) : "";
  for (let i = 1; i < 1000; i++) {
    const cand = hasExt ? `${stem}(${i}).${ext}` : `${stem}(${i})`;
    if (!(await taken(cand))) return cand;
  }
  return `${stem}-${b64e(randomBytes(3)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6)}`;
}

// ---------------------------------------------------------------- 读

export async function get(env: Env, nodeId: number): Promise<Node | null> {
  return await queryOne<Node>(
    env.DB,
    "SELECT n.*, m.display_name AS owner_name, m.color AS owner_color, " +
    "       u.display_name AS uploader_name " +
    "FROM nodes n LEFT JOIN members m ON m.id=n.owner_id " +
    "LEFT JOIN members u ON u.id=n.uploader_id WHERE n.id=?", nodeId);
}

export async function requireNode(
  env: Env, nodeId: number, allowDeleted = false,
): Promise<Node> {
  const n = await get(env, nodeId);
  if (!n) throw new ApiError("文件不存在或已被彻底删除", 404);
  if (n.deleted_at && !allowDeleted) throw new ApiError("文件在回收站里");
  return n;
}

export async function children(
  env: Env, spaceId: number, parentId: number,
): Promise<Node[]> {
  return await dbChildren(env.DB, spaceId, parentId);
}

/** 从根到当前节点的路径，面包屑用。 */
export async function breadcrumbs(
  env: Env, nodeId: number,
): Promise<{ id: number; name: string; parent_id: number; kind: string }[]> {
  const chain: { id: number; name: string; parent_id: number; kind: string }[] = [];
  let cur = nodeId;
  let guard = 0;
  while (cur && guard < 64) {
    guard++;
    const row = await queryOne<{ id: number; name: string; parent_id: number; kind: string }>(
      env.DB, "SELECT id,name,parent_id,kind FROM nodes WHERE id=?", cur);
    if (!row) break;
    chain.unshift(row);
    if (row.parent_id === cur) break;
    cur = row.parent_id;
  }
  if (!chain.length) {
    chain.push({ id: 0, name: "全部文件", parent_id: 0, kind: "folder" });
  }
  return chain;
}

export async function pathOf(env: Env, nodeId: number): Promise<string> {
  const parts = (await breadcrumbs(env, nodeId)).map((b) => b.name);
  return parts.filter((p) => p !== "全部文件").join("/");
}

/**
 * 整个子树。迭代实现（不用递归），层数再深也不会爆栈。
 *
 * includeDeleted=true 是恢复/彻底删除必须用的：
 * 回收站里整个子树都是 deleted_at 非空的，默认那版只看得到目录自己，
 * 结果就是「恢复了文件夹，里面的文件还留在回收站」。
 */
export async function descendants(
  env: Env, nodeId: number,
  opts: { includeSelf?: boolean; includeDeleted?: boolean } = {},
): Promise<number[]> {
  const out: number[] = opts.includeSelf ? [nodeId] : [];
  let frontier = [nodeId];
  let guard = 0;
  const where = opts.includeDeleted ? "" : " AND deleted_at IS NULL";
  while (frontier.length && guard < 100000) {
    guard++;
    const ph = frontier.map(() => "?").join(",");
    const rows = await queryAll<{ id: number }>(
      env.DB, `SELECT id FROM nodes WHERE parent_id IN (${ph})${where}`, ...frontier);
    frontier = rows.map((r) => r.id);
    out.push(...frontier);
  }
  return out;
}

export async function subtreeStats(
  env: Env, nodeId: number,
): Promise<{ files: number; folders: number; bytes: number }> {
  const ids = await descendants(env, nodeId);
  if (!ids.length) return { files: 0, folders: 0, bytes: 0 };
  let files = 0, folders = 0, bytes = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    const r = await queryOne<{ f: number; d: number; b: number }>(
      env.DB,
      `SELECT SUM(CASE WHEN kind='file' THEN 1 ELSE 0 END) AS f, ` +
      `SUM(CASE WHEN kind='folder' THEN 1 ELSE 0 END) AS d, ` +
      `COALESCE(SUM(size),0) AS b FROM nodes WHERE id IN (${ph})`, ...part);
    files += r?.f ?? 0;
    folders += r?.d ?? 0;
    bytes += r?.b ?? 0;
  }
  return { files, folders, bytes };
}

// ---------------------------------------------------------------- 写

export async function createFolder(
  env: Env, spaceId: number, parentId: number, name: string,
  owner: Member, category = "其他",
): Promise<Node> {
  const finalName = await uniqueName(env, spaceId, parentId, sanitizeName(name));
  const now = Date.now() / 1000;
  const nid = await insert(env.DB,
    "INSERT INTO nodes(space_id,parent_id,name,kind,owner_id,uploader_id,category,created_at,modified_at) " +
    "VALUES(?,?,?,'folder',?,?,?,?,?)",
    spaceId, parentId, finalName, owner.id, owner.id, category, now, now);
  return (await get(env, nid))!;
}

async function nextSeq(env: Env, nodeId: number): Promise<number> {
  const row = await queryOne<{ s: number }>(
    env.DB, "SELECT COALESCE(MAX(seq),0)+1 AS s FROM versions WHERE node_id=?", nodeId);
  return row?.s ?? 1;
}

export interface CommitOpts {
  size: number;
  mime: string;
  member: Member;
  encrypted?: boolean;
  fileKey?: Uint8Array;
  saltSeed?: Uint8Array;
  note?: string;
  category?: string | null;
  allowVersionBump?: boolean;
}

/**
 * 把一组内容块挂成一个新版本，并把它设为当前版本。
 *
 * 这是「上传完成」和「替换文件」的共同出口 —— 两者只差一个是否已存在节点。
 */
export async function commitVersion(
  env: Env, master: MasterLike,
  nodeId: number,
  chunks: { seq: number; blobId: number; plainSize: number }[],
  opts: CommitOpts,
): Promise<Node & { version_id: number; seq: number }> {
  const now = Date.now() / 1000;
  const node = await get(env, nodeId);
  if (!node) throw new ApiError("文件不存在", 404);
  const seq = opts.allowVersionBump === false ? 1 : await nextSeq(env, nodeId);
  const encrypted = !!opts.encrypted;

  const vid = await insert(env.DB,
    "INSERT INTO versions(node_id,seq,size,chunk_count,encrypted,mime,created_at,created_by,note,is_current) " +
    "VALUES(?,?,?,?,?,?,?,?,?,0)",
    nodeId, seq, opts.size, chunks.length, encrypted ? 1 : 0,
    opts.mime, now, opts.member.id, opts.note ?? "");

  if (encrypted) {
    const fileKey = opts.fileKey ?? randomBytes(32);
    const saltSeed = opts.saltSeed ?? randomBytes(16);
    const check = await sealCheckLocal(fileKey);
    await env.DB.prepare(
      "INSERT INTO version_crypto(version_id,algo,salt_seed,wrapped_key," +
      "check_salt,check_ct,check_tag,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(vid, "aes-256-gcm", b64e(saltSeed),
        b64e(await master.wrap(fileKey)),
        b64e(check.salt), b64e(check.ct), b64e(check.tag), now).run();
  }

  await attachVersion(env, vid, chunks);

  // 老版本降级 + 标记当前
  await execute(env.DB,
    "UPDATE versions SET is_current=0 WHERE node_id=? AND id<>?", nodeId, vid);
  await markCurrent(env, vid, opts.size, chunks.length);

  await env.DB.prepare(
    "UPDATE nodes SET current_version_id=?, size=?, chunk_count=?, mime=?, " +
    "uploader_id=?, modified_at=?, encrypted=? WHERE id=?")
    .bind(vid, opts.size, chunks.length, opts.mime, opts.member.id, now, encrypted ? 1 : 0, nodeId)
    .run();
  if (opts.category) {
    await execute(env.DB, "UPDATE nodes SET category=? WHERE id=?", opts.category, nodeId);
  }

  // 换了内容就重新建索引（加密文件只索引文件名，不抽正文）
  await indexNode(env, master, nodeId, vid, node.name, opts.mime, encrypted);

  const out = (await get(env, nodeId)) as Node & { version_id: number; seq: number };
  out.version_id = vid;
  out.seq = seq;
  return out;
}

/** 密钥自检（跟 MasterKey.sealCheck 一致，这里避免循环依赖单独实现一份）。 */
const KEYCHECK = new TextEncoder().encode("fcloud-keycheck-v1");

async function sealCheckLocal(fileKey: Uint8Array): Promise<{
  salt: Uint8Array; ct: Uint8Array; tag: Uint8Array;
}> {
  const salt = randomBytes(16);
  const { ct, tag } = await encryptChunk(KEYCHECK, fileKey, salt);
  return { salt, ct, tag };
}

export interface CreateFileOpts extends CommitOpts {
  spaceId: number;
  parentId: number;
  name: string;
  replaceNodeId?: number | null;
}

/** 上传完成的落库入口。新建或替换都走这里。 */
export async function createFile(
  env: Env, master: MasterLike,
  chunks: { seq: number; blobId: number; plainSize: number }[],
  opts: CreateFileOpts,
): Promise<Node & { version_id: number; seq: number }> {
  const now = Date.now() / 1000;
  const mime = opts.mime || guessMime(opts.name);
  const category = opts.category || guessCategory(opts.name);

  if (opts.replaceNodeId) {
    await requireNode(env, opts.replaceNodeId);
    return await commitVersion(env, master, opts.replaceNodeId, chunks, {
      ...opts, mime, category, note: opts.note || "替换文件",
    });
  }

  const finalName = await uniqueName(env, opts.spaceId, opts.parentId, sanitizeName(opts.name));
  const nid = await insert(env.DB,
    "INSERT INTO nodes(space_id,parent_id,name,kind,owner_id,uploader_id,category,note," +
    "mime,size,encrypted,created_at,modified_at) VALUES(?,?,?,'file',?,?,?,?,?,?,?,?,?)",
    opts.spaceId, opts.parentId, finalName, opts.member.id, opts.member.id,
    category, opts.note ?? "", mime, opts.size, opts.encrypted ? 1 : 0, now, now);
  return await commitVersion(env, master, nid, chunks, {
    ...opts, mime, category, note: opts.note || "初次上传",
  });
}

export async function rename(
  env: Env, master: MasterLike,
  nodeId: number, name: string, member: Member,
): Promise<Node> {
  const node = await requireNode(env, nodeId);
  checkWrite(node, member);
  const finalName = await uniqueName(env, node.space_id, node.parent_id, sanitizeName(name));
  await env.DB.prepare("UPDATE nodes SET name=?, modified_at=? WHERE id=?")
    .bind(finalName, Date.now() / 1000, nodeId).run();
  if (node.current_version_id) {
    await indexNode(env, master, nodeId, node.current_version_id, finalName,
      node.mime, !!node.encrypted);
  }
  return (await get(env, nodeId))!;
}

export async function move(
  env: Env, nodeId: number, newParentId: number, member: Member,
): Promise<Node> {
  const node = await requireNode(env, nodeId);
  checkWrite(node, member);
  if (newParentId === nodeId) throw new ApiError("不能把文件夹移进它自己");
  // 不能移进自己的子孙节点里，否则树会断成环
  if (node.kind === "folder") {
    const kids = await descendants(env, nodeId);
    if (kids.includes(newParentId)) {
      throw new ApiError("不能把文件夹移到它自己的子目录里");
    }
  }
  if (newParentId) {
    const parent = await requireNode(env, newParentId);
    if (parent.kind !== "folder") throw new ApiError("目标不是一个文件夹");
  }
  await env.DB.prepare("UPDATE nodes SET parent_id=?, modified_at=? WHERE id=?")
    .bind(newParentId, Date.now() / 1000, nodeId).run();
  return (await get(env, nodeId))!;
}

export async function applyMeta(
  env: Env, master: MasterLike,
  nodeId: number, member: Member,
  opts: { category?: string; tags?: string; note?: string; starred?: boolean },
): Promise<Node> {
  const node = await requireNode(env, nodeId);
  checkWrite(node, member);
  if (opts.category !== undefined) {
    if (!CATEGORIES.includes(opts.category)) throw new ApiError("分类不合法");
    await execute(env.DB, "UPDATE nodes SET category=? WHERE id=?", opts.category, nodeId);
  }
  if (opts.tags !== undefined) {
    const clean = [...new Set(opts.tags.replace(/，/g, ",").split(",")
      .map((t) => t.trim()).filter(Boolean))].sort().join(",").slice(0, 400);
    await execute(env.DB, "UPDATE nodes SET tags=? WHERE id=?", clean, nodeId);
  }
  if (opts.note !== undefined) {
    await execute(env.DB, "UPDATE nodes SET note=? WHERE id=?", opts.note.slice(0, 2000), nodeId);
  }
  if (opts.starred !== undefined) {
    await execute(env.DB, "UPDATE nodes SET starred=? WHERE id=?",
      opts.starred ? 1 : 0, nodeId);
  }
  await execute(env.DB, "UPDATE nodes SET modified_at=? WHERE id=?",
    Date.now() / 1000, nodeId);
  // 分类/标签变了，索引里的文件名权重可能也要更新
  if (node.current_version_id && opts.category !== undefined) {
    await indexNode(env, master, nodeId, node.current_version_id, node.name,
      node.mime, !!node.encrypted);
  }
  return (await get(env, nodeId))!;
}

export async function touchDownload(env: Env, nodeId: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE nodes SET download_count=download_count+1, last_access_at=? WHERE id=?")
    .bind(Date.now() / 1000, nodeId).run();
}

// ---------------------------------------------------------------- 版本

export async function versionList(env: Env, nodeId: number): Promise<Record<string, unknown>[]> {
  const rows = await queryAll<Record<string, unknown>>(
    env.DB,
    "SELECT v.*, m.display_name AS author FROM versions v " +
    "LEFT JOIN members m ON m.id=v.created_by WHERE v.node_id=? ORDER BY v.seq DESC",
    nodeId);
  return rows.map((d) => ({ ...d, is_current: !!d.is_current }));
}

/**
 * 回滚到某个历史版本。
 *
 * 不复制数据，只是把 current_version_id 指回去 ——
 * 所以回滚 100 MB 的文件也是一瞬间的事。
 */
export async function restoreVersion(
  env: Env, master: MasterLike,
  nodeId: number, versionId: number, member: Member,
): Promise<{ ok: boolean; restored_seq: number; size: number }> {
  const node = await requireNode(env, nodeId);
  checkWrite(node, member);
  const v = await queryOne<{
    id: number; seq: number; size: number; chunk_count: number; mime: string; encrypted: number;
  }>(env.DB, "SELECT * FROM versions WHERE id=? AND node_id=?", versionId, nodeId);
  if (!v) throw new ApiError("这个版本不存在");

  const now = Date.now() / 1000;
  const seq = await nextSeq(env, nodeId);
  await env.DB.batch([
    env.DB.prepare("UPDATE versions SET is_current=0 WHERE node_id=?").bind(nodeId),
    env.DB.prepare("UPDATE versions SET is_current=1 WHERE id=?").bind(versionId),
    env.DB.prepare(
      "UPDATE nodes SET current_version_id=?, size=?, chunk_count=?, mime=?, " +
      "encrypted=?, uploader_id=?, modified_at=? WHERE id=?")
      .bind(versionId, v.size, v.chunk_count, v.mime, v.encrypted, member.id, now, nodeId),
    // 回滚本身也记一版，历史不会断
    env.DB.prepare(
      "INSERT INTO versions(node_id,seq,size,chunk_count,encrypted,mime,created_at,created_by,note,is_current) " +
      "VALUES(?,?,?,?,?,?,?,?,?,0)")
      .bind(nodeId, seq, v.size, v.chunk_count, v.encrypted, v.mime, now, member.id,
        `回滚到第 ${v.seq} 版`),
  ]);
  await indexNode(env, master, nodeId, versionId, node.name, v.mime, !!v.encrypted);
  return { ok: true, restored_seq: v.seq, size: v.size };
}

/** 只保留最近 keep 个版本（当前版本永远保留）。 */
export async function pruneVersions(
  env: Env, nodeId: number, keep = 20,
): Promise<number> {
  const rows = await queryAll<{ id: number }>(
    env.DB, "SELECT id FROM versions WHERE node_id=? ORDER BY seq DESC", nodeId);
  const stale = rows.slice(keep).map((r) => r.id);
  if (!stale.length) return 0;
  for (let i = 0; i < stale.length; i += 90) {
    const part = stale.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    await execute(env.DB,
      `DELETE FROM version_chunks WHERE version_id IN (${ph}) AND version_id NOT IN ` +
      `(SELECT current_version_id FROM nodes WHERE id=?)`, ...part, nodeId);
    await execute(env.DB, `DELETE FROM versions WHERE id IN (${ph})`, ...part);
  }
  return stale.length;
}

// ---------------------------------------------------------------- 回收站

/** 进回收站。数据一个字节都不动，所以恢复是零成本的。 */
export async function softDelete(
  env: Env, nodeId: number, member: Member, recursive = true,
): Promise<{ deleted: number }> {
  const node = await requireNode(env, nodeId);
  if (node.owner_id !== member.id && !member.can.includes("delete_any")) {
    throw new ApiError("只能删除自己创建的文件", 403);
  }
  // 注意 includeSelf=true：只删子项、把自己留在原地是错的，
  // 那样文件夹还在原地，只是空了。
  const ids = (node.kind === "folder" && recursive)
    ? await descendants(env, nodeId, { includeSelf: true })
    : [nodeId];
  const now = Date.now() / 1000;
  const grace = now + 30 * 86400;

  // D1 绑定参数上限 100 → 分批
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE nodes SET deleted_at=?, deleted_by=?, trash_parent_id=parent_id ` +
        `WHERE id IN (${ph}) AND deleted_at IS NULL`)
        .bind(now, member.id, ...part),
      env.DB.prepare(
        `INSERT INTO tombstones(node_id,name,parent_id,size,version_id,deleted_at,deleted_by,grace_until) ` +
        `SELECT id,name,parent_id,size,current_version_id,?,?,? FROM nodes WHERE id IN (${ph})`)
        .bind(now, member.id, grace, ...part),
    ]);
  }
  return { deleted: ids.length };
}

/** 从回收站恢复。整棵子树一起回来，并且尽量放回原来的位置。 */
export async function restore(
  env: Env, nodeId: number, member: Member,
): Promise<{ restored: number; parent_id: number }> {
  const node = await requireNode(env, nodeId, true);
  if (!node.deleted_at) return { restored: 0, parent_id: node.parent_id };
  // 权限检查：自己的随便恢复，别人的要管理员或成人。
  // 漏了这一条的话，儿童能替别人把文件捞回来。
  if (node.owner_id !== member.id && !member.can.includes("restore_any")) {
    throw new ApiError("只能恢复自己删除的文件", 403);
  }
  // 整个子树可能都在回收站里，所以这里要连已删的一起取
  const ids = await descendants(env, nodeId, { includeSelf: true, includeDeleted: true });
  let targetParent = node.trash_parent_id || 0;
  // 原来的位置已经被别人占了，就退回到根目录
  if (targetParent) {
    const row = await queryOne(
      env.DB, "SELECT id FROM nodes WHERE id=? AND deleted_at IS NULL", targetParent);
    if (!row) targetParent = 0;
  }
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    const stmts = [
      env.DB.prepare(
        `UPDATE nodes SET deleted_at=NULL, deleted_by=NULL, trash_parent_id=NULL ` +
        `WHERE id IN (${ph})`).bind(...part),
      env.DB.prepare(`DELETE FROM tombstones WHERE node_id IN (${ph})`).bind(...part),
    ];
    if (node.kind === "folder" && targetParent !== node.parent_id) {
      stmts.push(env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
        .bind(targetParent, nodeId));
    }
    await env.DB.batch(stmts);
  }
  return { restored: ids.length, parent_id: targetParent };
}

/** 彻底删除。只有管理员能。块在垃圾回收时才真正落盘。 */
export async function purge(
  env: Env, nodeId: number, member: Member,
): Promise<{ purged: number; logical_freed: number }> {
  const node = await requireNode(env, nodeId, true);
  if (!member.can.includes("purge")) {
    throw new ApiError("只有管理员可以彻底删除", 403);
  }
  const ids = await descendants(env, nodeId, { includeSelf: true, includeDeleted: true });
  // versions 表对 nodes 有 ON DELETE CASCADE，删节点会连带删版本；
  // 但块不会被删 —— 必须先把块的引用计数减掉，否则永远回收不掉。
  const versions = await queryAll<{ id: number }>(
    env.DB,
    `SELECT id FROM versions WHERE node_id IN (${ids.map(() => "?").join(",")})`, ...ids);
  for (const v of versions) await detachVersion(env, v.id);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM tombstones WHERE node_id IN (${ph})`).bind(...part),
      env.DB.prepare(`DELETE FROM nodes WHERE id IN (${ph})`).bind(...part),
    ]);
  }
  return { purged: ids.length, logical_freed: node.size || 0 };
}

/** 清理超过保留期的回收站内容（后台任务）。 */
export async function purgeExpired(env: Env, graceDays = 30): Promise<{ purged_trees: number }> {
  const cutoff = Date.now() / 1000 - graceDays * 86400;
  const rows = await queryAll<{ node_id: number }>(
    env.DB, "SELECT DISTINCT node_id FROM tombstones WHERE deleted_at < ?", cutoff);
  let n = 0;
  const system: Member = {
    id: 0, username: "system", display_name: "系统", role: "admin",
    role_label: "管理员", initial: "系", color: "#5B9BFF", disabled: 0,
    created_at: 0, last_login_at: null,
    can: ["purge", "delete_any", "restore_any", "manage_space", "manage_members",
      "edit_meta", "view_audit", "run_backup", "share", "browse", "download",
      "preview", "upload", "create_folder", "delete_own", "use_encryption",
      "manage_master"],
  };
  for (const r of rows) {
    const node = await get(env, r.node_id);
    if (node?.deleted_at) {
      try {
        await purge(env, r.node_id, system);
        n++;
      } catch {
        continue;
      }
    }
  }
  return { purged_trees: n };
}

/** 回收站列表。只显示顶层被删的那个。 */
export async function trashList(
  env: Env, spaceId: number, limit = 200,
): Promise<Record<string, unknown>[]> {
  const rows = await queryAll<Record<string, unknown>>(
    env.DB,
    "SELECT n.*, m.display_name AS owner_name, u.display_name AS deleted_by_name " +
    "FROM nodes n LEFT JOIN members m ON m.id=n.owner_id " +
    "LEFT JOIN members u ON u.id=n.deleted_by " +
    "WHERE n.space_id=? AND n.deleted_at IS NOT NULL " +
    "ORDER BY n.deleted_at DESC LIMIT ?", spaceId, limit);
  const out: Record<string, unknown>[] = [];
  for (const d of rows) {
    // 只显示顶层被删的那个，子项单独删的也各算一条
    const pid = Number(d.parent_id);
    if (pid) {
      const parent = await queryOne(
        env.DB, "SELECT 1 AS x FROM nodes WHERE id=? AND deleted_at IS NOT NULL", pid);
      if (parent) continue;
    }
    out.push(d);
  }
  return out;
}

export async function emptyTrash(
  env: Env, spaceId: number, member: Member,
): Promise<{ purged: number }> {
  const roots = await trashList(env, spaceId, 10000);
  let total = 0;
  for (const t of roots) {
    try {
      total += (await purge(env, Number(t.id), member)).purged;
    } catch {
      continue;
    }
  }
  return { purged: total };
}

// ---------------------------------------------------------------- 权限

function checkWrite(node: Node, member: Member): void {
  if (node.owner_id === member.id) return;
  if (member.can.includes("delete_any")) return;
  throw new ApiError("只能操作自己创建的文件", 403);
}

// ---------------------------------------------------------------- 列表

export async function recent(env: Env, spaceId: number, limit = 12): Promise<Node[]> {
  return await queryAll<Node>(
    env.DB,
    "SELECT n.*, u.display_name AS uploader_name FROM nodes n " +
    "LEFT JOIN members u ON u.id=n.uploader_id " +
    "WHERE n.space_id=? AND n.kind='file' AND n.deleted_at IS NULL " +
    "ORDER BY n.modified_at DESC LIMIT ?", spaceId, limit);
}

export async function starred(env: Env, spaceId: number): Promise<Node[]> {
  return await queryAll<Node>(
    env.DB,
    "SELECT n.*, u.display_name AS uploader_name FROM nodes n " +
    "LEFT JOIN members u ON u.id=n.uploader_id " +
    "WHERE n.space_id=? AND n.kind='file' AND n.starred=1 AND n.deleted_at IS NULL " +
    "ORDER BY n.modified_at DESC", spaceId);
}

export async function byCategory(
  env: Env, spaceId: number,
): Promise<{ category: string; count: number; bytes: number }[]> {
  const rows = await queryAll<{ category: string; n: number; bytes: number }>(
    env.DB,
    "SELECT category, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM nodes " +
    "WHERE space_id=? AND kind='file' AND deleted_at IS NULL GROUP BY category", spaceId);
  const have = new Map(rows.map((r) => [r.category, r]));
  const out: { category: string; count: number; bytes: number }[] = [];
  for (const cat of CATEGORIES) {
    const d = have.get(cat);
    out.push({ category: cat, count: d?.n ?? 0, bytes: d?.bytes ?? 0 });
  }
  return out;
}

export async function byMember(
  env: Env, spaceId: number,
): Promise<Record<string, unknown>[]> {
  return await queryAll(
    env.DB,
    "SELECT m.id, m.display_name, m.color, " +
    "  COUNT(n.id) AS files, COALESCE(SUM(n.size),0) AS bytes " +
    "FROM members m LEFT JOIN nodes n ON n.owner_id=m.id AND n.deleted_at IS NULL " +
    "AND n.space_id=? GROUP BY m.id ORDER BY bytes DESC", spaceId);
}
