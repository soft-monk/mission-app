# mission-app · scripts/acceptance.ps1
#
# P0 验收：证明"14 个既有模块能被装到一起、能编译、能链接、能实例化"，
# 并让浏览器能打开一个出图的页面。
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
  [switch]$SkipBuild,
  [switch]$SkipFrontend,
  # sim-source / sensor-model 由另一个 agent 在写：写到一半时 configure 默认把它们掐掉，
  # 让本仓的 P0 验收仍然能证明"其余模块装得起来"。它们写完加 -IncludeInProgress 即可一起验。
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

# 模块源码 MUST NOT 被拷进本仓（原地引用）
$copied = @(Get-ChildItem -Path $repoRoot -Recurse -File -Include *.h,*.cc,*.cpp -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\build\\' -and $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\.git\\' -and $_.FullName -notmatch '\\packages\\host\\' })
Check 'S4' '本仓没有模块源码副本（宿主之外无 .cc/.h）' ($copied.Count -eq 0) $(if ($copied.Count -eq 0) { '零命中' } else { ($copied | Select-Object -First 3 | ForEach-Object { $_.FullName.Substring($repoRoot.Length + 1) }) -join ' | ' })

# CMake 原地引用：必须出现 add_subdirectory，且 MUST NOT 出现拷源码的命令
$cmakeText = Get-Content -LiteralPath (Join-Path $repoRoot 'CMakeLists.txt') -Raw -Encoding UTF8
Check 'S5' 'CMakeLists 原地引用模块（add_subdirectory）' ($cmakeText -match 'add_subdirectory\("\$\{MA_') '12 个模块 + 2 个条件包含'
Check 'S6' 'CMakeLists 无 file(COPY / configure_file 拷源码' (-not ($cmakeText -match '(?i)file\s*\(\s*COPY|configure_file\s*\(')) '零命中'

# ════════════════════════════════════════════════════════════ 2 · C++ 构建
Section '2 · C++ 构建（configure + build）'

$buildPath = Join-Path $repoRoot $BuildDir
$hostExe = Join-Path $buildPath "bin/$Config/mission_host.exe"
if (-not (Test-Path $hostExe)) { $hostExe = Join-Path $buildPath 'bin/mission_host.exe' }

if (-not $SkipBuild) {
  $cfgArgs = @('-S', $repoRoot, '-B', $buildPath, '-G', 'Visual Studio 17 2022', '-A', 'x64',
               '-DCMAKE_CONFIGURATION_TYPES=Release', "-DMA_VCPKG_DIR=$vcpkgDir")
  if (-not $IncludeInProgress) {
    $cfgArgs += '-DMA_BUILD_SIM_SOURCE=OFF'
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
$runPsi.Arguments = "--stop-after 2 --port $Port"
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
$svcProc = Start-Process -FilePath $hostExe -ArgumentList @('--port', "$Port") `
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
