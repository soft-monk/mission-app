# mission-app · scripts/manual.ps1
#
# **手点模式的辅助小工具**：给"自己在页面上点"的人用。它只做四件事 —— 跳屏 / 复位 / 看状态 / 逃生舱。
#
# 为什么需要它：界面本身是**按真实前置**串起来的（该灰的按钮就灰着），
# 但演示时经常要"直接看第 9 屏""点乱了想回起点"——这些能力在宿主命令面上有，界面上没有按钮。
#
# 用法（在 mission-app 根目录下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 state          # 现在第几步 / 哪个阶段 / 任务号
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 goto 7         # 跳到第 7 屏（**不改变引擎状态**，纯演示用）
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 goto summary   # 也可以按步骤 key 跳
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 reset          # 回步 1 起点（仿真回起点 + 清任务 + 清自检）
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 cmd sim.speed '{"speed":60}'   # 逃生舱：发任意 verb
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\manual.ps1 log 30          # 看宿主日志最后 30 行
#
# 参数：
#   -Action  state | goto | reset | cmd | log        （默认 state）
#   -Arg      goto 的步骤号/key；cmd 的 verb；log 的行数
#   -Json     cmd 的 params（JSON 字符串，可省）
#   -Port     宿主端口（默认 8099）
param(
    [Parameter(Position = 0)]
    [ValidateSet('state', 'goto', 'reset', 'cmd', 'log')]
    [string]$Action = 'state',
    [Parameter(Position = 1)][string]$Arg = '',
    [Parameter(Position = 2)][string]$Json = '',
    [int]$Port = 8099
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$base = "http://127.0.0.1:$Port"
$logFile = Join-Path $root 'scripts\.demo-host.out.log'

function Say($m) { Write-Output "[manual] $m" }

function Invoke-Cmd([string]$verb, $params = @{}) {
    $body = @{ verb = $verb; params = $params } | ConvertTo-Json -Depth 8 -Compress
    return (Invoke-WebRequest "$base/api/command" -Method POST -Body $body -ContentType 'application/json' `
            -TimeoutSec 600 -UseBasicParsing).Content | ConvertFrom-Json
}

function Get-State {
    try { return (Invoke-WebRequest "$base/api/state" -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json }
    catch { return $null }
}

$st = Get-State
if (-not $st) { Say "没有实例在 $base 上跑：先 powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve"; exit 1 }

switch ($Action) {
    'state' {
        Say ("步 {0}/11（{1}）· 屏名 '{2}' · 阶段 '{3}' · 任务 {4}" -f $st.step, $st.stepKey, $st.stepTitle, $st.phase, $st.missionId)
        if ($st.simulation) { Say ("仿真：running={0} paused={1} speed={2}x simElapsedMs={3}" -f $st.simulation.running, $st.simulation.paused, $st.simulation.speed, $st.simulation.simElapsedMs) }
        if ($st.selfCheck) { Say ("自检：{0}（{1} 项）" -f $st.selfCheck.status, $st.selfCheck.items.Count) }
    }

    'goto' {
        if ([string]::IsNullOrWhiteSpace($Arg)) { Say '用法：manual.ps1 goto <1..11 | 步骤 key>'; break }
        $n = 0
        $params = @{}
        if ([int]::TryParse($Arg, [ref]$n)) { $params = @{ step = $n } } else { $params = @{ key = $Arg } }
        $r = Invoke-Cmd 'flow.goto' $params
        if ($r.code -ne 0) { Say ("跳转失败：code={0} {1}" -f $r.code, $r.error.message); break }
        Say ("已跳到步 {0}（{1}）· 阶段 '{2}'  页面会自己跟过去（它在轮询 /api/state）" -f $r.data.step, $r.data.stepKey, $r.data.phase)
        if ($r.data.simNote) { Say ("提示：{0}" -f $r.data.simNote) }
        Say '注意：跳屏**不改变引擎状态**（不建任务、不采纳方案）。要看"有数据"的屏，得按手册顺序真的点过去。'
    }

    'reset' {
        Say 'sim.reset（仿真源重建回起点）…'
        $r0 = Invoke-Cmd 'sim.reset'
        if ($r0.code -eq 0) { Say ("  simElapsedMs {0} → {1}；平台 {2} 台" -f $r0.data.before.simElapsedMs, $r0.data.after.simElapsedMs, $r0.data.platforms) }
        else { Say ("  code={0}（仿真源没装配？）" -f $r0.code) }
        Say 'mission.reset（清任务与阶段）…'
        $r1 = Invoke-Cmd 'mission.reset'
        Say ("  code={0}" -f $r1.code)
        Say 'boot.reset（清自检与启动进度 → 回步 1）…'
        $r2 = Invoke-Cmd 'boot.reset'
        Say ("  code={0}" -f $r2.code)
        $now = Get-State
        Say ("现在：步 {0}/11（{1}）· 阶段 '{2}' —— 刷新页面就是全新一轮" -f $now.step, $now.stepKey, $now.phase)
    }

    'cmd' {
        if ([string]::IsNullOrWhiteSpace($Arg)) { Say '用法：manual.ps1 cmd <verb> ["<params json>"]'; break }
        $p = @{}
        if (-not [string]::IsNullOrWhiteSpace($Json)) { $p = $Json | ConvertFrom-Json -AsHashtable }
        $r = Invoke-Cmd $Arg $p
        Say ("code={0}" -f $r.code)
        $r | ConvertTo-Json -Depth 8
    }

    'log' {
        $n = 30
        if (-not [string]::IsNullOrWhiteSpace($Arg)) { $n = [int]$Arg }
        if (-not (Test-Path $logFile)) { Say "还没有日志文件 $logFile（宿主是用 demo.ps1 serve 起的才会有）"; break }
        Get-Content $logFile -Encoding UTF8 -Tail $n
    }
}
