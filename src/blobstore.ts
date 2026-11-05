/**
 * 版本与内容块的关系 —— Edge 版 blobstore。
 *
 * Python 版的 blobstore.py 有两件事：
 *   1. CAS 存取（已在 storage.ts 里移植完）
 *   2. **版本 ↔ 块** 的绑定与引用计数（这里是）
 *
 * ## 引用计数为什么必须算准
 *
 * 一个块被谁引用：
 *   - upload_parts  —— 上传中的分片（还没进版本）
 *   - version_chunks —— 已落库的版本
 *
 * Python 版踩过的坑（这里原样保留）：
 *   「分片在 finish 之前还没被任何版本引用，如果不提前占住引用计数，
 *     后台垃圾回收会把正在上传的块当垃圾删掉 —— 用户就传了个寂寞。」
 *
 * 所以流程是：put_part 时 retain(+1) → finish 时 attach 再 retain(+1)
 * → 立刻 release(-1) 把上传持有的那份还回去。净结果：版本持有 1 份。
 */

import { ApiError, type Env, type MasterLike } from "./types";
import { chunkSalt, decryptChunk, b64d, equalBytes } from "./crypto";
import { queryAll, queryOne, execute } from "./db";
import { needBlob } from "./storage";

/** GCM 标签长度。Python 版 crypto_box.TAG_LEN = 16。 */
const TAG_LEN = 16;

export interface ChunkRow {
  version_id: number;
  seq: number;
  blob_id: number;
  offset: number;
  size: number;
}

// ---------------------------------------------------------------- 引用计数

/** 引用计数 +1。 */
export async function retain(env: Env, blobIds: number[]): Promise<void> {
  if (!blobIds.length) return;
  // D1 一次绑定上限 100 个参数，所以分批
  for (let i = 0; i < blobIds.length; i += 90) {
    const part = blobIds.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE blobs SET refcount = refcount + 1 WHERE id IN (${ph})`)
      .bind(...part).run();
  }
}

/** 引用计数 -1（不会低于 0）。 */
export async function release(env: Env, blobIds: number[]): Promise<void> {
  if (!blobIds.length) return;
  for (let i = 0; i < blobIds.length; i += 90) {
    const part = blobIds.slice(i, i + 90);
    const ph = part.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE blobs SET refcount = MAX(0, refcount - 1) WHERE id IN (${ph})`)
      .bind(...part).run();
  }
}

// ---------------------------------------------------------------- 版本 ↔ 块

/**
 * 把块列表挂到版本上并加引用计数。
 *
 * offset 必须按实际明文大小累加 —— 小文件走「整块」路径时块大小
 * 不等于 CHUNK_SIZE，硬算会读出错位的文件（Python 版同样的教训）。
 */
export async function attachVersion(
  env: Env, versionId: number,
  chunks: { seq: number; blobId: number; plainSize: number }[],
): Promise<void> {
  if (!chunks.length) return;
  let offset = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const c of chunks) {
    stmts.push(env.DB.prepare(
      "INSERT INTO version_chunks(version_id,seq,blob_id,offset,size) VALUES(?,?,?,?,?)")
      .bind(versionId, c.seq, c.blobId, offset, c.plainSize));
    offset += c.plainSize;
  }
  // D1 一次 invocation 最多 1000 条语句；再多的分批
  for (let i = 0; i < stmts.length; i += 500) {
    await env.DB.batch(stmts.slice(i, i + 500));
  }
  await retain(env, chunks.map((c) => c.blobId));
}

/** 摘掉一个版本的全部块并减引用计数。 */
export async function detachVersion(env: Env, versionId: number): Promise<number> {
  const rows = await queryAll<{ blob_id: number }>(
    env.DB, "SELECT blob_id FROM version_chunks WHERE version_id=?", versionId);
  const ids = rows.map((r) => r.blob_id);
  await execute(env.DB, "DELETE FROM version_chunks WHERE version_id=?", versionId);
  await release(env, ids);
  return ids.length;
}

/** 标记当前版本，并把同节点的其它版本降级。 */
export async function markCurrent(
  env: Env, versionId: number, size: number, chunkCount: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE versions SET size=?, chunk_count=?, is_current=1 WHERE id=?")
      .bind(size, chunkCount, versionId),
    env.DB.prepare(
      "UPDATE versions SET is_current=0 WHERE node_id=(SELECT node_id FROM versions WHERE id=?) " +
      "AND id<>?").bind(versionId, versionId),
  ]);
}

// ---------------------------------------------------------------- 读明文

interface CryptoMeta {
  fileKey: Uint8Array;
  saltSeed: Uint8Array;
  algo: string;
}

