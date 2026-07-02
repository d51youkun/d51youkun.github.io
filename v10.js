/**
 * BlueChat v10 — 履歴同期・称号/プレミアム表示・スーパープレミアム・管理者認証
 */
var APP_VERSION = 'v10';

function applyV10Branding() {
  const title = 'BlueChat v10';
  document.title = title;
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = title;
  const logoTitle = document.querySelector('.logo-large h1');
  if (logoTitle) logoTitle.textContent = title;
}

onAppInit(() => {
  applyV10Branding();
});
