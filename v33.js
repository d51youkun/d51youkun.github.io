/**
 * BlueChat v33 — 起動順序修正（真っ暗画面で止まる問題）
 */
var APP_VERSION = 'v33';

function ensureVisibleScreen() {
  const visible = document.querySelector('.screen:not(.hidden)');
  if (visible) return;
  try {
    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    if (typeof showScreen === 'function') {
      showScreen(user ? 'main' : 'onboarding');
      return;
    }
  } catch (e) { /* fall through */ }
  const onboarding = document.getElementById('screen-onboarding');
  if (onboarding) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.add('hidden');
      s.classList.remove('active');
    });
    onboarding.classList.remove('hidden');
    onboarding.classList.add('active');
  }
}

function bootBlueChat() {
  try {
    init();
  } catch (err) {
    console.error('BlueChat init error:', err);
  }
  ensureVisibleScreen();
}

const _runFastBootSyncV33 = runFastBootSync;
runFastBootSync = function () {
  Promise.resolve(_runFastBootSyncV33()).catch(() => {});
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootBlueChat);
} else {
  bootBlueChat();
}
