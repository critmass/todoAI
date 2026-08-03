# Unattended driver for the model-base spike (docs/briefs/model_base_spike_qwen35.md).
#
# Runs every model through gates 0-2 in one pass: pushes any missing GGUF, verifies its hash,
# starts the host-side thermal sampler, drives the on-device harness by tapping controls found
# by label, waits for each model's suite to finish, cools the phone to a matched thermal state
# between models, then reassembles results and joins the thermal readings onto them.
#
# WHY THE COOLDOWN IS ON AP/SKIN AND NOT BATTERY. The first day of this spike gated cooldowns on
# `dumpsys battery` temperature. That is the wrong sensor: it reads the battery pack, not the SoC
# (13C lower than AP under load), and at low state of charge it partly measures discharge heating
# rather than compute. SKIN's mStatus is the throttling signal, so that is what we wait on.
#
#   .\scripts\run-model-base-spike.ps1                    # all three models
#   .\scripts\run-model-base-spike.ps1 -Models qwen08b    # just one
#   .\scripts\run-model-base-spike.ps1 -SkipPush          # models already on device
#
# Expect roughly 30 min per model plus cooldown, so ~2h for all three. Leave it plugged into a
# real charger: sustained decode draws ~1700mA, which a PC USB port does not cover, and the
# battery's lower half both drains and heats faster.

param(
  [string]$Serial = 'R5CWC240D5H',
  [string[]]$Models = @('bonsai4b', 'qwen2b', 'qwen08b'),
  [switch]$SkipPush,
  [int]$CoolToApC = 40,
  [int]$CoolMaxMinutes = 20
)

# NOT 'Stop'. The Adb helper merges stderr with 2>&1, and adb writes to stderr routinely — an
# `ls` on a file that is not there yet is a normal part of deciding whether to push it. Under
# 'Stop' every such line becomes a terminating NativeCommandError and kills a two-hour run over
# an expected condition. Failures that actually matter are thrown explicitly below.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$workDir = Join-Path $repo "docs\eval"
$thermalPath = Join-Path $workDir "qwen35_spike_thermals_$stamp.jsonl"
$logcatPath = Join-Path $env:TEMP "spike_logcat_$stamp.txt"
$resultsPath = Join-Path $workDir 'qwen35_spike_results.json'

# label shown in the harness picker -> the filename it expects on the device
$modelFiles = @{
  'bonsai4b' = 'Ternary-Bonsai-4B-TQ1_0.gguf'
  'qwen2b'   = 'Qwen3.5-2B-Q4_K_M.gguf'
  'qwen08b'  = 'Qwen3.5-0.8B-Q4_K_M.gguf'
}
$modelLabels = @{
  'bonsai4b' = 'BONSAI-4B'
  'qwen2b'   = 'QWEN3.5-2B'
  'qwen08b'  = 'QWEN3.5-0.8B'
}
$deviceDir = '/sdcard/Android/data/com.todoai/files'

# Two traps here, both of which cost an unattended run:
#
# 1. MUST invoke `adb.exe`, not `adb`. PowerShell command resolution is case-insensitive and puts
#    functions ahead of applications, so `& adb` inside a function named `Adb` re-enters this
#    function — infinite recursion, "call depth overflow", nothing reaches the device.
#
# 2. MUST be a simple function using $args, NOT an advanced one. A `[Parameter(...)]` attribute
#    makes the function advanced, which adds the common parameters, and PowerShell prefix-matches
#    `-d` to `-Debug` and swallows it. `Adb logcat -d -s ReactNativeJS` then runs as
#    `adb logcat -s ReactNativeJS` — a STREAMING logcat that never returns, so preflight hangs
#    forever with no error. $args takes every argument literally.
function Adb { & adb.exe -s $Serial @args 2>&1 }

function Get-UiNodes {
  $remote = '/sdcard/ui_spike.xml'
  Adb shell uiautomator dump $remote *>$null
  $xml = Adb shell cat $remote
  Adb shell rm -f $remote *>$null
  if (-not $xml) { return @() }
  [regex]::Matches($xml, '<node[^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?>')
}

