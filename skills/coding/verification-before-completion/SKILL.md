---
name: verification-before-completion
description: 完成前验证：声称工作完成、已修复或测试通过之前，必须先运行验证命令并确认输出，用新鲜证据说话。准备宣布完成、提交或创建 PR 之前使用。
user-invocable: true
---

# 完成前验证

## 概述

没验证就说做完了，不是效率高，是不诚实。

**核心原则：** 先有证据，再下结论，没有例外。

**钻字面空子绕开这条规则，就是违反这条规则。**

## 铁律

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

这一轮没跑过验证命令，就不能说它通过了。

## 下结论前的关卡

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## 常见的错

| 要说的话        | 需要的证据               | 不够的                     |
| --------------- | ------------------------ | -------------------------- |
| 测试通过        | 测试命令输出：0 个失败   | 上一次的结果、「应该能过」 |
| 代码检查干净    | lint 输出：0 个错误      | 只查了一部分、推断         |
| 构建成功        | 构建命令退出码 0         | lint 过了、日志看着没问题  |
| Bug 修好了      | 复现原来的现象：不再出现 | 改了代码，觉得修好了       |
| 回归测试有效    | 走过红-绿循环            | 测试跑通了一次             |
| 子 Agent 做完了 | 版本管理的 diff 里有改动 | 子 Agent 报告「成功」      |
| 需求都满足了    | 逐条核对的清单           | 测试通过                   |

## 危险信号：停下来

- 用了「应该」「大概」「看起来」
- 还没验证就表示满意（「好了！」「完美！」「搞定！」）
- 要提交、推送、开 PR，但没验证
- 直接相信子 Agent 的成功报告
- 只验证了一部分
- 心里想「就这一次」
- 想赶紧收工
- **任何在没跑验证时暗示成功的说法**

## 别给自己找借口

| 借口               | 实际上             |
| ------------------ | ------------------ |
| 「现在应该好了」   | 去跑验证           |
| 「我有把握」       | 把握 ≠ 证据        |
| 「就这一次」       | 没有例外           |
| 「lint 过了」      | lint ≠ 编译        |
| 「Agent 说成功了」 | 自己独立验证       |
| 「换个说法就不算」 | 看精神，不看字面   |
| 「查一部分就够了」 | 部分证明不了任何事 |

## 正确和错误的做法

**测试：**

```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**回归测试（TDD 红-绿）：**

```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**构建：**

```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**需求：**

```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**派给子 Agent 的活：**

```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## 为什么重要

过去的翻车记录里反复出现：

- 用户说「我不信你」，信任没了
- 调用了没定义的函数就交出去，一跑就崩
- 漏了需求就交出去，功能不完整
- 假完成 → 返工 → 再返工，白白浪费时间

## 什么时候用

**以下之前都要先验证：**

- 任何形式的「完成了」「成功了」
- 任何表示满意的话
- 任何说工作状态良好的话
- 提交、开 PR、标记任务完成
- 进入下一个任务
- 把活派给子 Agent

**规则适用于：**

- 原话
- 换个说法、同义词
- 暗示成功的话
- 任何让人以为已完成或正确的表达

## 一句话

**验证没有捷径。** 跑命令，读输出，然后才说结果。
