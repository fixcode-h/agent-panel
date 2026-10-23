/**
 * 演示里模拟的等待（请求延迟、流式输出、安装和下载进度、授权）都按这个倍数缩短。
 * 界面检查（scripts/ui-check.mjs）在页面加载前往 localStorage 写 agent-panel-demo-speed：
 * 截图只看过程和结果，不必陪着模拟的进度真等；正常打开在线演示时没有这一项，倍数是 1，观感不变。
 */
const KEY = 'agent-panel-demo-speed'

const speed = (() => {
  try {
    return Math.max(1, Number(localStorage.getItem(KEY)) || 1)
  } catch {
    return 1
  }
})()

/** 模拟等待的毫秒数换算成这次实际要等的 */
export const demoMs = (ms: number) => ms / speed
