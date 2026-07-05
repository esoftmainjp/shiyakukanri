'use strict';

// ログインID(メールアドレス)の簡易形式チェック。送信はしない。
function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

module.exports = { isEmail };
