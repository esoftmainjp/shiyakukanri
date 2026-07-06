-- 本番の自動マイグレーション(AUTO_MIGRATE=1)の動作確認用。
-- 後続の 2026-07-16_automigrate_test_cleanup.sql で削除する一時テーブル。
CREATE TABLE IF NOT EXISTS _automigrate_test (
  id         INT,
  note       TEXT        NOT NULL DEFAULT 'auto-migrate ok',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
