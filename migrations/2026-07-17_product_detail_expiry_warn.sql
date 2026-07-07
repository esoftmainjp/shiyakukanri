-- 商品詳細に使用期限警告日数を追加(商品ごとの消費サイクルに合わせる)。
-- 0 = 未設定(施設設定の警告日数を使用)。商品詳細に0超の値があればそれを優先。
ALTER TABLE product_details ADD COLUMN IF NOT EXISTS expiry_warn_days INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN product_details.expiry_warn_days IS '使用期限警告日数(0=未設定→施設設定を使用。0超なら商品詳細を優先)';
