/**
 * 已知的代码查找类 MCP 工具：按用途分组，每个写一句「什么时候用」，拼进提示词「搜索（这个项目）」一节。
 *
 * 为什么不只靠 code-index.ts 的名字正则：正则要名字里同时有「搜 / 找」和「符号 / 代码」这类词，
 * UEToVS 的 get_members、suggest_include、get_reflection_info 和 IDE 里 EmmyLua 的 lua_code 都认不出来，
 * 写 UE C++ 时最该先用的「看成员签名」「该 include 哪个头」从没进过提示词，Agent 只能凭记忆写引擎 API、
 * 或者在自己文件里另写一个已有的函数（用户 2026-11-21 报：管家头衔那次没用现成的 GetDecorationActorTopLocation）。
 * 所以常见服务的工具在这里登记用途；这里没有的陌生服务才交给正则兜底。新认一个工具只加一行。
 * 交给 Agent 的话是提示词，不翻译
 */

/** 用途：决定在提示词里排在哪一组，顺序就是 CODE_TOOL_USES 的顺序 */
export type CodeToolUse = 'find' | 'shape' | 'refs' | 'deps' | 'other'

/** 各组的名字和顺序：先找到、再看清结构和签名、再查谁在用、最后是 include / 模块依赖和配置资源 */
export const CODE_TOOL_USES: { use: CodeToolUse; label: string }[] = [
  { use: 'find', label: '找声明和文件' },
  { use: 'shape', label: '看结构和签名' },
  { use: 'refs', label: '查引用和调用' },
  { use: 'deps', label: 'include 和模块依赖' },
  { use: 'other', label: '配置、蓝图和其他' },
]

export interface KnownCodeTool {
  use: CodeToolUse
  /** 什么时候用：一句话，写给模型看 */
  when: string
}

/**
 * 按工具名登记。名字在 UEToVS、JetBrains IDE 和 EmmyLua 插件里都是唯一的，不用再按服务名区分；
 * 别家服务碰巧同名时用途也一样（search_symbols 就是按名字找符号）
 */
export const KNOWN_CODE_TOOLS: Record<string, KnownCodeTool> = {
  // UEToVS（VS 里的 C++ 索引，scope: all 时包括引擎源码）
  search_symbols: {
    use: 'find',
    when: '按名字找类、函数、变量、宏（可按 UFUNCTION / UPROPERTY 过滤）；`scope: all` 连引擎源码一起找',
  },
  search_files: { use: 'find', when: '按文件名找源码文件' },
  go_to_definition: { use: 'shape', when: '跳到定义，看函数的真实签名和实现' },
  get_members: {
    use: 'shape',
    when: '列一个类的成员和签名（`include_inherited` 连父类）；调用某个类的函数前先查，不凭记忆写函数名和参数',
  },
  get_type_hierarchy: { use: 'shape', when: '看基类链和派生类' },
  get_reflection_info: { use: 'shape', when: '一个 UCLASS / USTRUCT 的全部 UPROPERTY、UFUNCTION 和说明符' },
  get_file_outline: { use: 'shape', when: '文件大纲：先看一个文件（例如函数库）有哪些函数，再决定读哪段、用哪个' },
  find_references: { use: 'refs', when: '查谁在调用、谁在用；改接口前用它列全调用方' },
  find_delegate_bindings: { use: 'refs', when: '一个函数被绑到了哪些委托、输入、定时器' },
  suggest_include: { use: 'deps', when: '某个类型该 `#include` 哪个头、Build.cs 要加哪个模块' },
  get_module_info: { use: 'deps', when: '文件属于哪个模块、模块依赖了谁' },
  search_config: { use: 'other', when: '搜 ini 配置、CVar、GameplayTag' },
  find_blueprint_usages: { use: 'other', when: '哪些蓝图继承或用到某个类、函数、属性' },
  // IntelliJ-EmmyLua 挂在 IDE MCP 服务上的 Lua 查找
  lua_code: {
    use: 'find',
    when: 'Lua 代码：`action: search` 按名字找声明，`files` 找文件或 require 路径，`outline` 看文件大纲，`references` 查引用',
  },
  // JetBrains IDE 自带
  search_symbol: { use: 'find', when: 'IDE 索引里按名字找符号' },
  get_symbol_info: { use: 'shape', when: 'IDE 里看一个符号的声明和文档' },
  analyze_calls: { use: 'refs', when: 'IDE 里看调用层级' },
}

export const knownCodeTool = (name: string): KnownCodeTool | undefined =>
  Object.hasOwn(KNOWN_CODE_TOOLS, name) ? KNOWN_CODE_TOOLS[name] : undefined
