import type { BuiltinWorkflow } from '@shared/builtin/workflows'
import { addBuiltinAgents as addAgents, addBuiltinWorkflow as add, type BuiltinState } from '@shared/builtin/install'
import { api } from './api'

export { addedBuiltin, missingAgents } from '@shared/builtin/install'

/** 工作流页「内置工作流」里点添加：通过接口建 */
export const addBuiltinWorkflow = (w: BuiltinWorkflow, state: BuiltinState) => add(w, state, api)

/** Agent 页「内置 Agent」里点添加 */
export const addBuiltinAgents = (keys: string[], state: BuiltinState) => addAgents(keys, state, api)
