# 设置里的称呼没有交给 Agent，回复和提问里不用它

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:affected` 通过）
- 症状：设置 → 输入与文件 → 称呼填了之后，AI 的回复、它发出的提问里仍然写「你」「用户」，不按设置的称呼叫用户
- 入口：`server/exec/runner.ts` 拼 `instructions`（角色设定 + 面板规则）的地方，规则文本在 `shared/prompt-lang.ts` 的 `promptUserNameRules`
- 根因类型：设置只接到了界面上，没进提示词
- 模块：`server-exec`（`server/exec/runner.ts`），配套 `shared/prompt-lang.ts`
- 关键词：称呼、userName、需要用户回答、提问卡片、怎么称呼用户、系统提示词

## 根因

`settings.userName` 加进来时（b148178）只给界面用：`web/src/lib/user-name.ts` 的 `useUserName` 把它填进提问卡片「需要X回答」、
子对话「等X选择」这类标签。拼给 CLI 的提示词里从来没有它，Agent 不知道用户想被怎么称呼；提问卡片里的问题和选项说明是 Agent 写的，
所以卡片标签换了称呼，卡片正文仍是「你」「用户」。

## 修法

`promptUserNameRules` 生成「怎么称呼用户」一节（没填称呼时为空，不加），runner 把它和角色设定、语言规则放在一起：
有系统提示词参数的 CLI 每轮都在系统提示词里；没有的放在会话第一轮的角色段，改了称呼时角色段哈希变化，续接的会话会补发一次新版。
