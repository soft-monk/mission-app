# mission-app · scripts/acceptance.ps1
#
# P0 验收：证明"14 个既有模块能被装到一起、能编译、能链接、能实例化"，
# 并让浏览器能打开一个出图的页面。
#
# P1 验收（本文件 §7~§9）：证明**真实链路真的通**：
#   本地配置 → 仿真 → UDP → device-ingest → realtime-hub → WS 客户端
#   · /stats 接入点计数 > 0（包真的到了接入层，不是"起得来"而已）
#   · node WS 客户端**原文**收到 telemetry.uav.pos，且字段含 uavId/type/groupId/lng/lat
#   · hub.clientCount 随连/断正确增减；断开后 heartbeatClosed / closed 计数正确
#   · 机检 SimOptions::defaultKind == "uav.pos"（注入口径，不是引擎的中立占位）
#   · 离线双跑逐字节一致（假时钟；与挂钟无关）
#
# 退出码：0 = 全绿；1 = 有失败项。
#
# 纪律检查（结构守卫）：
#   · 宿主源码无业务词（阶段规则 / 评分算法 / 告警规则一律不许出现在宿主里）
#   · 宿主源码无跨模块内部 include（只允许 include/<mod>/*.h 这一个公开面）
#   · 宿主源码无 SQL
#
# 用法：
#   pwsh -File scripts/acceptance.ps1
#   pwsh -File scripts/acceptance.ps1 -SkipBuild      # 复用已有构建产物
#   pwsh -File scripts/acceptance.ps1 -SkipFrontend   # 跳过 npm 构建
[CmdletBinding()]
param(
  [string]$BuildDir   = 'build',
  [string]$Config     = 'Release',
  [int]$Port          = 8099,
  [int]$IngestPort    = 45500,
  [switch]$SkipBuild,
  [switch]$SkipFrontend,
  # sim-source / sensor-model 由另一个 agent 在写：写到一半时 configure 默认把它们掐掉，
  # 让本仓的 P0 验收仍然能证明"其余模块装得起来"。它们写完加 -IncludeInProgress 即可一起验。
  # P1 的真实链路**依赖 sim-source**，所以本文件默认按"装得上"配置（见 §2 的 _simRequired）。
  [switch]$IncludeInProgress
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$vcpkgDir = 'D:/dsh_workpath/mapApp/backend/build/vcpkg_installed/x64-windows'

$script:pass = 0
$script:fail = 0
$script:results = New-Object System.Collections.Generic.List[object]

function Check([string]$id, [string]$title, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++ } else { $script:fail++ }
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  $line = "[$tag] $id  $title"
  if ($detail) { $line += "  -- $detail" }
  Write-Host $line -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  $script:results.Add([pscustomobject]@{ Id = $id; Title = $title; Ok = $ok; Detail = $detail })
}

function Section([string]$name) {
  Write-Host ''
  Write-Host "==== $name ====" -ForegroundColor Cyan
}

# ════════════════════════════════════════════════════════════ 0 · 前置
Section '0 · 环境前置'

$haveCmake = $null -ne (Get-Command cmake -ErrorAction SilentlyContinue)
Check 'E0' 'cmake 可用' $haveCmake
$haveNode = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
Check 'E1' 'node 可用' $haveNode
$haveVcpkg = Test-Path (Join-Path $vcpkgDir 'share/drogon')
Check 'E2' 'vcpkg 树含 Drogon' $haveVcpkg $vcpkgDir
if (-not ($haveCmake -and $haveVcpkg)) {
  Write-Host '前置不满足，无法继续。' -ForegroundColor Red
  exit 1
}

# ════════════════════════════════════════════════════════════ 1 · 结构守卫
Section '1 · 结构守卫（宿主源码）'

$srcFiles = @(Get-ChildItem -Path (Join-Path $repoRoot 'packages/host/src') -Filter *.cc -File -ErrorAction SilentlyContinue)
$srcFiles += @(Get-ChildItem -Path (Join-Path $repoRoot 'packages/host/include') -Filter *.h -File -Recurse -ErrorAction SilentlyContinue)
Check 'S0' '宿主源码文件数 > 0' ($srcFiles.Count -gt 0) "$($srcFiles.Count) 个文件"

function ScanForbidden([string]$id, [string]$title, [string[]]$patterns) {
  $hits = New-Object System.Collections.Generic.List[string]
  foreach ($f in $srcFiles) {
    $lines = Get-Content -LiteralPath $f.FullName -Encoding UTF8
    for ($i = 0; $i -lt $lines.Count; $i++) {
      foreach ($p in $patterns) {
        if ($lines[$i] -match $p) {
          $hits.Add("$(Split-Path $f.FullName -Leaf):$($i + 1) $($lines[$i].Trim())")
        }
      }
    }
  }
  $detail = if ($hits.Count -eq 0) { '零命中' } else { "$($hits.Count) 处：" + ($hits[0..([Math]::Min(2, $hits.Count - 1))] -join ' | ') }
  Check $id $title ($hits.Count -eq 0) $detail
}

