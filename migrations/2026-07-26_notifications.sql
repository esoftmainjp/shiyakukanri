-- 能動通知(期限接近・在庫僅少のメール)の送信状態。1日1回の重複送信を防ぐ。冪等・非破壊。
CREATE TABLE IF NOT EXISTS notification_state (
    facility_id    BIGINT      PRIMARY KEY REFERENCES facilities(id),
    last_sent_date DATE,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE  notification_state                IS '能動通知の送信状態(施設単位。日次重複送信の抑止)';
COMMENT ON COLUMN notification_state.last_sent_date IS '最後に通知メールを送信した日付';
