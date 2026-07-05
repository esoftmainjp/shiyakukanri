'use strict';

// リクエスト単位のコンテキスト(操作施設など)を非同期処理間で持ち回るための仕組み。
// 操作ログに「その操作が行われた施設」を自動付与するために使う。
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// ストア {facilityId} をセットして fn を実行(以降の await 連鎖でも参照可能)
function runWithContext(store, fn) {
  return als.run(store, fn);
}

function getContext() {
  return als.getStore() || {};
}

module.exports = { als, runWithContext, getContext };
