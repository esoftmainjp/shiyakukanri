-- システム全体の設定(施設に依存しないKV)。決済プロバイダの選択などに使用。冪等。
CREATE TABLE IF NOT EXISTS system_settings (
    key        VARCHAR(64) PRIMARY KEY,
    value      TEXT        NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE system_settings IS 'システム全体設定(施設非依存KV)。例: payment_provider';
