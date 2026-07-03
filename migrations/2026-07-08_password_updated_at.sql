-- ユーザーのパスワード保存日時(将来のパスワード有効期限機能で使用)
-- 冪等: 既存列があれば何もしない。既存ユーザーは実行時刻が入る。
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
COMMENT ON COLUMN users.password_updated_at IS 'パスワード保存日時';
