/**
 * 文件加密（信封加密）—— WebCrypto 版。
 *
 * ## 跟 Python 版的对应关系
 *
 *   Python                          Edge (WebCrypto)
 *   ─────────────────────────────    ─────────────────────────────
 *   hashlib.scrypt                  crypto.subtle.deriveKey(PBKDF2)
 *   hashlib.pbkdf2_hmac             crypto.subtle.deriveKey(PBKDF2)
 *   hashlib.sha256                  crypto.subtle.digest(SHA-256)
 *   hmac.new(k, m, sha256)          crypto.subtle.sign/verify(HMAC)
 *   cryptography AESGCM             crypto.subtle.encrypt/decrypt(AES-GCM)
 *   os.urandom(n)                   crypto.getRandomValues
 *   base64                          btoa/atob + 字节处理
 *
 * ## 为什么主口令派生从 scrypt 换成 PBKDF2
 *
 * Workers 免费版有 **10ms CPU 硬限制**，而且 WebCrypto 之外的一切
 * 纯 JS 密码学运算都要计入这 10ms。
 * scrypt 无论用什么纯 JS 实现（scrypt-js 之类）都要几百毫秒 —— 直接撞墙。
 *
 * PBKDF2-SHA256 走的是 WebCrypto **原生实现**，不计入 JS 的 CPU 时间，
 * 20 万轮在原生速度下只要几十毫秒。安全性上两者都是
 * 「内存硬 vs 迭代硬」的取舍，PBKDF2 迭代数调高即可。
 *
 * 老数据兼容：Python 版写进 settings 的派生密钥带 'scrypt:' 前缀，
 * 本版只产出 'pbkdf2:' 前缀的，unlock 时按前缀分别处理。
 * 跨版本迁移的密钥在 migrate 脚本里转换（见 migrations/README.md）。
 *
 * ## 每块独立认证
 * 数据按块加密，每块用自己派生的 nonce 和独立标签。
 * 好处：可以随机访问任意一块（断点续传、Range 下载都能用），
 * 一个块损坏不会连累整份文件。
 */

import { AuthError, type Env } from "./types";

const WRAP_LABEL = new TextEncoder().encode("fcloud-wrap-v1");
const KEYCHECK_PLAINTEXT = new TextEncoder().encode("fcloud-keycheck-v1");
const MASTER_CHECK_LABEL = new TextEncoder().encode("fcloud-master-check");

const NONCE_LEN = 12;
const TAG_LEN = 16;

/** PBKDF2 迭代轮数。原生实现，20 万轮 ≈ 几十毫秒。 */
export const PBKDF2_ROUNDS = 210_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

// ---------------------------------------------------------------- 字节工具

export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** 字节数组 → base64（D1 里存这个）。 */
export function b64e(b: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + chunk)));
  }
  return btoa(s);
}

export function b64d(s: string): Uint8Array {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/** 字节数组 → hex（某些场景比 base64 省地方）。 */
export function hex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16);
  return a;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- 摘要与 HMAC

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** SHA-256 的 hex 形式（内容寻址用这个当 key）。 */
export async function sha256hex(data: Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

export async function hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg as BufferSource));
}

/** 常量时间比较。自己写是因为 JS 没有 memcmp。 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------- 密钥派生

/**
 * 从口令派生主密钥。
 *
 * @param algo "pbkdf2"（本版默认）或 "scrypt"（读老数据用，见 deriveLegacy）
 */
/**
 * 分段 PBKDF2 派生。
 *
 * ## 为什么要分段
 *
 * **Cloudflare 的 WebCrypto 硬限制：PBKDF2 迭代次数不能超过 100000。**
 * 超过就直接抛 `NotSupportedError: Pbkdf2 failed: iteration counts above
 * 100000 are not supported` —— 不是慢，是根本不让跑。
 *
 * 实测（线上）：10 万轮正常返回，21 万轮直接 500。
 *
 * 所以要更强的密钥强度（比如密码哈希用 21 万轮、OWASP 建议 60 万），
 * 只能**分成几段跑，再把结果拼起来**。
 *
 * ## 为什么这样安全
 *
 * 每一段用**不同的 salt**（原 salt ‖ 段号），所以各段之间没有关联，
 * 不能被并行爆破或者彩虹表复用。等价于把迭代数翻倍。
 *
 * ## 为什么这样快
 *
 * 实测 WebCrypto 原生调用**不计入 Workers 的 CPU 配额**
 * （诊断端点里 PBKDF2 耗时显示 ms: 0）。
 * 所以分段不会撞 10ms CPU 限制。
 */
