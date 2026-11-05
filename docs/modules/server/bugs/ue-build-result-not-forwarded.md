# UE 子对话把编译交给父对话，父对话编完不告诉它，子对话一直待收尾

- 状态：已修复（`shared/build-ask.test.ts`、`server/tasks/merge.test.ts` 的「UE 共用目录的子对话」「编译通过时子对话已经在等收尾」、`server/tasks/startup.test.ts` 的编译重启用例通过；流程用例在改前的 `merge.ts` 上确认失败）
- 症状：UE 项目里子对话向父对话申请编译，父对话编译完成后子对话收不到结果，或收到后也不动，一直停在「待收尾」
- 入口：`server/tasks/merge.ts` 的 `childRequestBuild` / `parentRequestBuild` / `submitMerge`；`server/tasks/jobs.ts` 的编译结果回调；`server/tasks/drive.ts` 的 `nudgeWrapUp`；`shared/wrapup-prompt.ts` 的 `uePart`
- 根因类型：跨对话的交付结果靠模型填参数传递，面板没有记账；结果推给待收尾的子对话会作废它的收尾请求
- 模块：`server`（`server/tasks/merge.ts`、`server/tasks/jobs.ts`、`server/tasks/build-results.ts`、`server/tasks/drive.ts`、`server/tasks/startup.ts`）、`shared`（`shared/build-ask.ts`、`shared/wrapup-prompt.ts`）
- 关键词：UE、编译申请、request_build、children、编译结果、待收尾、finish_child、submit_merge、父对话不告诉子对话、互相等

## 现象

用户 2026-11-04 报：子对话无法收尾——子对话把编译放到父对话里执行，父对话编译完成后不会告诉子对话，子对话一直卡在「待收尾」。

## 根因

1. 编译结果能不能回到子对话，全看父对话调用 `request_build` 时有没有填 `children`：面板只把它记在内存里的对应表（`buildFor`）。漏填就只推给父对话；面板自己的提示还写成「child 写 <id>」，工具只认 `children` 数组，照着写也会被丢掉；面板重启对应表也没了。
2. 共用目录的 UE 子对话提示里一边说「编译通过后再 submit_merge」，末尾又说「完成标准是编译申请已经发出」，子对话申请完编译就顺手交了收尾请求，进了「待收尾」。
3. 父对话的规则写着「结果也直接推给子对话」，编译通过后以为子对话会自己处理，不调 `finish_child`；子对话在等父对话收下：两边互相等。
4. 父对话申请完编译就结束这一轮，`nudgeWrapUp` 不看它还在等自己的编译，编译期间就把催收尾的次数耗掉，编译出了结果反而不再催。
5. 反过来结果真推到了待收尾的子对话，会开新的一轮，`run.ts` 把它的收尾请求作废，它还得再 `submit_merge`，常常就停在「未完成」。

## 修复

- `shared/build-ask.ts` + `Task.buildAsk`（落盘）：子对话申请编译时记下；父对话 `request_build` 漏写 `children` 时按「名下申请过、还没开编」自动补上（也认旧的 `child` 写法），提示改成 `children`；编译跑完按这份记录推回（`server/tasks/build-results.ts`），一次编译分几条命令时全部跑完才推。
- 编译通过、子对话已在待收尾：不叫醒它（只在它的对话里记一行），改在父对话收到的结果后面点名「它在等你收尾，调用 finish_child」。失败照常叫醒子对话去修。
- `submitMerge` 硬约束：共用目录的 UE 子对话改了要编译的文件，没有这次改动的编译通过结果（按改动指纹核对，通过后又改了 C++ 要重编）就拒绝请求验收。
- `nudgeWrapUp`：父对话自己还有后台命令在跑时不催、不扣次数。
- 面板重启时编译中断的子对话退回「申请了还没编」，父对话收件箱留一句重新 `request_build`。
- 提示词：共用目录的子对话等编译通过再 `submit_merge`；父对话编译通过后要对待收尾的子对话调用 `finish_child`。

## 防线

- `shared/build-ask.test.ts`：替谁编、多条命令的结算、`submit_merge` 核对。
- `server/tasks/merge.test.ts`：申请 → 漏写 children 自动补上 → 结果推回 → 通过才能请求验收 → 又改了要重编；待收尾的子对话编译通过不叫醒、父对话被点名 finish_child，失败照常退回。
- `server/tasks/startup.test.ts`：编译到一半重启的恢复。
