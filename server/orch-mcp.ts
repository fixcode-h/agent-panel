/**
 * 编排工具：工作流节点和对话每次调用 CLI 时，绑定在调用它的节点上（执行引擎的 Orchestra）。
 * 节点用它派子 Agent 并行处理、取回结果、查各 Agent 的状态、给别的 Agent 传话；
 * 项目对话用它分派子对话，子对话用它和父对话通讯、认领文件。
 * 它和提问、等下一句这些工具挂在同一个面板 MCP（ask-mcp.ts 的 panel）上：一次调用只连一个面板服务。
 * 工具调用不能等太久（Codex 老版本默认 60 秒超时），等待都有上限；wait_agents 例外，见 WAIT_AGENTS_S
 *
 * 每个工具的条件、定义、用法说明和执行都在注册表里（server/panel-tools/registry.ts），这里只是对外的入口，
 * 调用方照旧从这里取
 */
export { callOrchTool, orchTools } from './panel-tools/registry.ts'
export { WAIT_AGENTS_S } from './panel-tools/spawn.ts'
export { orchHint } from './orch-hint.ts'
