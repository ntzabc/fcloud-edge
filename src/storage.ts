/**
 * 内容寻址存储 —— R2 版。
 *
 * 跟 Python 版 blobstore 的对应关系：
 *   本地 blobs/ab/cd/<hash>  →  R2 key = <hash>（两字符前缀分桶也保留，便于控制台浏览）
 *   refcount 记账             →  一样在 D1 的 blobs 表
 *
 * ## 为什么用 R2 而不是 KV
 *   - KV 单值 25MB、总容量 1GB；R2 单对象 5GB、总 10GB，文件就该放对象存储
 *   - R2 出口流量免费 —— 家庭云盘下载是纯出口流量，这个很关键
 *   - R2 支持 Range 请求，正好对上「断点续传下载」和「视频拖进度条」
 *
 * ## 加密文件的关键限制
 *   R2 里存的永远是密文。每个块的 nonce 从文件密钥派生（见 crypto.ts），
 *   所以同一个明文块在不同文件里密文不同 —— 加密文件不能跨文件去重。
 *   这跟 Python 版的行为一致。
 */

import { ApiError, type Env } from "./types";
import { sha256hex } from "./crypto";

/** R2 key：两字符前缀分桶，key = <hash>。 */
export function blobKey(hash: string): string {
  return hash.length >= 2 ? `${hash.slice(0, 2)}/${hash}` : hash;
}

/** 上传会话的分片暂存区。 */
export function stagingKey(uploadId: string, seq: number): string {
  return `staging/${uploadId}/${seq}`;
}

export interface PutResult {
  hash: string;
  size: number;
  /** true = 这个块已经存在（去重命中），没重新写 R2。 */
  deduped: boolean;
  /** D1 里 blobs 表的自增 id。 */
  blobId: number;
}

/**
 * 存一个块：先算 SHA-256，再看 D1 里有没有同 hash 的块。
 * 有就直接复用（引用计数 +1），没有就写 R2 并登记。
 */
