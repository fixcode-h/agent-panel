/**
 * 全项目全文搜索的起点（shared/wide-search.ts）：长命令守卫靠它把从项目根起的 grep -r 转后台。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fullScanStarts } from './wide-search.ts'

test('全文递归搜索的起点：grep -r、findstr /s、find | xargs grep、gci -Recurse | sls 认得，rg、不递归、带排除的不算', () => {
  // 用户 2026-11-07 截图里的那条
  assert.deepEqual(
    fullScanStarts(`grep -rl "Win-UE5\\|Win-UE4\\|globals.json" "G:/Project/x/Project" --include="*.ini"`),
    ['G:/Project/x/Project'],
  )
  assert.deepEqual(fullScanStarts('grep -rn foo'), ['.'], '不写路径从当前目录起')
  assert.deepEqual(fullScanStarts('grep -R -e foo -e bar src docs'), ['src', 'docs'], '-e 给了模式，剩下都是路径')
  assert.deepEqual(fullScanStarts('cd a && grep --recursive -A 2 foo .'), ['.'])
  assert.deepEqual(fullScanStarts('findstr /s /i foo *.cpp'), ['.'])
  assert.deepEqual(fullScanStarts('findstr /s foo Source\\*.h'), ['Source'])
  assert.deepEqual(fullScanStarts("find . -name '*.ts' | xargs grep -l foo"), ['.'])
  assert.deepEqual(fullScanStarts('find src -type f -exec grep -l foo {} +'), ['src'])
  assert.deepEqual(fullScanStarts('Get-ChildItem -Recurse -Path G:/p | Select-String foo'), ['G:/p'])
  for (const c of [
    'rg -n foo .',
    'git grep foo',
    'grep -n foo a.ts',
    'grep -rn --exclude-dir=Intermediate foo .',
    "find . -name '*.ts'",
    "find . -name Intermediate -prune -o -name '*.h' -exec grep -l x {} +",
    'Get-ChildItem -Recurse',
    "cat > a.md <<'EOF'\ngrep -r foo .\nEOF",
  ])
    assert.deepEqual(fullScanStarts(c), [], c)
})
