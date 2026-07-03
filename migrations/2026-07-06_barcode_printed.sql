-- バーコードの印刷済みフラグ (冪等)
--   実行: node scripts/migrate.js --file migrations/2026-07-06_barcode_printed.sql
--
-- 1度印刷したバーコードは通常再印刷不要のため、印刷済みを記録し、
-- バーコード印刷画面では既定で非表示にする(「印刷済みも表示」で表示可)。

ALTER TABLE barcodes ADD COLUMN IF NOT EXISTS printed_flag BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE barcodes ADD COLUMN IF NOT EXISTS printed_at   TIMESTAMPTZ;

COMMENT ON COLUMN barcodes.printed_flag IS 'ラベル印刷済みフラグ';
COMMENT ON COLUMN barcodes.printed_at   IS 'ラベル印刷日時';

CREATE INDEX IF NOT EXISTS idx_barcodes_unprinted
  ON barcodes(issue_date) WHERE voided_flag = FALSE AND printed_flag = FALSE;
