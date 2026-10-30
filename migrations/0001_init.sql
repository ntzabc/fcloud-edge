-- Family Cloud · D1 schema
-- 从 Python 版 fcloud/db.py 的 SCHEMA 翻译而来。
--
-- D1 与 SQLite 的差异（这几条影响了下面的写法）：
--   1. 不支持 BEGIN/COMMIT/ROLLBACK —— 多语句原子性用 batch() 代替
--   2. PRAGMA foreign_keys = OFF 会被静默忽略（外键永远开启）
--      → 所以所有外键列都建成 INTEGER，用应用层保证引用有效
--   3. 没有 AUTOINCREMENT —— 用 INTEGER PRIMARY KEY（rowid 别名）即可
--   4. WITHOUT ROWID 支持，但 D1 上没必要，索引一样建
--   5. 触发器只支持部分，这里一个都不用

-- 成员 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'child',
    pwd_hash      TEXT,                      -- 原 BLOB，D1 里用 hex/base64 存
    pwd_salt      TEXT,
    pwd_algo      TEXT,
    color         TEXT NOT NULL DEFAULT '#5B9BFF',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    last_login_at REAL
);

-- 家庭空间 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS spaces (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    owner_id     INTEGER NOT NULL REFERENCES members(id),
    quota_bytes  INTEGER NOT NULL DEFAULT 0,
    created_at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
    space_id  INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    role      TEXT NOT NULL,
    PRIMARY KEY (space_id, member_id)
);

-- 内容块：去重的核心。hash 是明文的 SHA-256，同内容只存一份 ----------
-- data 不在这里 —— 块本体存在 R2（bucket: fcloud-blobs），key = hash
CREATE TABLE IF NOT EXISTS blobs (
    id         INTEGER PRIMARY KEY,
    hash       TEXT NOT NULL UNIQUE,
    size       INTEGER NOT NULL,
    refcount   INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);