export async function putBytes(
  env: Env, data: Uint8Array, existingBlobId: number | null = null,
): Promise<PutResult> {
  const hash = await sha256hex(data);
  const size = data.byteLength;

  if (existingBlobId !== null) {
    await bumpRef(env.DB, existingBlobId, 1);
    return { hash, size, deduped: true, blobId: existingBlobId };
  }

  // 查 D1 有没有同 hash 的块
  const row = await env.DB.prepare("SELECT id FROM blobs WHERE hash=?").bind(hash).first<{ id: number }>();
  if (row) {
    await bumpRef(env.DB, row.id, 1);
    return { hash, size, deduped: true, blobId: row.id };
  }

  // 写 R2
  await env.BLOB.put(blobKey(hash), data as BufferSource, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  const res = await env.DB.prepare(
    "INSERT INTO blobs(hash, size, refcount, created_at) VALUES(?,?,?,?)")
    .bind(hash, size, 1, Date.now() / 1000).run();
  const id = Number(res.meta.last_row_id ?? 0);
  if (!id) throw new ApiError("内容块登记失败", 500);

  return { hash, size, deduped: false, blobId: id };
}

/**
 * 存一个块但**不动引用计数** —— 跟 Python 版 blobstore.put_bytes 对齐。
 *
 * 区别很重要：
 *   putBytes     新块 refcount=1，去重命中 refcount+1（自带持有）
 *   storeChunk   新块 refcount=0，去重命中不变（引用由调用方 retain）
 *
 * 上传流程用 storeChunk：先登记（refcount=0）→ 立刻 retain(+1)。
 * 这样「块已存在但还没被任何版本引用」这个窗口最短，
 * 后台 GC 不会把它当垃圾删掉（Python 版踩过这个坑）。
 */
export async function storeChunk(
  env: Env, data: Uint8Array,
): Promise<{ hash: string; size: number; blobId: number; deduped: boolean }> {
  const hash = await sha256hex(data);
  const size = data.byteLength;

  const row = await env.DB.prepare("SELECT id FROM blobs WHERE hash=?").bind(hash).first<{ id: number }>();
  if (row) {
    return { hash, size, blobId: row.id, deduped: true };
  }

  await env.BLOB.put(blobKey(hash), data as BufferSource, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  const res = await env.DB.prepare(
    "INSERT INTO blobs(hash, size, refcount, created_at) VALUES(?,?,0,?)")
    .bind(hash, size, Date.now() / 1000).run();
  const id = Number(res.meta.last_row_id ?? 0);
  if (!id) throw new ApiError("内容块登记失败", 500);
  return { hash, size, blobId: id, deduped: false };
}

export async function bumpRef(db: D1Database, blobId: number, delta: number): Promise<void> {
  await db.prepare("UPDATE blobs SET refcount = refcount + ? WHERE id=?")
    .bind(delta, blobId).run();
}

/** 读一个块。 */
export async function readBlob(
  env: Env, hash: string, offset = 0, length?: number,
): Promise<Uint8Array> {
  const obj = await env.BLOB.get(blobKey(hash), {
    range: length !== undefined
      ? { offset, length }
      : (offset > 0 ? { offset } : undefined),
  });
  if (!obj) throw new ApiError("数据块丢失", 500);
  return new Uint8Array(await obj.arrayBuffer());
}

/**
 * 读一个块的 Range，直接返回 R2 的流式响应。
 * 大文件下载走这条 —— 避免把整个文件读进内存（128MB 限制）。
 */
export async function streamBlob(
  env: Env, hash: string, offset = 0, length?: number,
): Promise<R2ObjectBody | null> {
  return await env.BLOB.get(blobKey(hash), {
    range: length !== undefined
      ? { offset, length }
      : (offset > 0 ? { offset } : undefined),
  });
}

/** 块是否存在。 */
export async function blobExists(env: Env, hash: string): Promise<boolean> {
  return await env.BLOB.head(blobKey(hash)) !== null;
}

/** 删块（R2 + D1 两边）。 */
export async function deleteBlob(env: Env, hash: string, blobId: number): Promise<void> {
  await env.BLOB.delete(blobKey(hash));
  await env.DB.prepare("DELETE FROM blobs WHERE id=?").bind(blobId).run();
}

/**
 * 垃圾回收：找出引用计数为 0 的块并删掉。
 * Python 版是扫本地目录，这里是查 D1 找 refcount=0 的记录。
 */
export async function gc(env: Env, limit = 500): Promise<{ purged: number; freed: number }> {
  const rows = await env.DB.prepare(
    "SELECT id, hash, size FROM blobs WHERE refcount <= 0 LIMIT ?").bind(limit).all<{
      id: number; hash: string; size: number;
    }>();
  const list = rows.results ?? [];
  let freed = 0;
  for (const b of list) {
    await env.BLOB.delete(blobKey(b.hash));
    await env.DB.prepare("DELETE FROM blobs WHERE id=?").bind(b.id).run();
    freed += b.size;
  }
  return { purged: list.length, freed };
}

/** 孤儿块数量（引用计数为 0）。 */
export async function orphanCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM blobs WHERE refcount <= 0")
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * 存储统计。
 *
 * 字段名必须跟 Python 版 blobstore.storage_stats() 一致 ——
 * 前端「设置」页直接吃这些 key。
 *
 *   logical_bytes  用户看到的文件大小之和（同一文件改 10 版也只算一份）
 *   physical_bytes 这些文件真正占的字节（去重后的不同块之和）
 *   差额 = 去重省下来的空间
 */
export async function storageStats(env: Env): Promise<{
  logical_bytes: number; physical_bytes: number; dedup_saved: number; dedup_ratio: number;
  trash_bytes: number; disk_bytes: number; files: number; folders: number; trash_files: number;
  versions: number; shared_blobs: number; blobs: number; orphan_candidates: number;
  encrypted_files: number;
}> {
  const live = await env.DB.prepare(
    "SELECT COALESCE(SUM(size),0) AS s FROM nodes WHERE kind='file' AND deleted_at IS NULL")
    .first<{ s: number }>();
  const trash = await env.DB.prepare(
    "SELECT COALESCE(SUM(size),0) AS s FROM nodes WHERE kind='file' AND deleted_at IS NOT NULL")
    .first<{ s: number }>();
  // 活跃文件当前版本引用到的、去重后的不同块
  const phys = await env.DB.prepare(
    "SELECT COALESCE(SUM(b.size),0) AS s FROM blobs b WHERE b.id IN (" +
    "  SELECT DISTINCT vc.blob_id FROM version_chunks vc" +
    "  JOIN versions v ON v.id = vc.version_id" +
    "  JOIN nodes n ON n.current_version_id = v.id" +
    "  WHERE n.deleted_at IS NULL)").first<{ s: number }>();
  const all = await env.DB.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM blobs").first<{ c: number; s: number }>();
  const versions = await env.DB.prepare("SELECT COUNT(*) AS c FROM versions").first<{ c: number }>();
  const shared = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM (SELECT blob_id FROM version_chunks GROUP BY blob_id HAVING COUNT(*) > 1)")
    .first<{ c: number }>();
  const zeroRef = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM blobs WHERE refcount<=0").first<{ c: number }>();
  const files = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE kind='file' AND deleted_at IS NULL").first<{ c: number }>();
  const folders = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE kind='folder' AND deleted_at IS NULL").first<{ c: number }>();
  const trashFiles = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE deleted_at IS NOT NULL").first<{ c: number }>();
  const encrypted = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE kind='file' AND deleted_at IS NULL AND encrypted=1")
    .first<{ c: number }>();

  const logical = live?.s ?? 0;
  const physical = phys?.s ?? 0;
  return {
    logical_bytes: logical,
    physical_bytes: physical,
    dedup_saved: Math.max(0, logical - physical),
    dedup_ratio: physical ? Math.round(logical / physical * 100) / 100 : 1,
    trash_bytes: trash?.s ?? 0,
    disk_bytes: all?.s ?? 0,
    files: files?.c ?? 0,
    folders: folders?.c ?? 0,
    trash_files: trashFiles?.c ?? 0,
    versions: versions?.c ?? 0,
    shared_blobs: shared?.c ?? 0,
    blobs: all?.c ?? 0,
    orphan_candidates: zeroRef?.c ?? 0,
    encrypted_files: encrypted?.c ?? 0,
  };
}

// ---------------------------------------------------------------- 上传暂存

/** 暂存一个上传分片（还没 finish，不进 blobs 表）。 */
export async function putStaging(
  env: Env, uploadId: string, seq: number, data: Uint8Array,
): Promise<void> {
  await env.BLOB.put(stagingKey(uploadId, seq), data as BufferSource);
}

/** 读暂存分片。 */
export async function getStaging(
  env: Env, uploadId: string, seq: number,
): Promise<Uint8Array | null> {
  const obj = await env.BLOB.get(stagingKey(uploadId, seq));
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

/** 列出一个上传会话的所有暂存分片。 */
export async function listStaging(
  env: Env, uploadId: string,
): Promise<{ seq: number; size: number }[]> {
  const out: { seq: number; size: number }[] = [];
  let cursor: R2ListOptions["cursor"] | undefined = undefined;
  do {
    const page = await env.BLOB.list({ prefix: `staging/${uploadId}/`, cursor, limit: 1000 });
    for (const o of page.objects) {
      const m = o.key.match(/\/(\d+)$/);
      if (m) out.push({ seq: Number(m[1]), size: o.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.seq - b.seq);
}

/** 清掉一个上传会话的所有暂存分片。 */
export async function clearStaging(env: Env, uploadId: string): Promise<void> {
  let cursor: R2ListOptions["cursor"] | undefined = undefined;
  do {
    const page = await env.BLOB.list({ prefix: `staging/${uploadId}/`, cursor, limit: 1000 });
    if (page.objects.length) {
      await env.BLOB.delete(page.objects.map((o) => o.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
