# mapApp 变更请求单

| 项 | 内容 |
|---|---|
| 文档编号 | CR-MAPAPP-001 |
| 版本 | v0.1 |
| 用途 | 汇总**引擎实现过程中发现的、需要改动主项目仓 `mapApp`（= `smart-mission-system`）的问题**。本波纪律禁止改其它仓，此处只登记，由 `mapApp` 按自身排期处理 |
| 与 `map-2d变更请求单.md` 的分工 | 本文针对**主项目仓**；`map-2d` 的请求单独立成文 |

---

## CR-01 · 前端启动进度是假动画（来自 `selfcheck` 第 3 波）

**提出者**：`selfcheck` 实现者（其 `docs/实现报告.md` §7 开放问题 7）

### 现状

`frontend/src/stores/useStore.ts` `loadBoot()`（约 L187–200）：

```ts
for (let step = 1; step <= 20; step++) {
  mods.forEach((m, i) => {
    const target = [100, 100, 100, 100, 100][i]   // ← 写死的进度目标
    m.percent = Math.min(target, Math.round((step / 20) * 100))
  })
  set({ bootProgress: Math.round((step / 20) * 100), bootModules: [...mods] })
  await new Promise((r) => setTimeout(r, 60))     // ← 20 × 60ms = 1.2s 假动画
}
```

**性质**：整个启动进度是**等分假动画**，与真实模块加载无关；进度目标值 `[100,100,100,100,100]` 也是写死的。

### 引擎侧已就绪的替代

`selfcheck` 引擎（第 3 波已完成）提供：

| 能力 | 接口/事件 |
|---|---|
| 真实进度上报 | `selfcheck.progress` → `{items:[{key,percent}], overall}` |
| **启动加载完成**（只发一次） | `selfcheck.ready` → `{readyAt(epoch ms), overall, modules[{key,percent}], readyAtText?}` |
| 轻量轮询端点 | 进度端点 P95 ≈ 8 µs（比全量 `/health` 便宜得多） |
| 各模块**自己声明**进度目标与权重 | 规则包 `policies/mapapp/probes.json` |

### 请求

| # | 改动 | 对应需求 |
|---|---|---|
| 1 | 删除 `loadBoot()` 的 20 步假动画与 `setTimeout(..., 60)` | `SFC-PROG-01` |
| 2 | 删除写死的进度目标数组 `[100,100,100,100,100]`，改为消费引擎上报的模块进度 | `SFC-PROG-02` |
| 3 | 用 `selfcheck.ready`（只发一次）作为"进入自检界面"的触发，取代"20 步跑完"的判定 | `SFC-PROG-06` |

### 不阻塞项声明

- 引擎侧已保证**不产生假进度**，且这些机检项在 `selfcheck` 仓的验收里已全绿；
  **仅前端侧未落实**（本波纪律禁改 `mapApp`）。
- ⚠️ **优先级提醒**：`mapApp` 是**过渡原型、最终会重写新宿主仓**（见 `交接文档.md` §5.2）。
  若短期内会重写宿主，本改动**可能不值得现在做** —— 建议在决定宿主重写时间点后一并评估。

---

## CR-02 · `/health.checkedAt` 的类型口径（来自 `selfcheck` 第 3 波）

**提出者**：`selfcheck` 实现者（其 `docs/实现报告.md` §7 开放问题 1）

### 冲突

| 文档 | 要求 |
|---|---|
| `mapApp` 契约规格书 §3.1 | `/health.checkedAt` 为**本地时间串** `YYYY-MM-DD HH:mm:ss` |
| `protocol.md` **P5** | 时间戳一律 **epoch 毫秒** |

### 现状处置（已采纳，无需改代码）

`selfcheck` 引擎选择：**`/health.checkedAt` 保持冻结的本地时间串**（形状不改），
事件 `selfcheck.done` / `selfcheck.ready` 用 **epoch ms**（对齐 P5），另加可选 `readyAtText` 供宿主直出。

**理由**：契约 §3.1 的形状已被前端与验收脚本依赖，"只增不改"优先。

### 请求

| # | 待定 | 建议 |
|---|---|---|
| 1 | 是否统一为一套时间类型 | 建议**维持现状**（冻结形状不动），并在契约 §3.1 补一句"`checkedAt` 为展示串，事件内改用 epoch ms" |
| 2 | 若将来重写宿主 | 直接统一为 epoch ms，展示串由前端格式化 |

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-16 | 首版：登记 CR-01（前端假进度，来自 `selfcheck` 第 3 波）、CR-02（`checkedAt` 类型口径） |