# 业务词：宿主里 MUST NOT 出现（阶段规则 / 评分算法 / 告警规则都是模块与规则包的事）
ScanForbidden 'S1' '无业务词（任务/方案/目标/场景/阶段/编组/评估）' @('任务', '方案', '目标', '场景', '阶段', '编组', '评估')

# 跨模块内部 include：只允许 <模块>/<公开头>.h 这条路（模块内部实现在 src/ 下，宿主不许碰）
$internalInclude = New-Object System.Collections.Generic.List[string]
foreach ($f in $srcFiles) {
  $lines = Get-Content -LiteralPath $f.FullName -Encoding UTF8
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*#\s*include\s+[<"]') {
      $inc = $lines[$i]
      if ($inc -match '/src/|\bsrc/|\/internal\.h|/detail/') {
        $internalInclude.Add("$(Split-Path $f.FullName -Leaf):$($i + 1) $($inc.Trim())")
      }
    }
  }
}
Check 'S2' '无跨模块内部 include' ($internalInclude.Count -eq 0) $(if ($internalInclude.Count -eq 0) { '零命中' } else { $internalInclude -join ' | ' })

# SQL：宿主 MUST NOT 出现（引擎不接触 SQL，落库是宿主经 I*Store 的事，P0 更没有）
$sqlHits = New-Object System.Collections.Generic.List[string]
foreach ($f in $srcFiles) {
  $lines = Get-Content -LiteralPath $f.FullName -Encoding UTF8
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '(?i)\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b') {
      $sqlHits.Add("$(Split-Path $f.FullName -Leaf):$($i + 1) $($lines[$i].Trim())")
    }
  }
}
Check 'S3' '无 SQL' ($sqlHits.Count -eq 0) $(if ($sqlHits.Count -eq 0) { '零命中' } else { $sqlHits -join ' | ' })

# 模块源码 MUST NOT 被拷进本仓（原地引用）。
# 除外的是本仓**自己的代码**：packages/ 下是宿主的包（host 是 P0 的；scenario-data 与
# sim-bridge 是 P1 的"本地配置 → 上路"那一层）。它们本来就该在本仓里，不是模块副本。
$copied = @(Get-ChildItem -Path $repoRoot -Recurse -File -Include *.h,*.cc,*.cpp -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\build\\' -and $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\.git\\' -and $_.FullName -notmatch '\\packages\\' })
Check 'S4' '本仓没有模块源码副本（packages/ 之外无 .cc/.h）' ($copied.Count -eq 0) $(if ($copied.Count -eq 0) { '零命中' } else { ($copied | Select-Object -First 3 | ForEach-Object { $_.FullName.Substring($repoRoot.Length + 1) }) -join ' | ' })

# CMake 原地引用：必须出现 add_subdirectory，且 MUST NOT 出现拷源码的命令
$cmakeText = Get-Content -LiteralPath (Join-Path $repoRoot 'CMakeLists.txt') -Raw -Encoding UTF8
Check 'S5' 'CMakeLists 原地引用模块（add_subdirectory）' ($cmakeText -match 'add_subdirectory\("\$\{MA_') '12 个模块 + 2 个条件包含'
Check 'S6' 'CMakeLists 无 file(COPY / configure_file 拷源码' (-not ($cmakeText -match '(?i)file\s*\(\s*COPY|configure_file\s*\(')) '零命中'

# ════════════════════════════════════════════════════════════ 2 · C++ 构建
Section '2 · C++ 构建（configure + build）'

$buildPath = Join-Path $repoRoot $BuildDir
$hostExe = Join-Path $buildPath "bin/$Config/mission_host.exe"
if (-not (Test-Path $hostExe)) { $hostExe = Join-Path $buildPath 'bin/mission_host.exe' }

# P1 的真实链路依赖 sim-source（scenario-data / sim-bridge 都是围着它转的）。
# 缺了它链路根本装不出来，所以验收默认把它打开（-SkipBuild 时只影响"是否重新 configure"）。
$simRequired = Test-Path (Join-Path $repoRoot '..\sim-source\CMakeLists.txt')

