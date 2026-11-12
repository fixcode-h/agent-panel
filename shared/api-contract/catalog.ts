/**
 * 设置、角色、工作流、分类、标签、项目分类、项目、定时计划的接口契约（写法见 ./define.ts）。
 *
 * 这些接口直接回存盘的那份记录，所以 res 用完整 schema：契约测试（contractProblems）会拦下
 * 「schema 替它补了默认值」的情况，也就是正式后端或演示后端少给了字段。
 */
import { z } from 'zod'
import { Schedule, ScheduleInput } from '../schedule.ts'
import {
  Agent,
  AgentInput,
  Category,
  CategoryInput,
  Project,
  ProjectCategory,
  ProjectCategoryInput,
  ProjectInput,
  Tag,
  TagInput,
  Workflow,
  WorkflowInput,
} from '../schema.ts'
import { Settings } from '../settings-schema.ts'
import { endpoint } from './define.ts'

/** 删除成功回 204，没有返回体 */
const NoContent = z.void()

/** 项目分类带 builtin 标记返回（以固定 id 为准，见 server/index.ts 的 withBuiltinFlag）：不能靠默认值补 */
const ProjectCategoryRow = ProjectCategory.extend({ builtin: z.boolean() })

export const catalogContract = {
  settings: endpoint({ method: 'GET', path: '/settings', res: Settings }),
  saveSettings: endpoint({ method: 'PUT', path: '/settings', body: Settings, res: Settings }),

  categories: endpoint({ method: 'GET', path: '/categories', res: z.array(Category) }),
  createCategory: endpoint({ method: 'POST', path: '/categories', body: CategoryInput, res: Category }),
  /** 改名时不带 scope：沿用原来的 */
  renameCategory: endpoint({
    method: 'PUT',
    path: '/categories/:id',
    body: CategoryInput.partial({ scope: true }),
    res: Category,
  }),
  deleteCategory: endpoint({ method: 'DELETE', path: '/categories/:id', res: NoContent }),

  tags: endpoint({ method: 'GET', path: '/tags', res: z.array(Tag) }),
  createTag: endpoint({ method: 'POST', path: '/tags', body: TagInput, res: Tag }),
  updateTag: endpoint({ method: 'PUT', path: '/tags/:id', body: TagInput, res: Tag }),
  deleteTag: endpoint({ method: 'DELETE', path: '/tags/:id', res: NoContent }),

  agents: endpoint({ method: 'GET', path: '/agents', res: z.array(Agent) }),
  createAgent: endpoint({ method: 'POST', path: '/agents', body: AgentInput, res: Agent }),
  updateAgent: endpoint({ method: 'PUT', path: '/agents/:id', body: AgentInput, res: Agent }),
  deleteAgent: endpoint({ method: 'DELETE', path: '/agents/:id', res: NoContent }),

  workflows: endpoint({ method: 'GET', path: '/workflows', res: z.array(Workflow) }),
  createWorkflow: endpoint({ method: 'POST', path: '/workflows', body: WorkflowInput, res: Workflow }),
  updateWorkflow: endpoint({ method: 'PUT', path: '/workflows/:id', body: WorkflowInput, res: Workflow }),
  deleteWorkflow: endpoint({ method: 'DELETE', path: '/workflows/:id', res: NoContent }),

  projectCategories: endpoint({ method: 'GET', path: '/project-categories', res: z.array(ProjectCategoryRow) }),
  createProjectCategory: endpoint({
    method: 'POST',
    path: '/project-categories',
    body: ProjectCategoryInput,
    res: ProjectCategoryRow,
  }),
  updateProjectCategory: endpoint({
    method: 'PUT',
    path: '/project-categories/:id',
    body: ProjectCategoryInput,
    res: ProjectCategoryRow,
  }),
  deleteProjectCategory: endpoint({ method: 'DELETE', path: '/project-categories/:id', res: NoContent }),

  projects: endpoint({ method: 'GET', path: '/projects', res: z.array(Project) }),
  createProject: endpoint({ method: 'POST', path: '/projects', body: ProjectInput, res: Project }),
  /** 侧栏拖拽后的顺序：body 是全部项目的 id */
  orderProjects: endpoint({ method: 'PUT', path: '/projects/order', body: z.array(z.string()), res: z.array(Project) }),
  deleteProject: endpoint({ method: 'DELETE', path: '/projects/:id', res: NoContent }),

  schedules: endpoint({ method: 'GET', path: '/schedules', res: z.array(Schedule) }),
  createSchedule: endpoint({ method: 'POST', path: '/schedules', body: ScheduleInput, res: Schedule }),
  updateSchedule: endpoint({ method: 'PUT', path: '/schedules/:id', body: ScheduleInput, res: Schedule }),
  deleteSchedule: endpoint({ method: 'DELETE', path: '/schedules/:id', res: NoContent }),
}
