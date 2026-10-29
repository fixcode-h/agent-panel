---
name: systematic-debugging
description: 系统化调试：先查模块 bugs.md 历史，从相关模块开始逐层定位，在每一层按根因调查、模式分析、假设验证、实现修复四个阶段找到根因后再修，找到就停。遇到任何 Bug、测试失败或意外行为，在提出修复方案之前使用。
user-invocable: true
---

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue:
- Test failures
- Bugs in production
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- Manager wants it fixed NOW (systematic is faster than thrashing)

## Module Bug History First

在进入四阶段调试前，先确定受影响模块，并按以下顺序读取历史问题：

1. 根据 `MODULE-MAP.md`、代码路径、错误堆栈和入口文件确定模块名。
2. 查找 `DOC_ROOT/modules/<模块名>/bugs.md`；如果存在，先按错误信息、症状、入口、关键词和根因类型搜索。
3. 如果索引命中，读取对应的 `DOC_ROOT/modules/<模块名>/bugs/<bug-id>.md`，把其中的复现条件、根因、排查路径和回归测试作为优先假设；必须重新验证，不能直接套用旧结论。
4. 如果没有命中，按下面的通用四阶段流程自行查找。
5. 用户报的 Bug 修复并验证后，无论是否命中历史记录，都更新 `bugs.md` 和对应单 Bug 文档；记录新证据、修复路径、回归测试和防复发护栏。

**Bug 记录只记用户报的 Bug。** 自己写代码、自测、评审或跑测试时发现并修掉的问题（包括自己改出来的测试失败）不写 `bugs.md` 和单 Bug 文档，写进交接摘要；值得长期记住的写进项目教训。

模块 Bug 记录必须至少包含：

- Bug ID、日期、状态和影响范围；
- 症状、错误信息、关键词和受影响入口；
- 复现条件与最小复现步骤；
- 根因和数据/调用排查路径；
- 修复文件、验证命令和回归测试；
- 防复发护栏，以及与 OpenSpec change 的链接（若存在）。

OpenSpec 仍然只承载一次独立变更；它在 `design.md` 中引用模块文档和 Bug 记录，归档后把长期知识回写 `docs/modules/<模块名>/`。

## 查到哪一层为止

四个阶段在**一层**里做完，不是一路往底层挖：

1. **起点**：用户点名的模块或部分优先；其次是别人交来的模块；都没有时按报错原文、堆栈和 `MODULE-MAP.md` 先定到一个模块。
2. **在这一层查**：用报错原文、函数名限定在这个模块里搜索（`rg <关键词> <模块目录>`，带上项目设置的排除目录），只读现象实际走的那条路径（入口 → 出错点），同时看这个模块最近的改动（`git log -p -n 10 -- <模块目录>`）。回归问题往往就在最近的改动里。
   - 报错、堆栈已经给出具体文件时直接读那个文件，不做全仓搜索。
   - 模块目录里搜完没命中，才把范围扩大一级（模块 → 调用方 → 仓库根），每一步都带排除（`-g '!node_modules' -g '!dist'`；UE 工程的排除清单见 `ue-project-structure`）。
   - 可能超过 60 秒的搜索放后台（面板的 `run_background`）或先小范围试；不要一条全仓 grep 干等。
3. **评估可疑代码**：能从输入一步步推到错误输出、每一步都有代码依据，才算确定，直接进入 Phase 4；推不通或有两种以上可能，先加临时日志或写针对性的测试复现，用结果确认或排除，不改代码去猜。
4. **排除了才下一层**：这条路径读完，或者日志、测试证明这一层的输入输出都对，才进入它调用的那个依赖或底层模块；每下一层先写一句上一层的排除依据。
5. **找到就停**：找到能完整解释现象的原因并验证后就修，修完收尾。下面「Trace Data Flow」说的追到源头，指追到能完整解释现象的那一处，不是追到最底层；路上看到的其他可疑点单独列出，不顺手修。
6. **控制深度**：同一层读了不少代码还没有假设，换成加日志或测试缩小范围，不再扩大阅读范围；下到第三层还没找到，停下来报告查过哪几层、各自的排除依据和下一步建议。

## 定位顺序：模块文档 → 模块代码 → 调用栈 → 日志

拿到日志、报错就直接翻日志找「像的那一行」，是最常见的瞎猜来源：那一行是哪段代码打的、在调用链的哪一步都没对上。每一层里按这个顺序，不能跳：

1. **模块文档**：`MODULE-MAP.md` → `modules/<模块>/README.md` → `bugs.md`。文档写清的入口和数据流直接用。
2. **模块代码**：从入口读到出错点，只读现象走的那条路径。
3. **调用栈**：写成一跳一行的 `path:line 函数 → path:line 函数 → … → 出错点`，每一跳都读过；有报错堆栈时每一帧都对得上，对不上就是读错了路径。
4. **再对日志**：每条要用的日志先拿原文在代码里搜出打印位置（`path:line`），标到调用栈上；按时间顺序看哪一跳打了、哪一跳该打没打（没走到）、值和分支条件对不对得上。搜不到出处的日志（别的进程、第三方库）写明来源，不当成这个模块的证据。

