# 界面截图索引（真机 · 1280×800 · 由验收脚本自动落盘）

> 全部截图都由对应阶段的验收脚本在**真宿主 + 真前端**上抓的（Chrome CDP `Emulation.setDeviceMetricsOverride(1280x800)`），
> 不是设计稿、不是拼的。重跑脚本会就地刷新这些图。

| 文件 | Excel 步 | 对应参考图 | 怎么复现 |
|---|---|---|---|
| `p2-1-boot.png` | 1 启动加载 | `系统启动界面一.png` | `node scripts/p2-check.mjs` |
| `p2-2-selfcheck.png` | 2 自检校验 | `系统启动界面二.png` | 同上 |
| `p2-3-situation.png` | 3 任务态势（进入任务那一刻） | `T0-1` | 同上 |
| `p3-1-situation.png` | 3 任务态势（区域/空域/集群/目标 + 图层工具） | `T0-1/T0-2` | `node scripts/p3-check.mjs` |
| `p3-1-grouping.png` / `p3-2-grouping.png` | 4 无人机分组与任务编组（三方案卡 + 推荐 93%） | `T1-1` | 同上 / 前端 `.p3-ui.mjs` |
| `p3-3-groupconfirm.png` / `p3-3b-groupconfirm-after.png` | 5 编组确认（确认前后） | `T1-2` | 同上 |
| `p4-1-execute.png` | 6 任务执行（链路 15 条 + 覆盖率/遍历周期 + 倍速控制） | `T2-1/T3-1` | `node scripts/p4-check.mjs` |
| `p4-2-targets.png` | 7 实时侦察目标（目标随探测出现 + 详情 + 视频/SAR） | `T4-1/T4-2` | 同上 |
| `p5-1-strike.png` | 8 任务决策与打击准备（三打击方案：协同方式/预计完成分钟） | `T5-1` | `node scripts/p5-check.mjs` |
| `p5-2-strikeconfirm.png` | 9 打击方案确认（IP 点高亮 + 引导连线 10 条 + 时间轴 4 段含 `basis`） | `T5-2` | 同上 |
| `p6-1-guidance.png` | 10 协同执行与引导（命中后目标变灰 + 回传画面） | `T6-1/T6-2` | `node scripts/p6-check.mjs` |
| `p6-2-summary.png` | 11 任务总结（报告 6 组 30 字段 + 时间轴 + 预警计数 + 缺失原因） | `T7-1/T7-2` | 同上 |
| `p7-1-running.png` | 一键串联进行中（页面跟着走） | — | `node scripts/p7-check.mjs` |
| `p7-2-summary.png` | 一键串联结束（步 11） | — | 同上 |

**看图小贴士**：
- 每一屏都有**左上角流程徽标**（步 N/11 · 屏名 · 阶段），底部是全局状态条（系统/无人机/数据链路/定位/AI/安全）。
- 界面上凡是"未提供/未就绪"的字段，都会**带上原因与来源**（例如 AI 分析腿未接、留存层无数据）——
  这是本工程的纪律：MUST NOT 编数值或显示成 0。
