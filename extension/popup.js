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
