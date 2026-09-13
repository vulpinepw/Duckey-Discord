param(
    [int]$Port = 9224,
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ScriptPath)) {
    Write-Host "Script not found: $ScriptPath"
    exit 1
}

$code = [System.IO.File]::ReadAllText($ScriptPath, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($code)) {
    Write-Host "Script is empty"
    exit 1
}

$targets = Invoke-RestMethod -Uri "http://localhost:$Port/json" -TimeoutSec 5
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*discord.com*' } | Select-Object -First 1
if (-not $page) {
    $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
}
if (-not $page) {
    Write-Host "No CDP page target found"
    exit 1
}

Write-Host "Target: $($page.url)"

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None

try {
    $connect = $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct)
    if (-not $connect.Wait(10000)) {
        Write-Host "WebSocket connect timeout"
        exit 1
    }
} catch {
    Write-Host "WebSocket connect failed: $_"
    exit 1
}

if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
    Write-Host "WebSocket not open: $($ws.State)"
    exit 1
}

$payload = @{
    id = 1
    method = 'Runtime.evaluate'
    params = @{
        expression = $code
        awaitPromise = $true
        includeCommandLineAPI = $true
    }
} | ConvertTo-Json -Depth 10 -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)

try {
    $send = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct)
    if (-not $send.Wait(10000)) {
        Write-Host "Send timeout"
        exit 1
    }
} catch {
    Write-Host "Send failed: $_"
    exit 1
}

$buf = New-Object byte[] 65536
$seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)

try {
    $recv = $ws.ReceiveAsync($seg, $ct)
    if (-not $recv.Wait(10000)) {
        Write-Host "Receive timeout"
        exit 1
    }
} catch {
    Write-Host "Receive failed: $_"
    exit 1
}

$response = [System.Text.Encoding]::UTF8.GetString($buf, 0, $recv.Result.Count)

if ($response -match '"error"') {
    Write-Host "Injection error: $response"
    $ws.Dispose()
    exit 1
}

Write-Host "Injected successfully"
$ws.Dispose()
exit 0