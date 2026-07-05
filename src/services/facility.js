'use strict';

// リクエストの「操作対象施設」を判定する共通ヘルパー(マルチテナント)
//
// - 全体管理者(superadmin): セッションで選択中の施設(activeFacilityId)。
//     未選択(null)は「全施設」を意味し、一覧は全施設を横断表示する。
//     登録/更新など施設を特定する操作は、施設未選択だと不可(呼び出し側で 400)。
// - それ以外(admin/general/supplier): 自分の所属施設に固定。全施設アクセスは不可。
//
// 戻り値: { facilityId: number|null, all: boolean }
//   all=true  … 施設を特定しない(全施設横断)。superadmin かつ未選択時のみ。
//   facilityId… 対象施設ID(all=true のときは null)。
function facilityScope(req) {
  const user = req.session && req.session.user;
  if (user && user.userType === 'superadmin') {
    const fid = req.session.activeFacilityId;
    if (fid == null || fid === '') return { facilityId: null, all: true };
    return { facilityId: Number(fid), all: false };
  }
  const fid = (user && user.facilityId != null)
    ? user.facilityId
    : (req.session ? req.session.activeFacilityId : null);
  return { facilityId: fid != null ? Number(fid) : null, all: false };
}

module.exports = { facilityScope };
