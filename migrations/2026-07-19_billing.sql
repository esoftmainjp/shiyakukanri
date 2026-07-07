-- 問屋精算(支払/請求)機能。冪等マイグレーション。
-- 入庫実績(receipt_details.unit_price)を問屋×期間で集計し、返品を控除、消費税を加味して締める。

-- 1) 返品の金額・問屋を保持(既存の返品=NULLは精算対象外)
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS supplier_id    BIGINT REFERENCES suppliers(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_price     NUMERIC(12,2);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS quantity_input INTEGER;   -- 入力単位数量(金額=quantity_input×unit_price)
COMMENT ON COLUMN stock_movements.supplier_id    IS '返品等の相手問屋(精算用。receipt/issue/adjustはNULL)';
COMMENT ON COLUMN stock_movements.unit_price     IS '返品等の単価(精算用)';
COMMENT ON COLUMN stock_movements.quantity_input IS '入力単位数量(精算用。金額=quantity_input×unit_price)';
CREATE INDEX IF NOT EXISTS idx_stock_movements_supplier ON stock_movements(supplier_id);

-- 2) プランに請求機能フラグ(既定はstandard/proのみ)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS feat_billing BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE plans SET feat_billing = FALSE WHERE code IN ('free', 'light');

-- 3) 請求ヘッダ
CREATE TABLE IF NOT EXISTS supplier_bills (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    facility_id   BIGINT       NOT NULL REFERENCES facilities(id),
    supplier_id   BIGINT       NOT NULL REFERENCES suppliers(id),
    bill_number   VARCHAR(32)  NOT NULL,               -- 請求番号(施設内一意)
    period_from   DATE         NOT NULL,
    period_to     DATE         NOT NULL,
    closing_date  DATE,                                 -- 締日
    subtotal      NUMERIC(14,2) NOT NULL DEFAULT 0,     -- 税抜小計(返品控除後)
    tax_rate      NUMERIC(5,2)  NOT NULL DEFAULT 0,     -- 確定時の税率スナップショット(%)
    tax_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,     -- 消費税(円未満切り捨て)
    total_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,     -- 税込合計
    status        VARCHAR(16)  NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('draft', 'confirmed', 'paid', 'canceled')),
    note          TEXT         NOT NULL DEFAULT '',
    confirmed_by  BIGINT       REFERENCES users(id),
    confirmed_at  TIMESTAMPTZ,
    paid_at       TIMESTAMPTZ,
    canceled_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE supplier_bills IS '問屋精算(請求/支払)ヘッダ';
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_bills_number   ON supplier_bills(facility_id, bill_number);
CREATE INDEX IF NOT EXISTS idx_supplier_bills_facility ON supplier_bills(facility_id);
CREATE INDEX IF NOT EXISTS idx_supplier_bills_supplier ON supplier_bills(supplier_id);

DROP TRIGGER IF EXISTS trg_supplier_bills_updated_at ON supplier_bills;
CREATE TRIGGER trg_supplier_bills_updated_at
    BEFORE UPDATE ON supplier_bills
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4) 請求明細(二重請求防止の要)
CREATE TABLE IF NOT EXISTS supplier_bill_lines (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bill_id      BIGINT       NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
    source_type  VARCHAR(16)  NOT NULL CHECK (source_type IN ('receipt', 'return')),
    source_id    BIGINT       NOT NULL,                -- receipt_details.id または stock_movements.id
    product_id   BIGINT       REFERENCES products(id),
    event_date   DATE,                                  -- 入庫日 or 返品日
    quantity     INTEGER      NOT NULL DEFAULT 0,       -- 入力単位数量(返品は負)
    unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount       NUMERIC(14,2) NOT NULL DEFAULT 0,      -- quantity×unit_price(返品はマイナス)
    note         TEXT         NOT NULL DEFAULT ''
);
COMMENT ON TABLE supplier_bill_lines IS '問屋精算 明細(source_type/source_idで二重請求防止)';
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill ON supplier_bill_lines(bill_id);
-- 同一ソース(入庫明細/返品)を二重に締めない。取消時はlines削除で解放。
CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_lines_active_source ON supplier_bill_lines(source_type, source_id);
