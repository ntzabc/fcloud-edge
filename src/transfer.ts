/**
 * 分片上传与断点续传 —— Edge 版。
 *
 * ## 为什么要分片
 * 家里传个 20 GB 的 4K 视频，如果中途网断了就得从头再来 ——
 * 分片之后只重传断掉的那几片，大文件上传从「看运气」变成「一定会成」。
 *
 * ## 跟 Python 版的对应
 *   Python 用本地临时目录存分片 → Edge 直接把分片写进 R2（内容寻址）
 *   Python 的 temp_dir 列 → Edge 保留但恒为空串（表结构不变，迁移不用改列）
 *
 * ## 引用计数的关键细节（Python 版踩过的坑）
 * 分片在 finish 之前还没被任何版本引用，如果不提前占住引用计数，
 * 后台垃圾回收会把正在上传的块当垃圾删掉 —— 用户就传了个寂寞。
 * 所以 put_part 里就 retain，finish 时 attach 再 retain、然后把上传持有的那份释放掉。
 */

import {
  b64d, b64e, chunkSalt, encryptChunk, hex, randomBytes,
} from "./crypto";
import { execute, insert, queryAll, queryOne } from "./db";
import { release, retain } from "./blobstore";
import { storeChunk } from "./storage";
import { createFile, guessCategory, guessMime, requireNode, sanitizeName } from "./files";
import { checkQuota } from "./members";
import { ApiError, type Env, type MasterLike, type Member, type Upload } from "./types";

export const DEFAULT_CHUNK = 4 * 1024 * 1024;
/** 小于这个大小就不分片了，整块存，避免几百个小文件产生一堆元数据行。 */
export const CHUNK_TARGET = 1024 * 1024;
export const MAX_OPEN_SESSIONS_PER_USER = 20;

/** GCM 标签长度。 */
const TAG_LEN = 16;

function chunkCount(totalSize: number, chunkSize: number): number {
  if (totalSize <= 0) return 1;
  return Math.ceil(totalSize / chunkSize);
}

function firstMissing(got: Set<number>, total: number): number | null {
  for (let i = 0; i < total; i++) if (!got.has(i)) return i;
  return null;
}

// ---------------------------------------------------------------- 建会话

export interface CreateUploadOpts {
  parentId?: number;
  name: string;
  totalSize: number;
  mime?: string;
  encrypted?: boolean;
  category?: string;
  note?: string;
  chunkSize?: number | null;
  replaceNodeId?: number | null;
  spaceId?: number;
}

