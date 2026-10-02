# Run in administrator PowerShell. Bind only the chosen LAN IP; firewall is LocalSubnet-scoped.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ListenAddress,
  [string]$Distro = 'Ubuntu',
  [ValidateRange(1024,65535)][int]$Port = 8787,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as administrator.' }
$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($ListenAddress,[ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'ListenAddress must be an IPv4 LAN address.' }
$rule = "LAN-Agent-$Port-$ListenAddress"
if ($Remove) {
  & netsh interface portproxy delete v4tov4 listenaddress=$ListenAddress listenport=$Port
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Output 'Removed only LAN Agent forwarding and firewall rule.'
  exit
}
if (-not (Get-NetIPAddress -IPAddress $ListenAddress -ErrorAction SilentlyContinue)) { throw 'ListenAddress is not assigned to this computer.' }
# hostname -I can be blank on recent WSL; query the primary route explicitly.
$linux = "ip -4 -o addr show dev eth0"
$line = (& wsl.exe -d $Distro -- sh -lc $linux) -join ' '
if ($LASTEXITCODE -ne 0 -or $line -notmatch 'inet\s+(\d+\.\d+\.\d+\.\d+)/') { throw 'Cannot determine WSL eth0 IPv4 address. Check the distro name.' }
$wslIp = $Matches[1]
Set-Service iphlpsvc -StartupType Automatic
Start-Service iphlpsvc
& netsh interface portproxy add v4tov4 listenaddress=$ListenAddress listenport=$Port connectaddress=$wslIp connectport=$Port
if ($LASTEXITCODE -ne 0) { throw 'portproxy failed' }
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $ListenAddress -RemoteAddress LocalSubnet -Profile Any | Out-Null
Write-Output "LAN URL: http://${ListenAddress}:$Port -> WSL ${wslIp}:$Port"
Write-Output 'After WSL restarts its IP may change: run this script again. No public-network forwarding is configured.'
