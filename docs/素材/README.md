# 素材（用户提供的原图）

> **这份目录是什么**：`docs\素材\png库\` 是**用户提供的素材库原件**，逐字节原样入库 ——
> 目的是"换机器 / 重新 clone 之后素材不会丢"。
>
> 它**不参与构建**（`docs/` 不会被拷进 `apps/web/dist`），网页上用的是 `apps/web/public/` 里那份
> 已经改好名、压好尺寸的副本。

## 原件 → 项目里用的文件

| 素材库原件（`docs\素材\png库\`） | 项目里（`apps/web/public/`） | 用在哪 |
|---|---|---|
| `网络连接 (1).png` | `status-network.png` | 启动/自检页右侧「系统状态」第 1 行（宿主 key = `network`） |
| `数据链接.png` | `status-datalink.png` | 同上第 2 行（`datalink`） |
| `定位.png` | `status-position.png` | 同上第 3 行（`gps`） |
| `安全.png` | `status-security.png` | 同上第 4 行（`security`） |
| `WIFI.png` | `wifi-on.png` | 顶栏 WiFi —— **能连通百度**时 |
| `无wifi.png` | `wifi-off.png` | 顶栏 WiFi —— **连不通百度**时 |
| `用户.png` | `user.png` | 顶栏最右的用户头像 |
| `earth.png`（4256×2832 / 15.5 MB） | `earth.jpg`（1920×1278 / 384 KB） | 启动加载界面（SH-01）的底图 |

## 两处"不是原样拷贝"的地方，写清楚免得以后误会

1. **改了文件名**：URL 里不带中文，省掉编码这一类麻烦。对照关系就是上表。
2. **底图重新压过**：`earth.png` 15.5 MB 直接当网页底图太重，压成了 `earth.jpg`（1920 宽 / q=0.9 / 384 KB）。
   **没有裁切、没有调色**。要换尺寸或质量，重新压一遍即可（原件就在本目录）。

## 顶栏 WiFi 是"真探测"，不是写死的图标

浏览器发不出 ICMP，所以判据是 `fetch(https://www.baidu.com/favicon.ico, {mode:'no-cors'})` + 3.5 s 超时：
通了用 `wifi-on.png`，不通（含超时、浏览器 offline）用 `wifi-off.png`。进页面探一次，之后每 15 s 重探。
实现在 `apps/web/src/screens/Chrome.tsx` 的 `useNetReach()`。
