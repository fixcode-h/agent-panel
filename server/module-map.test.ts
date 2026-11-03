import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { syncManagedModuleMap } from './module-map.ts'
import { MAP_BEGIN } from '../shared/module-docs.ts'

test('每轮结束时的地图同步：没有地图就建、内容一样不写，旧的手写地图不自动改', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'module-map-'))
  try {
    mkdirSync(path.join(root, 'modules/calc'), { recursive: true })
    writeFileSync(path.join(root, 'modules/calc/README.md'), '# calc：计算\n\n- 职责：加减乘除\n- 源码：`src/`\n')
    const first = await syncManagedModuleMap(root)
    assert.equal(first.changed, true)
    const map = readFileSync(path.join(root, 'MODULE-MAP.md'), 'utf8')
    assert.ok(map.includes(MAP_BEGIN) && map.includes('| calc | `src/` | 加减乘除 |'))
    assert.equal((await syncManagedModuleMap(root)).changed, false, '再跑一次不改文件')
    // 用户项目里旧的手写地图：不动它
    writeFileSync(path.join(root, 'MODULE-MAP.md'), '# 地图\n\n| 模块 | 文档 |\n| --- | --- |\n| x | y |\n')
    assert.equal((await syncManagedModuleMap(root)).changed, false)
    assert.match(readFileSync(path.join(root, 'MODULE-MAP.md'), 'utf8'), /\| x \| y \|/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
