/**
 * 查找接管的纯逻辑（ADR 0084 第二期）：搜索命令的参数认法（真实命令样本，含 Windows 写法）、拿不准放行、
 * 改写 / 代答按 CLI 定义的 takeover 字段走、面板补的那段和代答全文是「面板 + 原命令」的并集。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { FindHit } from '../capability-router/find/types.ts'
import { classifyCall } from './classify.ts'
import { parseGrepTool, parseSearchCommand } from './search-args.ts'
import { CliTakeover } from './takeover-spec.ts'
import { findRequestOfSearch, panelExtras, panelSection, planTakeover, rewriteCommand, serveText } from './takeover.ts'
import { getCli } from '../clis.ts'

const shell = (command: string, name = 'Bash') =>
  classifyCall({ kind: 'shell', name, input: { command }, path: '', paths: [] }, { cli: 'x' })
const grepTool = (input: Record<string, unknown>, name = 'Grep') =>
  classifyCall({ kind: 'read', name, input, path: '', paths: [] }, { cli: 'x', spec: { searchTools: [name] } })

test('搜索命令的参数：认得的读出关键词、范围、大小写；拿不准的（正则、变量、不认识的参数、读标准输入）不认', () => {
  const ok: [string, Partial<ReturnType<typeof parseSearchCommand> & object>][] = [
    ['rg -n "OnSellAll" Content/Script', { pattern: 'OnSellAll', paths: ['Content/Script'], ignoreCase: false }],
    ['rg -i -g "*.lua" bag_panel', { pattern: 'bag_panel', include: ['*.lua'], ignoreCase: true }],
    ['rg -S onsellall -t lua', { ignoreCase: true, exts: ['lua'] }],
    ['rg -F "a.b(c)" src', { pattern: 'a.b(c)' }],
    ['rg -n OnSellAll 2>/dev/null', { pattern: 'OnSellAll', paths: [] }],
    ['grep -rn --include=*.h UBagPanel Source', { pattern: 'UBagPanel', include: ['*.h'], paths: ['Source'] }],
    ['grep -rni todo_later .', { ignoreCase: true, paths: ['.'] }],
    ['git grep -n BagPanel -- Source', { program: 'git', pattern: 'BagPanel', paths: ['Source'] }],
    ['bash -lc \'rg -l "Refresh" web\'', { pattern: 'Refresh', paths: ['web'] }],
    // Windows：findstr、Select-String（PowerShell 默认不分大小写）、cmd 外壳、PowerShell 的 & 和 '' 转义
    ['findstr /s /n /c:"OnSellAll" *.lua', { pattern: 'OnSellAll', include: ['*.lua'] }],
    [
      'cmd /c "findstr /s /i BagPanel Source\\*.h"',
      { pattern: 'BagPanel', ignoreCase: true, include: ['*.h'], paths: ['Source'] },
    ],
    [
      "Select-String -Path 'Content\\Script\\*.lua' -Pattern 'OnSellAll'",
      { pattern: 'OnSellAll', ignoreCase: true, paths: ['Content/Script'] },
    ],
    ["sls -Pattern 'it''s' -Path a.txt -CaseSensitive", { pattern: "it's", ignoreCase: false }],
    ['& "C:\\Tools\\rg.exe" -n BagPanel Source', { program: 'rg', pattern: 'BagPanel' }],
  ]
  for (const [cmd, want] of ok) {
    const s = parseSearchCommand(cmd)
    assert.ok(s, `应该认出：${cmd}`)
    for (const [k, v] of Object.entries(want)) assert.deepEqual(s[k as keyof typeof s], v, `${cmd} 的 ${k}`)
  }
  for (const cmd of [
    'rg "On.*All" src', // 正则
    'rg -e a -e b src', // 两个关键词
    'rg --pre ./decode.sh foo', // 会跑别的程序
    'rg -v foo src', // 反选
    'rg "$NAME" src', // 变量
    'rg foo $(git ls-files)', // 命令替换
    'rg foo src > out.txt', // 重定向到文件
    'grep foo', // 不带 -r 又没给文件：读标准输入
    'findstr "Bag Panel" *.h', // 不带 /c: 的空格是「任一个词」
    'Select-String -Pattern Foo', // 没给 -Path：读管道
    'rg x src', // 太短
  ])
    assert.equal(parseSearchCommand(cmd), undefined, `应该放行：${cmd}`)
  // bash 下没加引号的通配由 shell 展开：认得出来，但面板不照原样跑（代答时拿不准）
  assert.equal(parseSearchCommand('rg OnSellAll *.lua')?.run, undefined)
  assert.deepEqual(parseSearchCommand('rg OnSellAll "*.lua"')?.run, { argv: ['rg', 'OnSellAll', '*.lua'] })
  assert.ok(
    parseSearchCommand('Select-String -Path a.lua -Pattern Foo')?.run &&
      'powershell' in parseSearchCommand('Select-String -Path a.lua -Pattern Foo')!.run!,
  )
  // 自带 Grep：ripgrep 形状，照原样跑时拼成 rg；多行、分页这类拿不准
  assert.deepEqual(
    parseGrepTool({ pattern: 'OnSellAll', path: 'Content', glob: '*.lua', output_mode: 'content', '-i': true })?.run,
    {
      argv: ['rg', '-n', '-i', '--glob', '*.lua', '-e', 'OnSellAll', '--', 'Content'],
    },
  )
  assert.equal(parseGrepTool({ pattern: 'a.*b' }), undefined)
  assert.equal(parseGrepTool({ pattern: 'OnSellAll', multiline: true }), undefined)
  assert.equal(parseGrepTool({ pattern: 'OnSellAll', head_limit: 5 }), undefined)
})

test('接不接、怎么接按 CLI 定义的 takeover 走：能改写的改写，不能的代答，都不能、拿不准、多段、找文件的放行', () => {
  const claude = {
    takeover: getCli('claude')!.takeover!,
    rewriteTpl: !!getCli('claude')!.hooks?.events['tool.before']?.rewrite,
  }
  const plain = { takeover: CliTakeover.parse({}), rewriteTpl: false }
  const none = { takeover: CliTakeover.parse({ serve: false }), rewriteTpl: false }
  assert.equal(planTakeover(shell('rg -n OnSellAll Content/Script'), claude)?.how, 'rewrite')
  // 定义说能改写，但钩子没有改写模板：不改写
  assert.equal(planTakeover(shell('rg -n OnSellAll src'), { ...claude, rewriteTpl: false })?.how, 'serve')
  assert.equal(planTakeover(shell('rg -n OnSellAll src'), plain)?.how, 'serve', '没实测的 CLI 按保守值：代答')
  assert.equal(planTakeover(shell('rg -n OnSellAll *.lua'), plain)?.how, 'pass', '代答时照原样跑不了的放行')
  assert.equal(planTakeover(shell('rg -n OnSellAll src'), none)?.how, 'pass')
  // 多段：「搜索 + 截行 / 打印」能改写时接（原命令照样整条跑），数行数、再过滤、代答时都放行
  assert.equal(planTakeover(shell('rg -n OnSellAll src | head -5'), claude)?.how, 'rewrite')
  assert.equal(
    planTakeover(shell('grep -rn "RemoveItem" --exclude-dir=.git . ; echo "---exit:$?"'), claude)?.how,
    'rewrite',
  )
  assert.equal(planTakeover(shell('rg -n OnSellAll src | wc -l'), claude)?.how, 'pass', '数行数')
  assert.equal(planTakeover(shell('rg -n OnSellAll src | grep -v test'), claude)?.how, 'pass', '再过滤')
  assert.notEqual(planTakeover(shell('cat a.lua | grep OnSellAll'), claude)?.how, 'rewrite', '读标准输入')
  assert.equal(planTakeover(shell('rg -n OnSellAll src | head -5'), plain)?.how, 'pass', '代答跑不准多段')
  assert.equal(planTakeover(shell('find . -name "*.lua"'), claude)?.how, 'pass', '按名字找文件不改道')
  assert.equal(planTakeover(shell('rg "On.*" src'), claude)?.how, 'pass', '正则')
  assert.equal(planTakeover(shell('npm test'), claude), undefined, '不归查找的不管')
  // 自带工具：Grep 只能代答，Glob 放行；没登记形状的放行
  assert.equal(planTakeover(grepTool({ pattern: 'OnSellAll' }), claude)?.how, 'serve')
  assert.equal(planTakeover(grepTool({ pattern: '**/*.lua' }, 'Glob'), claude)?.how, 'pass')
  assert.equal(planTakeover(grepTool({ pattern: 'OnSellAll' }), plain)?.how, 'pass')
})

