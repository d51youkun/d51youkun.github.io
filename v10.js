/**
 * BlueChat v10 — 履歴同期・称号/プレミアム表示・スーパープレミアム・管理者認証
 */
var APP_VERSION = 'v10';
const BUILD_STAMP = '2026-07-02-v10';

function applyAppBranding() {
  const title = 'BlueChat v10';
  document.title = title;
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = title;
  const logoTitle = document.querySelector('.logo-large h1');
  if (logoTitle) logoTitle.textContent = title;
}

onAppInit(() => {
  applyAppBranding();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyAppBranding);
} else {
  applyAppBranding();
}
