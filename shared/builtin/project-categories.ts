import type { ProjectCategory } from '../schema.ts'
import { t } from '../i18n.ts'

/**
 * 自带的项目分类：新装就有，删不掉（和默认工作流一样不能删）。
 * 判定和补齐都按固定 id，不按名字：用户可以随便改名字、改简介、改默认工作流，标识不会丢；
 * 服务端落盘的数据里也带 builtin 标记，但真正说了算的是这里的 id（旧数据、手改文件缺字段时也一样）。
 * workflowId 留空：用哪个工作流取决于用户自己有哪些工作流，不硬绑内置工作流。
 */
const IDS = [
  'builtin-category-web',
  'builtin-category-game',
  'builtin-category-backend',
  'builtin-category-tools',
  'builtin-category-docs',
] as const

export function isBuiltinProjectCategory(id: string | undefined | null): boolean {
  return !!id && (IDS as readonly string[]).includes(id)
}

/** 不能删这个分类的原因；自建分类返回 null */
export function projectCategoryDeleteError(id: string): string | null {
  return isBuiltinProjectCategory(id) ? t('内置分类不能删除') : null
}

/** 补齐用的那一组内置分类；时间戳固定成 0，避免每次启动都变（数据文件才稳定） */
export function builtinProjectCategories(): ProjectCategory[] {
  const at = new Date(0).toISOString()
  const make = (id: string, name: string, description: string): ProjectCategory => ({
    id,
    createdAt: at,
    updatedAt: at,
    name,
    description,
    workflowId: '',
    builtin: true,
  })
  // 文案写成 t('中文原文') 字面量，i18n 脚本才扫得到
  return [
    make(IDS[0], t('Web 应用'), t('网站、管理后台等前后端分离的 Web 项目')),
    make(IDS[1], t('游戏客户端'), t('Unreal 客户端工程：玩法、关卡和界面')),
    make(IDS[2], t('后端服务'), t('服务端接口、数据库和内部服务')),
    make(IDS[3], t('工具与脚本'), t('命令行工具、自动化脚本、构建与部署')),
    make(IDS[4], t('文档与设计'), t('需求文档、设计稿、界面与素材')),
  ]
}