const hit = (file: string, line: number, text: string, rank: 0 | 1 | 2 = 1): FindHit => ({ file, line, text, rank })

test('并集：面板只补声明和原命令按原文搜不到的，范围外的不补；改写先打印面板那段再原样跑原命令，代答原输出一字不改', () => {
  const s = parseSearchCommand('rg -n OnSellAll Content/Script')!
  const req = findRequestOfSearch(s, ['Content/Script'])
  assert.deepEqual([req.kind, req.query, req.under, req.lang], ['refs', 'OnSellAll', ['Content/Script'], 'lua'])
  assert.equal(findRequestOfSearch(parseSearchCommand('rg -F "Sell all" src')!, ['src']).kind, 'text')
  const hits = [
    hit('Content/Script/UI/BagPanel.lua', 212, 'function BagPanel:OnSellAll()', 0),
    hit('Content/Script/UI/BagPanel.lua', 88, 'self.BtnSell.OnClicked:Add(self, self.OnSellAll)'),
    hit('Content/Script/UI/ShopPanel.lua', 41, 'Bag:Call("On" .. action)'),
    hit('Source/Other.cpp', 3, 'OnSellAll()'),
  ]
  const { decls, extras } = panelExtras(hits, s, ['Content/Script'])
  assert.deepEqual(
    decls.map((h) => h.line),
    [212],
  )
  assert.deepEqual(
    extras.map((h) => h.line),
    [41],
    '原命令按原文搜得到的、范围外的都不补',
  )
  const section = panelSection({ decls, extras, served: 'idea · lua_code' })
  assert.match(section, /^\[面板 find · idea · lua_code\]\n声明：\nContent\/Script\/UI\/BagPanel\.lua:212/)
  assert.match(section, /ShopPanel\.lua:41/)
  assert.equal(panelSection({ decls: [], extras: [], served: 'x' }), '', '没有可补的：不改写')

  const original = 'rg -n "OnSellAll" Content/Script'
  assert.equal(
    rewriteCommand(original, 'C:\\Users\\a b\\Temp\\agent-panel-takeover\\1.mjs'),
    'node "C:/Users/a b/Temp/agent-panel-takeover/1.mjs"; rg -n "OnSellAll" Content/Script',
    '原命令放最后（退出码是它的），路径用正斜杠，bash 和 PowerShell 都能跑',
  )

  const output =
    'Content/Script/UI/BagPanel.lua:88:  self.BtnSell.OnClicked:Add(self, self.OnSellAll)\nContent/Script/UI/ShopPanel.lua:41:x\n'
  const served = serveText({ output, decls, extras, served: 'idea · lua_code' })
  assert.match(served, /^结果（面板）\n/)
  assert.ok(served.includes(output.trimEnd()), '原命令的输出原样在里面')
  assert.ok(!/另外找到/.test(served), '原输出里已有的行不再补')
  assert.match(serveText({ output: '', decls: [], extras: [], served: 'x' }), /原命令没有找到/)
})
