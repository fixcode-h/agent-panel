/** 命令行里认「要改的文件」：p4 edit 的参数、带写动作时点名的资源文件。运行：npm run test:unit */
import assert from 'node:assert/strict'
import test from 'node:test'
import { shellWriteTargets } from './shell-write-targets.ts'

test('p4 edit / open 的文件参数：跳过开关和开关的值、depot 路径和通配符', () => {
  assert.deepEqual(shellWriteTargets('cd D:/P && p4 -c ws edit -c 123 a.xlsx "b c.lua" //depot/x.lua ...'), [
    'a.xlsx',
    'b c.lua',
  ])
  assert.deepEqual(shellWriteTargets('p4 opened a.xlsx'), [])
})

test('带写动作时点名的资源文件算要改；只读不算', () => {
  assert.deepEqual(
    shellWriteTargets(
      `python -c "wb=load_workbook(r'G:\\\\P\\\\Data\\\\A.xlsx'); wb.save(r'G:\\\\P\\\\Data\\\\A.xlsx')"`,
    ),
    ['G:\\\\P\\\\Data\\\\A.xlsx'],
  )
  assert.deepEqual(shellWriteTargets('python dump.py Data/A.xlsx'), [])
  assert.deepEqual(shellWriteTargets('Copy-Item tmp/x.uasset Content/Hero.uasset'), [
    'tmp/x.uasset',
    'Content/Hero.uasset',
  ])
  assert.deepEqual(shellWriteTargets('curl -o a.png https://x.com/a.png && cp a.png b.png'), ['a.png', 'b.png'])
})
