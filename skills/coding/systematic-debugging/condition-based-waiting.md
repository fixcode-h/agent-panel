# 按条件等，不按时长等

偶发失败的测试很多是靠固定延时猜时间：快机器上通过，负载高或 CI 上就失败。要等的是你真正关心的那个条件，不是猜它要多久。

## 什么时候用

- 测试里有随手写的延时（`setTimeout`、`sleep`、`time.sleep()`）；
- 测试偶发失败，并行跑或负载高时更容易失败；
- 在等一个异步操作完成。

**不适用**：测的就是时间行为本身（防抖、节流的间隔）。这时用固定时长是对的，但要在注释里写清为什么是这个数。

## 写法

```typescript
// 不要：猜时间
await new Promise((r) => setTimeout(r, 50))
expect(getResult()).toBeDefined()

// 要：等条件
await waitFor(() => getResult() !== undefined, '结果出来')
expect(getResult()).toBeDefined()
```

| 等什么 | 写法                                                                |
| ------ | ------------------------------------------------------------------- |
| 事件   | `waitFor(() => events.find((e) => e.type === 'DONE'), '收到 DONE')` |
| 状态   | `waitFor(() => machine.state === 'ready', '状态变成 ready')`        |
| 数量   | `waitFor(() => items.length >= 5, '至少 5 条')`                     |
| 文件   | `waitFor(() => fs.existsSync(path), '文件生成')`                    |

通用的轮询函数：

```typescript
async function waitFor<T>(condition: () => T | undefined | null | false, what: string, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  while (true) {
    const result = condition()
    if (result) return result
    if (Date.now() - start > timeoutMs) throw new Error(`等「${what}」超过 ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
```

同目录的 `condition-based-waiting-example.ts` 有按事件等的完整例子（`waitForEvent`、`waitForEventCount`、`waitForEventMatch`）。

## 常见错误

- 轮询太快（每 1ms）：白占 CPU，每 10ms 足够。
- 没有超时：条件永远不满足时一直卡着；一定要有超时，报错写清在等什么。
- 在循环外读一次值缓存起来：每次都要在循环里重新读。

## 固定时长确实对的时候

```typescript
await waitForEvent(manager, 'TOOL_STARTED') // 先等触发条件
await new Promise((r) => setTimeout(r, 200)) // 再等计时行为：工具每 100ms 一跳，要看两跳的输出
```

要求：先等到触发条件；时长按已知的节拍算，不是猜的；注释写清为什么。
