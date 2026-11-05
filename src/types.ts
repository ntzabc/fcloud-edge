/** 全局类型与绑定声明。 */

export interface Env {
  DB: D1Database;
  /**
   * R2 桶绑定。
   *
   * 标成可选是因为**账号没订阅 R2 时这个 binding 根本不存在** ——
   * 此时部署会因为「bucket not found」直接失败，所以只能用不带 R2 的配置部署，
   * 代码里也要能优雅降级（给用户明确提示，而不是 500 崩溃）。
   */
  BLOB?: R2Bucket;
  RATE: KVNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  SESSION_COOKIE: string;
  SESSION_TTL: string;
  CHUNK_SIZE: string;
  /** OpenRouter API Key（可选用 secret 注入；优先级低于 D1 设置）。 */
  FCLOUD_AI_KEY?: string;
  /** 回收站保留天数。 */
  TRASH_DAYS?: string;
  /**
   * 密钥加密密钥的根（Cloudflare Secret）。
   *
   * 主密钥用它派生的 KEK 加密后存 D1 —— D1 泄露不等于密钥泄露。
   * **绝不能写进 wrangler.jsonc 或 git**，用 `wrangler secret put MASTER_SECRET` 设。
   */
  MASTER_SECRET?: string;
  /** 是否开放 /api/poc 调试端点（生产必须关）。 */
  ALLOW_POC?: string;
}

/** 成员。字段名跟 Python 版 members.Member.to_dict() 对齐。 */
export interface Member {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "adult" | "child";
  /** 角色中文名。前端成员列表要用。 */
  role_label: string;
  /** 头像首字。前端要用。 */
  initial: string;
  color: string;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
  can: string[];
}

/** 文件树节点。 */
export interface Node {
  id: number;
  space_id: number;
  parent_id: number;
  name: string;
  kind: "file" | "folder";
  current_version_id: number | null;
  owner_id: number;
  uploader_id: number | null;
  category: string;
  tags: string;
  note: string;
  starred: number;
  encrypted: number;
  mime: string;
  size: number;
  chunk_count: number;
  created_at: number;
  modified_at: number;
  deleted_at: number | null;
  deleted_by: number | null;
  trash_parent_id: number | null;
  download_count: number;
  last_access_at: number | null;
}

export interface Version {
  id: number;
  node_id: number;
  seq: number;
  size: number;
  chunk_count: number;
  encrypted: number;
  mime: string;
  created_at: number;
  created_by: number | null;
  note: string;
  is_current: number;
}

export interface VersionChunk {
  version_id: number;
  seq: number;
  blob_id: number;
  offset: number;
  size: number;
}

export interface VersionCrypto {
  version_id: number;
  algo: "aes-256-gcm" | "hmac-sha256-ctr";
  salt_seed: string;
  wrapped_key: string;
  check_salt: string;
  check_ct: string;
  check_tag: string;
  created_at: number;
}

export interface Upload {
  id: string;
  space_id: number;
  member_id: number;
  node_id: number | null;
  parent_id: number;
  name: string;
  total_size: number;
  chunk_size: number;
  total_chunks: number;
  mime: string;
  encrypted: number;
  category: string;
  note: string;
  temp_dir: string;
  state: "open" | "done" | "aborted";
  wrapped_key: string | null;
  salt_seed: string | null;
  created_at: number;
  updated_at: number;
}

export interface Share {
  id: number;
  node_id: number;
  grantee_id: number;
  granted_by: number;
  permission: "read" | "write" | "own";
  created_at: number;
  note: string;
}

/** 统一的 API 错误。跟 Python 版 ApiError 语义一致。 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * 主密钥的最小接口。
 * 业务层只依赖这三个方法，方便测试时注入假实现。
 */
export interface MasterLike {
  /** 包裹文件密钥。 */
  wrap(fileKey: Uint8Array): Promise<Uint8Array>;
  /** 拆封文件密钥。 */
  unwrap(blob: Uint8Array): Promise<Uint8Array>;
  /** 取当前主密钥（未解锁会抛错）。 */
  mustKey(): Promise<Uint8Array>;
}
