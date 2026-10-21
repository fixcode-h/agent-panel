import type { Project, ProjectCategory, Workflow } from './schema.ts'
import { DEFAULT_WORKFLOW_ID } from './builtin/default.ts'
import { GENERAL_NAME, GENERAL_ORIGIN } from './builtin/workflows.ts'

type ProjectRef = Pick<Project, 'workflowId' | 'categoryId'>
type CategoryRef = Pick<ProjectCategory, 'id' | 'workflowId'>

/**
 * 项目对话用的工作流 id：项目自己指定 → 分类默认。
 * 内置的「默认」工作流是通用入口，不作为项目的默认：项目对话要有常驻编排器。
 */
export function projectWorkflowId(project: ProjectRef | undefined, categories: CategoryRef[]) {
  const id = project ? project.workflowId || categories.find((c) => c.id === project.categoryId)?.workflowId || '' : ''
  return id === DEFAULT_WORKFLOW_ID ? '' : id
}

/** 项目实际用的工作流：项目指定 → 分类默认 → 内置「通用项目」；没装通用项目时才退回内置「默认」 */
export function projectDefaultWorkflow(
  project: ProjectRef | undefined,
  categories: CategoryRef[],
  workflows: Workflow[],
) {
  const id = projectWorkflowId(project, categories)
  const own = id ? workflows.find((w) => w.id === id) : undefined
  const general = workflows.find((w) => w.origin === GENERAL_ORIGIN) ?? workflows.find((w) => w.name === GENERAL_NAME)
  return own ?? general ?? workflows.find((w) => w.id === DEFAULT_WORKFLOW_ID)
}
