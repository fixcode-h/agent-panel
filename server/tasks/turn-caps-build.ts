// 一轮执行交给引擎的「编译 / 测试 / 后台命令」类能力（重构文档第 3、5 条：从 createRun 的 start 里拆出来，按 EngineHost 的小接口分组）。
import type { RealContext } from '../exec/real-context.ts'
import { currentTestSteps, isUeBuildCommand } from '../../shared/test-steps.ts'
import { noPushEnv } from '../exec/no-push.ts'
import { parentRunRole } from './helpers.ts'

import type { TurnCapsCtx } from './turn-caps-conv.ts'

/** 编译、测试和后台命令的能力：UE 编译占位、测试验收、run_background */
export async function buildCaps(c: TurnCapsCtx) {
  const { sc, entry, task, project, found, dir, ueRole } = c
  return {
    ueBuild:
      ueRole === 'child'
        ? { role: 'child', request: (note) => sc.childRequestBuild(entry.task, note) }
        : ueRole === 'parent' && found
          ? { role: 'parent', request: (note, kids) => sc.parentRequestBuild(entry.task, found, note, kids) }
          : undefined,
    // 只有项目里的对话有：工作流的测试验收节点照常按快照里的完整步骤跑
    verify:
      task.mode === 'chat' && found?.id
        ? {
            // 按项目当前步骤拼这一轮的提示词（一次取一次，这一轮不再重读）；项目读不到才用任务快照
            steps: currentTestSteps(task.testSteps, found),
            platform: process.platform,
            wslDistro: found.wslDistro,
            scaled: found.scaledVerify,
            // 这次任务实际改了哪些文件：服务端算好「本轮该跑哪几条 + 命令」再交给模型，不靠它自己筛。
            // getter 现取：runner 在这一轮里会刷新 task.changes，保活的下一条消息要按新的改动清单算
            get changedFiles() {
              return entry.task.changes.map((c) => c.path)
            },
            ...(await parentRunRole(entry.task, found)),
          }
        : undefined,
    // 只给对话用：工作流节点一跑完就结束，结果没有地方推回
    runBackground:
      task.mode === 'chat' && dir
        ? async (input) => {
            // UE 的编译归父对话、按编译目录占位（ADR 0004）。以前这里一律拒收、让它改用 request_build，
            // request_build 坏掉时 Agent 只能去前台硬跑（用户 2026-11-12 报）。现在不拒收，面板替它分流：
            // 子对话交来的转成向父对话的申请，父对话交来的排进编译目录的占位队列（ADR 0006 补充 2026-11-12）
            if (ueRole && isUeBuildCommand(input.command)) {
              if (ueRole === 'child') {
                const r = await sc.childRequestBuild(
                  entry.task,
                  `交来的编译命令（子对话不自己编译，面板转成了申请）：${input.command}`,
                )
                return r.ok
                  ? {
                      ok: true,
                      info: `UE 项目里子对话不自己编译，面板已把这条编译命令转成向父对话的编译申请：${r.info}`,
                    }
                  : r
              }
              if (!found) return { ok: false, info: '找不到这个对话所在的项目，没法按编译目录占位编译' }
              return sc.parentRequestBuild(entry.task, found, `run_background 交来的编译：${input.name}`, [], {
                name: input.name,
                command: input.command,
                cwd: input.cwd,
                timeoutMinutes: input.timeoutMinutes,
              })
            }
            return sc.background.start({
              ...input,
              // 编译会抢文件锁：没写 exclusive 的 UE 编译也按目录排队
              exclusive: input.exclusive || isUeBuildCommand(input.command),
              // 交来的 service 原样带上（BgJob.service）：常驻服务不催、不算在等结果
              taskId: task.id,
              root: dir,
              env: noPushEnv(entry.task, project?.gitPolicy),
            })
          }
        : undefined,
    checkBackground: (id) => sc.background.check(task.id, id),
    stopBackground: (id) => sc.background.stopOne(task.id, id),
  } satisfies Partial<RealContext>
}
