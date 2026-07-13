/**
 * BlueChat v18 — プロフィール画像同期と通知の再定義
 */
var APP_VERSION = 'v18';

function syncFriendProfilesBatch() {
  const user = getCurrentUser();
  if (!user || !getSyncUrl()) return Promise.resolve(false);
  let friendIds = getFriends(user.id).map(f => String(f.id));
  return cloudFetchFriendIds(user.id).then(remoteIds => {
    if (Array.isArray(remoteIds)) {
      remoteIds.forEach(id => {
        const fid = String(id);
        if (fid !== String(user.id) && !friendIds.includes(fid)) friendIds.push(fid);
      });
    }
    return cloudRequest('/api/users/list');
  }).then(allUsers => {
    if (!Array.isArray(allUsers)) return false;
    const byId = new Map(allUsers.map(u => [String(u.id), u]));
    let changed = false;
    friendIds.forEach(friendId => {
      if (String(friendId) === String(user.id)) return;
      const remoteUser = byId.get(String(friendId));
      if (!remoteUser) return;
      ensureLocalUser(remoteUser);
      if (applyRemoteUserFields(friendId, remoteUser)) changed = true;
    });
    return changed;
  }).catch(() => false);
}

if (typeof syncFriendProfiles === 'function') {
  const _syncFriendProfilesV18 = syncFriendProfiles;
  syncFriendProfiles = async function () {
    const batchChanged = await syncFriendProfilesBatch();
    const legacyChanged = await _syncFriendProfilesV18();
    return batchChanged || legacyChanged;
  };
}

const _syncCurrentUserModerationV18 = syncCurrentUserModeration;
syncCurrentUserModeration = async function () {
  await syncCurrentUserProfile();
  return _syncCurrentUserModerationV18();
};

const _handleRemoteActivityV18 = handleRemoteActivity;
handleRemoteActivity = async function () {
  if (typeof suppressNotificationsFor === 'function') suppressNotificationsFor(4000);
  if (typeof syncCurrentUserProfile === 'function') await syncCurrentUserProfile();
  if (typeof syncFriendProfiles === 'function') {
    const profilesChanged = await syncFriendProfiles();
    if (profilesChanged) {
      if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
      else refreshMainUI();
    }
  }
  await _handleRemoteActivityV18();
};

const _setUserAvatarV18 = setUserAvatar;
setUserAvatar = function (userId, dataUrl) {
  const ok = _setUserAvatarV18(userId, dataUrl);
  if (ok) {
    const user = getUser(userId);
    if (user) cloudPushUser(user).catch(() => {});
    refreshMainUI();
  }
  return ok;
};

const _removeUserAvatarV18 = removeUserAvatar;
removeUserAvatar = function (userId) {
  _removeUserAvatarV18(userId);
  const user = getUser(userId);
  if (user) cloudPushUser(user).catch(() => {});
  refreshMainUI();
};
