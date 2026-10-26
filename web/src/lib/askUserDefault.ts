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

const CHILD_KEY = 'ask-user-child-default'

/**
 * 设置里「子对话默认也提问」的值。存一份在浏览器里：直接打开页面时设置还没从服务端取回来，
 * 新开的父对话要按它定「子对话也提问」的初始值（和服务端的 childAskUserDefault 同一个含义）
 */
export function childAskUserDefault() {
  try {
    return localStorage.getItem(CHILD_KEY) !== '0'
  } catch {
    return true
  }
}

export function rememberChildAskUserDefault(on: boolean) {
  try {
    localStorage.setItem(CHILD_KEY, on ? '1' : '0')
  } catch {}
}
