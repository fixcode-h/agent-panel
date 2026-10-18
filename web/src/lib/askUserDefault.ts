const DEFAULT_KEY = 'ask-user-default'

/**
 * 设置里「新会话默认开启提问」的值。存一份在浏览器里：直接打开某个页面时设置还没从服务端取回来，
 * 要靠它同步拿到，免得新会话先按关着记下来
 */
export function askUserDefault() {
  try {
    return localStorage.getItem(DEFAULT_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberAskUserDefault(on: boolean) {
  try {
    localStorage.setItem(DEFAULT_KEY, on ? '1' : '0')
  } catch {}
}
