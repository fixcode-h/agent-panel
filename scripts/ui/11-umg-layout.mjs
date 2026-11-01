/**
 * 界面检查分片：算出来的控件位置（shared/umg-layout.ts）和画布真正画出来的一致。
 *
 * 设计 AI 改完控件后拿算出来的位置回读（不用开页面截图），算错了它就会按错的数字改设计。
 * 这里把 shared/umg-layout.fixtures.ts、shared/web-layout.fixtures.ts 的样例树交给画布组件 UmgNode / WebNode（和设计页、截图同一个组件）
 * 在真浏览器里画出来，按截图量位置表的方法（控件本体的 getBoundingClientRect）逐个比对：
 * - 不带 est 的位置必须逐像素一致（误差 ≤ 0.6px）
 * - 带 est 的（按字宽估的文字）允许差几个像素：浏览器里的字体和估算的字宽表本来就对不上
 * 改 umg-render 的排版、或改 umg-layout 的规则时，这里会先报出来。
 *
 * 不走演示版页面：用 esbuild 现场把 scripts/ui/umg-layout/entry.tsx 打成一个脚本，塞进空白页。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runShard } from './harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function bundle() {
  const out = await build({
    entryPoints: [path.join(root, 'scripts/ui/umg-layout/entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    alias: { '@shared': path.join(root, 'shared'), '@': path.join(root, 'web/src') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_DEMO': 'false' },
    logLevel: 'error',
  })
  return out.outputFiles[0].text
}

const near = (a, b, tol) => Math.abs(a - b) <= tol

await runShard(import.meta.filename, async ({ page, check, errors }) => {
  const js = await bundle()
  const p = await page({ width: 2000, height: 1200 })
  await p.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`,
  )
  const count = await p.evaluate(() => window.__count)
  if (!(count > 0)) errors.push('画布排版对照：样例页没有加载起来')
  const webCount = await p.evaluate(() => window.__countWeb)
  // 游戏 UI（UmgNode）和网页（WebNode）两组样例，同一套比对规则
  const runs = [
    ...Array.from({ length: count }, (_, i) => ['__measure', i]),
    ...Array.from({ length: webCount }, (_, i) => ['__measureWeb', i]),
  ]
  for (const [fn, i] of runs) {
    const res = await p.evaluate(([fn, i]) => window[fn](i), [fn, i])
    const tag = `画布排版对照「${res.name}」`
    if (res.dom.length !== res.calc.length)
      errors.push(`${tag}：画布量出 ${res.dom.length} 个控件，算出来 ${res.calc.length} 个`)
    for (const d of res.dom) {
      const c = res.calc.find((x) => x.name === d.name)
      if (!c) {
        errors.push(`${tag}：${d.name} 画布上有，算出来的位置表里没有`)
        continue
      }
      const ok = ['x', 'y', 'w', 'h'].every((k) => {
        const tol = c.est ? Math.max(8, 0.15 * Math.max(d.w, d.h)) : 0.6
        return near(c[k], d[k], tol)
      })
      if (!ok)
        errors.push(
          `${tag}：${d.name} 画布 ${d.x.toFixed(1)},${d.y.toFixed(1)} ${d.w.toFixed(1)}×${d.h.toFixed(1)}，` +
            `算出 ${c.x.toFixed(1)},${c.y.toFixed(1)} ${c.w.toFixed(1)}×${c.h.toFixed(1)}${c.est ? '（估算）' : ''}`,
        )
    }
  }
  await check(p, '画布排版对照')
})
