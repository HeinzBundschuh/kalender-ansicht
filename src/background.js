// Verwaltungsseite (Monatsliste, Ausblenden/Kompakt) öffnen:
// über die Symbolleisten-Schaltfläche „Ansicht“ und über Extras-Menü.
const PAGE = browser.runtime.getURL("ui/manage.html");

async function openManager() {
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(PAGE));
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
  } else {
    await browser.tabs.create({ url: PAGE });
  }
}

browser.action.onClicked.addListener(openManager);

browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: "kv-manage", title: browser.i18n.getMessage("menuOpen"), contexts: ["tools_menu"] });
  });
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "kv-manage") openManager();
});