/** 取版本的加密元数据（文件密钥 + 盐种子）。没加密返回 null。 */
export async function cryptoFor(
  env: Env, master: MasterLike,
  versionId: number,
): Promise<CryptoMeta | null> {
  const row = await queryOne<{ wrapped_key: string; salt_seed: string; algo: string }>(
    env.DB, "SELECT wrapped_key, salt_seed, algo FROM version_crypto WHERE version_id=?", versionId);
  if (!row) return null;
  const fileKey = await master.unwrap(b64d(row.wrapped_key));
  return { fileKey, saltSeed: b64d(row.salt_seed), algo: row.algo };
}

/** 读一个块的原始字节（可能是密文）。 */
export async function readRaw(env: Env, blobId: number): Promise<Uint8Array> {
  const blob = needBlob(env);
  const row = await queryOne<{ hash: string }>(
    env.DB, "SELECT hash FROM blobs WHERE id=?", blobId);
  if (!row) throw new ApiError(`内容块 ${blobId} 不存在`, 500);
  const obj = await blob.get(hashKey(row.hash));
  if (!obj) throw new ApiError(`内容块 ${blobId} 的数据缺失`, 500);
  return new Uint8Array(await obj.arrayBuffer());
}

/** R2 key（跟 storage.ts 的 blobKey 保持一致）。 */
function hashKey(hash: string): string {
  return hash.length >= 2 ? `${hash.slice(0, 2)}/${hash}` : hash;
}

/**
 * 产出某个版本的**明文**字节流。
 *
 * 加密版本在这里逐块解密 —— 任何时刻内存里只有一块。
 * Worker 内存上限 128MB，所以大文件绝不能整块读进内存。
 */
export async function plainStream(
  env: Env, master: MasterLike,
  versionId: number,
  start = 0, end?: number,
): Promise<ReadableStream<Uint8Array>> {
  const rows = await queryAll<ChunkRow>(
    env.DB,
    "SELECT version_id, seq, blob_id, offset, size FROM version_chunks " +
    "WHERE version_id=? ORDER BY seq", versionId);
  if (!rows.length) {
    return new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
  }
  const total = rows[rows.length - 1].offset + rows[rows.length - 1].size;
  const stop = end === undefined ? total : Math.min(end, total);
  const cred = await cryptoFor(env, master, versionId);

  // 命中区间之外的块直接跳过
  const wanted = rows.filter((r) => r.offset + r.size > start && r.offset < stop);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!wanted.length) { controller.close(); return; }
      const r = wanted.shift()!;
      const raw = await readRaw(env, r.blob_id);
      let plain: Uint8Array;
      if (cred) {
        const salt = await chunkSalt(cred.fileKey, cred.saltSeed, r.seq);
        const ct = raw.slice(0, raw.length - TAG_LEN);
        const tag = raw.slice(raw.length - TAG_LEN);
        plain = await decryptChunk(ct, tag, cred.fileKey, salt);
      } else {
        plain = raw.slice(0, r.size);
      }
      const cstart = r.offset;
      const lo = Math.max(0, start - cstart);
      const hi = Math.min(plain.length, stop - cstart);
      if (hi > lo) controller.enqueue(plain.slice(lo, hi));
      else controller.enqueue(new Uint8Array(0));
      if (!wanted.length) controller.close();
    },
  });
}

/** 版本总字节数。 */
export async function versionSize(env: Env, versionId: number): Promise<number> {
  const row = await queryOne<{ s: number }>(
    env.DB,
    "SELECT COALESCE(MAX(offset+size),0) AS s FROM version_chunks WHERE version_id=?",
    versionId);
  return row?.s ?? 0;
}

/**
 * 重新核对一个版本：块还在不在、总大小对不对。
 * 用来发现存储损坏。
 */
export async function verifyVersion(
  env: Env, versionId: number,
): Promise<{ chunks: number; size: number; missing: number[]; ok: boolean }> {
  const blob = needBlob(env);
  const rows = await queryAll<{ seq: number; blob_id: number; size: number }>(
    env.DB, "SELECT seq, blob_id, size FROM version_chunks WHERE version_id=? ORDER BY seq",
    versionId);
  let size = 0;
  const missing: number[] = [];
  for (const r of rows) {
    size += r.size;
    const row = await queryOne<{ hash: string }>(
      env.DB, "SELECT hash FROM blobs WHERE id=?", r.blob_id);
    if (!row) { missing.push(r.blob_id); continue; }
    const obj = await blob.head(hashKey(row.hash));
    if (!obj) missing.push(r.blob_id);
  }
  return { chunks: rows.length, size, missing, ok: missing.length === 0 };
}

/** 校验两段字节是否相同（给测试用）。 */
export { equalBytes };