if (-not $SkipBuild) {
  $cfgArgs = @('-S', $repoRoot, '-B', $buildPath, '-G', 'Visual Studio 17 2022', '-A', 'x64',
               '-DCMAKE_CONFIGURATION_TYPES=Release', "-DMA_VCPKG_DIR=$vcpkgDir")
  if ($simRequired) {
    $cfgArgs += '-DMA_BUILD_SIM_SOURCE=ON'
  } elseif (-not $IncludeInProgress) {
    $cfgArgs += '-DMA_BUILD_SIM_SOURCE=OFF'
  }
  if (-not $IncludeInProgress) {
    $cfgArgs += '-DMA_BUILD_SENSOR_MODEL=OFF'
  }
  $cfgOut = & cmake @cfgArgs 2>&1
  $cfgCode = $LASTEXITCODE
  $cfgLog = Join-Path $repoRoot 'scripts/.acceptance-configure.log'
  $cfgOut | Set-Content -LiteralPath $cfgLog -Encoding UTF8
  Check 'C1' 'cmake configure 成功' ($cfgCode -eq 0) "exit=$cfgCode 日志=$cfgLog"
  if ($cfgCode -ne 0) {
    Write-Host ($cfgOut | Select-Object -Last 25 | Out-String)
    Write-Host "验收失败：configure 未通过。" -ForegroundColor Red
    exit 1
  }
  $skipped = ($cfgOut | Select-String -Pattern '跳过 (sim-source|sensor-model)' | ForEach-Object { $_.Line.Trim() })
  if ($skipped) { Write-Host "  （条件包含提示）$($skipped -join ' ; ')" -ForegroundColor DarkGray }

  Write-Host '  构建中（首次会编 12 个模块，可能要几分钟）…' -ForegroundColor DarkGray
  $buildLog = Join-Path $repoRoot 'scripts/.acceptance-build.log'
  & cmake --build $buildPath --config $Config --parallel 2>&1 | Set-Content -LiteralPath $buildLog -Encoding UTF8
  $buildCode = $LASTEXITCODE
  $errors = @(Select-String -LiteralPath $buildLog -Pattern 'error [A-Z]+\d+|error:|fatal error' -ErrorAction SilentlyContinue)
  Check 'C2' 'cmake build 退出码 0' ($buildCode -eq 0) "exit=$buildCode 日志=$buildLog"
  Check 'C3' 'build 0 error' ($errors.Count -eq 0) $(if ($errors.Count -eq 0) { '0 error' } else { "$($errors.Count) 条，首条：$($errors[0].Line.Trim())" })
  if ($buildCode -ne 0) {
    Write-Host ($errors | Select-Object -First 15 | ForEach-Object { $_.Line }) -ForegroundColor Red
    exit 1
  }
}

Check 'C4' "产物存在 $hostExe" (Test-Path $hostExe)

# ════════════════════════════════════════════════════════════ 3 · main.exe 起得来、退得干净
Section '3 · 宿主进程（起得来 / 退得干净）'

$runLog = Join-Path $repoRoot 'scripts/.acceptance-run.log'
$runErrLog = Join-Path $repoRoot 'scripts/.acceptance-run.err.log'
# 用 System.Diagnostics.Process（不是 Start-Process -PassThru）：
# -PassThru 返回的 Process 对象拿不到子进程的 ExitCode —— 必须让 -Wait 参数集自己退出。
$runPsi = New-Object System.Diagnostics.ProcessStartInfo
$runPsi.FileName = $hostExe
$runPsi.Arguments = "--stop-after 2 --port $Port --no-sim"
$runPsi.WorkingDirectory = $repoRoot
$runPsi.UseShellExecute = $false
$runPsi.CreateNoWindow = $true
$runPsi.RedirectStandardOutput = $true
$runPsi.RedirectStandardError = $true
$runProc = New-Object System.Diagnostics.Process
$runProc.StartInfo = $runPsi
$runProc.Start() | Out-Null
$runOut = $runProc.StandardOutput.ReadToEnd()
$runErr = $runProc.StandardError.ReadToEnd()
$exited = $runProc.WaitForExit(120000)
if (-not $exited) { try { $runProc.Kill() } catch {} }
$runCode = if ($exited) { $runProc.ExitCode } else { -1 }
$runOut | Out-File -LiteralPath $runLog -Encoding UTF8
$runErr | Out-File -LiteralPath $runErrLog -Encoding UTF8

Check 'R1' 'main.exe 退出码 0' ($exited -and $runCode -eq 0) "exit=$runCode"
$readyLine = ($runOut -split "`r?`n" | Where-Object { $_ -match '^\[host\] engines ready:' } | Select-Object -First 1)
Check 'R2' 'stdout 含就绪行' (-not [string]::IsNullOrWhiteSpace($readyLine)) $(if ($readyLine) { $readyLine.Trim() } else { '未找到 [host] engines ready:' })
if ($readyLine) {
  Write-Host "      实测：$($readyLine.Trim())" -ForegroundColor DarkGray
  $readyOnes = ([regex]::Matches($readyLine, '=1')).Count
  Check 'R3' '就绪行里已实例化引擎数 >= 8' ($readyOnes -ge 8) "$readyOnes 个 =1（只链接未实例化的那几个由 linked-only 行如实列出）"
} else {
  Check 'R3' '就绪行里已实例化引擎数 >= 8' $false '就绪行缺失'
}
Check 'R4' 'stdout 含退出自证行 [host] exit clean' ($runOut -match '\[host\] exit clean') ''
Check 'R5' 'stdout 含 flush telemetry-store' ($runOut -match '\[host\] telemetry-store flushed') ''
$dbg = ($runOut -split "`r?`n" | Where-Object { $_ -match '\[host\] (linked-only|flush telemetry-store)' })
foreach ($l in $dbg) { Write-Host "      $($l.Trim())" -ForegroundColor DarkGray }