export async function createUpload(
  env: Env, master: MasterLike, member: Member, opts: CreateUploadOpts,
): Promise<Record<string, unknown>> {
  if (!member.can.includes("upload")) {
    throw new ApiError(`「${member.role_label}」没有这个操作的权限`, 403);
  }
  if (opts.encrypted && !member.can.includes("use_encryption")) {
    throw new ApiError(`「${member.role_label}」没有这个操作的权限`, 403);
  }
  const spaceId = opts.spaceId ?? 1;
  const name = sanitizeName(opts.name);
  if (!name) throw new ApiError("文件名不能为空");

  if (opts.replaceNodeId) {
    const node = await requireNode(env, opts.replaceNodeId);
    if (!(node.owner_id === member.id || member.can.includes("delete_any"))) {
      throw new ApiError("只能替换自己创建的文件", 403);
    }
  } else if (opts.parentId) {
    const parent = await requireNode(env, opts.parentId);
    if (parent.kind !== "folder") throw new ApiError("上传目标不是文件夹");
  }

  const totalSize = opts.totalSize ?? 0;
  if (totalSize < 0) throw new ApiError("文件大小不对");
  if (!(await checkQuota(env.DB, spaceId, totalSize))) {
    throw new ApiError("空间不够了，先删掉一些东西或者调整配额");
  }

  // 小文件不必分片
  const chunkSize = Math.max(1, Math.trunc(
    opts.chunkSize ?? (totalSize > CHUNK_TARGET ? DEFAULT_CHUNK : Math.max(1, totalSize))));
  const totalChunks = chunkCount(totalSize, chunkSize);

  // 别让一个人的废弃会话堆积如山
  const openRow = await queryOne<{ c: number }>(
    env.DB, "SELECT COUNT(*) AS c FROM uploads WHERE member_id=? AND state='open'", member.id);
  if ((openRow?.c ?? 0) >= MAX_OPEN_SESSIONS_PER_USER) {
    await execute(env.DB,
      "DELETE FROM uploads WHERE member_id=? AND state='open' AND created_at < ?",
      member.id, Date.now() / 1000 - 3600);
    const again = await queryOne<{ c: number }>(
      env.DB, "SELECT COUNT(*) AS c FROM uploads WHERE member_id=? AND state='open'", member.id);
    if ((again?.c ?? 0) >= MAX_OPEN_SESSIONS_PER_USER) {
      throw new ApiError("你有太多没传完的文件了，先取消掉几个再传");
    }
  }

  const uid = hex(randomBytes(16));
  const now = Date.now() / 1000;

  let wrappedKey: string | null = null;
  let saltSeed: string | null = null;
  if (opts.encrypted) {
    const mk = await master.mustKey();
    if (!mk) throw new ApiError("主密钥还没解锁，先到设置里输入主口令");
    const fileKey = randomBytes(32);
    const seed = randomBytes(16);
    wrappedKey = b64e(await master.wrap(fileKey));
    saltSeed = b64e(seed);
  }

  await insert(env.DB,
    "INSERT INTO uploads(id,space_id,member_id,node_id,parent_id,name,total_size," +
    "chunk_size,total_chunks,mime,encrypted,category,note,temp_dir,state," +
    "wrapped_key,salt_seed,created_at,updated_at) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)",
    uid, spaceId, member.id, opts.replaceNodeId ?? null, opts.parentId ?? 0, name,
    totalSize, chunkSize, totalChunks,
    opts.mime || guessMime(name), opts.encrypted ? 1 : 0,
    opts.category || guessCategory(name), opts.note ?? "", "",
    wrappedKey, saltSeed, now, now);

  return await status(env, uid, member);
}

// ---------------------------------------------------------------- 状态

export async function status(
  env: Env, uploadId: string, member?: Member | null,
): Promise<Record<string, unknown>> {
  const u = await queryOne<Upload>(env.DB, "SELECT * FROM uploads WHERE id=?", uploadId);
  if (!u) throw new ApiError("上传会话不存在或已过期", 404);
  if (member && u.member_id !== member.id && member.role !== "admin") {
    throw new ApiError("这不是你的上传会话", 403);
  }
  const rows = await queryAll<{ seq: number; size: number }>(
    env.DB, "SELECT seq, size FROM upload_parts WHERE upload_id=? ORDER BY seq", uploadId);
  const gotSet = new Set(rows.map((r) => r.seq));
  const receivedBytes = rows.reduce((a, r) => a + r.size, 0);
  const missing: number[] = [];
  for (let i = 0; i < u.total_chunks; i++) if (!gotSet.has(i)) missing.push(i);

  return {
    upload_id: uploadId,
    name: u.name,
    state: u.state,
    total_size: u.total_size,
    chunk_size: u.chunk_size,
    total_chunks: u.total_chunks,
    received: [...gotSet].sort((a, b) => a - b),
    missing,
    received_bytes: receivedBytes,
    encrypted: !!u.encrypted,
    replace_node_id: u.node_id,
    next_index: firstMissing(gotSet, u.total_chunks),
    percent: u.total_size ? Math.round(receivedBytes / u.total_size * 1000) / 10 : 0,
  };
}

// ---------------------------------------------------------------- 收块

