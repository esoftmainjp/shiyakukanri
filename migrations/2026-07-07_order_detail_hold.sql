-- 発注明細の保留フラグ (冪等)
--   実行: node scripts/migrate.js --file migrations/2026-07-07_order_detail_hold.sql
--
-- 未発注(発注予定)の商品を「保留」して今回の発注から外せるようにする。
-- 保留した明細は発注予定から除外し、発注(place)時は新しい未発注へ退避して残す。

ALTER TABLE order_details ADD COLUMN IF NOT EXISTS held_flag BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN order_details.held_flag IS '保留フラグ(発注予定から一時的に外す)。TRUEは発注対象外';

CREATE INDEX IF NOT EXISTS idx_order_details_notheld ON order_details(order_id) WHERE held_flag = FALSE;
