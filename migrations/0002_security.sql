-- FcloudEdge · 安全加固迁移
--
-- 背景：主密钥原来以**明文派生值**存在 settings 表里。
-- D1 一旦被拖走（备份泄露、误配置公开、管理员账号被盗），
-- 全家的加密文件就全部裸奔。
--
-- 这次改成两层：
--   MASTER_SECRET（Cloudflare Secret，不在 D1、不在 git）
--      └─ HKDF → KEK（密钥加密密钥）
--           └─ AES-GCM 加密主密钥 → 存进 settings.master_wrapped
--
-- D1 被拖走 + 没有 MASTER_SECRET = 攻击者拿到的只是一堆密文。
--
-- 同时加两张表：
--   master_sessions —— 解锁会话（Worker 无状态，得有个地方记「谁解锁了」）
--   security_log   —— 安全事件审计（登录失败、解锁、限流触发…）

-- 解锁会话 ----------------------------------------------------------
-- Worker 是无状态的，「主密钥已解锁」这件事必须落 somewhere。
-- 这里记录「哪个成员的哪个会话解锁了」，会话过期自动失效。
-- 密钥本身不存这儿 —— 存的是「这个会话可以尝试用主密钥」的授权标记，
-- 真正的解密还是要靠 MASTER_SECRET 派生的 KEK。
CREATE TABLE IF NOT EXISTS master_sessions (
    id          INTEGER PRIMARY KEY,
    member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    session_tok TEXT NOT NULL,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL,
    ip          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_msessions_member ON master_sessions(member_id);
CREATE INDEX IF NOT EXISTS ix_msessions_exp    ON master_sessions(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msessions_tok ON master_sessions(session_tok);

-- 安全事件审计 -------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_log (
    id         INTEGER PRIMARY KEY,
    at         REAL NOT NULL,
    kind       TEXT NOT NULL,
    member_id  INTEGER,
    username   TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    ok         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_seclog_at   ON security_log(at DESC);
CREATE INDEX IF NOT EXISTS ix_seclog_kind ON security_log(kind, at DESC);
