/** 英文词典的一部分，键是中文原文：对话右栏的网页页签、沙箱源、阅读模式 */
export const EN_WEB_VIEW: Record<string, string> = {
  '{host} 不让别的网页嵌入它': "{host} doesn't allow other pages to embed it",
  '{site} · {time} 取回': '{site} · fetched at {time}',
  '交给浏览器的新标签页，登录状态、交互都在。':
    'Hand it to a new browser tab, with your sign-ins and full interactivity.',
  '以后 {host} 直接用阅读模式打开': 'Always open {host} in reader mode',
  '允许嵌入（要装面板浏览器扩展）': 'Allow embedding (needs the panel browser extension)',
  关闭网页: 'Close page',
  前进: 'Forward',
  后退: 'Back',
  '取不到这个网页：{why}': "Couldn't fetch this page: {why}",
  '取不到这个网页：对方返回 {code}': "Couldn't fetch this page: the site returned {code}",
  '只能打开 http 或 https 的网址': 'Only http or https addresses can be opened',
  '只能打开对话目录、项目目录和插件目录里的文件':
    'Only files in the conversation folder, the project folder or the plugins folder can be opened',
  在新窗口打开: 'Open in new window',
  '地址已过期，请在页签里刷新': 'This address has expired. Refresh the tab',
  '对方的内容安全策略只允许 {v} 嵌入': "The site's content security policy only allows {v} to embed it",
  '对方设置了 X-Frame-Options: {v}，不允许被别的网页嵌入':
    'The site sets X-Frame-Options: {v} and refuses to be embedded',
  打开网页的参数不对: 'Invalid parameters for opening the page',
  '扩展只对面板页签里的网页去掉这两个响应头，你在别处打开的网页不受影响。装上新版扩展后，在扩展弹窗的「允许嵌入」里加上 {host}。':
    'The extension strips these two response headers only for pages inside panel tabs; pages you open elsewhere are unaffected. After installing the latest extension, add {host} under "Allow embedding" in its popup.',
  '文件不存在：{path}': 'File not found: {path}',
  '文件太大，超过 {mb} MB': 'File is too large (over {mb} MB)',
  '本机文件 · 沙箱': 'Local file · sandboxed',
  '正在取回网页…': 'Fetching page…',
  '点浏览器工具栏里的 Agent 面板扩展，在「允许嵌入」里加上 {host}，再刷新这个页签。扩展只对面板页签里的网页去掉这两个响应头。':
    'Click the Agent Panel extension in the browser toolbar, add {host} under "Allow embedding", then refresh this tab. The extension strips these two response headers only for pages inside panel tabs.',
  用阅读模式看: 'Use reader mode',
  '这个地址不是网页（{type}），阅读模式只能读网页':
    'This address is not a web page ({type}); reader mode only reads web pages',
  这个网站不允许被嵌入: "This site doesn't allow embedding",
  这个网页没有能取出来的正文: 'No readable content could be extracted from this page',
  退出阅读模式: 'Exit reader mode',
  阅读模式: 'Reader mode',
  '阅读模式不运行页面脚本，视频、交互演示不会显示；要完整看点地址栏右边的「在新窗口打开」。':
    'Reader mode runs no page scripts, so videos and interactive demos are not shown. For the full page, use "Open in new window" at the right of the address bar.',
  '面板在本机取回页面，只留正文、图片和代码块，去掉脚本后显示。不带你在浏览器里的登录状态。':
    'The panel fetches the page locally and shows only the text, images and code blocks, with scripts removed. Your browser sign-ins are not used.',
  '{reason}。浏览器不会把它放进页签，换个方式看：': "{reason}. The browser won't show it in a tab. Try another way:",
  '缩略图（mode="thumb"）': 'Thumbnail (mode="thumb")',
  '整页（mode="full"），页面关在沙箱里': 'Full page (mode="full"), sandboxed',
  示例网页: 'Sample page',
  插件页面: 'Plugin page',
  '插件 {id} 没有装好，打不开它的页面': "Plugin {id} isn't installed properly, so its page can't be opened",
  只能打开插件目录里的文件: 'Only files in the plugin folder can be opened',
}
