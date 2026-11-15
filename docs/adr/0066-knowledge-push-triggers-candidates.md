# ADR 0066：经验与教训：事件推送、触发键与候选

状态：已接受（2026-11-15 用户看过设计稿《经验与教训重新设计（2026-11-15）》后定，第 9 节 Q1–Q7 全按推荐，已实施） · 2026-11-15

- 影响范围：`shared/knowledge/`（推送匹配、报错指纹、候选、提炼、回放）、`server/hooks/knowledge-push.ts`、`server/knowledge/`（候选存储、路由、提炼）、`server/panel-tools/knowledge.ts`、`shared/schema.ts`（`ProjectLesson` 新字段）、`shared/knowledge-hits.ts`（反馈计数）、项目设置的教训 / 经验 / 候选 / 提炼页
- 修订：[ADR 0039](./0039-project-lessons-in-docs.md)（教训只在开头带、改完文件才推）、[ADR 0054](./0054-project-experience.md)（经验只在整个对话完成后学、只靠 Agent 主动查）

## 背景

教训（ADR 0039、0052）和经验（ADR 0054）都在，但用户反映「记了也没用」：教训整段塞在新会话开头，几十条之后模型看不过来；经验要 Agent 自己想起来查，实际很少查；同一个坑在不同对话里反复踩。设计稿第 3 节的根因是三件事：推送的时机不对（开头一次给完，用到时早忘了）、匹配的依据太粗（只有 paths）、学习的入口太窄（只在用户纠正、整棵对话树做完后）。

一期（de6ee03）先不改数据格式：内置钩子 `push-lessons` 在跑命令、改文件、搜索之前和报错之后按现有字段推送，开头那段封顶 1500 字，加了回放脚本。二至四期按设计稿第 7 节一次做完。

## 事实核对

| 位置                                                                | 现状                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `shared/schema.ts` 的 `ProjectLesson`                               | 加 `wrong`、`triggers`（commands / errors / intents）、`severity`、`status`，都有默认值        |
| `server/projects/lessons.ts` 的 `renderLesson`                      | 新字段只在不是默认值时写进 `lessons/<id>.md`，`triggers` 写成一行 JSON                         |
| `shared/knowledge/push.ts`                                          | 命令、路径、报错、搜索四种匹配；`pushable` 按 `severity` / `status` 过滤排序；`blockingLesson` |
| `shared/knowledge/match/fingerprint.ts`                             | 报错指纹 `errorPrint`（错误码 + 去掉路径数字后的词）和 `printScore`                            |
| `server/hooks/knowledge-push.ts`                                    | 内置钩子的推送、当场捕获和反馈判定入口                                                         |
| `shared/knowledge/candidate.ts`、`server/knowledge/`                | 候选和没配上的查询，存数据目录 `knowledge/<项目 id>.json`                                      |
| `shared/knowledge-hits.ts` 的 `KnowledgeHit`                        | 加 `helped` / `violated` / `missed` 三个反馈计数                                               |
| `shared/knowledge/distill.ts`、`server/knowledge/distill-routes.ts` | 四期提炼：挑条目拼提示词，教训转用户钩子                                                       |

## 决策