# Taps outside this band are unreliable: below ~2150 the system navigation bar takes the touch
# (this is what made the dev affordance unreachable, and RUN FULL SUITE renders at y=2326), and
# above ~220 the harness tab strip covers the content. When a control is found outside the band,
# scroll it into view and look again rather than tapping at a coordinate SystemUI will eat.
# 110 clears the status bar without excluding the harness tab strip, whose controls sit at
# y=121-187 and tap fine (verified: 'base' registers at y=154). A 220 boundary would have pushed
# every tab into the scroll path, where the anti-stall below would eventually rescue it — but
# relying on a fallback for the normal case is how the dev-dot failure happened.
$script:SafeTopY = 110
# 2200, not 2150. The navigation bar on this 2340-tall screen starts around y=2210: a tap at
# y=2288 was swallowed by SystemUI, while y=2154 registered fine. The dev affordance sits at
# centre y=2153, so a 2150 boundary put it 3px outside the band and the runner tried to scroll
# an absolutely-positioned overlay that cannot scroll — it looped and gave up without tapping.
$script:SafeBottomY = 2200

function Tap-Label {
  param([string]$Label, [int]$Retries = 5)
  $lastY = -1
  for ($try = 1; $try -le $Retries; $try++) {
    foreach ($n in Get-UiNodes) {
      $t = $n.Groups[1].Value
      if ($t -and $t.ToLower().Contains($Label.ToLower())) {
        $x = [int](([int]$n.Groups[2].Value + [int]$n.Groups[4].Value) / 2)
        $y = [int](([int]$n.Groups[3].Value + [int]$n.Groups[5].Value) / 2)
        $outOfBand = ($y -gt $script:SafeBottomY) -or ($y -lt $script:SafeTopY)
        # Anti-stall: if a scroll did not move the element, it is not in a scrollable container
        # (an absolutely-positioned overlay, say), so scrolling again will never help. Tap it
        # rather than looping until the retry budget runs out.
        if ($outOfBand -and $y -ne $lastY) {
          $lastY = $y
          # `break`, not `continue`: after scrolling every coordinate in this dump is stale.
          if ($y -gt $script:SafeBottomY) {
            Adb shell input swipe 540 1600 540 1000 250 *>$null
          } else {
            Adb shell input swipe 540 1000 540 1600 250 *>$null
          }
          Start-Sleep -Milliseconds 600
          break
        }
        Adb shell input tap $x $y *>$null
        Write-Host "    tapped '$t' at ($x,$y)"
        return $true
      }
    }
    Start-Sleep -Seconds 2
  }
  Write-Host "    FAILED to tap '$Label'"
  return $false
}

function Get-Zone {
  param([string]$Name)
  $out = Adb shell dumpsys thermalservice
  $m = [regex]::Match($out, "Temperature\{mValue=([-\d.]+),\s*mType=\d+,\s*mName=$Name,\s*mStatus=(-?\d+)\}")
  if ($m.Success) { return @{ Value = [double]$m.Groups[1].Value; Status = [int]$m.Groups[2].Value } }
  return $null
}

function Wait-Cool {
  param([int]$TargetC, [int]$MaxMinutes)
  Write-Host "  cooling to AP <= $TargetC C (max $MaxMinutes min) ..."
  $deadline = (Get-Date).AddMinutes($MaxMinutes)
  while ((Get-Date) -lt $deadline) {
    $ap = Get-Zone 'AP'; $skin = Get-Zone 'SKIN'
    if ($ap) {
      Write-Host ("    AP={0:N1}C SKIN={1:N1}C status={2}" -f $ap.Value, $(if ($skin) { $skin.Value } else { 0 }), $(if ($skin) { $skin.Status } else { '?' }))
      if ($ap.Value -le $TargetC -and (-not $skin -or $skin.Status -eq 0)) {
        Write-Host "    cooled."; return $true
      }
    }
    Start-Sleep -Seconds 30
  }
  Write-Host "    WARNING: cooldown timed out; proceeding and recording the fact."
  return $false
}

# ---- preflight ----
Write-Host "== preflight =="
if (-not (Adb shell echo ok | Select-String 'ok')) { throw "device $Serial not reachable" }

# `adb reverse` does NOT survive a disconnect/reconnect. Without it a debug build cannot reach
# Metro, falls back to a packaged bundle that a debug build does not have, and dies on a red box
# at `loadJSBundleFromAssets` — which looks like a crash but is just a missing port forward.
# Re-establish it before anything else, then confirm the JS bundle is actually live.
Adb reverse tcp:8081 tcp:8081 *>$null

