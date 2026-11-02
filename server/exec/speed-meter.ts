import { estTokens } from './transcript.ts'

/**
 * 实时输出速度：最近 3 秒内流式输出的 token 数 ÷ 时间。CLI 只在一次请求结束时才报告真实的输出 token，
 * 所以先按字数估算，拿到真实数字后按「真实 ÷ 估算」校准。
 */
export function speedMeter(onIdle: () => void) {
  const WINDOW = 3000
  let samples: [number, number][] = []
  let est = 0
  let real = 0
  let lastAt = 0
  let genMs = 0
  let tps = 0
  const ratio = () => (est > 50 && real > 0 ? Math.min(3, Math.max(0.5, real / est)) : 1)
  const timer = setInterval(() => {
    if (tps && Date.now() - lastAt > 1500) {
      tps = 0
      samples = []
      onIdle()
    }
  }, 500)
  return {
    /** 流式输出了一段文字；返回新增的生成时间（毫秒） */
    add(text: string) {
      const now = Date.now()
      const gap = lastAt ? now - lastAt : 0
      // 两段输出间隔太久（在跑工具）不算生成时间
      const add = gap < 2000 ? gap : 0
      genMs += add
      lastAt = now
      est += estTokens(text)
      samples.push([now, est])
      while (samples.length > 2 && now - samples[1][0] > WINDOW) samples.shift()
      const [t0, e0] = samples[0]
      const dt = (now - t0) / 1000
      tps = dt > 0.3 ? ((est - e0) / dt) * ratio() : tps
      return add
    },
    real(n: number) {
      real += n
    },
    get tps() {
      return Math.round(tps * 10) / 10
    },
    stop() {
      clearInterval(timer)
      tps = 0
    },
  }
}
