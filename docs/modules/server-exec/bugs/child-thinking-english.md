# 子对话的思考过程是英文，父对话是中文

- 状态：已修复（`npm run typecheck`、`npm run lint`、全量单测通过）
- 症状：界面语言是中文，父对话的思考按中文输出，子对话跑一阵命令（p4、luac）后思考变成英文
- 入口：`server/exec/invoke.ts` 的 `invokeCli`，规则和提醒在 `server/exec/prompt-lang-inject.ts`
- 根因类型：规则只在起新进程时注入，保活的后续轮次和直接调 invokeCli 的调用方漏了
- 模块：`server-exec`，配套 `shared/prompt-lang.ts`
- 关键词：回复语言、思考过程、thinking、英文、子对话、保活、keepAlive、父对话传话、语言提醒、系统提示词

## 根因

语言规则有两处：系统提示词里的「回复语言」一节，和每段输入末尾的一句提醒。以前两处都只在 runner 起新进程时拼（`run-setup.ts`、`compose-input.ts`）。
对话和子对话的进程会保活：之后交给同一进程的消息走 `run-wait.ts` 的 `keepAlive` / `waitUser`，原样交给 CLI，没有提醒。
父对话收到的多是用户自己的中文消息，影响不大；子对话收到的是父对话的传话、子任务交回的结果，中间夹着大段英文命令输出，模型的思考就跟着换成英文。
另外经验提炼、AI 创建、文档、插件发起的调用直接调 `invokeCli`，系统提示词里从来没有语言规则。

## 修法

`prompt-lang-inject.ts` 成为唯一注入点，`invokeCli` 里统一做三件事：系统提示词补语言规则（有参数的 CLI 接在角色设定后，只能用 mod 的装语言 mod 并带环境变量）、
第一轮输入末尾放提醒、保活的每个后续轮次补提醒。`run-setup.ts`、`launch-options.ts` 不再各自拼规则；压缩、审查（`noLangReminder`）、原生 /命令、起标题这类只要文字的小活不加。
