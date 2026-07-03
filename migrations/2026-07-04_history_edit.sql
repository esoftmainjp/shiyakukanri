-- 履歴の編集/削除機能のための列追加 (冪等)
--   実行: node scripts/migrate.js --file migrations/2026-07-04_history_edit.sql
--
-- 1) barcodes.voided_flag : 独自バーコードの論理削除(void)フラグ。
--    入庫削除時に物理削除せず void にすることで serial_number / content_code の
--    再利用を防ぎ、同じバーコード値が二度と発行されないようにする。
-- 2) issue_details.barcode_id : バーコード出庫時にどの個体を出庫したかを記録。
--    出庫削除時に該当バーコードを未使用へ正確に復元するために用いる。

ALTER TABLE barcodes      ADD COLUMN IF NOT EXISTS voided_flag BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE issue_details ADD COLUMN IF NOT EXISTS barcode_id  BIGINT REFERENCES barcodes(id);

COMMENT ON COLUMN barcodes.voided_flag      IS '無効化(論理削除)フラグ。TRUEは入庫削除等で無効化された値(再発行しない)';
COMMENT ON COLUMN issue_details.barcode_id  IS 'バーコード出庫時の対象バーコードID(出庫取消時の復元用)';

-- 有効な(未void)バーコードを引く用途の部分インデックス
CREATE INDEX IF NOT EXISTS idx_barcodes_active ON barcodes(barcode_value) WHERE voided_flag = FALSE;
CREATE INDEX IF NOT EXISTS idx_issue_details_barcode ON issue_details(barcode_id);

-- 3) 入庫削除時に barcodes(void行)を残したまま receipt_details を削除できるよう、
--    barcodes.receipt_detail_id を NULL許可 + ON DELETE SET NULL に変更する。
--    (void済みバーコードは serial/content_code を予約するため行は残す)
ALTER TABLE barcodes ALTER COLUMN receipt_detail_id DROP NOT NULL;
ALTER TABLE barcodes DROP CONSTRAINT IF EXISTS barcodes_receipt_detail_id_fkey;
ALTER TABLE barcodes ADD CONSTRAINT barcodes_receipt_detail_id_fkey
    FOREIGN KEY (receipt_detail_id) REFERENCES receipt_details(id) ON DELETE SET NULL;