# ════════════════════════════════════════════════════════════ 4 · 前端构建
Section '4 · 前端构建（apps/web）'

$webDir = Join-Path $repoRoot 'apps/web'
$distIndex = Join-Path $webDir 'dist/index.html'
if (-not $SkipFrontend) {
  if (-not (Test-Path (Join-Path $webDir 'node_modules'))) {
    Write-Host '  npm.cmd install（首次）…' -ForegroundColor DarkGray
    & npm.cmd install --no-audit --no-fund --prefix $webDir 2>&1 | Set-Content -LiteralPath (Join-Path $repoRoot 'scripts/.acceptance-npm-install.log') -Encoding UTF8
    Check 'F1' 'npm install 成功' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
  } else {
    Check 'F1' 'npm install 成功（node_modules 已存在，跳过）' $true 'skip'
  }
  Write-Host '  npm.cmd run build …' -ForegroundColor DarkGray
  $npmLog = Join-Path $repoRoot 'scripts/.acceptance-npm-build.log'
  & npm.cmd run build --prefix $webDir 2>&1 | Set-Content -LiteralPath $npmLog -Encoding UTF8
  $npmCode = $LASTEXITCODE
  Check 'F2' 'npm run build 成功' ($npmCode -eq 0) "exit=$npmCode 日志=$npmLog"
  if ($npmCode -ne 0) { Write-Host ((Get-Content -LiteralPath $npmLog -Encoding UTF8 | Select-Object -Last 20) -join "`n") -ForegroundColor Red }
}

Check 'F3' 'apps/web/dist/index.html 存在' (Test-Path $distIndex) $distIndex
Check 'F4' 'Vite 别名原地引用 map-2d' ((Get-Content -LiteralPath (Join-Path $webDir 'vite.config.ts') -Raw -Encoding UTF8) -match "'map-2d':\s*fileURLToPath") ''
Check 'F5' '页面用全屏 MapView' ((Get-Content -LiteralPath (Join-Path $webDir 'src/App.tsx') -Raw -Encoding UTF8) -match '<MapView') ''

# ════════════════════════════════════════════════════════════ 5 · /health 实测
Section '5 · 服务端 /health 实测'

$svcLog = Join-Path $repoRoot 'scripts/.acceptance-serve.log'
$svcProc = Start-Process -FilePath $hostExe -ArgumentList @('--port', "$Port", '--no-sim') `
  -WorkingDirectory $repoRoot -NoNewWindow -PassThru -RedirectStandardOutput $svcLog `
  -RedirectStandardError (Join-Path $repoRoot 'scripts/.acceptance-serve.err.log')

