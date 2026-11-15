const $ = (id) => document.getElementById(id)

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' })
  $('state').className = 'row' + (s?.connected ? ' ok' : '')
  $('text').textContent = s?.connected ? '已连接到 Agent 面板' : '没有连上面板：请确认面板正在运行、端口正确'
  $('tabs').textContent = s?.tabs ? `找到 ${s.tabs} 个 Gemini / ChatGPT 标签页` : '还没有打开 Gemini 或 ChatGPT'
}

chrome.storage.local.get('port').then(({ port }) => ($('port').value = port || ''))
$('port').addEventListener('change', async (e) => {
  const v = e.target.value.replace(/\D/g, '')
  await chrome.storage.local.set({ port: v ? Number(v) : 0 })
  void refresh()
})
void refresh()

// ---- 允许嵌入：按站点，加的时候向浏览器要这个站点的权限（用户点了才要，不要全部网站） ----
const siteOf = (text) => {
  const v = text.trim().toLowerCase()
  if (!v) return ''
  try {
    return new URL(/^[a-z]+:\/\//.test(v) ? v : `https://${v}`).hostname
  } catch {
    return ''
  }
}

async function renderSites() {
  const { embedSites = [] } = await chrome.storage.local.get('embedSites')
  const ul = $('sites')
  ul.replaceChildren()
  for (const site of embedSites) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = site
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = '移除'
    del.addEventListener('click', async () => {
      const cur = (await chrome.storage.local.get('embedSites')).embedSites ?? []
      await chrome.storage.local.set({ embedSites: cur.filter((x) => x !== site) })
      void chrome.permissions.remove({ origins: [`https://${site}/*`, `http://${site}/*`] }).catch(() => {})
      void renderSites()
    })
    li.append(name, del)
    ul.append(li)
  }
}

$('add').addEventListener('click', () => {
  const site = siteOf($('site').value)
  if (!site) return
  // permissions.request 必须在点击的同一拍里调，先要权限再存
  chrome.permissions.request({ origins: [`https://${site}/*`, `http://${site}/*`] }).then(async (ok) => {
    if (!ok) return
    const cur = (await chrome.storage.local.get('embedSites')).embedSites ?? []
    if (!cur.includes(site)) await chrome.storage.local.set({ embedSites: [...cur, site] })
    $('site').value = ''
    void renderSites()
  })
})
void renderSites()