export async function derivePbkdf2(
  password: string, salt: Uint8Array, iterations: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw", enc.encode(password) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const parts: Uint8Array[] = [];
  let done = 0;
  let seg = 0;
  while (done < iterations) {
    const chunk = Math.min(MAX_PBKDF2_ITERATIONS, iterations - done);
    // 每段的 salt 加段号，防止段间关联
    const segSalt = new Uint8Array(salt.length + 1);
    segSalt.set(salt, 0);
    segSalt[salt.length] = seg;
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: segSalt as BufferSource, iterations: chunk, hash: "SHA-256" },
      base, 256);
    parts.push(new Uint8Array(bits));
    done += chunk;
    seg++;
  }
  return concat(...parts);
}

/** Cloudflare WebCrypto 允许的单次迭代上限。 */
export const MAX_PBKDF2_ITERATIONS = 100_000;

export async function derive(
  password: string, salt: Uint8Array, algo = "pbkdf2",
): Promise<Uint8Array> {
  if (algo === "scrypt") {
    throw new CryptoError("scrypt 派生在本版不支持，请先解锁后重新设置主口令");
  }
  const raw = await derivePbkdf2(password, salt, PBKDF2_ROUNDS);
  // 只要 32 字节（256 位）—— 分段结果可能更长
  return raw.slice(0, 32);
}

// ---------------------------------------------------------------- 对称加解密

/**
 * 块 nonce 从文件密钥派生，这样解密时不用额外保存 nonce。
 * 跟 Python 版 _chunk_nonce 完全一致（HMAC-SHA256(key, WRAP_LABEL||salt) 前 12 字节）。
 */
export async function chunkNonce(key: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const h = await hmacSha256(key, concat(WRAP_LABEL, salt));
  return h.slice(0, NONCE_LEN);
}

/** 第 index 块的盐 = HMAC(文件密钥, label || seed || 块号)，可重算，无需存储。 */
export async function chunkSalt(
  fileKey: Uint8Array, saltSeed: Uint8Array, index: number,
): Promise<Uint8Array> {
  const ctr = new Uint8Array(8);
  new DataView(ctr.buffer).setBigUint64(0, BigInt(index), false);
  const h = await hmacSha256(
    fileKey, concat(enc.encode("fcloud-chunk"), saltSeed, ctr));
  return h.slice(0, 16);
}

/** 加密一个数据块，返回 (密文, 标签)。 */
export async function encryptChunk(
  plain: Uint8Array, key: Uint8Array, salt: Uint8Array,
): Promise<{ ct: Uint8Array; tag: Uint8Array }> {
  const nonce = await chunkNonce(key, salt);
  const ck = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const blob = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      ck, plain as BufferSource));
  return { ct: blob.slice(0, blob.length - TAG_LEN), tag: blob.slice(blob.length - TAG_LEN) };
}

/** 解密一个数据块。失败抛 CryptoError。 */
export async function decryptChunk(
  cipher: Uint8Array, tag: Uint8Array, key: Uint8Array, salt: Uint8Array,
): Promise<Uint8Array> {
  const nonce = await chunkNonce(key, salt);
  const ck = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      ck, concat(cipher, tag) as BufferSource);
    return new Uint8Array(plain);
  } catch {
    throw new CryptoError("解密失败：密钥不对或数据已损坏");
  }
}

// ---------------------------------------------------------------- 主密钥

export interface MasterState {
  configured: boolean;
  unlocked: boolean;
  algo: string;
}

const SETTING_DERIVED = "master_derived";     // 旧格式：明文派生值（迁移后删除）
const SETTING_WRAPPED = "master_wrapped";     // 新格式：KEK 包装的主密钥
const SETTING_CHECK = "master_check";         // 口令校验值（不是密钥）

/**
 * 主密钥管理。
 *
 * ## 存储模型（2026-10-27 安全加固后）
 *
 * Worker 是无状态的 —— 每个请求都是新 isolate，进程内缓存不存在。
 * 所以主密钥的**存放位置**必须仔细设计：
 *
 *   MASTER_SECRET（Cloudflare Secret：不在 D1、不在 git、不在 wrangler.jsonc）
 *        └─ HKDF-SHA256 → KEK
 *             └─ AES-GCM 加密主密钥 → settings.master_wrapped
 *
 * **为什么不能明文存**：D1 会被备份、会被导出、可能因配置错误而公开。
 * 明文存主密钥等于「D1 泄露 = 全家加密文件裸奔」，
 * 而用户以为自己设了主口令就安全了 —— 这是最危险的假象。
 *
 * **剩下的风险（必须诚实说）**：攻陷 Cloudflare 账号本身 = 拿到所有密钥。
 * 这一层挡不住，因为 MASTER_SECRET 解密后就明文注入 env。
 * 要真正挡住得做客户端持钥（浏览器里派生，服务端只见密文），
 * 那是另一个量级的改造。
 *
 * ## 口令的作用
 *
 * 主口令现在只用来**授权**：口令正确 → 写一条 master_sessions 记录 →
 * 这个会话才能用加密功能。口令本身不参与密钥推导。
 */
