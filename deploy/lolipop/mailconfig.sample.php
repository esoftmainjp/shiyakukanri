<?php
/**
 * メール送信設定(サンプル)。
 * これを mailconfig.php にコピーし、実際の値を入れて send.php と同じ場所に置く。
 * ※ 認証情報を含むため、公開リポジトリにはコミットしないこと。
 */
return [
    // Node側 LOLIPOP_MAIL_TOKEN と一致させる長いランダム文字列(例: 48文字以上)
    'token'      => 'CHANGE_ME_TO_A_LONG_RANDOM_TOKEN',

    // ロリポップのSMTP(スタンダードプラン)
    'smtp_host'  => 'smtp.lolipop.jp',
    'smtp_port'  => 465,                          // 465=SSL / 587=STARTTLS
    'smtp_user'  => 'no-reply@e-soft.jp',         // ロリポップで作成したメールアカウント(e-soft.jp)
    'smtp_pass'  => 'YOUR_MAILBOX_PASSWORD',      // そのメールアカウントのパスワード

    // 差出人(メインドメインのアカウント。DKIM/SPFが自動で効き、到達性・信頼性が高い)
    'from_email' => 'no-reply@e-soft.jp',
    'from_name'  => '試薬在庫管理システム',
];
