-- 初回ログイン時のパスワード変更要求フラグ
-- 冪等: 既存列があれば何もしない。既存ユーザーは既定(FALSE=変更不要)。
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN users.must_change_password IS '初回ログイン時パスワード変更要求フラグ';
