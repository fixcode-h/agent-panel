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
import { rewriteAt, searchUnits } from './takeover-segments.ts'
import {
  covered,
  findRequestOfSearch,
  findRequestsOfSearch,
  panelExtras,
  panelSection,
  planTakeover,
  rewriteCommand,
  serveText,
} from './takeover.ts'
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
  // 模型常把看文件、打印分隔和搜索串成一条：只有一个搜索段、输出不再过滤、不中途换目录就接（类别按第一段是 read 也接）
  const tk = (c: string) => planTakeover(shell(c), claude)
  assert.equal(tk('wc -l a.lua && grep -n "SellAll" -r scripts | head -20')?.how, 'rewrite')
  assert.equal(tk('cat Log.lua && echo "=== grep ===" && grep -rn "GetGold" . --exclude-dir=.git')?.how, 'rewrite')
  assert.equal(tk('rg -n "Foo|Bar" src; echo "---"; ls -R scripts')?.how, 'rewrite', '引号里的 | 不是管道')
  assert.notEqual(tk('rg -n OnSellAll src; cd web && rg -n Foo src')?.how, 'rewrite', '中途换了目录')
  // 几个搜索段各接各的，插在各自前面；循环、子 shell 里的整条不接
  const two = tk('rg -n Foo src; echo "---"; grep -rn Bar . | head')
  assert.equal(two?.how, 'rewrite')
  const units = two?.how === 'rewrite' ? two.units : []
  assert.deepEqual(
    units.map((u) => [u.search.pattern, u.at]),
    [
      ['Foo', 0],
      ['Bar', 27],
    ],
  )
  assert.equal(
    rewriteAt('rg -n Foo src; echo "---"; grep -rn Bar . | head', [
      { at: 0, script: 'a.mjs' },
      { at: 27, script: 'C:\\t\\b.mjs' },
    ]),
    'node "a.mjs" && rg -n Foo src; echo "---"; node "C:/t/b.mjs" && grep -rn Bar . | head',
  )
  // 开头一句 `cd <写死的目录> &&`（Claude Code 几乎每条搜索都这么起头）：路径按 cd 的目录算
  const cdRg = tk(
    `cd "G:/P/Content/Script" && rg -n --no-heading "StartGuide" --glob '!Intermediate_UpLoad/**' | head -40`,
  )
  assert.equal(cdRg?.how, 'rewrite', 'cd + rg + head')
  assert.deepEqual(cdRg?.how === 'rewrite' ? cdRg.units[0].search.paths : [], ['G:/P/Content/Script'])
  const cdRel = searchUnits('cd src/ui && grep -rn Foo lib a.lua')
  assert.deepEqual(cdRel?.[0].search.paths, ['src/ui/lib', 'src/ui/a.lua'])
  assert.equal(searchUnits('cd src; grep -rn Foo .'), undefined, '; 连的 cd 失败了还在原目录跑')
  assert.equal(searchUnits('cd $ROOT && grep -rn Foo .'), undefined, '变量')
  assert.equal(searchUnits('cd - && grep -rn Foo .'), undefined, '回上个目录')
  assert.equal(searchUnits('cd a && cd b && grep -rn Foo .'), undefined, '后面又换目录')
  assert.equal(searchUnits('ls && cd a && grep -rn Foo .'), undefined, '不在开头的 cd')
  assert.notEqual(tk('for f in a b; do grep -n Foo $f; done')?.how, 'rewrite', '循环')
  assert.notEqual(tk('(grep -rn Foo .; ls)')?.how, 'rewrite', '子 shell')
  assert.equal(searchUnits('cat a | grep Foo; grep -rn Bar . | wc -l'), undefined, '一个都接不住')
  assert.notEqual(tk('test -f a || grep -rn Foo .')?.how, 'rewrite', '前面是 ||，可能不跑')
  assert.notEqual(tk('cat a && grep -rn Foo . | wc -l')?.how, 'rewrite', '数行数')
  assert.equal(planTakeover(shell('find . -name "*.lua"'), claude)?.how, 'pass', '按名字找文件不改道')
  assert.equal(planTakeover(shell('rg "On.*" src'), claude)?.how, 'pass', '正则')
  // 只有「或」的正则拆成几个原文：grep 不加 -E 是 \|，rg 和 grep -E 是 |；\. 是原文的点
  assert.deepEqual(parseSearchCommand('grep -rn "GetGold\\|AddGold" .')?.alts, ['GetGold', 'AddGold'])
  assert.deepEqual(parseSearchCommand('rg -n "ShopPanel|\\.items" .')?.alts, ['ShopPanel', '.items'])
  assert.deepEqual(parseSearchCommand('grep -rnE "Foo|Bar" .')?.alts, ['Foo', 'Bar'])
  assert.equal(parseSearchCommand('grep -rn "Foo|Bar" .')?.alts, undefined, 'BRE 里 | 是原文')
  assert.equal(parseSearchCommand('rg -n "Log\\.Info" .')?.pattern, 'Log.Info')
  assert.equal(parseSearchCommand('rg -n "Foo|B.*r" .'), undefined, '有别的元字符')
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
  const alt = parseSearchCommand('rg -n "GetGold|AddGold" src')!
  assert.deepEqual(
    findRequestsOfSearch(alt, ['src']).map((r) => r.query),
    ['GetGold', 'AddGold'],
  )
  assert.ok(covered(hit('a.lua', 1, 'x:AddGold(1)'), alt), '任一个出现就算原命令搜得到')
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