1. **数据格式只做加法，不搬目录、不写迁移。** 教训仍是 `<文档根>/lessons/<id>.md` 一条一个文件，新字段有默认值，旧数据读进来就是 `warn` / `active`、触发键为空，照样按 paths 和正文里反引号写的命令匹配；旧面板读到不认识的字段直接忽略。设计稿原想把教训和经验并进一个 `knowledge/` 目录、统一成一种格式，没选：P4 / SVN 的共用文档根（ADR 0052）要跟着搬，迁移失败的代价远大于两套文件名带来的不便。经验文件不动。
2. **推送按事件来，开头只给少量。** 跑命令前按命令触发键、改文件前按 paths、报错后按报错指纹推教训，搜索前按关键词推经验；一次最多 3 条、600 字，同一个对话一条只推一次。开头只带没有 paths 也没有触发键的全局条目和按需求原文对上意图词的（Q1：当场提示最多 2 条，其余进候选）。
3. **工具改名为两个。** `knowledge_lookup`（查教训和经验）直接列出，`knowledge_record`（记一条）收进 `more_tools`；旧的 `project_lessons`、`record_lesson`、`project_experience`、`record_experience` 保留一个版本当别名（Q6），下个版本删。
4. **学习的入口变多，但都先进候选。** 失败后换了做法才成（同目的的命令先失败、后来换写法成功）面板机械地记下失败命令、改对的命令和报错指纹，当场提示 Agent 用 `knowledge_record` 带 episode 记；Agent 记了的直接生效，没记的留作候选，同一个报错指纹在另一个对话里复发时自动转正（Q2）。子对话记的进候选等用户收下。经验在每一轮结束时学，不等整棵对话树做完（Q3）。候选存面板数据目录，不进项目文件：还没被认可的东西不该跟项目一起提交。
5. **拦截只能用户升级。** `severity: block` 的教训在跑对得上的命令前直接拒绝并给出对的做法；面板只在「推了还犯」多次时建议升级，按钮由用户点（Q4）。
6. **反馈只看工具调用，不看回复文字**（ADR 0041、0049）：推了之后同目的的命令一次就过算帮上，推了还出现这条记下的报错算违反，报错对上了却事前没推到算漏推。升级、降权、提炼的建议都按这三个计数算。
7. **提炼产出补丁，不直接改。** 够格的教训写进 AGENTS.md、合进模块文档、整理面板改进建议、把没配上的查询补成经验，这四种都只拼提示词，界面照「AI 评审」那样开一个项目对话，改动走评审弹窗确认（Q5）；教训转钩子直接生成一条项目用户钩子，用户点按钮就是确认。

## 操作清单 / 契约

| 接口 / 工具                                    | 作用                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `knowledge_lookup` { query, files, tags, id }  | 查教训和经验，最相关的全文在前                              |
| `knowledge_record` { kind, …, episode }        | 记一条；带 episode 时面板补上命令和报错指纹                 |
| `GET /projects/:id/knowledge`                  | 候选、没配上的查询、对教训的建议（`KnowledgeStateView`）    |
| `POST /projects/:id/knowledge/candidates/:cid` | 收下 / 忽略一条候选                                         |
| `POST /projects/:id/knowledge/distill`         | `DistillRequest` → `DistillResult`：提示词，或写入的钩子 id |

## 与现有实现的关系

- 内置钩子 `push-lessons`（ADR 0049 的钩子模块）是推送、捕获、反馈的唯一入口；关掉它就回到只靠开头和 Agent 主动查。
- 命中记录 `knowledge-hits/<项目 id>.json` 继续用，加反馈计数；候选另存 `knowledge/<项目 id>.json`。
- 「AI 评审」教训（`shared/lesson-review.ts`）不变；提炼开对话的方式照它。
- 教训转出来的钩子是普通用户钩子（`shared/hooks/defs.ts` 的 `HookDef`），在钩子设置里能看、能改、能删。

## 运行时

推送、捕获、反馈都在面板钩子里同步算，纯字符串比较，不调模型；条目最多 2 秒重读一次，别的对话刚记的下一次工具调用就能推到。CLI 报不出工具失败的（Codex）报错后推送和捕获对它无效，只剩命令前、改文件前、搜索前三种。候选和命中记录写失败只打日志，不影响对话。

## 分期

一期（de6ee03）推送；二期新字段、触发键、报错指纹、新工具；三期捕获、候选、复发转正、反馈、升降级、拦截、界面；四期提炼。本 ADR 覆盖二至四期，一次做完。

## 风险与代价

- 机械捕获会有噪音（笔误、网络抖动也算「失败后改对」）：只当场提示、不直接生效，复发了才转正，用户在候选页能一键忽略。
- 拦截误伤：只拦命令触发键和错的做法里写的命令，不拦对的做法里的命令；拒绝说明里告诉模型怎么请用户降级。
- 别名多留一个版本，工具清单短期内多四个名字（收在 `more_tools` 里，不占列出的位置）。

## 开放问题

- 意图词（`triggers.intents`）目前只在新会话开头按需求原文匹配；要不要在用户中途补充需求时也匹配，等回放数据再定，先只做开头。
- 经验要不要也加触发键和反馈计数：先不加，经验靠搜索前推送和查询；等「没配上的查询」攒够数据再看。
