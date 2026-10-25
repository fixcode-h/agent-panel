/**
 * 界面检查分片：ComfyUI 工作流和模板商店：分类、搜索、模板详情、依赖下载入口、添加为工作流；手机宽度
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/comfy')
  await p.getByRole('button', { name: '模板商店', exact: true }).click()
  await check(p, '模板商店', ['所有模板', '面板内置', 'Z-Image Turbo · 文本生图', 'SDXL1.0: Text to Image (Simple)'])

  // 搜索：只剩含 SDXL 的模板，内置的 Z-Image 不再出现
  await p.getByLabel('搜索模板').fill('SDXL')
  await settle(p)
  if (await p.getByText('Z-Image Turbo · 文本生图', { exact: false }).count())
    errors.push('模板商店：搜索 SDXL 后 Z-Image 还在')
  await check(p, '模板商店-搜索', ['SDXL1.0: Text to Image (Simple)', '2 个模板'])

  // 详情：节点图、依赖文件、添加按钮
  await p.getByRole('button').filter({ hasText: 'SDXL1.0: Text to Image (Simple)' }).first().click()
  await check(p, '模板详情', ['节点图', '依赖的模型文件', 'sd_xl_base_1.0.safetensors', '添加为工作流'])

  // 添加为工作流：回到工作流页，左侧出现新工作流
  await p.getByRole('button', { name: '添加为工作流', exact: true }).click()
  await p
    .getByText('SDXL1.0: Text to Image (Simple)（副本）', { exact: false })
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('模板商店：添加后没有回到工作流页并选中新工作流'))
  await check(p, '模板添加为工作流')

  // 手机宽度：分类、筛选和卡片都不出横向滚动
  const m = await page({ width: 390, height: 844 })
  await m.goto(base + '#/comfy')
  await m.getByRole('button', { name: '模板商店', exact: true }).click()
  await check(m, '模板商店-手机', ['所有模板', 'SDXL1.0: Text to Image (Simple)'])

  // 工作流链：能建链、选段、看到预览区（演示版没有 ComfyUI，试跑会给出说明）
  // check() 断言的是界面上真看得见的文字；段的下拉框只有 aria-label，用 getByLabel 查
  await p.goto(base + '#/comfy/game')
  await check(p, '工作流链', ['工作流链', '新建链'])
  await p.getByRole('button', { name: '新建链', exact: true }).click()
  await check(p, '工作流链-新建', ['加一段', '试跑', '选原图'])
  await p
    .getByLabel('第 1 段的工作流')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('工作流链：新建后没有第一段的工作流选择器'))
  await p.getByRole('button', { name: '加一段', exact: true }).click()
  await p
    .getByLabel('第 2 段的工作流')
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('工作流链：加一段后没有第二段'))
  await check(p, '工作流链-两段')
})
