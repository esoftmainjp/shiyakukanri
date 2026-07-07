-- 施設ごとのプラン(料金プラン相当)。プランで上限・機能を差別化する。
-- 上限系(NULL=無制限)、機能フラグ(TRUE=利用可)。superadminが編集可・施設ごとに割当。
CREATE TABLE IF NOT EXISTS plans (
    code               VARCHAR(16)  PRIMARY KEY,   -- free/light/standard/pro
    name               VARCHAR(64)  NOT NULL,
    sort_order         INTEGER      NOT NULL DEFAULT 0,
    max_users          INTEGER,                     -- ユーザー登録最大数(NULL=無制限)
    max_products       INTEGER,                     -- 商品マスター最大数(NULL=無制限)
    log_retention_days INTEGER,                     -- 操作ログ等の保持日数(NULL=無制限)
    feat_stocktake     BOOLEAN      NOT NULL DEFAULT TRUE,  -- 棚卸し
    feat_barcode       BOOLEAN      NOT NULL DEFAULT TRUE,  -- 独自バーコード発行・印刷
    feat_reports       BOOLEAN      NOT NULL DEFAULT TRUE,  -- 集計・分析
    feat_ledger        BOOLEAN      NOT NULL DEFAULT TRUE,  -- 試薬管理台帳
    feat_import        BOOLEAN      NOT NULL DEFAULT TRUE,  -- CSV一括インポート
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 初期プラン(存在しなければ投入)。既定値は後からsuperadminが編集可能。
INSERT INTO plans (code, name, sort_order, max_users, max_products, log_retention_days,
                   feat_stocktake, feat_barcode, feat_reports, feat_ledger, feat_import) VALUES
  ('free',     'フリー',       1,    1,    10,   30,   FALSE, FALSE, FALSE, FALSE, FALSE),
  ('light',    'ライト',       2,   10,   100,   90,   FALSE, TRUE,  FALSE, TRUE,  TRUE),
  ('standard', 'スタンダード', 3,  100,  1000,  365,   TRUE,  TRUE,  TRUE,  TRUE,  TRUE),
  ('pro',      'プロ',         4, 1000, 10000, NULL,   TRUE,  TRUE,  TRUE,  TRUE,  TRUE)
ON CONFLICT (code) DO NOTHING;

-- 施設にプランを割当(既定=free)。
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS plan_code VARCHAR(16) NOT NULL DEFAULT 'free' REFERENCES plans(code);

-- 既存施設は当面プロで運用(新規作成はfree既定)。導入時の破壊的制限を避ける。
UPDATE facilities SET plan_code = 'pro' WHERE plan_code = 'free';
