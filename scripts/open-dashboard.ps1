[CmdletBinding()]
param([string]$Distro = 'Arch', [string]$TokenPath = '/root/.local/share/lan-agent/token', [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$token = ((& wsl.exe -d $Distro -- cat $TokenPath) -join '').Trim()
if ($LASTEXITCODE -ne 0 -or $token.Length -lt 24) { throw 'Cannot read pairing token. Start the WSL bridge first.' }
# URL fragment is not sent in HTTP requests. The dashboard clears it immediately.
$url = "http://localhost:$Port/#token=$([Uri]::EscapeDataString($token))"
Start-Process $url
Write-Output 'Opened LAN Agent. Choose phone pairing to display the QR code. Do not share the QR code.'
