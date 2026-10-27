import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolUse } from './schema.ts'
import { NO_PROBES, addProbes, probeKind, probeTotal, toolFailures, toolsOutsideNodes } from './tool-failures.ts'

const tool = (over: Partial<ToolUse> = {}): ToolUse => ({ kind: 'run', label: 'ls', detail: '', ...over })

test('探路失败：工具不存在、路径不存在、命令不存在分开认，退出码非零的业务失败不算', () => {
  // Pi 读一个不存在的文件：这是不熟目录，不是做错了事
  assert.equal(probeKind(tool({ failed: true, output: 'cat: missing.txt: No such file or directory' })), 'path')
  // 命令名写错
  assert.equal(probeKind(tool({ failed: true, output: 'bash: line 1: rgx: command not found' })), 'command')
  // Windows 上命令不存在
  assert.equal(
    probeKind(tool({ failed: true, output: "'npm.cmd' is not recognized as an internal or external command" })),
    'command',
  )
  // 工具名不存在：CLI 的工具表里没有它
  assert.equal(probeKind(tool({ failed: true, label: 'browser_open', output: 'Unknown tool: browser_open' })), 'tool')
  assert.equal(probeKind(tool({ failed: true, output: 'Tool not found: plan_update' })), 'tool')
  // 正常的执行失败（断言没过、权限、超时）不是探路
  assert.equal(probeKind(tool({ failed: true, exitCode: 1, output: 'failed: 断言没过' })), undefined)
  assert.equal(probeKind(tool({ failed: true, output: 'Permission denied' })), undefined)
  // 没标失败的不算，哪怕输出里带着这几个词
  assert.equal(probeKind(tool({ output: 'No such file or directory' })), undefined)
})

test('探路失败：分类表按原因从窄到宽匹配，工具名优先于命令行里的 No such file', () => {
  // 两个都能匹配时按更具体的那类算：Unknown tool 说的是工具，不是路径
  assert.equal(probeKind(tool({ failed: true, output: 'Unknown tool: read\nNo such file or directory' })), 'tool')
  // 127 只有命令不存在才有，路径不存在不会有
  assert.equal(probeKind(tool({ failed: true, exitCode: 127 })), 'command')
})

test('探路失败：编译、断言失败里带 does not exist 不算探路，Windows 的系统报错算路径', () => {
  // TS 的类型错误、Jest 的断言失败里都有 does not exist，它们不是探路（评审 R1）
  assert.equal(
    probeKind(
      tool({
        failed: true,
        exitCode: 1,
        output: "src/a.ts(3,7): error TS2339: Property 'foo' does not exist on type 'Bar'.",
      }),
    ),
    undefined,
  )
  assert.equal(probeKind(tool({ failed: true, output: 'Expected element does not exist' })), undefined)
  // 带 file / directory / path 的才是路径不存在
  assert.equal(probeKind(tool({ failed: true, output: 'Error: file does not exist: config.json' })), 'path')
  // Windows 的 cmd 说法以前漏计了
  assert.equal(probeKind(tool({ failed: true, output: 'The system cannot find the path specified.' })), 'path')
  assert.equal(probeKind(tool({ failed: true, output: '系统找不到指定的路径。' })), 'path')
})

test('工具调用合计：总数、失败数、探路分类一次遍历算出', () => {
  const stats = toolFailures([
    tool({}),
    tool({ failed: true, output: 'cat: a.txt: No such file or directory' }),
    tool({ failed: true, output: 'bash: line 1: nit: command not found' }),
    tool({ failed: true, output: 'Tool not found: spawn' }),
    tool({ failed: true, exitCode: 2, output: 'error TS2304' }),
  ])
  assert.equal(stats.calls, 5)
  assert.equal(stats.failed, 4)
  assert.deepEqual(stats.probeBy, { tool: 1, path: 1, command: 1 })
  // 探路失败是「失败的调用」里的一部分，不是另一类调用
  assert.equal(probeTotal(stats.probeBy), 3)
})

test('工具调用合计：没有工具调用时全是 0，相加只合并计数', () => {
  assert.deepEqual(toolFailures([]), { calls: 0, failed: 0, probeBy: NO_PROBES })
  assert.deepEqual(addProbes({ tool: 1, path: 0, command: 2 }, { tool: 0, path: 3, command: 0 }), {
    tool: 1,
    path: 3,
    command: 2,
  })
  assert.equal(probeTotal(NO_PROBES), 0)
})

test('节点外的工具调用：任务级总数减各节点合计，负数按 0 算', () => {
  const all = toolFailures([
    tool({}),
    tool({ failed: true, output: 'cat: a.txt: No such file or directory' }),
    tool({ failed: true, output: 'bash: line 1: nit: command not found' }),
    tool({ failed: true, output: 'Tool not found: spawn' }),
  ])
  const node = { calls: 2, failed: 1, probeBy: { tool: 0, path: 1, command: 0 } }
  assert.deepEqual(toolsOutsideNodes(all, [node]), {
    calls: 2,
    failed: 2,
    probeBy: { tool: 1, path: 0, command: 1 },
  })
  // 节点合计比任务级还大时（手改过的数据）不能出现负数
  assert.deepEqual(toolsOutsideNodes(all, [all]), { calls: 0, failed: 0, probeBy: NO_PROBES })
  // 探路分类的差额比失败差额大时（手改过的数据）夹到失败数以内，不出现「失败 1 次、探路 2 次」
  const odd = toolsOutsideNodes({ calls: 3, failed: 1, probeBy: { tool: 1, path: 1, command: 0 } }, [
    { calls: 1, failed: 0, probeBy: NO_PROBES },
  ])
  assert.equal(odd.failed, 1)
  assert.equal(probeTotal(odd.probeBy), 1, '探路合计不能超过失败数')
})
