/**
 * 搜索规范（shared/search-spec/，用户 2026-11-27 定：不合规范的搜索直接退回并告诉怎么写）。
 * 用例取自 2026-11-25 ~ 11-27 的任务导出里 Agent 真实发过的命令。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { checkSearchCommand, searchSpecDenyText, searchSpecPrompt, SEARCH_BY_TYPE, type SpecCtx } from './index.ts'
import { FIND_LANGS } from '../capability-router/find/types.ts'

const ctx: SpecCtx = {
  cwd: '/p',
  excludes: ['Saved', 'Intermediate'],
  resolve: (b, p) => path.posix.resolve(b, p),
  scopeOf: (a) =>
    a === '/p'
      ? 'project-root'
      : a === '/' || a === '/home/u'
        ? 'too-wide'
        : a.startsWith('/home/u/.vscode')
          ? 'tool-dir'
          : 'ok',
}
const check = (cmd: string) => checkSearchCommand(cmd, ctx)
const fixed = (cmd: string) => check(cmd)[0]?.fixed

test('合规范的照常放行：rg 限定目录、从项目根带类型、只看一层的 ls、过滤别的命令输出', () => {
  for (const cmd of [
    `cd "/p/Project/Content/Script" && rg -n --no-heading "Dispatch\\(" "Module/X/" | head -20; echo "=== X ==="`,
    `rg -n foo -g '*.lua'`,
    `rg -n -t cpp Foo`,
    `rg --files Content -g '*Clink*.uasset'`,
    `ls Project/Designer/ExcelTool/`,
    `Get-ChildItem Project/x | Select-Object Name`,
    `p4 opened 2>&1 | grep -i "clinkglasses"`,
    `git status --short | Select-String lua`,
    `cat a.lua && echo === && rg -n X scripts | head`,
  ])
    assert.deepEqual(check(cmd), [], cmd)
})

test('grep / find / Get-ChildItem / Select-String / findstr / ls -R 退回并给出等价的 rg', () => {
  assert.equal(
    fixed(`grep -rn "EnterInteract\\|InteractiveAction" "Project/Content/Script/Module" --include=*.lua | head -20`),
    `rg -n 'EnterInteract|InteractiveAction' Project/Content/Script/Module -g '*.lua'`,
    'grep 的基本正则 \\| 换成 rg 的 |',
  )
  assert.equal(
    fixed(`grep -n "^function" "Project/x.lua" | head -30`),
    `rg -n '^function' Project/x.lua`,
    '单文件也只用 rg',
  )
  assert.equal(
    fixed(`grep -c "990001" "Project/a.txt" 2>/dev/null`),
    `rg -n -c 990001 Project/a.txt`,
    '重定向不当成路径',
  )
  assert.equal(fixed(`grep -rn "a(b)" src`), `rg -n 'a\\(b\\)' src`, '基本正则里不带反斜杠的括号是普通字符')
  assert.equal(
    fixed(`find Project/Content -iname "*ClinkGlasses*" -not -path "*/ScriptBytecode/*"`),
    `rg --files Project/Content --iglob '*ClinkGlasses*' -g '!*/ScriptBytecode/*'`,
  )
  assert.equal(fixed(`ls -R Project/x`), `rg --files Project/x`)
  assert.equal(
    fixed(`Select-String -Path "src\\*.lua" -Pattern "PlaySequence"`),
    `rg -n -i PlaySequence src -g '*.lua'`,
    'Select-String 默认不分大小写、路径通配拆成起点和 -g',
  )
  assert.equal(fixed(`findstr /s /i /c:"Foo Bar" *.cpp`), `rg -n -F -i 'Foo Bar' -g '*.cpp'`)
  assert.equal(fixed(`git grep -n Foo -- src`), `rg -n Foo src`)
})

test('换算不出的只给建议，不拿出半截命令', () => {
  const v = check(`find Project/Content/TableData -newermt "2026-11-26 17:00" -type f 2>/dev/null | sort`)
  assert.equal(v.length, 1)
  assert.equal(v[0].fixed, undefined)
  assert.match(v[0].advice.join(), /p4 opened/)
  assert.ok(
    v[0].whys.some((w) => /吞掉/.test(w)),
    '吞报错也一起指出',
  )
})

test('rg 也要合规范：-r、\\|、--no-ignore、吞报错、项目根不带类型、范围太大、翻程序', () => {
  assert.equal(fixed('rg -rn foo src'), 'rg -n foo src')
  assert.equal(fixed('rg -n "A\\|B" src -uu'), 'rg -n "A|B" src')
  assert.match(check('rg -n "A\\|B" src -uu')[0].advice.join(), /把那个目录明确写成起点/, '排除目录要写成起点')
  assert.equal(fixed('rg -n foo src --no-ignore 2>/dev/null'), 'rg -n foo src')
  assert.match(check('rg -n foo')[0].whys.join(), /项目根/)
  assert.match(check('rg -n foo .')[0].whys.join(), /项目根/)
  assert.match(check('rg -n foo /')[0].whys.join(), /范围太大/)
  assert.match(check('cd / && rg -n foo')[0].whys.join(), /范围太大/, 'cd 换过的目录也算')
  const prog = check(`Get-ChildItem -Path "/p" -Recurse -Filter "luac*.exe" -ErrorAction SilentlyContinue`)[0]
  assert.match(prog.whys.join(), /翻找程序/)
  assert.equal(prog.fixed, undefined, '找程序不给 rg 改法')
  assert.match(check(`find "/home/u/.vscode/extensions" -maxdepth 5 -iname 'luac*'`)[0].whys.join(), /程序目录/)
})

test('退回说明：逐段列出问题和改法，最后指回规范', () => {
  const text = searchSpecDenyText(check(`grep -rn foo src && find . -name '*.lua'`))
  assert.match(text, /^【面板】/)
  assert.match(text, /1\. `grep -rn foo src`/)
  assert.match(text, /2\. `find \. -name '\*\.lua'`/)
  assert.match(text, /改成：`rg --files -g '\*\.lua'`/)
  assert.match(text, /搜索规范/)
})

test('规范正文：每一类文件都有写法，排除目录要写成起点', () => {
  for (const id of FIND_LANGS) assert.ok(SEARCH_BY_TYPE[id].lines.length, id)
  const p = searchSpecPrompt({ excludes: ['Saved', 'Intermediate'], git: true })
  assert.match(p, /## 搜索规范/)
  assert.match(p, /排除目录里（Saved、Intermediate）时[^\n]*明确写成起点/)
  assert.match(p, /\.gitignore/)
  assert.match(p, /Lua[\s\S]*C\+\+[\s\S]*配置、数据/)
})
