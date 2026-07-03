-- 発注明細の商品ごとキャンセル用フラグ (冪等)
--   実行: node scripts/migrate.js --file migrations/2026-07-05_order_detail_cancel.sql
--
-- 発注済み(ordered)の発注で、商品(明細)単位にキャンセルできるようにする。
-- キャンセルした明細は行を残したまま canceled_flag=TRUE とし、
-- 入庫予定・入庫済み判定から除外する。全明細がキャンセルされたら発注自体を canceled にする。

ALTER TABLE order_details ADD COLUMN IF NOT EXISTS canceled_flag BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN order_details.canceled_flag IS '明細キャンセルフラグ(発注済みの商品ごとキャンセル)。TRUEは入庫予定・入庫判定から除外';

CREATE INDEX IF NOT EXISTS idx_order_details_active ON order_details(order_id) WHERE canceled_flag = FALSE;