$healthOk = $false
$healthBody = ''
$statsBody = ''
$rootStatus = 0
$rootIsHtml = $false
$assetStatus = 0
try {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $healthOk = $true; $healthBody = $r.Content; break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if ($healthOk) {
    try { $statsBody = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/stats" -TimeoutSec 5 -UseBasicParsing).Content } catch {}
    try {
      $rr = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5 -UseBasicParsing
      $rootStatus = $rr.StatusCode
      $rootIsHtml = ("$($rr.Headers['Content-Type'])" -match 'text/html')
      # 静态产物：页面引用的第一个 /assets/ 文件必须拿得到（否则"能出图"是假的）
      $m = [regex]::Match([string]$rr.Content, '/assets/[A-Za-z0-9._-]+')
      if ($m.Success) {
        $assetStatus = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port$($m.Value)" -TimeoutSec 10 -UseBasicParsing).StatusCode
      }
    } catch {}
  }
} finally {
  if (-not $svcProc.HasExited) {
    try { Stop-Process -Id $svcProc.Id -Force } catch {}
    $svcProc.WaitForExit(15000) | Out-Null
  }
}

Check 'H1' "GET /health 返回 200" $healthOk $(if ($healthOk) { $healthBody } else { '请求失败或超时' })
Check 'H2' '/health 返回静态占位 {"status":"ok"}' ($healthBody -match '"status"\s*:\s*"ok"') $healthBody
Check 'H3' '/stats 返回各引擎就绪表' ($statsBody -match '"engines"' -and $statsBody -match '"instantiated"') $(if ($statsBody) { "长度 $($statsBody.Length)" } else { '无响应' })

# H6 是"能实例化"的硬判据：/stats 说 instantiated=true 的，必须 linked=true（不存在"没装却起来了"）。
$coreReady = 0
$badInstantiated = New-Object System.Collections.Generic.List[string]
try {
  $statsJson = $statsBody | ConvertFrom-Json
  foreach ($p in $statsJson.engines.PSObject.Properties) {
    $row = $p.Value
    if ($row.linked -and $row.instantiated) { $coreReady++ }
    if ($row.instantiated -and -not $row.linked) { $badInstantiated.Add($p.Name) }
  }
} catch { }
Check 'H6' '/stats 里没有"未链接却实例化"的引擎' ($badInstantiated.Count -eq 0) $(if ($badInstantiated.Count -eq 0) { '一致' } else { $badInstantiated -join ',' })
Check 'H7' '/stats 里已实例化引擎数 >= 8' ($coreReady -ge 8) "$coreReady 个 linked+instantiated"

Check 'H4' 'GET / 返回 200 且是 HTML（页面出得来）' ($rootStatus -eq 200 -and $rootIsHtml) "status=$rootStatus html=$rootIsHtml"
Check 'H5' '页面引用的 /assets/ 产物可取（200）' ($assetStatus -eq 200) "status=$assetStatus"
if ($healthOk) { Write-Host "      实测 /health 响应：$healthBody" -ForegroundColor DarkGray }

# ════════════════════════════════════════════════════════════ 6 · P1 结构守卫与机检
Section '6 · P1 机检（注入口径 / 装配契约）'

$hostSrcDir = Join-Path $repoRoot 'packages/host'
function ReadSrc([string]$rel) {
  $p = Join-Path $repoRoot $rel
  if (Test-Path $p) { return (Get-Content -LiteralPath $p -Raw -Encoding UTF8) }
  return ''
}

$enginesCc = ReadSrc 'packages/host/src/engines.cc'
$simBridgeHdr = ReadSrc 'packages/sim-bridge/include/ma/sim_bridge/sim_bridge.h'
$cfgJson = ReadSrc 'config.json'

# 注入点在**装配入口**：宿主把 config 的 simKind 填进 opts.sim.defaultKind，
# sim-bridge 的 BridgeOptions 原样透传给引擎 —— 两处都要在，且不许回落引擎的中立占位。
Check 'K0' 'SimOptions::defaultKind 由装配层显式注入（不是引擎的中立占位）' `
  ($enginesCc -match 'opts\.sim\.defaultKind\s*=\s*kindName' -and `
   $simBridgeHdr -match 'sim_source::SimOptions\s+sim;' -and `
   $enginesCc -notmatch 'defaultKind\s*=\s*"sim\.pos"\s*;') `
  'engines.cc: opts.sim.defaultKind = kindName（经 BridgeOptions.sim 原样透传）'

Check 'K0b' '宿主把 config 的 simKind 传给装配层' `
  ($enginesCc -match 'opts\.sim\.defaultKind\s*=\s*kindName' -and $cfgJson -match '"simKind"\s*:\s*"uav\.pos"') `
  "config.json simKind=$(($cfgJson | ConvertFrom-Json).simKind)"

Check 'K0c' 'config.json: simKind == "uav.pos" 且 modules.hub == true' `
  ($cfgJson -match '"simKind"\s*:\s*"uav\.pos"' -and $cfgJson -match '"hub"\s*:\s*true') `
  'simKind=uav.pos, modules.hub=true'

Check 'K0d' 'config.json: 有接入点且端口避开 8080/8081/8090/8099' `
  ($cfgJson -match '"points"\s*:' -and $cfgJson -match '"parserId"\s*:\s*"legacy\.kind\.v1"' -and `
   (@((($cfgJson | ConvertFrom-Json).ingest.points) | ForEach-Object { [int]$_.port } |
      Where-Object { $_ -in @(8080, 8081, 8090, 8099) }).Count -eq 0)) `
  "ingest.points[0].port=$IngestPort parserId=legacy.kind.v1（server.port=$Port 是 HTTP 监听，不在禁令内）"

# 宿主源码 MUST 仍然没有跨模块内部 include（P1 新增的包也不例外）
$packSrcs = @()
foreach ($d in @('packages/scenario-data/src', 'packages/sim-bridge/src', 'packages/scenario-data/include', 'packages/sim-bridge/include')) {
  $packSrcs += @(Get-ChildItem -Path (Join-Path $repoRoot $d) -File -Recurse -ErrorAction SilentlyContinue)
}
$packBadInc = New-Object System.Collections.Generic.List[string]
foreach ($f in $packSrcs) {
  $lines = Get-Content -LiteralPath $f.FullName -Encoding UTF8
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*#\s*include\s+[<"]' -and $lines[$i] -match '/src/|\bsrc/|/internal\.h|/detail/') {
      $packBadInc.Add("$(Split-Path $f.FullName -Leaf):$($i + 1) $($lines[$i].Trim())")
    }
  }
}
Check 'K0e' '新包无跨模块内部 include' ($packBadInc.Count -eq 0) `
  $(if ($packBadInc.Count -eq 0) { "$($packSrcs.Count) 个文件，零命中" } else { $packBadInc -join ' | ' })