-- 文件树：文件夹与文件同表 -------------------------------------------
CREATE TABLE IF NOT EXISTS nodes (
    id                INTEGER PRIMARY KEY,
    space_id          INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    parent_id         INTEGER NOT NULL DEFAULT 0,
    name              TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'file',
    current_version_id INTEGER REFERENCES versions(id),
    owner_id          INTEGER NOT NULL REFERENCES members(id),
    uploader_id       INTEGER REFERENCES members(id),
    category          TEXT NOT NULL DEFAULT '其他',
    tags              TEXT NOT NULL DEFAULT '',
    note              TEXT NOT NULL DEFAULT '',
    starred           INTEGER NOT NULL DEFAULT 0,
    encrypted         INTEGER NOT NULL DEFAULT 0,
    mime              TEXT NOT NULL DEFAULT 'application/octet-stream',
    size              INTEGER NOT NULL DEFAULT 0,
    chunk_count       INTEGER NOT NULL DEFAULT 0,
    created_at        REAL NOT NULL,
    modified_at       REAL NOT NULL,
    deleted_at        REAL,
    deleted_by        INTEGER,
    trash_parent_id   INTEGER,
    download_count    INTEGER NOT NULL DEFAULT 0,
    last_access_at    REAL
);
CREATE INDEX IF NOT EXISTS ix_nodes_parent   ON nodes(space_id, parent_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_nodes_modified ON nodes(space_id, modified_at DESC);
CREATE INDEX IF NOT EXISTS ix_nodes_owner    ON nodes(owner_id);
CREATE INDEX IF NOT EXISTS ix_nodes_cat      ON nodes(space_id, category);
CREATE INDEX IF NOT EXISTS ix_nodes_deleted  ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;

-- 同一目录下不能有同名的东西（文件、文件夹都算；回收站里的不算）
CREATE UNIQUE INDEX IF NOT EXISTS ux_nodes_sibling
    ON nodes(space_id, parent_id, name)
    WHERE deleted_at IS NULL;

-- 版本历史 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS versions (
    id           INTEGER PRIMARY KEY,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    chunk_count  INTEGER NOT NULL,
    encrypted    INTEGER NOT NULL DEFAULT 0,
    mime         TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL,
    created_by   INTEGER REFERENCES members(id),
    note         TEXT NOT NULL DEFAULT '',
    is_current   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_versions_node ON versions(node_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_versions_seq ON versions(node_id, seq);

-- 一个版本由若干内容块拼起来（分块上传 / 断点续传的基础） ------------
CREATE TABLE IF NOT EXISTS version_chunks (
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    blob_id    INTEGER NOT NULL REFERENCES blobs(id),
    offset     INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    PRIMARY KEY (version_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_vchunks_blob ON version_chunks(blob_id);

-- 每个版本的加密元数据 ------------------------------------------------
-- 文件密钥只在这里出现，且永远是被主密钥包裹过的形式。
-- R2 里的 blobs 只有密文。
CREATE TABLE IF NOT EXISTS version_crypto (
    version_id   INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
    algo         TEXT NOT NULL,
    salt_seed    TEXT NOT NULL,
    wrapped_key  TEXT NOT NULL,
    check_salt   TEXT NOT NULL,
    check_ct     TEXT NOT NULL,
    check_tag    TEXT NOT NULL,
    created_at   REAL NOT NULL
);

-- 分片上传会话 -------------------------------------------------------
-- temp_dir 在 Python 版是本地临时目录；Edge 版没有文件系统，
-- 分片直接进 R2 的 staging/ 前缀，所以这列不再需要，保留为空串兼容。
CREATE TABLE IF NOT EXISTS uploads (
    id           TEXT PRIMARY KEY,
    space_id     INTEGER NOT NULL,
    member_id    INTEGER NOT NULL,
    node_id      INTEGER,
    parent_id    INTEGER NOT NULL DEFAULT 0,
    name         TEXT NOT NULL,
    total_size   INTEGER NOT NULL,
    chunk_size   INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    mime         TEXT NOT NULL DEFAULT '',
    encrypted    INTEGER NOT NULL DEFAULT 0,
    category     TEXT NOT NULL DEFAULT '其他',
    note         TEXT NOT NULL DEFAULT '',
    temp_dir     TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'open',
    wrapped_key  TEXT,
    salt_seed    TEXT,
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_uploads_owner ON uploads(member_id, state);

CREATE TABLE IF NOT EXISTS upload_parts (
    upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    seq       INTEGER NOT NULL,
    hash      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (upload_id, seq)
);

-- 共享 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shares (
    id          INTEGER PRIMARY KEY,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    grantee_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    granted_by  INTEGER NOT NULL REFERENCES members(id),
    permission  TEXT NOT NULL DEFAULT 'read',
    created_at  REAL NOT NULL,
    note        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_shares ON shares(node_id, grantee_id);
CREATE INDEX IF NOT EXISTS ix_shares_grantee ON shares(grantee_id);

-- 操作记录 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY,
    space_id    INTEGER,
    actor_id    INTEGER,
    actor_name  TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id   INTEGER,
    target_name TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    ip          TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_time   ON audit(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_actor  ON audit(actor_id, created_at DESC);

-- 会话 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    ua         TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sessions_exp ON sessions(expires_at);

-- 删除墓碑：彻底删除之后仍然留痕 -------------------------------------
CREATE TABLE IF NOT EXISTS tombstones (
    id          INTEGER PRIMARY KEY,
    node_id     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    parent_id   INTEGER NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    version_id  INTEGER,
    deleted_at  REAL NOT NULL,
    deleted_by  INTEGER,
    purged_at   REAL,
    purged_by   INTEGER,
    grace_until REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tomb_grace ON tombstones(grace_until);

-- 设置（主密钥材料、配额、上次备份时间等） ----------------------------
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at REAL NOT NULL
);

-- 抽取出来的正文缓存（预览高亮片段、命中回显用）
CREATE TABLE IF NOT EXISTS file_text (
    node_id    INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    version_id INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    indexed_at REAL NOT NULL
);

-- 倒排索引 -----------------------------------------------------------
-- 为什么不用 SQLite 自带的 FTS5？
--   实测：FTS5 的 trigram 分词器把中文字符全部当成分隔符，
--   中文文档索引进去一个字都搜不到（英文正常）。
--   所以中文检索只能自己建倒排索引。
--
-- 分词策略（不引入任何第三方分词库）：
--   中文连续片段 -> 全部二元组（bigram）+ 单字
--   英文/数字   -> 整词转小写
-- term 上有索引，等值匹配和前缀匹配（term LIKE 'x%'）都能走索引。
CREATE TABLE IF NOT EXISTS fterms (
    term    TEXT NOT NULL,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tf      REAL NOT NULL DEFAULT 1,
    PRIMARY KEY (term, node_id)
);
CREATE INDEX IF NOT EXISTS ix_fterms_node ON fterms(node_id);
