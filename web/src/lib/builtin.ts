import type { BuiltinWorkflow } from '@shared/builtin/workflows'
import { addBuiltinWorkflow as add, type BuiltinState } from '@shared/builtin/install'
import { api } from './api'

export { missingAgents } from '@shared/builtin/install'

/** 工作流页「内置工作流」里点添加：通过接口建 */
export const addBuiltinWorkflow = (w: BuiltinWorkflow, state: BuiltinState) => add(w, state, api)
