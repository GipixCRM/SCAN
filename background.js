// Клик по иконке открывает боковую панель; вся работа идёт в ней (sidepanel.js), пока она открыта.
// sidePanel есть в Chrome, но в некоторых версиях Яндекс Браузера API ещё
// отсутствует. Это не должно ломать service worker и остальные функции.
try {
  const panelSetup = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  panelSetup?.catch?.(() => {});
} catch { /* sidePanel отсутствует или недоступен в этой версии браузера */ }

// После обновления расширения старая вкладка table.html могла остаться
// открытой со старым JavaScript. Перезагружаем только страницу таблицы.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const url = chrome.runtime.getURL('table.html');
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter(tab => tab.url === url && tab.id).map(tab => chrome.tabs.reload(tab.id).catch(() => {})));
  } catch { /* обновление таблицы не должно ломать service worker */ }
});
