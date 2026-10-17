# dsh-continue-on-limit

本地小模型「输出达到上限」自动继续插件，面向 **DeepSeek Harness Web GUI**，当前适配 **harness 0.2.0-rc.2**。

本地部署的模型输出 token 上限往往设得比较保守，回答到一半就截断——界面上出现「已达到输出 token 上限」的提示，得手动发送一次「继续」才能接着输出。本插件在检测到该截断处于会话尾部时，**自动发送「继续」**，让回复自动接上，不用盯着界面手动点。

> **一键安装：**
> ```
> dsh plugin add qwert702/dsh-continue-on-limit
> ```
> 装完重启 harness、刷新页面即可生效。插件完全隐形，不占用任何界面空间。

## 功能

- **自动继续**：会话出现输出上限截断（数据层是 `turn/end` 事件带 `reason.kind === "max-tokens"`）且截断处于会话尾部时，自动以 `queue` 模式发送配置好的继续文字（默认「继续」），模型自动接着输出。
- **不打断用户**：只在截断是会话**最后一件事实**、且会话空闲（没有正在回复、没有待提交消息）时触发；用户中途发了新消息或自己操作了，就不会被插件打扰。
- **防死循环烧 token**：模型如果一直输出就截断，插件最多连续自动继续 `maxConsecutive` 次（默认 3）就停下，避免无限烧 token；模型正常完成一次回复或用户插话后，计数自动重置。
- **防重复发送**：同一条截断只处理一次；两次自动发送之间至少间隔 `minIntervalMs`（默认 1500ms）。
- **全自动、无 UI**：插件不渲染任何按钮或提示，仅在控制台打印操作日志（`[dsh-continue-on-limit] …`），方便排查。

## 工作原理

1. **host 半区**注册一个会话投影 `continueMaxTokens`：按事件顺序折叠会话日志，`turn/end` + `reason.kind === "max-tokens"` 时把「截断通知（turn/seq/time）」置为有效；此后任何流程事件（`turn/start`、`user/message`、`steering/message`、正常结束的 `turn/end`）都会把通知置空并记录「谁终结了它」。因此 host 端发布出去的通知**永远是会话尾部的最新截断**——0.2.0 的客户端契约不再向 header 坐席暴露 Chat 快照，这个「尾部」判断因此放在 host 侧。
2. **浏览器半区**挂载在会话头部坐席 `conversation.session.header.actions`（与 dsh-context-compressor 同一条链），渲染为空；它通过标准 props 拿到 `useSession`（会话快照）、`useProjection`（按键读投影，即 `continueMaxTokens`）与 `sessionId`，纯策略函数 `evaluate` 决定是否发送。
3. 判定通过后，插件通过会话面的 `prompt([{ type: 'text', text: '继续' }], 'queue')` 发送继续消息，与输入框手动发送走同一条通道。
4. 模型接着输出；若再次截断则再次自动继续，直到完成、用户介入或达到连续次数上限。

## 诊断（插件不触发时先看这里）

插件完全隐形，但挂载时会往浏览器控制台打一行日志：

```
[dsh-continue-on-limit] 观察器已挂载：projection=就绪(无截断)
```

- **看不到这行日志** → 客户端半区没加载（安装/重启问题），先确认插件装过、harness 已重启、页面已刷新。
- **日志显示 `projection=缺失`** → host 半区没有注册投影（host 加载失败或版本不匹配），此时不会自动继续。
- **截断发生后仍不自动发送** → 通常是「截断不是会话尾部」（截断后你又发了消息）或连续自动继续已达上限，浏览器控制台会有对应的 warn 日志。

## 设置（可选）

配置走 harness 0.2.0 的 profile 条目 config（插件 config schema 即 `Config` 导出）。在你的 profile 补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里覆盖条目 `ui-continue-on-limit` 的 config：

```yaml
- id: ui-continue-on-limit
  config:
    enabled: true        # 总开关
    continueText: '继续' # 发送的继续文字，可自定义，如 '请继续' / 'continue'
    maxConsecutive: 3    # 未完成回复时的连续自动继续次数上限（防无限烧 token）
    minIntervalMs: 1500  # 两次自动发送之间的最小间隔（毫秒）
```

不配置即用以上默认值。改完配置后重启 harness 生效（浏览器半区在页面加载时读取一次 host 路由返回的配置）。

## 仓库布局

- `lib/index.js` — host 半区：`Config` 导出（loader 配置通道）+ `continueMaxTokens` 会话投影 + `GET /api/dsh-continue-on-limit/config` 配置读取路由。
- `lib/client.js` — 浏览器半区：纯策略函数（`evaluate` / `evaluateReset`）+ 隐形观察组件（订阅会话快照与投影、自动发送继续）。
- `test/smoke.cjs` — `node test/smoke.cjs`：host（Config 导出/投影注册与折叠分支/路由默认值/覆盖值/405）+ client（坐席注册/策略全分支/链重置/配置读取回退/SSR 空渲染）断言。

## 已知限制

- **只作用于打开中的会话**：插件订阅的是当前展示（staged）的会话，切到别的会话时只对该会话生效——这符合使用直觉：你在看哪个会话，哪个会话才会被自动继续。
- **截断必须处于对话尾部**：如果截断之后用户已经发了新消息，host 投影已把通知置空，插件不会去追发「继续」（此时继续的意义已经变了，用户正在主导对话）。
- **无法区分手动「继续」**：如果用户恰好手动发送了与 `continueText` 相同的文字，插件会把它当作自己发的，不重置连续计数——最多让自动继续提前一轮停手，无其他影响。
- **配置读取一次**：浏览器半区在页面加载时读取一次配置，改配置需重启并刷新页面（host 端每次请求都实时解析，但浏览器端不轮询）。
- **浏览器半区手动维护**：`lib/client.js` 为手写 bundle（与 dsh-context-compressor / dsh-auto-translate 同一技术路线），不经过构建步骤；改动后直接生效，冒烟测试兜底。

## License

MIT