if (-not (Adb logcat -d -s ReactNativeJS | Select-String 'Running "todoAI"')) {
  Write-Host "  JS bundle not loaded; restarting the app ..."
  Adb shell am force-stop com.todoai *>$null
  Start-Sleep -Seconds 3
  Adb shell am start -n com.todoai/.MainActivity *>$null
  $bundleDeadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $bundleDeadline) {
    if (Adb logcat -d -s ReactNativeJS | Select-String 'Running "todoAI"') { break }
    Start-Sleep -Seconds 5
  }
  if (-not (Adb logcat -d -s ReactNativeJS | Select-String 'Running "todoAI"')) {
    throw "JS bundle never loaded - is Metro running (npm start)?"
  }
  Write-Host "  bundle live."
}

if (-not $SkipPush) {
  foreach ($key in $Models) {
    $file = $modelFiles[$key]
    $remote = "$deviceDir/$file"
    # Ask the device's shell to answer yes/no rather than reading adb's stderr: the test exits 0
    # either way, so a missing file is an answer instead of an error.
    $present = ((Adb shell "if [ -f '$remote' ]; then echo YES; else echo NO; fi") -join '') -match 'YES'
    if (-not $present) {
      $local = Join-Path $env:USERPROFILE "Downloads\$file"
      if (-not (Test-Path $local)) { throw "missing $local - download it before running" }
      Write-Host "  pushing $file ..."
      Adb push $local $remote | Select-Object -Last 1
    }
    $deviceHash = (Adb shell sha256sum $remote) -split '\s+' | Select-Object -First 1
    Write-Host "  $file sha256=$deviceHash"
  }
}

# ---- thermal sampler ----
Write-Host "== starting thermal sampler -> $thermalPath =="
$sampler = Start-Process -FilePath 'node' `
  -ArgumentList @((Join-Path $PSScriptRoot 'thermal-sampler.js'), $Serial, $thermalPath, '10') `
  -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $env:TEMP "thermal_stdout_$stamp.txt")

try {
  Adb logcat -c *>$null

  foreach ($key in $Models) {
    Write-Host "== $key =="
    Wait-Cool -TargetC $CoolToApC -MaxMinutes $CoolMaxMinutes | Out-Null

    # The harness lives behind the dev affordance; make sure the screen is up and we are on it.
    Adb shell input keyevent KEYCODE_WAKEUP *>$null
    Start-Sleep -Seconds 2
    Adb shell input swipe 540 1800 540 700 300 *>$null   # dismiss lockscreen if present
    Start-Sleep -Seconds 2
    if (-not (Tap-Label 'base')) {
      if (Tap-Label 'dev') { Start-Sleep -Seconds 3; Tap-Label 'base' | Out-Null }
    }
    Start-Sleep -Seconds 2
    # scroll to the top so the model picker is on screen
    for ($i = 0; $i -lt 8; $i++) { Adb shell input swipe 540 600 540 1900 250 *>$null; Start-Sleep -Milliseconds 300 }

    if (-not (Tap-Label $modelLabels[$key])) { Write-Host "  ERROR: could not select $key - skipping"; continue }
    Start-Sleep -Seconds 2
    if (-not (Tap-Label 'RUN FULL SUITE')) { Write-Host "  ERROR: no RUN FULL SUITE button - skipping"; continue }

    Write-Host "  suite running; waiting for completion ..."
    $suiteDeadline = (Get-Date).AddMinutes(60)
    while ((Get-Date) -lt $suiteDeadline) {
      $log = Adb logcat -d -s ReactNativeJS
      $done = ($log | Select-String 'SUITE COMPLETE').Count
      $aborted = ($log | Select-String 'Suite aborted').Count
      if ($done -ge ($Models.IndexOf($key) + 1) -or $aborted -ge 1) { break }
      Adb shell input keyevent KEYCODE_WAKEUP *>$null   # keep the display alive
      Start-Sleep -Seconds 30
    }
    Write-Host "  $key done."
  }
}
finally {
  Write-Host "== stopping sampler =="
  if ($sampler -and -not $sampler.HasExited) { Stop-Process -Id $sampler.Id -Force }
}

# ---- collect ----
Write-Host "== collecting =="
Adb logcat -d > $logcatPath
$fresh = Join-Path $env:TEMP "spike_fresh_$stamp.json"
node (Join-Path $PSScriptRoot 'q1-reassemble.js') $logcatPath $fresh

# Merge rather than overwrite: the logcat ring buffer rotates during a multi-hour run, so a fresh
# dump can be missing tags that are already recorded.
node (Join-Path $PSScriptRoot 'merge-results.js') $resultsPath $fresh

node (Join-Path $PSScriptRoot 'join-thermals.js') $resultsPath $thermalPath

Write-Host ""
Write-Host "results : $resultsPath"
Write-Host "thermals: $thermalPath"
Write-Host "logcat  : $logcatPath"
