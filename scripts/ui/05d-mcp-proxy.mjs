/**
 * 界面检查分片：设置 →「Agent 工具」→「工具路由」最下面的「给 Agent 的工具」（ADR 0085）：
 * 每个外部服务是代理的还是直接挂的、为什么，被 find 接管没给的工具；关掉代理后原因跟着变；
 * 对话页上经面板代理的外部工具按「服务 · 工具」显示、带 MCP 小标。演示数据由 web/src/lib/demo/demo-mcp-proxy.ts 给。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  await p.getByRole('button', { name: 'Agent 工具', exact: true }).click()
  await p.getByRole('tab', { name: '工具路由' }).click()
  const box = p.locator('[data-exposure-run="claude"]')
  await box.scrollIntoViewIfNeeded()
  await check(p, '设置-工具路由-给Agent的工具', [
    '给 Agent 的工具',
    '外部服务经面板代理',
    '经面板代理：调用都进调用记录，面板补参数、等索引',
    '面板的客户端不支持它的协议，退回直接挂在 CLI 上',
    '这个 CLI 不能只挂面板的服务，照旧直接挂',
    'lua_code → find',
  ])
  if ((await box.locator('[data-exposure-server="idea"] >> text=代理').count()) < 1)
    errors.push('给 Agent 的工具：Claude Code 那一轮 idea 应该是代理的')
  if (await p.locator('[data-exposure-run="codex"] >> text=lua_code → find').count())
    errors.push('给 Agent 的工具：Codex 照旧直接挂时不该藏工具')

  // 关掉代理：每个服务都写「设置里关了代理」，再打开回来
  await p.getByRole('switch', { name: '外部服务经面板代理' }).click()
  await p.getByRole('tab', { name: '调用记录' }).click()
  await p.getByRole('tab', { name: '工具路由' }).click()
  await check(p, '设置-工具路由-关掉代理', ['设置里关了代理，照旧直接挂在 CLI 上'])
  if (await p.locator('text=lua_code → find').count()) errors.push('关掉代理后不该再有被接管没给的工具')
  await p.getByRole('switch', { name: '外部服务经面板代理' }).click()
  // 连点两下回到原样：开关先跟着点击变，不等接口（以前第二下算的是旧值，两次都存成「关」）
  const sw = p.getByRole('switch', { name: '外部服务经面板代理' })
  await sw.click()
  await sw.click()
  await p.waitForTimeout(800)
  if ((await sw.getAttribute('aria-checked')) !== 'true') errors.push('给 Agent 的工具：连点代理开关两下后没有回到打开')

  // 调用记录里代理调用按外部工具记
  await p.getByRole('tab', { name: '调用记录' }).click()
  await p.getByPlaceholder('搜索命令或工具').fill('more_tools')
  await check(p, '设置-调用记录-代理调用', ['面板代理 idea · lua_debug_inspect'])
  // 第一下清掉搜索框的焦点，第二下关设置
  await p.keyboard.press('Escape')
  await p.keyboard.press('Escape')

  // 对话页：经代理的外部工具那一行显示成 idea · lua_debug_inspect，带 MCP 小标
  await p.getByText('购物车右上角的数量角标').first().click()
  const row = p.locator('text=idea · lua_debug_inspect').first()
  await row.waitFor({ timeout: 5000 }).catch(() => errors.push('对话页：代理的外部工具没按「服务 · 工具」显示'))
  await row.scrollIntoViewIfNeeded().catch(() => {})
  await check(p, '对话-代理的外部工具', ['idea · lua_debug_inspect'])
})
