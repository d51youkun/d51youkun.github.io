/**
 * BlueChat v16 — 友だちプロフィール画像の同期改善
 */
var APP_VERSION = 'v16';

if (typeof feedAuthorCardHtml === 'function') {
  const _feedAuthorCardHtmlV16 = feedAuthorCardHtml;
  feedAuthorCardHtml = function (authorId, authorName, authorAvatar) {
    const live = typeof getUser === 'function' ? getUser(authorId) : null;
    return _feedAuthorCardHtmlV16(authorId, live?.name || authorName, live?.avatar || authorAvatar);
  };
}

const _avatarHtmlV16 = avatarHtml;
avatarHtml = function (user, opts = {}) {
  if (user && user.avatar && user.avatarUpdatedAt) {
    const busted = { ...user };
    if (busted.avatar.startsWith('data:')) {
      return _avatarHtmlV16(busted, opts);
    }
    const sep = busted.avatar.includes('?') ? '&' : '?';
    busted.avatar = busted.avatar + sep + 'v=' + user.avatarUpdatedAt;
    return _avatarHtmlV16(busted, opts);
  }
  return _avatarHtmlV16(user, opts);
};

if (typeof handleRemoteActivity === 'function') {
  const _handleRemoteActivityV16 = handleRemoteActivity;
  handleRemoteActivity = async function () {
    if (typeof syncFriendProfiles === 'function') {
      const changed = await syncFriendProfiles();
      if (changed) {
        if (typeof refreshUIAfterSync === 'function') refreshUIAfterSync();
        else refreshMainUI();
      }
    }
    await _handleRemoteActivityV16();
  };
}

const _startGlobalSyncV16 = startGlobalSync;
startGlobalSync = function () {
  _startGlobalSyncV16();
  if (typeof syncFriendProfiles === 'function') {
    syncFriendProfiles().then(changed => {
      if (changed) refreshMainUI();
    }).catch(() => {});
  }
};

onAppInit(() => {});
