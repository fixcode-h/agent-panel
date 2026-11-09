import { z } from 'zod'

/**
 * 模型设计（Blender）前后端共用的结构和提示词，见 docs/adr/0025-model-design-blender.md。
 * 服务端在 server/blender.ts（进程和接口）、server/blender-mcp.ts（给 Agent 的工具）
 */

/** 场景里的一个物体：桥接脚本 /scene 返回的样子 */
export const ModelObject = z.object({
  name: z.string(),
  type: z.string(),
  location: z.array(z.number()).default([0, 0, 0]),
  rotation: z.array(z.number()).default([0, 0, 0]),
  scale: z.array(z.number()).default([1, 1, 1]),
  dimensions: z.array(z.number()).default([0, 0, 0]),
  parent: z.string().default(''),
  collection: z.string().default(''),
  materials: z.array(z.string()).default([]),
  hidden: z.boolean().default(false),
  vertices: z.number().optional(),
  faces: z.number().optional(),
  modifiers: z.array(z.string()).optional(),
})
export type ModelObject = z.infer<typeof ModelObject>

/** 一个模型对话的预览状态：版本号每次执行加一，网页看到变了就重新加载 glb */
export const ModelMeta = z.object({
  version: z.number().int().min(0).catch(0).default(0),
  updatedAt: z.string().default(''),
  objects: z.array(ModelObject).catch([]).default([]),
  /** 导出 glb 失败的原因（场景照样存了 .blend） */
  exportError: z.string().default(''),
})
export type ModelMeta = z.infer<typeof ModelMeta>

/** 物体列表压成给 Agent 看的几行文字：名字、类型、位置、尺寸、面数、材质 */
export function sceneText(objects: ModelObject[]): string {
  if (!objects.length) return '场景是空的。'
  const n = (v: number[]) => v.map((x) => +x.toFixed(3)).join(', ')
  return objects
    .map((o) => {
      const parts = [`${o.name}（${o.type}）`, `位置 (${n(o.location)})`, `尺寸 (${n(o.dimensions)})`]
      if (o.parent) parts.push(`父级 ${o.parent}`)
      if (o.faces !== undefined) parts.push(`${o.faces} 面`)
      if (o.materials.length) parts.push(`材质 ${o.materials.join('、')}`)
      if (o.modifiers?.length) parts.push(`修改器 ${o.modifiers.join('、')}`)
      if (o.hidden) parts.push('隐藏')
      return `- ${parts.join(' · ')}`
    })
    .join('\n')
}

/** 模型对话的提示：工具怎么用、约定是什么（拼在用户消息后面，runner 加） */
export const MODEL_HINT = `## 用 Blender 建模
这是一个模型设计对话，场景在一个后台运行的 Blender 里，用户在网页上实时看到你建出来的模型。
- 用工具 blender_python 执行 bpy 代码来建模、改模型、加材质；每执行一次场景就自动保存并刷新给用户看。可以分几次小步做，每步看一下结果。
- 用工具 blender_scene 查看现在场景里有哪些物体、位置、尺寸和面数。
- 约定：单位是米，Z 轴朝上；每个物体起有意义的英文名字（例如 Chair_Leg_FL），同一部件放进同一个集合；材质用 Principled BSDF，颜色写在 Base Color 上，网页预览才能显示出来。
- 修改器在导出预览时会被应用，几何节点等 Blender 专有的效果预览里可能看不到。
- 不要调用 exit、不要改 Blender 的用户设置或安装插件。`
