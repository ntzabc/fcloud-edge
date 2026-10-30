/**
 * 核心链路 PoC —— 验证方案 B 的三个关键假设。
 *
 * 假设 1：**10ms CPU 限制下，WebCrypto 密码学够用吗？**
 *   这是最大的未知。scrypt 肯定不行，PBKDF2 是原生调用理论上不计时。
 *   但"理论上"不算数 —— 必须实测。
 *
 * 假设 2：**R2 + D1 的往返链路通吗？**
 *   put → D1 记账 → get → 校验内容一致。
 *
 * 假设 3：**加密后的数据能正确解密回来吗？**
 *
 * PoC 走 /api/poc 端点，返回每一步的耗时和结果。
 * 本地 wrangler dev 跑（miniflare 模拟 D1/R2），CPU 计时不准，
 * 但**功能**能验证；CPU 耗时的真实数字要部署到线上才能测。
 */

import { json } from "./index";
import {
  chunkSalt, decryptChunk, derive, encryptChunk, hmacSha256,
  MasterKey, randomBytes, sha256hex,
} from "./crypto";
import { putBytes, readBlob } from "./storage";
import { execute, queryOne } from "./db";
import type { Env } from "./types";

export async function poc(_req: Request, env: Env): Promise<Response> {
  const steps: Record<string, unknown>[] = [];
  const t0 = Date.now();

  // ---- 1. SHA-256 摘要 ----
  {
    const a = performance.now();
    const data = new TextEncoder().encode("Fcloud PoC 测试数据 2026");
    const h = await sha256hex(data);
    steps.push({
      step: "sha256",
      ok: h.length === 64,
      ms: +(performance.now() - a).toFixed(2),
      sample: h.slice(0, 16),
    });
  }

  // ---- 2. PBKDF2 派生（假设 1 的核心）----
  {
    const a = performance.now();
    const salt = randomBytes(16);
    const key = await derive("correct horse battery staple", salt);
    steps.push({
      step: "pbkdf2_210k",
      ok: key.length === 32,
      ms: +(performance.now() - a).toFixed(2),
      note: "原生 WebCrypto，不计入 JS 的 10ms CPU 配额（需线上实测确认）",
    });
  }

  // ---- 3. HMAC-SHA256 ----
  {
    const a = performance.now();
    const k = randomBytes(32);
    const m = new TextEncoder().encode("hello");
    const sig = await hmacSha256(k, m);
    steps.push({
      step: "hmac_sha256", ok: sig.length === 32, ms: +(performance.now() - a).toFixed(2),
    });
  }

  // ---- 4. AES-GCM 加密 → 解密往返 ----
  {
    const a = performance.now();
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const plain = new TextEncoder().encode("这是一段用来测试加密的中文内容，重复内容重复内容重复内容");
    const { ct, tag } = await encryptChunk(plain, key, salt);
    const back = await decryptChunk(ct, tag, key, salt);
    const same = back.length === plain.length && back.every((b, i) => b === plain[i]);
    steps.push({
      step: "aes_gcm_roundtrip",
      ok: same,
      ms: +(performance.now() - a).toFixed(2),
      ctLen: ct.length,
    });
  }

  // ---- 5. chunkSalt 派生（每块独立盐）----
  {
    const a = performance.now();
    const fk = randomBytes(32);
    const seed = randomBytes(16);
    const s0 = await chunkSalt(fk, seed, 0);
    const s1 = await chunkSalt(fk, seed, 1);
    // ⚠️ 断言要写成「整体不相等」，不能写成「每个字节都不同」。
    // 两个 16 字节随机盐，有 1/256 概率某一个字节恰好相同 ——
    // 那样逐字节比较会误报失败。这个坑我踩过一次。
    const differ = s0.length === 16 && s1.length === 16
      && !s0.every((b, i) => b === s1[i]);
    steps.push({
      step: "chunk_salt",
      ok: differ,
      ms: +(performance.now() - a).toFixed(2),
    });
  }

  // ---- 6. R2 + D1 往返（假设 2）----
  // ⚠️ 这步会往 R2 写一个测试块并记进 blobs 表 —— 会污染存储统计。
  // 所以用「占位哈希 + 事后删记录」的方式：先在 R2 存/取，
  // 然后把 blobs 表里那一行删掉（块本身留在 R2 但没引用，GC 会回收）。
  let blobOk = false;
  let blobDetail = "";
  try {
    const a = performance.now();
    const payload = new TextEncoder().encode("R2 存储往返测试 " + Date.now());
    const put = await putBytes(env, payload);
    const got = await readBlob(env, put.hash);
    blobOk = got.length === payload.length && got.every((b, i) => b === payload[i]);
    blobDetail = `hash=${put.hash.slice(0, 12)} deduped=${put.deduped}`;
    // 清掉记账行，别让这个测试块算进用户配额
    await env.DB.prepare("DELETE FROM blobs WHERE hash=?").bind(put.hash).run();
    steps.push({
      step: "r2_d1_roundtrip", ok: blobOk, ms: +(performance.now() - a).toFixed(2),
      detail: blobDetail,
    });
  } catch (e) {
    steps.push({
      step: "r2_d1_roundtrip", ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ---- 7. D1 写入读取 ----
  try {
    const a = performance.now();
    // 用一个一次性的键，写完立刻删 —— 不留残留
    await execute(env.DB,
      "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      "poc_last", "ok", Date.now() / 1000);
    const row = await queryOne<{ value: string }>(
      env.DB, "SELECT value FROM settings WHERE key=?", "poc_last");
    const ok = row?.value === "ok";
    await env.DB.prepare("DELETE FROM settings WHERE key='poc_last'").run();
    steps.push({
      step: "d1_write_read", ok, ms: +(performance.now() - a).toFixed(2),
    });
  } catch (e) {
    steps.push({
      step: "d1_write_read", ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ---- 8. 加密文件全链路：加密 → 上传 → 读回 → 解密 ----
  try {
    const a = performance.now();
    const mk = new MasterKey(env);
    const fileKey = mk.newFileKey();
    const saltSeed = randomBytes(16);
    const plain = new TextEncoder().encode("端到端加密测试：妈妈的照片 2026");
    const salt = await chunkSalt(fileKey, saltSeed, 0);
    const { ct, tag } = await encryptChunk(plain, fileKey, salt);

    // 密文进 R2
    const put = await putBytes(env, ct);
    // 读回
    const gotCt = await readBlob(env, put.hash);
    // 解密
    const back = await decryptChunk(gotCt, tag, fileKey, salt);
    const same = back.length === plain.length && back.every((b, i) => b === plain[i]);
    // 清掉记账行，别让测试块算进配额
    await env.DB.prepare("DELETE FROM blobs WHERE hash=?").bind(put.hash).run();

    steps.push({
      step: "e2e_encrypt_upload_decrypt",
      ok: same,
      ms: +(performance.now() - a).toFixed(2),
      note: "密文存 R2，只有文件密钥能解开",
    });
  } catch (e) {
    steps.push({
      step: "e2e_encrypt_upload_decrypt", ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ---- 9. 密钥包裹往返（主密钥 wrap/unwrap）----
  try {
    const a = performance.now();
    // ⚠️ 必须用 ephemeral（临时）模式！
    // 真实主密钥一旦被 setPassphrase 覆盖，全家加密文件就再也解不开了。
    // 而且 /api/poc 之前是公开端点 —— 等于任何人都能来改主口令。
    const mk = new MasterKey(env, { ephemeral: true });
    await mk.setPassphrase("poc-test-passphrase");
    const fk = mk.newFileKey();
    const wrapped = await mk.wrap(fk);
    const back = await mk.unwrap(wrapped);
    const same = back.length === fk.length && back.every((b, i) => b === fk[i]);
    steps.push({
      step: "key_wrap_roundtrip", ok: same, ms: +(performance.now() - a).toFixed(2),
      wrappedLen: wrapped.length,
    });
  } catch (e) {
    steps.push({
      step: "key_wrap_roundtrip", ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const allOk = steps.every((s) => (s as { ok: boolean }).ok);
  return json({
    ok: allOk,
    totalMs: Date.now() - t0,
    steps,
    verdict: allOk
      ? "核心链路全通。PBKDF2/AES-GCM/R2/D1 都正常。"
      : "有步骤失败，看上面哪个 ok=false。",
  });
}
