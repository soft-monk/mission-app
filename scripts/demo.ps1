# mission-app · scripts/demo.ps1
#
# 演示用的一把梭脚本：起宿主 / 看状态 / 一键跑全流程 / 优雅停。
#
# 为什么要有它：宿主是**长跑进程**，而 PowerShell 里最容易被忽略的两件事是
#   ① 从前台终端 Ctrl+C 才是"优雅停"（先 flush 留存层再逆序停模块）；
#   ② 后台起起来的进程收不到 Ctrl+C，硬杀又等于不 flush。
# 所以宿主提供了 `POST /shutdown`（走正常退出序列），本脚本的 stop 用它。
#
# 用法（在 mission-app 根目录下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve                 # 后台起宿主（默认 8099 / 8x），并打印页面地址
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 status                # 看当前流程状态（步/阶段/任务/仿真读数）
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 runAll                # 一键把 Excel 11 步跑完（逐步回执）
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 runAll -Speed 60      # 60 倍速跑（演示用）
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 stop                  # 优雅停（先 flush 再停模块）
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve -Port 8100 -IngestPort 45501   # 并行第二个实例（必须错开 UDP 端口）
#
# 参数：
#   -Port <int>        监听端口（默认 8099）
#   -Speed <1|8|60>    仿真倍速（默认 8）
#   -IngestPort <int>  覆盖 config.json 里 UDP 接入点端口（默认不动；并行实例时必须错开）
#   -NoBuild           跳过构建（默认会先 cmake --build）
param(
    [Parameter(Position = 0)]
    [ValidateSet('serve', 'status', 'runAll', 'stop')]
    [string]$Action = 'serve',
    [int]$Port = 8099,
    [ValidateSet(1, 8, 60)][int]$Speed = 8,
    [int]$IngestPort = 0,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # mission-app/
$exe = Join-Path $root 'build\bin\Release\mission_host.exe'
$logOut = Join-Path $root 'scripts\.demo-host.out.log'
$logErr = Join-Path $root 'scripts\.demo-host.err.log'
$base = "http://127.0.0.1:$Port"

function Say($m) { Write-Output "[demo] $m" }

function Get-State {
    try { return (Invoke-WebRequest "$base/api/state" -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json }
    catch { return $null }
}

function Invoke-Cmd([string]$verb, $params = @{}) {
    $body = @{ verb = $verb; params = $params } | ConvertTo-Json -Depth 8 -Compress
    return (Invoke-WebRequest "$base/api/command" -Method POST -Body $body -ContentType 'application/json' `
            -TimeoutSec 600 -UseBasicParsing).Content | ConvertFrom-Json
}

function Wait-Ready([int]$seconds = 40) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Get-State) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

switch ($Action) {
    'serve' {
        if (-not $NoBuild) {
            Say '构建宿主（0 error 才算过）…'
            cmake --build (Join-Path $root 'build') --config Release --parallel |
                Select-String -Pattern 'error C|error LNK|mission_host.vcxproj ->' | Select-Object -First 4 |
                ForEach-Object { $_.Line }
        }
        if (-not (Test-Path $exe)) { throw "找不到 $exe（先跑一次 make：cmake -S . -B build -G `"Visual Studio 17 2022`" -A x64）" }

        # 并行第二个实例：config.json 里 UDP 接入点是 45500，两个实例都绑它就只有一个收得到包
        $cfgArgs = @()
        if ($IngestPort -gt 0) {
            $cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $cfg.ingest.points[0].port = $IngestPort
            $tmp = Join-Path $root "scripts\.demo-config-$Port.json"
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $tmp -Encoding UTF8
            $cfgArgs = @('--config', $tmp)
            Say "接入点端口改为 $IngestPort（临时配置 $tmp）"
        }

        if (Get-State) { Say "已经有实例在 $base 上跑着（先 stop）"; break }
        $hostArgs = @('--speed', "$Speed", '--port', "$Port") + $cfgArgs
        # ★ 起进程这件事有两个坑，都在这里绕开了：
        #   ① **Windows PowerShell 5.1 的 `Start-Process -RedirectStandardOutput` 会一直等到子进程退出**
        #      （PS 7 不会）—— 用它起长跑宿主，脚本就永远不返回（实测卡死 3 分钟以上）；
        #   ② 所以日志改为**宿主自己落盘**（`--log <文件>`）：调用方不需要任何重定向参数，
        #      `Start-Process` 立刻返回，宿主在后台继续跑，日志照样留痕。
        $hostArgs = $hostArgs + @('--log', $logOut)
        Start-Process -FilePath $exe -ArgumentList $hostArgs -WorkingDirectory $root -WindowStyle Hidden
        if (-not (Wait-Ready)) { Say "起不来，看 $logOut / $logErr"; break }
        $st = Get-State
        Say "已就绪：$base/   （排障后门 $base/?stage=map）"
        Say ("引擎就绪：selfCheckReady={0}  step={1}  phase='{2}'" -f $st.selfCheckReady, $st.step, $st.phase)
        Say "日志：$logOut"
        Say "下一步：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 runAll    （或直接在浏览器里点）"
    }

    'status' {
        $st = Get-State
        if (-not $st) { Say "$base 上没有实例在跑"; break }
        Say ("步 {0}/11（{1}）· 阶段 '{2}' · 任务 {3}" -f $st.step, $st.stepKey, $st.phase, $st.missionId)
        $sim = $st.simulation
        if ($sim) { Say ("仿真：running={0} paused={1} speed={2}x simElapsedMs={3}" -f $sim.running, $sim.paused, $sim.speed, $sim.simElapsedMs) }
        if ($st.selfCheck) { Say ("自检：{0}（{1} 项，{2} ms）" -f $st.selfCheck.status, $st.selfCheck.items.Count, $st.selfCheck.elapsedMs) }
        if ($st.wsClients -ne $null) { Say ("实时连接数：{0}" -f $st.wsClients) }
    }

    'runAll' {
        if (-not (Get-State)) { Say '没有实例在跑，先：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\demo.ps1 serve'; break }
        Say 'sim.reset（把仿真源重建回起点，不重启进程）…'
        $r0 = Invoke-Cmd 'sim.reset'
        Say ("  code={0}  simElapsedMs {1} → {2}  平台 {3} 台" -f $r0.code, $r0.data.before.simElapsedMs, $r0.data.after.simElapsedMs, $r0.data.platforms)
        Say "mission.reset（清任务与阶段）…"
        $null = Invoke-Cmd 'mission.reset'
        Say ("flow.runAll（倍速 {0}x，11 步一次跑完）…" -f $Speed)
        $r = Invoke-Cmd 'flow.runAll' @{ speed = $Speed }
        if ($r.code -ne 0) { Say ("失败：code={0} {1}" -f $r.code, $r.error.message); break }
        foreach ($s in $r.data.steps) {
            # 注意：这里**不能**写 `$flag = if (...) {...} else {...}` —— 那是 PowerShell 7 的写法，
            # Windows PowerShell 5.1 会报"赋值表达式不合法"（本脚本要能在 5.1 上跑）。
            $flag = '✗'
            if ($s.code -eq 0) { $flag = '✓' }
            Say ("  {0} 步 {1,2}  {2,-22} code={3,-4} {4,6} ms" -f $flag, $s.step, $s.verb, $s.code, $s.ms)
        }
        $sum = $r.data.summary
        $failed = '(无)'
        if ($null -ne $sum.failedStep) { $failed = "$($sum.failedStep)" }
        Say ("汇总：ok={0} failedStep={1} 总耗时 {2} ms 倍速 {3}x" -f $sum.ok, $failed, $sum.totalMs, $sum.speed)
        $st = Get-State
        Say ("现在：步 {0}/11 · 阶段 '{1}'（页面会自己跟到这一步）" -f $st.step, $st.phase)
    }

    'stop' {
        if (-not (Get-State)) { Say "$base 上没有实例在跑"; break }
        Say '请求优雅停（先 flush 留存层，再按装配逆序停模块）…'
        try { $null = Invoke-WebRequest "$base/shutdown" -Method POST -TimeoutSec 10 -UseBasicParsing } catch { }
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 1
            if (-not (Get-State)) { Say '已停（正常退出序列）'; break }
        }
        if (Get-State) { Say '还没停：它可能是前台跑的，去那个终端按 Ctrl+C' }
    }
}
