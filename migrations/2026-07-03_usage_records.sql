-- 使用記録テーブル追加 (バーコード発行OFFの試薬管理対象品の使用開始/終了管理)
-- 既存の本番DBに対して実行する。冪等(存在すれば作成しない)。
--   実行: node scripts/migrate.js --file migrations/2026-07-03_usage_records.sql

CREATE TABLE IF NOT EXISTS usage_records (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id     BIGINT      NOT NULL REFERENCES products(id),
    lot_number     VARCHAR(64) NOT NULL DEFAULT '',
    expiry_date    DATE,
    content_code   INTEGER     NOT NULL,
    use_start_date DATE        NOT NULL,
    use_end_date   DATE,
    issue_id       BIGINT      REFERENCES issues(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_records_product ON usage_records(product_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_open    ON usage_records(product_id, lot_number) WHERE use_end_date IS NULL;
