/**
 * 模型设计的 Blender 冒烟测试（docs/adr/0025-model-design-blender.md）：真的起一个 Blender，走一遍
 * 检测 → 执行建模 → 报错回传 → MCP 工具 → 关掉再开（场景从 .blend 接着用）。
 *
 * CI 上没有 Blender，所以不进单测；改了 server/blender.ts、server/blender-mcp.ts、server/blender/bridge.py 后手动跑：
 *   npx tsx scripts/blender-smoke.mjs                                 # 用设置里 / PATH 上的 Blender
 *   AGENT_PANEL_BLENDER_PYTHON=<装了 bpy 的 python> npx tsx scripts/blender-smoke.mjs   # 没装 Blender 本体时用 pip 的 bpy
 * 数据目录用一次性的临时目录，不碰 ~/.agent-panel。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const data = mkdtempSync(path.join(tmpdir(), 'agent-panel-blender-'))
process.env.AGENT_PANEL_DATA = data
const { blenderStatus, runPython, sceneObjects, closeBlender, glbFile, readModelMeta } =
  await import('../server/blender.ts')
const { blenderMcpApi, openBlenderSession } = await import('../server/blender-mcp.ts')

let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failed++
}

try {
  const st = await blenderStatus()
  check(!st.error && !!st.version, `找到 Blender：${st.path} ${st.version}${st.error ? ` · ${st.error}` : ''}`)
  if (st.error) throw new Error(st.error)

  const id = 'smoke-task'
  const r1 = await runPython(
    id,
    `bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
cube = bpy.context.object
cube.name = 'Crate'
mat = bpy.data.materials.new('Wood')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.6, 0.4, 0.2, 1)
cube.data.materials.append(mat)
print('ok', cube.name)`,
  )
  check(r1.ok && r1.output.includes('ok Crate'), '执行建模代码，print 的输出回来了')
  check(r1.meta.version === 1 && r1.meta.objects.some((o) => o.name === 'Crate'), '版本 1，场景里有 Crate')
  check(existsSync(glbFile(id)), '导出了 glb 给网页预览')

  const r2 = await runPython(id, 'x = 1 / 0')
  check(
    !r2.ok && r2.error.includes('ZeroDivisionError') && r2.meta.version === 2,
    '报错只回 Agent 代码那段，版本照样加一',
  )

  const objs = await sceneObjects(id)
  check(objs.length === 1 && objs[0].materials.includes('Wood'), 'blender_scene 读到物体和材质')

  // MCP：和 CLI 同一条路径（JSON-RPC）
  const mcp = openBlenderSession(id)
  const token = mcp.url.split('/').pop()
  const app = blenderMcpApi()
  const rpc = async (method, params) =>
    (
      await app.request(`/blender/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    ).json()
  const list = await rpc('tools/list')
  check(
    list.result.tools.map((t) => t.name).join() === 'blender_python,blender_scene',
    'MCP 列出 blender_python、blender_scene',
  )
  const call = await rpc('tools/call', {
    name: 'blender_python',
    arguments: { code: "bpy.context.scene.objects['Crate'].location.x = 2" },
  })
  const said = call.result.content[0].text
  check(
    !call.result.isError && said.includes('第 3 版') && said.includes('位置 (2, 0, 0.5)'),
    'MCP 调用改了位置，回话里是新场景',
  )
  mcp.close()
  const gone = await app.request(`/blender/${token}`, {
    method: 'POST',
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  })
  check(gone.status === 404, '这一轮结束后令牌失效')

  // 关掉进程再开：场景从 .blend 接着用
  await closeBlender(id)
  const r3 = await runPython(id, 'print(sorted(o.name for o in bpy.data.objects))')
  check(r3.ok && r3.output.includes("['Crate']"), '关掉 Blender 再开，场景还在')
  check((await readModelMeta(id)).version === 4, 'model.json 的版本跟着累加')
  await closeBlender(id)
} catch (e) {
  failed++
  console.log(`✗ ${e.message}`)
} finally {
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} 项失败` : '\nBlender 冒烟测试通过')
process.exit(failed ? 1 : 0)
