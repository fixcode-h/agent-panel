import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CustomTool, type ToolEntry } from './schema.ts'
import { DIRECT_MAX, callHint, customToolView, directDef, directId, directName, directTools } from './direct.ts'
import { panelToolName } from '../panel-tools.ts'

const tool = (x: Partial<CustomTool> = {}) =>
  CustomTool.parse({
    id: 'lua-pack-incremental',
    name: 'Lua 增量编译',
    summary: '只编改过的 Lua',
    useWhen: '改完 Lua 要生效时',
    avoidWhen: '改了 GDefine.lua',
    run: { command: 'python {{packer}} {{mode}} {{n}}' },
    params: [
      { name: 'packer', label: '打包脚本', type: 'path', default: 'C:/x/generateLuac.py' },
      { name: 'mode', type: 'enum', options: ['pc', 'mobile'], required: true },
      { name: 'n', type: 'number', min: 1, max: 8 },
    ],
    ...x,
  })

test('自建工具直接调：名字和 id 来回换，不是自建工具的名字认不出', () => {
  assert.equal(directName('lua-pack-incremental'), 'tool_lua_pack_incremental')
  assert.equal(directId('tool_lua_pack_incremental'), 'lua-pack-incremental')
  assert.equal(directId('custom_tool'), '')
  assert.equal(directId('tool_'), '')
})

test('自建工具直接调：参数按定义出 schema，有默认值的不算必填，未知参数不收', () => {
  const d = directDef(tool())
  assert.equal(d.name, 'tool_lua_pack_incremental')
  assert.equal(d.title, 'Lua 增量编译')
  assert.deepEqual(d.inputSchema.required, ['mode'])
  assert.equal(d.inputSchema.additionalProperties, false)
  const p = d.inputSchema.properties as Record<string, Record<string, unknown>>
  assert.equal(p.packer.default, 'C:/x/generateLuac.py')
  assert.deepEqual(p.mode.enum, ['pc', 'mobile'])
  assert.equal(p.n.type, 'number')
  assert.equal(p.n.maximum, 8)
  assert.match(d.description, /什么时候用：改完 Lua 要生效时/)
  assert.match(d.description, /什么时候别用：改了 GDefine\.lua/)
  assert.ok(d.description.length <= 1200)
  // 参数全有默认值：说明里让它直接调
  const all = directDef(
    tool({
      params: [
        {
          name: 'packer',
          label: '',
          type: 'path',
          default: 'x',
          desc: '',
          required: true,
          options: [],
          inProject: true,
        },
      ],
    }),
  )
  assert.equal(all.inputSchema.required, undefined)
  assert.match(all.description, /不填参数直接调/)
})

test('自建工具直接调：清单按最近用过排，被盖住的不列，最多 DIRECT_MAX 个', () => {
  const entries: ToolEntry[] = Array.from({ length: DIRECT_MAX + 3 }, (_, i) => ({
    scope: 'project',
    file: `${i}`,
    tool: tool({ id: `t-${String(i).padStart(2, '0')}` }),
    last: { at: `2026-11-${String(10 + i).padStart(2, '0')}`, ok: true, ms: 1, summary: '' },
  }))
  entries.push({ scope: 'global', file: 'g', tool: tool({ id: 'zz-shadow' }), shadowed: true })
  const list = directTools(entries)
  assert.equal(list.length, DIRECT_MAX)
  assert.equal(list[0].name, `tool_t_${DIRECT_MAX + 2}`)
  assert.ok(!list.some((x) => x.name === 'tool_zz_shadow'))
})

test('自建工具直接调：带面板服务名的 tool_<id> 认作面板工具 custom_tool，裸名字不认', () => {
  assert.equal(panelToolName('mcp__panel__tool_lua_pack_incremental'), 'custom_tool')
  assert.equal(panelToolName('mcp__panel-1a2b__tool_lua_check'), 'custom_tool')
  assert.equal(panelToolName('tool_search'), '')
  assert.equal(panelToolName('mcp__panel__custom_tool'), 'custom_tool')
})

test('自建工具直接调：对话里那一行写中文名，调用提示带兜底写法', () => {
  const out = 'Lua 增量编译 lua-pack-incremental · 退出码 0 · 3.1s · 成功\n命令：x'
  assert.deepEqual(customToolView('MCP panel · tool_lua_pack_incremental', { mode: 'pc' }, out), {
    label: 'Lua 增量编译',
    input: '{\n  "mode": "pc"\n}',
  })
  assert.equal(customToolView('MCP panel · tool_lua_check', {}).label, 'lua-check')
  assert.equal(customToolView('MCP panel · custom_tool', { action: 'show', id: 'x' }).label, 'show x')
  assert.match(
    callHint('lua-check', '{"file": "<文件>"}'),
    /^tool_lua_check（参数 \{"file": "<文件>"\}）（工具清单里没有这个名字时用 custom_tool action=run id=lua-check args=/,
  )
})
