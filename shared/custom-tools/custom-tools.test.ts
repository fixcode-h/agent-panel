import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkArgs,
  commandTemplate,
  draftProblems,
  expandCommand,
  insideRoot,
  needsConfirm,
  quoteFor,
} from './expand.ts'
import { commandPrint, findDups } from './dup.ts'
import { customToolFor, programOf } from './match.ts'
import { CustomTool, nextVersion, type ToolEntry } from './schema.ts'
import { hintText, listText, parseErrors, runText, toolCommandPrompt } from './text.ts'

const tool = (x: Partial<CustomTool> = {}) =>
  CustomTool.parse({
    id: 'export-tables',
    name: '导表',
    useWhen: '改了 Excel 配置表之后',
    run: { command: 'python tools/export.py {{sheet}} {{out}} {{dry}}' },
    params: [
      { name: 'sheet', label: '表名', type: 'string' },
      { name: 'out', type: 'path', flag: '--out', default: 'Content/Config' },
      { name: 'dry', type: 'boolean', flag: '--dry-run' },
    ],
    ...x,
  })

test('自建工具：按 shell 加引号，cmd 里带 " 和 % 的值、任何 shell 里的换行直接拒绝', () => {
  assert.equal(quoteFor('sh', 'a.txt'), 'a.txt')
  assert.equal(quoteFor('sh', "it's a"), `'it'\\''s a'`)
  assert.equal(quoteFor('powershell', "it's a"), "'it''s a'")
  assert.equal(quoteFor('cmd', 'a b'), '"a b"')
  assert.equal(quoteFor('cmd', 'a"b'), null)
  assert.equal(quoteFor('cmd', '50%'), null)
  assert.equal(quoteFor('sh', 'a\nb'), null)
  // 命令注入只会变成一个带引号的参数
  assert.equal(quoteFor('sh', 'x; rm -rf /'), `'x; rm -rf /'`)
})

test('自建工具：参数校验（未知参数、必填、类型、选项、范围、项目外路径）', () => {
  const t = tool({
    params: [
      { name: 'n', type: 'number', min: 1, max: 9, required: true, label: '', desc: '', options: [], inProject: true },
      { name: 'mode', type: 'enum', options: ['a', 'b'], label: '', desc: '', required: false, inProject: true },
      { name: 'file', type: 'path', label: '', desc: '', required: false, options: [], inProject: true },
    ],
  })
  assert.deepEqual(checkArgs(t, { n: '3', mode: 'a', file: 'src/x.lua' }, '/p').errors, [])
  assert.equal(checkArgs(t, { n: '3' }).values.n, 3)
  const bad = checkArgs(t, { n: 20, mode: 'c', file: '../../etc/passwd', typo: 1 }, '/p').errors
  assert.equal(bad.length, 4)
  assert.match(bad[0], /没有参数 typo/)
  assert.match(checkArgs(t, {}).errors[0], /缺参数 n/)
  assert.ok(insideRoot('/p', '/p/a/b'))
  assert.ok(!insideRoot('/p', '/pp/a'))
  assert.ok(insideRoot('C:\\Work\\P', 'c:/work/p/x'))
})

test('自建工具：展开命令，空值和假值连同开关去掉，值里的连续空格原样保留', () => {
  const t = tool()
  const v = checkArgs(t, { sheet: 'Item  Table', dry: true }).values
  assert.deepEqual(expandCommand(t.run.command, t, v, 'sh', {}), {
    line: `python tools/export.py 'Item  Table' --out Content/Config --dry-run`,
  })
  const v2 = checkArgs(t, { out: '' }).values
  assert.equal(expandCommand(t.run.command, t, v2, 'sh', {}).line, 'python tools/export.py --out Content/Config')
  const r = expandCommand('run {{script}} {{nope}}', t, {}, 'sh', {})
  assert.match(r.error!, /\{\{script\}\} 在这里没有值/)
  assert.match(r.error!, /\{\{nope\}\} 不是参数/)
  assert.equal(commandTemplate(tool({ run: { ...t.run, win: 'export.bat' } }), 'win32'), 'export.bat')
  assert.deepEqual(draftProblems(tool({ run: { ...t.run, command: 'x {{y}}' } })), ['命令里的 {{y}} 不是参数'])
})

