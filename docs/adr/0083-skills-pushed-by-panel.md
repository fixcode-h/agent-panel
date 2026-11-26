# ADR 0083：技能由面板推送，启动时只带角色的技能

- 状态：已接受
- 日期：2026-11-26
- 设计稿：《技能与自建工具按情境加载》第一部分（2–3 节）、13–14 节

## 背景

以前每轮把能用的技能全交给 CLI：Claude Code 每轮 `--add-dir ~/.agents/skills`，插件带的技能也每轮全放进技能目录，提示里再列一节「装着的插件带的技能」；自带技能装在 `~/.agents/skills`，Codex、Pi、Command Code 启动时自己把那里全部读进去。CLI 只给模型看技能的名字和一句说明，用不用、什么时候读正文都靠模型自己判断。实际看到的是：弱模型看到一长串技能却一个不读，强模型也常常在该用的时候没去读（改 Lua 不看 lua-code-style、测试失败不看 systematic-debugging）。另外「开发」角色按 `lang` 在角色设定里常驻一段代码风格要点，情境规则里又单独登记了一份（已删掉的 code-style 表），同一件事两处维护。

## 决策

- **启动时只带角色的技能**：这一轮的技能目录（`run-skills/<项目>/<CLI>-<这组技能的指纹>/`）只放角色点名的技能（含引入的角色、就地用的挂载能力）、用户设成「每个对话都带」的、项目能力里打开了的按项目技能。Claude Code 不再加 `--add-dir ~/.agents/skills`（CLI 定义去掉 `runSkills.shared`），插件技能不再每轮全带，提示里那一节去掉。不能按会话加载技能的 CLI 在提示里只列这一轮带的技能。
- **其余技能由面板在用得上的那一刻推正文**：技能目录（`shared/skills/catalog.ts`）给每个技能写触发条件 `SkillWhen`（`edit` / `read` / `command` / `tool` / `failed` / `phase` / `project` / `message` / `params`，`shared/skills/when.ts`），工具调用时的条件生成情境规则（`shared/skills/rules.ts`），开跑时的条件在 `server/skills/launch-push.ts` 判断。对上了就把 SKILL.md 正文（去掉 frontmatter）直接推给模型，开头一句说明这是面板按情境给的、照它做，子文件只给路径，入口里写明什么时候读哪个。只看工具调用、面板状态、用户消息和节点参数，不看模型回复（ADR 0041、0049）。
- **推送的规矩**：同一技能一个对话只推一次（推送记录 `server/skills/push-ledger.ts`，`recordSkillPush` / `skillPushes` 的签名给「调用记录」页用，不改）；上下文压缩后（`context.restored`）把推过的再推一次；一个对话推的正文总量默认不超过 20000 token（`estimateTokens`），超了只推一行路径；不看扶持档位（精简档也开）、不占情境规则的条数。用户「/名字」点名的技能由「/」展开带正文，只记一笔不再推。
- **默认条件**：lua / cpp 代码风格在改对应文件、消息里写到、`lang` 参数时推；coding-standards 改代码时；project-testing 改测试或跑测试命令时；systematic-debugging 测试命令失败后和 Bug 模式开跑时；verification-before-completion 调收尾工具时；project-vcs 跑版本管理命令和改过文件后收尾时；project-documentation 改文档时；ue-project-structure 项目里有 `.uproject` 时（先带 project-structure）。brainstorming、grilling、openspec、task-records 不自动推（要用户主动走流程）。插件技能默认在调这个插件的工具（`<插件 id>_*`）时推，插件接口不改。
- **用户能改**：设置「Agent 工具 → 技能」按来源列出技能，每个技能能开关自动推、改条件、设成「每个对话都带」、恢复默认，能看最近推送；上限在同一页改。存在钩子配置 `config/hooks.json` 的 `skills`（新加的字段有默认值，不用迁移）和内置钩子 `skill-push` 的参数里。会话栏「环境 → 技能」写这一轮带了哪些、推过哪些。
- **自带技能挪进面板数据目录** `bundled-skills/`：不再装进 `~/.agents/skills`（那里各 CLI 会自己全读）。第一次用到时一次性搬过来（`server/skills/store-move.ts`）：没改过的搬走，改过的复制一份、原样留着。没被改过的副本照旧自动跟上新版（安装记录的指纹，再加入口大改过的技能登记的发布版指纹）。自带技能进「/」菜单，由面板展开。
- **入口不超过 8000 字**：systematic-debugging、project-documentation 的入口瘦身，细节挪进子文件（`full-flow.md`；`structure.md`、`bug-index.md`、`init.md`），入口写明什么时候读哪个。「开发」角色去掉按 `lang` 常驻的风格要点，改成 `params: lang=lua` 开跑时推全文。

## 放弃的做法

- **按模型档位决定推不推**：用户要的是不漏用技能，强模型也会漏，所以不分档位。
- **只推路径让模型自己读**：弱模型同样不读；正文直接给，超了上限才退回路径。
- **按模型回复判断「它是不是要做某件事」**：违反 ADR 0041、0049，只看工具调用和面板状态。

## 影响

- 角色自带的技能条件对上时也会推正文（「开发」带着 lua / cpp 两个风格技能，弱模型照样不读）。条件要卡在真正要用的那一刻：project-vcs 只在改版本库的命令（`command vcs-write`：commit、push、p4 edit……）上推，开工看 `git status` 不推——Flash 实测里 6 个对话全在第一条 `git status` 上推了它，每个对话白多 1.8k token。
- 推送记录只在内存里：重启后同一技能最多再推一次。
- 技能入口都不超过 8000 字（单测核对全部自带技能）：cpp-code-style 的静态分析告警、模块导出细则和完整示例挪进 `details.md`。
- 插件还不能在清单里自己写 `skillWhen`，先用默认的「调这个插件的工具时」。