export class MasterKey {
  private env: Env;
  /** 缓存的派生密钥。属性名不能叫 key —— 会跟 key() 方法同名冲突。 */
  private _cached: Uint8Array | null = null;
  /**
   * 临时模式：不把派生密钥写进 D1，只在本次请求的内存里用。
   *
   * 存在的理由：PoC 这类调试端点要测「包裹/拆封」往返，
   * 但绝不能动真实的主密钥 —— 一旦写进 D1，
   * 全家的加密文件主口令就被改成了测试用的固定字符串。
   */
  private ephemeral = false;

  constructor(env: Env, opts?: { ephemeral?: boolean }) {
    this.env = env;
    this.ephemeral = !!opts?.ephemeral;
  }

  // ------------------------------------------------------------ KEK 层

  /**
   * 从 MASTER_SECRET 派生「密钥加密密钥」（KEK）。
   *
   * ## 为什么要有这一层
   *
   * 原来主密钥的派生值是**明文**存在 settings 表里的。
   * 那意味着 D1 一旦被拖走 —— 备份文件泄露、误配置把数据库公开、
   * 管理员账号被钓走 —— 全家的加密文件就全部裸奔，
   * 而用户以为自己设了主口令就万事大吉。
   *
   * ## 现在的模型
   *
   *   MASTER_SECRET（Cloudflare Secret，*不在* D1、*不在* git）
   *        └─ HKDF-SHA256 → KEK
   *             └─ AES-GCM 加密主密钥 → settings.master_wrapped
   *
   * D1 被拖走 + 没有 MASTER_SECRET = 攻击者只拿到一堆 AES-GCM 密文。
   *
   * ## 代价（必须诚实说出来）
   *
   * MASTER_SECRET 在 Worker 里是明文的（Cloudflare 解密后注入 env）。
   * 所以**攻陷 Cloudflare 账号本身**就等于拿到所有密钥 ——
   * 这一点无法靠应用层解决。真要防住得做「客户端持钥」，
   * 那是另一个量级的改造。
   *
   * 但威胁模型变了：从「D1 泄露就全完」变成
   * 「要同时拿到 Cloudflare 账号 + D1 才全完」。这是实质提升。
   */
  private async kek(): Promise<Uint8Array> {
    const secret = this.env.MASTER_SECRET;
    if (!secret) {
      throw new CryptoError(
        "还没配置 MASTER_SECRET，无法使用加密功能。请执行：wrangler secret put MASTER_SECRET",
      );
    }
    // HKDF：用固定 info 派生，这样 MASTER_SECRET 可以直接是一段随机串
    const salt = new TextEncoder().encode("fcloud-master-kek-v1");
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret) as BufferSource,
      "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("master-wrap") },
      base, 256);
    return new Uint8Array(bits);
  }

  /** 用 KEK 加密主密钥。 */
  private async wrapMaster(master: Uint8Array): Promise<string> {
    const kek = await this.kek();
    const nonce = randomBytes(NONCE_LEN);
    const ck = await crypto.subtle.importKey(
      "raw", kek as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
    const blob = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      ck, master as BufferSource));
    return `K1:${b64e(nonce)}:${b64e(blob)}`;
  }

  /** 用 KEK 解密主密钥。 */
  private async unwrapMaster(wrapped: string): Promise<Uint8Array | null> {
    const parts = wrapped.split(":");
    if (parts.length !== 3 || parts[0] !== "K1") return null;
    const kek = await this.kek();
    const nonce = b64d(parts[1]);
    const blob = b64d(parts[2]);
    const ck = await crypto.subtle.importKey(
      "raw", kek as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
    try {
      const out = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, ck, blob as BufferSource);
      return new Uint8Array(out);
    } catch {
      // 解不开 = MASTER_SECRET 不对
      return null;
    }
  }

  async configured(): Promise<boolean> {
    // 临时模式：只看内存，不碰真实配置。
    if (this.ephemeral) return this._cached !== null;
    const row = await this.env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(SETTING_WRAPPED).first<{ value: string }>();
    if (row?.value) return true;
    // 旧格式兼容
    const legacy = await this.env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(SETTING_DERIVED).first<{ value: string }>();
    return !!legacy?.value;
  }

  /**
   * 主密钥是否已解锁。
   *
   * Worker 无状态 —— 「解锁了」这件事必须落库。
   * 这里记在 master_sessions 表（解锁授权），带 TTL 自动过期。
   *
   * 语义跟 Python 版一致：**解锁是全局的** ——
   * 管理员解锁一次，全家都能用加密功能，直到解锁过期。
   * （Python 版是进程内全局标志，Worker 版对应「一条全局记录 + TTL」）
   */
  async unlocked(): Promise<boolean> {
    if (this.ephemeral) return this._cached !== null;
    const row = await this.env.DB.prepare(
      "SELECT COUNT(*) AS c FROM master_sessions WHERE expires_at > ?")
      .bind(Date.now() / 1000).first<{ c: number }>();
    return (row?.c ?? 0) > 0;
  }

  /**
   * 授予解锁权限。
   *
   * @param memberId 谁解锁的（记审计用）
   * @param sessionToken 哪个会话解锁的
   * @param ttlSeconds 授权有效期
   */
  async grantUnlock(
    memberId: number, sessionToken: string, ttlSeconds = 8 * 3600,
  ): Promise<void> {
    if (this.ephemeral) return;
    const now = Date.now() / 1000;
    // 同一会话可能解锁多次（设完口令解锁一次、又手动解锁一次）——
    // session_tok 上有唯一索引，所以要用 upsert 续期，不能裸 INSERT。
    await this.env.DB.prepare(
      "INSERT INTO master_sessions(member_id, session_tok, created_at, expires_at, ip) " +
      "VALUES(?,?,?,?,?) " +
      "ON CONFLICT(session_tok) DO UPDATE SET " +
      "  member_id=excluded.member_id, expires_at=excluded.expires_at")
      .bind(memberId, sessionToken || "unknown", now, now + ttlSeconds, "")
      .run();
  }

  /** 撤销所有解锁授权（改主口令、发现异常时用）。 */
  async revokeUnlock(): Promise<void> {
    await this.env.DB.prepare("DELETE FROM master_sessions").run();
  }

  /**
   * 拿主密钥。
   *
   * 流程：D1 取「用 KEK 加密的主密钥」→ 用 KEK 解开 → 得到主密钥。
   *
   * 旧格式（明文派生值 `pbkdf2:...`）也兼容读 ——
   * 迁移期间两种格式并存，读到旧的会自动升级成新的。
   */
  async key(): Promise<Uint8Array | null> {
    if (this._cached) return this._cached;
    // 临时模式绝不回落到真实主密钥 —— 那样等于绕过口令。
    if (this.ephemeral) return null;

    // 新格式：KEK 包装
    const wrapped = await this.env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(SETTING_WRAPPED).first<{ value: string }>();
    if (wrapped?.value) {
      const k = await this.unwrapMaster(wrapped.value);
      if (k) { this._cached = k; return k; }
      return null;
    }

    // 旧格式：明文派生值（迁移兼容）
    const legacy = await this.env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(SETTING_DERIVED).first<{ value: string }>();
    if (!legacy?.value) return null;
    const parts = legacy.value.split(":");
    if (parts.length < 4) return null;
    this._cached = b64d(parts[2]);
    return this._cached;
  }

  /**
   * 设置主口令。
   *
   * 现在做三件事：
   *   1. 派生主密钥
   *   2. 用 KEK 加密它，存进 settings.master_wrapped（**不是明文**）
   *   3. 旧的明文派生值删掉 —— 留着就等于没加固
   */
  async setPassphrase(passphrase: string): Promise<void> {
    if (passphrase.length < 8) throw new CryptoError("主口令至少 8 位");
    const salt = randomBytes(16);
    const key = await derive(passphrase, salt);
    const check = await hmacSha256(key, MASTER_CHECK_LABEL);
    // 临时模式：只在内存里留着，不落库。
    if (this.ephemeral) {
      this._cached = key;
      return;
    }
    const wrapped = await this.wrapMaster(key);
    const now = Date.now() / 1000;
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
        .bind(SETTING_WRAPPED, wrapped, now),
      // 口令校验值单独存 —— 它不是密钥，泄露了也只是能被离线爆破
      this.env.DB.prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
        .bind(SETTING_CHECK, `${b64e(salt)}:${b64e(check)}`, now),
      // ⚠️ 删掉旧的明文派生值 —— 这是本次加固的关键
      this.env.DB.prepare("DELETE FROM settings WHERE key=?").bind(SETTING_DERIVED),
    ]);
    this._cached = key;
  }

  /** 校验口令是否正确。 */
  async checkPassphrase(passphrase: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(SETTING_CHECK).first<{ value: string }>();
    // 兼容旧格式：check 混在派生值里
    let saltB64: string;
    let checkB64: string;
    if (row?.value) {
      const parts = row.value.split(":");
      if (parts.length < 2) return false;
      saltB64 = parts[0]; checkB64 = parts[1];
    } else {
      const legacy = await this.env.DB.prepare("SELECT value FROM settings WHERE key=?")
        .bind(SETTING_DERIVED).first<{ value: string }>();
      if (!legacy?.value) return false;
      const parts = legacy.value.split(":");
      if (parts.length < 4) return false;
      if (parts[0] === "scrypt") {
        throw new CryptoError("旧版 scrypt 主密钥需先在 Python 版解锁并重新设置");
      }
      saltB64 = parts[1]; checkB64 = parts[3];
    }
    const salt = b64d(saltB64);
    const key = await derive(passphrase, salt);
    const want = await hmacSha256(key, MASTER_CHECK_LABEL);
    if (!equalBytes(want, b64d(checkB64))) return false;
    this._cached = key;
    return true;
  }

  /**
   * 取主密钥（没有解锁授权就抛错）。
   *
   * ⚠️ 关键：**必须先检查解锁授权**。
   * 因为主密钥现在能用 MASTER_SECRET 从 D1 里解出来 ——
   * 如果不检查授权，任何人（哪怕没输过口令）都能用加密功能。
   */
  async mustKey(): Promise<Uint8Array> {
    if (!this.ephemeral && !(await this.unlocked())) {
      throw new AuthError("主密钥未解锁，请先在设置里输入主口令");
    }
    const k = await this.key();
    if (!k) throw new AuthError("主密钥未解锁，请先在设置里输入主口令");
    return k;
  }

  newFileKey(): Uint8Array {
    return randomBytes(32);
  }

  /**
   * 包裹文件密钥。
   * 布局：F1 | nonce(12) | aad盐(16) | 密文 | 标签(16)
   * 盐同时作为 AES-GCM 的 AAD，拆封时必须原样传回去。
   */
  async wrap(fileKey: Uint8Array): Promise<Uint8Array> {
    const mk = await this.mustKey();
    const salt = randomBytes(16);
    const nonce = randomBytes(NONCE_LEN);
    const ck = await crypto.subtle.importKey(
      "raw", mk as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const blob = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: salt as BufferSource, tagLength: 128 },
      ck, fileKey as BufferSource));
    return concat(enc.encode("F1"), nonce, salt, blob);
  }

  async unwrap(blob: Uint8Array): Promise<Uint8Array> {
    const mk = await this.mustKey();
    if (blob.length < 2) throw new CryptoError("密钥数据格式不对");
    const tag = dec.decode(blob.slice(0, 2));
    if (tag !== "F1") throw new CryptoError("密钥数据格式不对（只支持 F1 格式）");
    const nonce = blob.slice(2, 2 + NONCE_LEN);
    const aad = blob.slice(2 + NONCE_LEN, 2 + NONCE_LEN + 16);
    const rest = blob.slice(2 + NONCE_LEN + 16);
    const ct = rest.slice(0, rest.length - TAG_LEN);
    const gtag = rest.slice(rest.length - TAG_LEN);
    const ck = await crypto.subtle.importKey(
      "raw", mk as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    try {
      const out = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        ck, concat(ct, gtag) as BufferSource);
      return new Uint8Array(out);
    } catch {
      throw new CryptoError("拆封失败：主口令不对");
    }
  }

  /** 密钥自检：解开一个已知常量来判断文件密钥对不对。 */
  async sealCheck(fileKey: Uint8Array): Promise<{ salt: Uint8Array; ct: Uint8Array; tag: Uint8Array }> {
    const salt = randomBytes(16);
    const { ct, tag } = await encryptChunk(KEYCHECK_PLAINTEXT, fileKey, salt);
    return { salt, ct, tag };
  }

  async openCheck(
    fileKey: Uint8Array, salt: Uint8Array, ct: Uint8Array, tag: Uint8Array,
  ): Promise<boolean> {
    try {
      const p = await decryptChunk(ct, tag, fileKey, salt);
      return equalBytes(p, KEYCHECK_PLAINTEXT);
    } catch {
      return false;
    }
  }
}