# 宿主**不许**自己拼线上格式：那是 sim-bridge 的活，宿主只注入 kind
$hostWireLeak = ($enginesCc -match 'uavId' -or $enginesCc -match 'groupId"\s*\]')
Check 'K0f' '宿主不自己拼线上格式（uavId/groupId 只出现在 sim-bridge）' (-not $hostWireLeak)

# 确定性：离线双跑（假时钟，与挂钟无关）
$detLog = Join-Path $repoRoot 'scripts/.acceptance-determinism.log'
& $hostExe --determinism-check 2>&1 | Set-Content -LiteralPath $detLog -Encoding UTF8
$detCode = $LASTEXITCODE
$detText = (Get-Content -LiteralPath $detLog -Encoding UTF8 -Raw)
Check 'K1' '离线双跑逐字节一致（假时钟）' ($detCode -eq 0 -and $detText -match '两跑逐字节一致') `
  $(if ($detText -match '确定性检查[^\r\n]*') { $Matches[0].Trim() } else { "exit=$detCode" })

# ════════════════════════════════════════════════════════════ 7 · 真实链路（起宿主 + 起仿真）
Section '7 · 真实链路：本地配置 → 仿真 → UDP → 接入层 → 广播 → WS'

$liveLog = Join-Path $repoRoot 'scripts/.acceptance-live.log'
$liveErr = Join-Path $repoRoot 'scripts/.acceptance-live.err.log'
$liveProc = Start-Process -FilePath $hostExe `
  -ArgumentList @('--speed', '8', '--port', "$Port") `
  -WorkingDirectory $repoRoot -NoNewWindow -PassThru `
  -RedirectStandardOutput $liveLog -RedirectStandardError $liveErr

function Get-Stats {
  try { return (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/stats" -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json }
  catch { return $null }
}
function Wait-Stats([scriptblock]$pred, [int]$seconds = 20) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = Get-Stats
    if ($last -ne $null -and (& $pred $last)) { return $last }
    Start-Sleep -Milliseconds 300
  }
  return $last
}