/** 收一块。重复传同一块直接返回成功（幂等），不会重复占空间。 */
export async function putPart(
  env: Env, master: MasterLike, uploadId: string, seq: number,
  data: Uint8Array, member: Member,
): Promise<Record<string, unknown>> {
  const u = await queryOne<Upload>(env.DB, "SELECT * FROM uploads WHERE id=?", uploadId);
  if (!u) throw new ApiError("上传会话不存在", 404);
  if (u.member_id !== member.id && member.role !== "admin") {
    throw new ApiError("这不是你的上传会话", 403);
  }
  if (u.state !== "open") throw new ApiError("这个上传会话已经结束了");

  seq = Math.trunc(seq);
  const totalChunks = u.total_chunks;
  if (seq < 0 || seq >= totalChunks) {
    throw new ApiError(`分片序号 ${seq} 超出范围（总共 ${totalChunks} 块）`);
  }
  const chunkSize = u.chunk_size;
  // 最后一块可能短，其余必须是满的
  const isLast = seq === totalChunks - 1;
  const expected = isLast ? u.total_size - seq * chunkSize : chunkSize;
  if (expected < 0) throw new ApiError("分片序号超出文件范围");
  if (data.length !== expected) {
    throw new ApiError(`第 ${seq} 块大小不对：应为 ${expected} 字节，收到 ${data.length} 字节`);
  }

  const dup = await queryOne(
    env.DB, "SELECT seq FROM upload_parts WHERE upload_id=? AND seq=?", uploadId, seq);
  if (dup) {
    const st = await status(env, uploadId, member);
    st.duplicate = true;
    return st;
  }

  const encrypted = !!u.encrypted;
  let stored: Uint8Array;
  if (encrypted) {
    const fileKey = await master.unwrap(b64d(u.wrapped_key!));
    const salt = await chunkSalt(fileKey, b64d(u.salt_seed!), seq);
    const { ct, tag } = await encryptChunk(data, fileKey, salt);
    stored = new Uint8Array(ct.length + tag.length);
    stored.set(ct, 0);
    stored.set(tag, ct.length);
  } else {
    stored = data;
  }

  const chunk = await storeChunk(env, stored);
  // 先占住引用，防垃圾回收把正在上传的块删掉
  await retain(env, [chunk.blobId]);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO upload_parts(upload_id,seq,hash,size,encrypted) VALUES(?,?,?,?,?)")
      .bind(uploadId, seq, chunk.hash, chunk.size, encrypted ? 1 : 0),
    env.DB.prepare("UPDATE uploads SET updated_at=? WHERE id=?")
      .bind(Date.now() / 1000, uploadId),
  ]);

  return await status(env, uploadId, member);
}

// ---------------------------------------------------------------- 完成

/** 所有块都到齐了，落成一个真正的文件节点。 */
export async function finish(
  env: Env, master: MasterLike, uploadId: string, member: Member,
): Promise<Record<string, unknown>> {
  const u = await queryOne<Upload>(env.DB, "SELECT * FROM uploads WHERE id=?", uploadId);
  if (!u) throw new ApiError("上传会话不存在", 404);
  if (u.member_id !== member.id && member.role !== "admin") {
    throw new ApiError("这不是你的上传会话", 403);
  }
  if (u.state === "done") throw new ApiError("这个上传已经完成了");

  const st = await status(env, uploadId, member);
  const missing = st.missing as number[];
  if (missing.length) {
    throw new ApiError(`还差 ${missing.length} 块没传完（第 ${missing[0]} 块起）`);
  }

  const rows = await queryAll<{ seq: number; hash: string; size: number }>(
    env.DB, "SELECT seq, hash, size FROM upload_parts WHERE upload_id=? ORDER BY seq", uploadId);

  const chunks: { seq: number; blobId: number; plainSize: number }[] = [];
  for (const r of rows) {
    const row = await queryOne<{ id: number }>(
      env.DB, "SELECT id FROM blobs WHERE hash=?", r.hash);
    if (!row) throw new ApiError(`第 ${r.seq} 块的数据丢了，请重新传这一块`);
    // 明文大小 = 存的大小 - 标签长度（加密时）
    chunks.push({
      seq: r.seq,
      blobId: row.id,
      plainSize: r.size - (u.encrypted ? TAG_LEN : 0),
    });
  }

  let fileKey: Uint8Array | undefined;
  let saltSeed: Uint8Array | undefined;
  if (u.encrypted) {
    fileKey = await master.unwrap(b64d(u.wrapped_key!));
    saltSeed = b64d(u.salt_seed!);
  }

  const blobIds = chunks.map((c) => c.blobId);
  let node;
  try {
    node = await createFile(env, master, chunks, {
      spaceId: u.space_id,
      parentId: u.parent_id,
      name: u.name,
      size: u.total_size,
      mime: u.mime,
      member,
      encrypted: !!u.encrypted,
      fileKey,
      saltSeed,
      category: u.category,
      note: u.note,
      replaceNodeId: u.node_id,
    });
  } catch (e) {
    // 落库失败就把持有的引用还回去，别泄漏
    await release(env, blobIds);
    await execute(env.DB, "UPDATE uploads SET state='aborted' WHERE id=?", uploadId);
    throw e;
  }

  // 引用已经转移给版本了，把上传持有的那一份还回去
  await release(env, blobIds);
  await execute(env.DB, "UPDATE uploads SET state='done', updated_at=? WHERE id=?",
    Date.now() / 1000, uploadId);

  return { ok: true, node, status: st };
}

