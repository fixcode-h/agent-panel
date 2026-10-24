/**
 * 构建指纹的判定规则：哪些改动算「产物过期」、哪些不算，以及提示里要说清怎么修。
 * 这些规则错了会让界面检查悄悄跑旧页面，所以单独钉住。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { checkDemoBuild, describeDemoBuildProblem, writeDemoBuildInfo } from './demo-build-info.mjs'

const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 造一个最小的仓库结构：入口 HTML、前端源码、shared、构建配置，外加一份 demo 产物 */
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-build-info-'))
  dirs.push(root)
  mkdirSync(path.join(root, 'web/src'), { recursive: true })
  mkdirSync(path.join(root, 'shared'), { recursive: true })
  mkdirSync(path.join(root, 'dist-demo'), { recursive: true })
  writeFileSync(path.join(root, 'web/index.html'), '<div id="root"></div>\n')
  writeFileSync(path.join(root, 'web/src/app.tsx'), 'export const app = 1\n')
  writeFileSync(path.join(root, 'web/src/app.test.tsx'), 'test\n')
  writeFileSync(path.join(root, 'shared/schema.ts'), 'export const s = 1\n')
  writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}\n')
  writeFileSync(path.join(root, 'dist-demo/index.html'), '<div id="root"></div>\n')
  const build = () => writeDemoBuildInfo(root, path.join(root, 'dist-demo'))
  return { root, build, out: path.join(root, 'dist-demo') }
}

test('源码没变时产物算新的', () => {
  const { root, build, out } = makeRepo()
  build()
  assert.deepEqual(checkDemoBuild(root, out), { ok: true, reason: '', changed: [] })
  assert.equal(describeDemoBuildProblem(root, out), null)
})

test('改源码后提示具体哪个文件变了，并要求重新构建', () => {
  const { root, build, out } = makeRepo()
  build()
  writeFileSync(path.join(root, 'web/src/app.tsx'), 'export const app = 2\n')
  const r = checkDemoBuild(root, out)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'stale')
  assert.deepEqual(r.changed, ['改动 web/src/app.tsx'])
  const text = describeDemoBuildProblem(root, out)
  assert.match(text, /改动 web\/src\/app\.tsx/)
  assert.match(text, /npx vite build --mode demo/)
})

test('增删源文件也算过期', () => {
  const { root, build, out } = makeRepo()
  build()
  writeFileSync(path.join(root, 'shared/extra.ts'), 'export const e = 1\n')
  assert.deepEqual(checkDemoBuild(root, out).changed, ['新增 shared/extra.ts'])
  build()
  rmSync(path.join(root, 'shared/schema.ts'))
  assert.deepEqual(checkDemoBuild(root, out).changed, ['删除 shared/schema.ts'])
})

test('只改测试文件不需要重新构建', () => {
  const { root, build, out } = makeRepo()
  build()
  writeFileSync(path.join(root, 'web/src/app.test.tsx'), 'test changed\n')
  assert.equal(checkDemoBuild(root, out).ok, true)
})

test('改构建配置或依赖锁文件也算过期', () => {
  const { root, build, out } = makeRepo()
  build()
  writeFileSync(path.join(root, 'vite.config.ts'), 'export default { plugins: [] }\n')
  assert.deepEqual(checkDemoBuild(root, out).changed, ['改动 vite.config.ts'])
  build()
  // 依赖只在锁文件上升级时（package.json 的 range 没变）产物也会变
  writeFileSync(path.join(root, 'package-lock.json'), '{}\n')
  assert.deepEqual(checkDemoBuild(root, out).changed, ['新增 package-lock.json'])
})

test('隐藏文件和编辑器临时文件不算过期', () => {
  const { root, build, out } = makeRepo()
  build()
  writeFileSync(path.join(root, 'web/src/.DS_Store'), 'x')
  writeFileSync(path.join(root, 'web/src/app.tsx.swp'), 'x')
  assert.equal(checkDemoBuild(root, out).ok, true)
})

test('没有产物或没有构建标记时给出各自的提示', () => {
  const { root, out } = makeRepo()
  rmSync(path.join(out, 'index.html'))
  assert.equal(checkDemoBuild(root, out).reason, 'missing-dist')
  assert.match(describeDemoBuildProblem(root, out), /没有演示版产物/)

  const second = makeRepo()
  assert.equal(checkDemoBuild(second.root, second.out).reason, 'missing-info')
  assert.match(describeDemoBuildProblem(second.root, second.out), /构建标记/)
})
