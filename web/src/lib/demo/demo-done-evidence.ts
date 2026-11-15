import type { Task } from '@shared/schema'

/**
 * 演示：最后一轮用 end_turn 记成做完，带一份完成依据（分析稿 A3，见 DoneEvidenceCard.tsx）。
 * 改了代码、跑了两条验证命令：类型检查通过、单测失败一次（界面上要看得到退出码的两种颜色）
 */
export function demoDoneEvidence(task: Task) {
  task.turnEnds = [
    ...(task.turnEnds ?? []),
    {
      at: new Date().toISOString(),
      outcome: 'done',
      evidence: {
        files: [
          'src/components/CartBadge.tsx',
          'src/components/RestockButton.tsx',
          'src/store/cart.ts',
          'tests/cart.test.ts',
          'docs/cart.md',
        ],
        commands: [
          { command: 'npm run typecheck', exitCode: 0, step: '类型检查' },
          { command: 'npx vitest run tests/cart.test.ts', exitCode: 1, failed: true },
        ],
        code: true,
        unverified: false,
      },
    },
  ]
}