// ---------------------------------------------------------------- 取消

/** 取消上传。已经存下来的块释放掉，等垃圾回收清理。 */
export async function abort(
  env: Env, uploadId: string, member: Member,
): Promise<Record<string, unknown>> {
  const u = await queryOne<Upload>(env.DB, "SELECT * FROM uploads WHERE id=?", uploadId);
  if (!u) throw new ApiError("上传会话不存在", 404);
  if (u.member_id !== member.id && member.role !== "admin") {
    throw new ApiError("这不是你的上传会话", 403);
  }
  const rows = await queryAll<{ hash: string }>(
    env.DB, "SELECT hash FROM upload_parts WHERE upload_id=?", uploadId);
  const blobIds: number[] = [];
  for (const r of rows) {
    const row = await queryOne<{ id: number }>(
      env.DB, "SELECT id FROM blobs WHERE hash=?", r.hash);
    if (row) blobIds.push(row.id);
  }
  await release(env, blobIds);
  await execute(env.DB, "UPDATE uploads SET state='aborted', updated_at=? WHERE id=?",
    Date.now() / 1000, uploadId);
  return { aborted: true };
}

// ---------------------------------------------------------------- 我的上传

export async function myUploads(env: Env, member: Member): Promise<Record<string, unknown>[]> {
  const rows = await queryAll<{
    id: string; name: string; total_size: number; chunk_size: number;
    total_chunks: number; updated_at: number;
  }>(
    env.DB,
    "SELECT * FROM uploads WHERE member_id=? AND state='open' ORDER BY updated_at DESC",
    member.id);
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const c = await queryOne<{ c: number }>(
      env.DB, "SELECT COUNT(*) AS c FROM upload_parts WHERE upload_id=?", r.id);
    out.push({
      upload_id: r.id,
      name: r.name,
      total_size: r.total_size,
      chunk_size: r.chunk_size,
      total_chunks: r.total_chunks,
      got: c?.c ?? 0,
      updated_at: r.updated_at,
    });
  }
  return out;
}

/**
 * 后台任务：把放太久没动静的上传会话收掉。
 * Edge 版没有临时目录要清，但引用计数还是要还回去。
 */
export async function cleanupStale(env: Env, maxAgeHours = 48): Promise<number> {
  const cutoff = Date.now() / 1000 - maxAgeHours * 3600;
  const rows = await queryAll<{ id: string }>(
    env.DB, "SELECT id FROM uploads WHERE state='open' AND updated_at < ?", cutoff);
  let n = 0;
  for (const r of rows) {
    const parts = await queryAll<{ hash: string }>(
      env.DB, "SELECT hash FROM upload_parts WHERE upload_id=?", r.id);
    const blobIds: number[] = [];
    for (const p of parts) {
      const row = await queryOne<{ id: number }>(
        env.DB, "SELECT id FROM blobs WHERE hash=?", p.hash);
      if (row) blobIds.push(row.id);
    }
    await release(env, blobIds);
    await execute(env.DB, "UPDATE uploads SET state='aborted' WHERE id=?", r.id);
    n++;
  }
  return n;
}
