// 面板页面上的小脚本：把「允许嵌入」的站点写到 <html data-ap-embed-sites="…">，
// 面板的网页页签据此知道哪些站点扩展会放行（见 web/src/lib/web-view/tabs.ts 的 extensionAllows）。
// 只写站点列表，不读面板页面的任何内容。属性存在（哪怕是空的）就表示装了这一版扩展。
const write = (sites) => {
  document.documentElement.dataset.apEmbedSites = (Array.isArray(sites) ? sites : []).join(' ')
}
chrome.storage.local.get('embedSites').then(({ embedSites }) => write(embedSites))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.embedSites) write(changes.embedSites.newValue)
})