$statsLive = $null
try {
  # ---- 等它起来并**真的收到包**
  $statsLive = Wait-Stats { param($s) $s.ingest.running -and $s.ingest.packets -gt 0 } 30
  $packets = if ($statsLive) { [int]$statsLive.ingest.packets } else { 0 }
  $pointRunning = if ($statsLive) { [int]$statsLive.ingest.pointsRunning } else { 0 }
  $simRunning = if ($statsLive) { [bool]$statsLive.simulation.running } else { $false }
  $wireSent = if ($statsLive) { [int]$statsLive.simulation.wire.sent } else { 0 }

  Check 'K2' '/stats 接入点在跑（pointsRunning >= 1）' ($pointRunning -ge 1) "pointsRunning=$pointRunning"
  Check 'K3' '/stats 接入点计数 > 0（UDP 真收到了）' ($packets -gt 0) `
    "ingest.packets=$packets（仿真已发 $wireSent 包；events=$($statsLive.ingest.events)）"
  Check 'K4' '仿真节拍在跑且已产出事件' ($simRunning -and $wireSent -gt 0) `
    "simulation.running=$simRunning wire.sent=$wireSent eventsEmitted=$($statsLive.simulation.eventsEmitted)"
  Check 'K5' '/stats 里 simSource 已实例化（真实链路装上了）' `
    ([bool]$statsLive.engines.simSource.instantiated) $statsLive.engines.simSource.note
  Check 'K6' '/stats 里 ingest 的 note 报出接入点数' `
    ($statsLive.engines.ingest.note -match 'points=') $statsLive.engines.ingest.note

  # ---- WS 客户端：**原文**收到 telemetry.uav.pos
  $wsScript = Join-Path $repoRoot 'scripts/ws-client.mjs'
  $wsOut = & node $wsScript --url "ws://127.0.0.1:$Port/ws" --expect 'telemetry.uav.pos' `
      --count 3 --timeout 20000 --send-probe --tag accept 2>&1
  $wsCode = $LASTEXITCODE
  $ws = $null
  try { $ws = ($wsOut | Out-String).Trim() | ConvertFrom-Json } catch { }
  $wsFile = Join-Path $repoRoot 'scripts/.acceptance-ws.json'
  ($wsOut | Out-String) | Set-Content -LiteralPath $wsFile -Encoding UTF8

  Check 'K7' 'node WS 客户端收到 telemetry.uav.pos（>= 3 条）' `
    ($wsCode -eq 0 -and $ws -ne $null -and [int]$ws.expectCount -ge 3) `
    $(if ($ws) { "expectCount=$($ws.expectCount) total=$($ws.total) types=$($ws.types | ConvertTo-Json -Compress)" } else { "客户端输出解析失败：$wsOut" })
  Check 'K8' '事件字段含 uavId/type/groupId/lng/lat' `
    ($ws -ne $null -and @($ws.missingFields).Count -eq 0) `
    $(if ($ws -and @($ws.missingFields).Count -eq 0) { '五个字段都在' } else { "缺：$(@($ws.missingFields) -join ',')" })
  if ($ws -and $ws.firstSampleRaw) {
    Write-Host "      实测原文：$($ws.firstSampleRaw)" -ForegroundColor DarkGray
    $envSrc = Join-Path $repoRoot 'scripts/.acceptance-ws-raw.txt'
    $ws.firstSampleRaw | Set-Content -LiteralPath $envSrc -Encoding UTF8
  }
  Check 'K9' '入站帧走通了（hub 回了 sys.error，连接没断）' `
    ($ws -ne $null -and [int]$ws.types.'sys.welcome' -ge 1 -and [int]$ws.types.'sys.error' -ge 1) `
    $(if ($ws) { "sys.welcome=$($ws.types.'sys.welcome') sys.error=$($ws.types.'sys.error')" } else { 'n/a' })

  # ---- 连/断：clientCount 正确增减
  $afterClose = Wait-Stats { param($s) [int]$s.realtime.clientCount -eq 0 } 10
  $closedN = if ($afterClose) { [int]$afterClose.realtime.transport.closed } else { 0 }
  Check 'K10' '客户端断开后 clientCount 归零' `
    ($afterClose -ne $null -and [int]$afterClose.realtime.clientCount -eq 0) `
    "clientCount=$(if ($afterClose) { $afterClose.realtime.clientCount } else { 'n/a' }) transport.closed=$closedN"
  Check 'K11' '断开走的是注销路径（transport.closed >= 1）' ($closedN -ge 1) "closed=$closedN"

  # ---- 心跳判死：抓一条**还连着**的连接，让 hub 自己踢
  #
  # 判死窗口 = HubOptions.heartbeatMs × deadAfterMissedHeartbeats = 1.5 s × 3 = 4.5 s。
  # 所以那个客户端要**坐够 10 s 不说话**（--quiet-ms 让它收到数据也别自己断），
  # 维护线程每秒扫一次 —— 到点把它踢掉，heartbeatClosed +1。
  # 注意：本机回环上的对端在判死前一直"连着"，所以扫描时 sweptConnected 应当 > 0。
  $hbClosedBefore = if ($afterClose) { [int]$afterClose.realtime.hub.heartbeatClosed } else { 0 }
  $bgJob = Start-Job -ScriptBlock {
    param($node, $script, $url)
    & $node $script --url $url --expect 'telemetry.uav.pos' --count 3 --timeout 20000 `
        --quiet-ms 14000 --tag hb 2>&1
  } -ArgumentList (Get-Command node).Source, (Join-Path $repoRoot 'scripts/ws-client.mjs'), "ws://127.0.0.1:$Port/ws"

  $oneOnline = Wait-Stats { param($s) [int]$s.realtime.clientCount -ge 1 } 15
  Check 'K12' 'WS 客户端连上后 clientCount >= 1' `
    ($oneOnline -ne $null -and [int]$oneOnline.realtime.clientCount -ge 1) `
    "clientCount=$(if ($oneOnline) { $oneOnline.realtime.clientCount } else { 'n/a' })"

  $hb = Wait-Stats { param($s) [int]$s.realtime.hub.heartbeatClosed -gt $hbClosedBefore } 20
  $hbClosed = if ($hb) { [int]$hb.realtime.hub.heartbeatClosed } else { 0 }
  $alive = if ($hb) { [int]$hb.realtime.transport.sweptConnected } else { 0 }
  Check 'K13' '心跳判死：hub 踢掉"还连着但不说话"的连接并计入 heartbeatClosed' `
    ($hbClosed -gt $hbClosedBefore) `
    "heartbeatClosed=$hbClosedBefore -> $hbClosed（扫描时对端仍连着 $alive 条，sweeps=$($hb.realtime.transport.sweeps)）"
  $hbAfter = Wait-Stats { param($s) [int]$s.realtime.clientCount -eq 0 } 10
  Check 'K14' '判死后 clientCount 归零（断开路径统一）' `
    ($hbAfter -ne $null -and [int]$hbAfter.realtime.clientCount -eq 0) `
    "clientCount=$(if ($hbAfter) { $hbAfter.realtime.clientCount } else { 'n/a' })"
  if ($bgJob) { Stop-Job $bgJob -ErrorAction SilentlyContinue; Remove-Job $bgJob -Force -ErrorAction SilentlyContinue }

  # ---- 显式强断（POST /ws-close）：运维/验收用的确定性断开路径
  $bg2 = Start-Job -ScriptBlock {
    param($node, $script, $url)
    & $node $script --url $url --expect 'telemetry.uav.pos' --count 3 --timeout 20000 `
        --quiet-ms 12000 --tag hb2 2>&1
  } -ArgumentList (Get-Command node).Source, (Join-Path $repoRoot 'scripts/ws-client.mjs'), "ws://127.0.0.1:$Port/ws"
  $up2 = Wait-Stats { param($s) [int]$s.realtime.clientCount -ge 1 } 15
  $forced = 0
  try {
    $fr = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/ws-close?peer=127.0.0.1" -Method Post -TimeoutSec 5 -UseBasicParsing
    $forced = [int](($fr.Content | ConvertFrom-Json).closed)
  } catch { }
  $down2 = Wait-Stats { param($s) [int]$s.realtime.clientCount -eq 0 } 10
  Check 'K14b' 'POST /ws-close 强断后 clientCount 归零' `
    ($up2 -ne $null -and $forced -ge 1 -and $down2 -ne $null -and [int]$down2.realtime.clientCount -eq 0) `
    "closed=$forced clientCount=$(if ($down2) { $down2.realtime.clientCount } else { 'n/a' })"
  if ($bg2) { Stop-Job $bg2 -ErrorAction SilentlyContinue; Remove-Job $bg2 -Force -ErrorAction SilentlyContinue }

  # ---- 广播腿的读数自洽：投递次数 > 0 且没有 transport 错误
  $final = Get-Stats
  Check 'K15' '广播真的投递过（hub.deliveries > 0）' `
    ($final -ne $null -and [int]$final.realtime.hub.deliveries -gt 0) `
    "broadcasts=$($final.realtime.hub.broadcasts) deliveries=$($final.realtime.hub.deliveries) transportErrors=$($final.realtime.hub.transportErrors)"
  Check 'K16' '广播路径零 transport 错误、零被拒载荷' `
    ($final -ne $null -and [int]$final.realtime.hub.transportErrors -eq 0 -and [int]$final.realtime.hub.rejectedPayloads -eq 0) `
    "transportErrors=$($final.realtime.hub.transportErrors) rejectedTypes=$($final.realtime.hub.rejectedTypes) rejectedPayloads=$($final.realtime.hub.rejectedPayloads)"
  Check 'K17' '每连接发送队列有上限且被报出来' `
    ($final -ne $null -and [int]$final.realtime.transport.queueLimit -ge 1) `
    "queueLimit=$($final.realtime.transport.queueLimit) queued=$($final.realtime.transport.queued) dropped=$($final.realtime.transport.framesDropped)"
} finally {
  if ($liveProc -and -not $liveProc.HasExited) {
    try { Stop-Process -Id $liveProc.Id -Force } catch {}
    $liveProc.WaitForExit(15000) | Out-Null
  }
}

$liveText = if (Test-Path $liveLog) { Get-Content -LiteralPath $liveLog -Encoding UTF8 -Raw } else { '' }
Check 'K18' '真实链路启动日志里有接入点与仿真启动行' `
  ($liveText -match '接入点 ingest' -and $liveText -match '仿真已启动') `
  $(if ($liveText -match '\[host\] 仿真已启动[^\r\n]*') { $Matches[0].Trim() } else { '未找到启动行' })

# ════════════════════════════════════════════════════════════ 汇总
Section '汇总'

$summaryPath = Join-Path $repoRoot 'scripts/.acceptance-summary.txt'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("mission-app P0 验收  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
foreach ($r in $script:results) {
  $lines.Add(("{0}  {1,-4} {2}  {3}" -f $(if ($r.Ok) { '[PASS]' } else { '[FAIL]' }), $r.Id, $r.Title, $r.Detail))
}
$lines.Add("通过 $($script:pass) / 失败 $($script:fail)")
$lines | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ""
Write-Host "检查项：$($script:pass + $script:fail)   通过：$($script:pass)   失败：$($script:fail)" -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "明细：$summaryPath" -ForegroundColor DarkGray

if ($script:fail -gt 0) {
  Write-Host ''
  Write-Host '失败项：' -ForegroundColor Red
  foreach ($r in $script:results) { if (-not $r.Ok) { Write-Host "  - $($r.Id) $($r.Title)  $($r.Detail)" -ForegroundColor Red } }
  exit 1
}
Write-Host '全部通过 ✅' -ForegroundColor Green
exit 0