**证据链**：根因 = 现象 ← 日志原文（或测试输出）← 代码 `path:line` 的条件或赋值，三环都有才算确定。缺一环就是假设，写成「假设：……，用 X 确认」，不写「可能 / 应该」。

**证据不够时二选一，不猜着改**：
- 能自己复现（相关测试、命令、新写一个失败用例）就先复现；
- 复现不了就在调用栈上可能分叉的几处加临时日志（统一前缀 `[排查-<主题>]`，打分支条件和关键变量，不打密钥），告诉用户复现步骤、日志在哪、要贴回哪几行，然后停下等；拿到日志回到第 4 步。修完删掉这些临时日志。

**回写**：这次摸清、文档里还没写的入口、调用链、关键日志位置、复现方法，写回 `modules/<模块>/README.md`（没有就新建，按项目的文档规则，通常交给文档角色）。下次同类问题先读文档就能定位。

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings
   - They often contain the exact solution
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce Consistently**
   - Can you trigger it reliably?
   - What are the exact steps?
   - Does it happen every time?
   - If not reproducible → gather more data, don't guess

3. **Check Recent Changes**
   - What changed that could cause this?
   - Git diff, recent commits
   - New dependencies, config changes
   - Environmental differences

4. **Gather Evidence in Multi-Component Systems**

   **WHEN system has multiple components (CI → build → signing, API → service → database):**

   **BEFORE proposing fixes, add diagnostic instrumentation:**
   ```
   For EACH component boundary:
     - Log what data enters component
     - Log what data exits component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   ```

   **Example (multi-layer system):**
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   **This reveals:** Which layer fails (secrets → workflow ✓, workflow → build ✗)

5. **Trace Data Flow**

   **WHEN error is deep in call stack:**

   See `root-cause-tracing.md` in this directory for the complete backward tracing technique.

   **Quick version:**
   - Where does bad value originate?
   - What called this with bad value?
   - Keep tracing up until you find the source
   - Fix at source, not at symptom

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in same codebase
   - What works that's similar to what's broken?

2. **Compare Against References**
   - If implementing pattern, read reference implementation COMPLETELY
   - Don't skim - read every line
   - Understand the pattern fully before applying

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small
   - Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need?
   - What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Testing

**Scientific method:**

1. **Form Single Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Write it down
   - Be specific, not vague

2. **Test Minimally**
   - Make the SMALLEST possible change to test hypothesis
   - One variable at a time
   - Don't fix multiple things at once

3. **Verify Before Continuing**
   - Did it work? Yes → Phase 4
   - Didn't work? Form NEW hypothesis
   - DON'T add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X"
   - Don't pretend to know
   - Ask for help
   - Research more

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Create Failing Test Case**
   - Simplest possible reproduction
   - Automated test if possible
   - One-off test script if no framework
   - MUST have before fixing
   - 需要专门的 TDD 流程时，配合 `test-driven-development` 技能

2. **Implement Single Fix**
   - Address the root cause identified
   - ONE change at a time
   - No "while I'm here" improvements
   - No bundled refactoring

3. **Verify Fix**
   - Test passes now?
   - No other tests broken?
   - Issue actually resolved?

4. **If Fix Doesn't Work**
   - STOP
   - Count: How many fixes have you tried?
   - If < 3: Return to Phase 1, re-analyze with new information
   - **If ≥ 3: STOP and question the architecture (step 5 below)**
   - DON'T attempt Fix #4 without architectural discussion

5. **If 3+ Fixes Failed: Question Architecture**

   **Pattern indicating architectural problem:**
   - Each fix reveals new shared state/coupling/problem in different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   **STOP and question fundamentals:**
   - Is this pattern fundamentally sound?
   - Are we "sticking with it through sheer inertia"?
   - Should we refactor architecture vs. continue fixing symptoms?

   **Discuss with your human partner before attempting more fixes**

   This is NOT a failed hypothesis - this is a wrong architecture.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**

**If 3+ fixes failed:** Question the architecture (see Phase 4.5)

## your human partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" - You assumed without verifying
- "Will it show us...?" - You should have added evidence gathering
- "Stop guessing" - You're proposing fixes without understanding
- "Ultrathink this" - Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) - Your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## When Process Reveals "No Root Cause"

If systematic investigation reveals issue is truly environmental, timing-dependent, or external:

1. You've completed the process
2. Document what you investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

These techniques are part of systematic debugging and available in this directory:

- **`root-cause-tracing.md`** - Trace bugs backward through call stack to find original trigger
- **`defense-in-depth.md`** - Add validation at multiple layers after finding root cause
- **`condition-based-waiting.md`** - Replace arbitrary timeouts with condition polling

**Related capabilities:**
- `test-driven-development`：需要专门 TDD 流程时配合使用
- `verification-before-completion`：准备声明完成前配合使用

## Real-World Impact

From debugging sessions:
- Systematic approach: 15-30 minutes to fix
- Random fixes approach: 2-3 hours of thrashing
- First-time fix rate: 95% vs 40%
- New bugs introduced: Near zero vs common