test('自建工具：查重认同 id、相近的名字、去掉参数后一样的命令', () => {
  const entries: ToolEntry[] = [{ scope: 'project', file: 'a.json', tool: tool() }]
  assert.equal(commandPrint(`python "tools\\export.py" {{x}}`), 'python tools/export.py')
  const same = findDups({ id: 'export-tables', name: '别的', run: { command: 'x' } }, entries)
  assert.equal(same[0].sameId, true)
  const like = findDups({ id: 'exp2', name: '导表工具', run: { command: 'python tools/export.py {{a}}' } }, entries)
  assert.equal(like[0].why, '名字很像、命令一样（不算参数）')
  assert.deepEqual(findDups({ id: 'lua', name: 'Lua 检查', run: { command: 'luac -p' } }, entries), [])
})

test('自建工具：存一版时版本 +1，旧版进历史且带它自己的说明', () => {
  const v1 = nextVersion(tool(), undefined, { note: '第一版', now: '2026-01-01' })
  assert.equal(v1.version, 1)
  const v2 = nextVersion(tool({ name: '导表2' }), v1, { note: '改名', now: '2026-01-02' })
  assert.equal(v2.version, 2)
  assert.equal(v2.note, '改名')
  assert.deepEqual(
    v2.history.map((h) => [h.version, h.note]),
    [[1, '第一版']],
  )
  let cur = v2
  for (let i = 0; i < 8; i++) cur = nextVersion(tool(), cur, { now: '2026-01-03' })
  assert.equal(cur.history.length, 5)
})

test('自建工具：提示词清单、列表、运行结果都按长度上限', () => {
  const entries: ToolEntry[] = [
    { scope: 'project', file: 'a', tool: tool() },
    { scope: 'global', file: 'b', tool: tool(), shadowed: true },
  ]
  const hint = hintText(entries)
  assert.match(hint, /tool_export_tables（导表）：改了 Excel 配置表之后/)
  assert.doesNotMatch(hint, /action=show/)
  assert.equal(hintText([]), '')
  // 顶替的程序写进清单：一开始就知道别自己拼 luac
  const lua = {
    ...tool(),
    id: 'lua-check',
    name: 'Lua 检查',
    role: { kind: 'verify' as const, paths: ['**/*.lua'], replaces: ['luac'], listFile: false },
  }
  assert.match(hintText([{ scope: 'project', file: 'c', tool: lua }]), /tool_lua_check（Lua 检查，代替 luac）：/)
  assert.match(listText(entries, 'excel'), /export-tables「导表」\[项目/)
  assert.match(listText(entries, 'zzz'), /没有和「zzz」相关/)
  const errs = parseErrors(['ok', 'Item.xlsx:12: 缺列 ID'], '^(?<file>[^:]+):(?<line>\\d+): (?<msg>.*)$')
  assert.deepEqual(errs, [{ file: 'Item.xlsx', line: 12, msg: '缺列 ID' }])
  const text = runText(tool(), { ok: false, code: 1, ms: 1200, line: 'x', errors: errs, tail: ['a'], totalLines: 1 })
  assert.match(text, /退出码 1 · 1\.2s · 失败/)
  assert.match(text, /Item\.xlsx:12: 缺列 ID/)
  assert.ok(text.length <= 4000)
  assert.match(toolCommandPrompt('export-tables', '只导 Item'), /直接调 tool_export_tables[\s\S]*只导 Item/)
})

test('自建工具：按命令里的程序名或脚本名认出对应的工具', () => {
  assert.equal(programOf('luac -p {{file}}'), 'luac')
  assert.equal(programOf('"C:\\Tools\\luac.exe" -p {{file}}'), 'luac')
  assert.equal(programOf('python Tools/check_lua.py {{dir}}'), 'check_lua.py')
  assert.equal(programOf('cmd /c build.bat {{x}}'), 'build')
  assert.equal(programOf('{{script}}'), '')
  assert.equal(programOf('python {{script}}'), '')
  const tools = [{ id: 'check', name: '检查', sigs: ['check_lua.py'] }]
  assert.equal(customToolFor('python3 .\\Tools\\check_lua.py Script', tools)?.id, 'check')
  assert.equal(customToolFor('python other.py', tools), undefined)
})

test('自建工具：已保存的默认不弹授权卡（会改文件、影响外部的也一样），设了 confirm 才问；草稿不是只读的照旧问', () => {
  const tool = (x: Record<string, unknown>) =>
    CustomTool.parse({ id: 'pack', name: '打包', run: { command: 'pack' }, ...x })
  assert.equal(tool({}).confirm, false, '旧文件没有这个字段，读进来是不问')
  for (const effect of ['read', 'write', 'external']) assert.equal(needsConfirm(tool({ effect }), false), false)
  assert.equal(needsConfirm(tool({ effect: 'read', confirm: true }), false), true)
  assert.equal(needsConfirm(tool({ effect: 'write' }), true), true)
  assert.equal(needsConfirm(tool({ effect: 'read', confirm: true }), true), false)
})
