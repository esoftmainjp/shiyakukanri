<?php
/**
 * 試薬在庫管理システム — メール送信エンドポイント(ロリポップ設置用)
 *
 * Renderアプリの services/mail.js から HTTPS POST(JSON) で呼び出し、
 * ロリポップのSMTP(smtp.lolipop.jp:465 SSL, SMTP AUTH)で送信する。
 * 依存ライブラリ不要(自己完結SMTPクライアント)。
 *
 * 設置: このファイルと mailconfig.php を sendmail.e-soft.jp の公開領域に置く。
 * 認証: 共有トークン(mailconfig.php の token)を X-Auth-Token ヘッダで照合。
 *
 * リクエスト(JSON): { "to": "...", "subject": "...", "text": "...", "replyTo": "..."? }
 * レスポンス(JSON): { "ok": true } / { "ok": false, "error": "..." }
 */

header('Content-Type: application/json; charset=utf-8');
mb_internal_encoding('UTF-8');

function respond($code, $arr) {
    http_response_code($code);
    echo json_encode($arr, JSON_UNESCAPED_UNICODE);
    exit;
}

// POST のみ
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(405, ['ok' => false, 'error' => 'method not allowed']);
}

$cfgPath = __DIR__ . '/mailconfig.php';
if (!is_file($cfgPath)) {
    respond(500, ['ok' => false, 'error' => 'mailconfig.php がありません']);
}
$cfg = require $cfgPath;

// トークン照合(ヘッダ優先、無ければボディ)
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];
$token = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? ($body['token'] ?? '');
if (empty($cfg['token']) || !hash_equals((string)$cfg['token'], (string)$token)) {
    respond(401, ['ok' => false, 'error' => 'unauthorized']);
}

// 入力
$to      = trim((string)($body['to'] ?? ''));
$subject = (string)($body['subject'] ?? '');
$text    = (string)($body['text'] ?? '');
$replyTo = trim((string)($body['replyTo'] ?? ''));

// バリデーション + ヘッダインジェクション対策(改行除去)
$strip = function ($s) { return str_replace(["\r", "\n"], '', $s); };
$to      = $strip($to);
$subject = $strip($subject);
$replyTo = $strip($replyTo);
if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
    respond(400, ['ok' => false, 'error' => '宛先メールアドレスが不正です']);
}
if ($replyTo !== '' && !filter_var($replyTo, FILTER_VALIDATE_EMAIL)) {
    $replyTo = '';
}
if ($subject === '') $subject = '(件名なし)';
if (mb_strlen($text) > 100000) {
    respond(400, ['ok' => false, 'error' => '本文が長すぎます']);
}

// 送信元は設定に固定(なりすまし防止)
$fromEmail = $cfg['from_email'];
$fromName  = $cfg['from_name'] ?? '';

try {
    smtp_send($cfg, $fromEmail, $fromName, $to, $subject, $text, $replyTo);
    respond(200, ['ok' => true]);
} catch (Exception $e) {
    error_log('[send.php] ' . $e->getMessage());
    respond(502, ['ok' => false, 'error' => '送信に失敗しました']);
}

// ---- 自己完結SMTPクライアント ----------------------------------------

function smtp_send($cfg, $fromEmail, $fromName, $to, $subject, $text, $replyTo) {
    $host = $cfg['smtp_host'];
    $port = (int)$cfg['smtp_port'];
    $user = $cfg['smtp_user'];
    $pass = $cfg['smtp_pass'];

    $transport = ($port === 465) ? "ssl://$host" : $host; // 465=SSL, 587=STARTTLS(下で昇格)
    $ctx = stream_context_create();
    $fp = @stream_socket_client("$transport:$port", $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) throw new Exception("接続失敗: $errstr ($errno)");
    stream_set_timeout($fp, 15);

    smtp_expect($fp, 220);
    smtp_cmd($fp, 'EHLO sendmail.e-soft.jp', 250);

    if ($port === 587) { // STARTTLS
        smtp_cmd($fp, 'STARTTLS', 220);
        if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            throw new Exception('STARTTLS失敗');
        }
        smtp_cmd($fp, 'EHLO sendmail.e-soft.jp', 250);
    }

    // AUTH LOGIN
    smtp_cmd($fp, 'AUTH LOGIN', 334);
    smtp_cmd($fp, base64_encode($user), 334);
    smtp_cmd($fp, base64_encode($pass), 235);

    smtp_cmd($fp, 'MAIL FROM:<' . $fromEmail . '>', 250);
    smtp_cmd($fp, 'RCPT TO:<' . $to . '>', [250, 251]);
    smtp_cmd($fp, 'DATA', 354);

    // ヘッダ・本文(UTF-8, base64本文)
    $encSubject = mimeHeader($subject);
    $encFromName = $fromName !== '' ? mimeHeader($fromName) . ' ' : '';
    $domain = substr(strrchr($fromEmail, '@'), 1);
    $headers = [];
    $headers[] = 'From: ' . $encFromName . '<' . $fromEmail . '>';
    $headers[] = 'To: <' . $to . '>';
    if ($replyTo !== '') $headers[] = 'Reply-To: <' . $replyTo . '>';
    $headers[] = 'Subject: ' . $encSubject;
    $headers[] = 'Date: ' . date('r');
    $headers[] = 'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $domain . '>';
    $headers[] = 'MIME-Version: 1.0';
    $headers[] = 'Content-Type: text/plain; charset=UTF-8';
    $headers[] = 'Content-Transfer-Encoding: base64';

    $data = implode("\r\n", $headers) . "\r\n\r\n" . chunk_split(base64_encode($text));
    // ドットスタッフィング(行頭の . を .. に)
    $data = preg_replace('/^\./m', '..', $data);
    $data = str_replace("\n", "\r\n", str_replace("\r\n", "\n", $data));

    fwrite($fp, $data . "\r\n.\r\n");
    smtp_expect($fp, 250);

    smtp_cmd($fp, 'QUIT', 221);
    fclose($fp);
}

function smtp_readline($fp) {
    $data = '';
    while (true) {
        $line = fgets($fp, 515);
        if ($line === false) throw new Exception('SMTP応答なし(タイムアウト)');
        $data .= $line;
        // 継続行(4文字目が '-')でなければ終了
        if (strlen($line) < 4 || $line[3] !== '-') break;
    }
    return $data;
}

function smtp_expect($fp, $expected) {
    $resp = smtp_readline($fp);
    $code = (int)substr($resp, 0, 3);
    $ok = is_array($expected) ? in_array($code, $expected, true) : ($code === $expected);
    if (!$ok) throw new Exception('SMTP応答異常(期待:' . json_encode($expected) . ' 実際:' . trim($resp) . ')');
    return $code;
}

function smtp_cmd($fp, $cmd, $expected) {
    fwrite($fp, $cmd . "\r\n");
    return smtp_expect($fp, $expected);
}

function mimeHeader($s) {
    if (function_exists('mb_encode_mimeheader')) {
        return mb_encode_mimeheader($s, 'UTF-8', 'B', "\r\n");
    }
    return '=?UTF-8?B?' . base64_encode($s) . '?=';
}
