# P4 项目里 Agent 改了代码或资源，不进默认 Changelist

- 状态：已修复（`server/hooks/p4-open.test.ts`；UE 资源那条在插件仓库 `ue/server/p4-checkout.test.ts`）
- 症状：P4 项目里 Agent 用改文件工具改了代码、新建了文件，或经 UE 插件保存了资源，改动不在 default（也不在任何）changelist 里，提交时漏掉
- 入口：`server/hooks/p4-open.ts`（内置钩子「P4 改前自动签出」）、插件仓库 `ue/server/ops.ts` 的 `checkout`
- 根因类型：必须照做的规则只写在提示词里；按只读属性猜「要不要签出」
- 模块：`server`（`server/hooks/`）
- 关键词：P4、Perforce、p4 edit、p4 add、default changelist、签出、checkout、只读、allwrite、资源保存

## 现象

用户 2026-11-23 报：P4 项目里 Agent 改了代码或资源文件，不会自动加到默认 Changelist 了；本来应该先加进 Changelist 再改。

## 根因

- 代码文件：面板从来没有自己签出，只在提示词里写「修改前先 p4 edit / add」。工作区文件是只读时 CLI 改不动、Agent 会回头 p4 edit；文件可写（client 设了 allwrite、文件被手动去掉过只读）或者模型没照做时就直接改了，改动不在任何 changelist 里。
- UE 资源：保存前只对「只读」的包 `p4 edit`，可写但没打开的包跳过，同样漏掉。

## 修复

- 内置钩子 `p4-auto-open`（精简档就开）：P4 项目里改文件工具和 `sed -i` 改已有文件前，面板先 `p4 fstat` 看状态：在库里没打开的 `p4 edit -c default`，已经在当前 client 某个 pending 里的不动，库里没有的写完后 `p4 add -c default`；项目外的文件和项目的 `.tmp/` 不管；P4 拒绝时把原因补给模型。
- UE 插件 0.55.13：保存前不再按只读判断，磁盘上已有的包都先问 P4，规则同上。
