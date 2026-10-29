# Installation de Lumen sur un poste Windows 10 ou 11 : outils (Node.js, pnpm, FFmpeg),
# dépendances, interface web, lanceur avec sa clé maître et raccourci sur le Bureau.
# Sans danger à relancer : ce qui est déjà en place est gardé (clé maître comprise).
#
# Usage : double-clic sur installer.cmd, ou
#   powershell -ExecutionPolicy Bypass -File scripts\installer.ps1 [-Dev]
param(
  # Ajoute le navigateur des tests de bout en bout (Playwright) : utile pour développer seulement.
  [switch]$Dev
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Versions imposées par package.json (« engines » et « packageManager »).
$NodeMajor = 22
$NodeWingetId = "OpenJS.NodeJS.$NodeMajor"
$FfmpegWingetId = 'Gyan.FFmpeg'
$PnpmVersion = ((Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).packageManager -split '@')[1]
# Base, clé maître et mot de passe : hors Git, propres à ce poste.
$DataDir = Join-Path $root 'data'
$Launcher = Join-Path $DataDir 'lancer-lumen.ps1'
$MasterKeyBytes = 32
$PasswordLength = 16
# Sans caractères ambigus (0/O, 1/l/I) : le mot de passe se recopie à la main sans erreur.
$PasswordAlphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$Port = 8090

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "    $text" -ForegroundColor Green }
function Fail([string]$text) {
  Write-Host ''
  Write-Host "ÉCHEC : $text" -ForegroundColor Red
  exit 1
}
function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Test-Command([string]$name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Install-WithWinget([string]$id) {
  if (-not (Test-Command 'winget')) {
    Fail "winget est introuvable. Installez « Programme d'installation d'application » (App Installer) depuis le Microsoft Store, puis relancez installer.cmd."
  }
  winget install --exact --id $id --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) { Fail "l'installation de $id a échoué (code $LASTEXITCODE)." }
  Update-SessionPath
}
function New-Secret([int]$length, [string]$alphabet) {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] $length
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

Write-Host 'Installation de Lumen' -ForegroundColor White
Update-SessionPath

Step "Node.js $NodeMajor"
if (Test-Command 'node') {
  $version = (node -v).TrimStart('v')
  if ([int]($version -split '\.')[0] -ne $NodeMajor) {
    Fail "Node.js $version est installé, Lumen demande la version $NodeMajor. Désinstallez Node.js (Paramètres > Applications), puis relancez installer.cmd."
  }
  Ok "déjà installé ($version)"
} else {
  Install-WithWinget $NodeWingetId
  if (-not (Test-Command 'node')) { Fail 'Node.js est installé mais pas encore visible : fermez cette fenêtre et relancez installer.cmd.' }
  Ok "installé ($(node -v))"
}

Step "pnpm $PnpmVersion"
if ((Test-Command 'pnpm') -and ((pnpm -v) -eq $PnpmVersion)) {
  Ok 'déjà installé'
} else {
  npm install --global "pnpm@$PnpmVersion"
  if ($LASTEXITCODE -ne 0) { Fail "l'installation de pnpm a échoué." }
  Update-SessionPath
  Ok "installé ($(pnpm -v))"
}

Step 'FFmpeg'
if (Test-Command 'ffmpeg') {
  Ok 'déjà installé'
} else {
  Install-WithWinget $FfmpegWingetId
  if (-not (Test-Command 'ffmpeg')) { Fail 'FFmpeg est installé mais pas encore visible : fermez cette fenêtre et relancez installer.cmd.' }
  Ok 'installé'
}

Step 'Dépendances du projet (quelques minutes la première fois)'
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install a échoué : vérifiez la connexion Internet, puis relancez.' }
Ok 'installées'

Step 'Interface web'
pnpm --filter @lumen/web build
if ($LASTEXITCODE -ne 0) { Fail "la construction de l'interface web a échoué." }
Ok 'construite'

if ($Dev) {
  Step 'Navigateur des tests de bout en bout (Playwright)'
  pnpm exec playwright install chromium
  if ($LASTEXITCODE -ne 0) { Fail "l'installation de Playwright a échoué." }
  Ok 'installé'
}

Step 'Lanceur et clé maître'
$password = $null
if (Test-Path $Launcher) {
  Ok 'déjà présents : clé maître et mot de passe conservés'
} else {
  New-Item -ItemType Directory -Force $DataDir | Out-Null
  $key = New-Object byte[] $MasterKeyBytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
  $password = New-Secret $PasswordLength $PasswordAlphabet
  $template = @'
# Lancement local de Lumen. Fichier hors Git (dossier data/) : il contient la clé maître.
# Perdre cette clé rend les portails enregistrés illisibles : gardez une copie de ce fichier.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:LUMEN_MASTER_KEY = '__MASTER_KEY__'
$env:LUMEN_ADMIN_PASSWORD = '__PASSWORD__'
$env:LUMEN_COOKIE_SECURE = 'false'
$env:LUMEN_HOST = '0.0.0.0'
$env:LUMEN_PORT = '__PORT__'
$env:LUMEN_DATABASE_PATH = Join-Path $root 'apps\server\data\lumen.db'
Write-Host 'Démarrage de Lumen (30 s à 1 min). Prêt quand « Server listening » s''affiche ; Ctrl+C pour arrêter.'
pnpm run server
'@
  $content = $template.Replace('__MASTER_KEY__', [Convert]::ToBase64String($key)).Replace('__PASSWORD__', $password).Replace('__PORT__', "$Port")
  # UTF-8 avec BOM : sans lui, Windows PowerShell 5.1 lit les accents de travers.
  [IO.File]::WriteAllText($Launcher, $content, (New-Object Text.UTF8Encoding $true))
  Ok 'créés (data\lancer-lumen.ps1)'
}

Step 'Raccourci « Lumen » sur le Bureau'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lumen.lnk'))
$shortcut.TargetPath = Join-Path $root 'Lumen.cmd'
$shortcut.WorkingDirectory = $root
$shortcut.Save()
Ok 'créé'

$lan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { "http://$($_.IPAddress):$Port" }
Write-Host ''
Write-Host 'Lumen est installé.' -ForegroundColor Green
Write-Host "  Lancer      : double-clic sur le raccourci « Lumen » du Bureau (ou Lumen.cmd)"
Write-Host "  Ouvrir      : http://localhost:$Port"
if ($lan) { Write-Host "  Téléphone/TV: $($lan -join '  ')" }
if ($null -ne $password) {
  Write-Host "  Connexion   : admin / $password" -ForegroundColor Yellow
  Write-Host '  (noté aussi dans data\lancer-lumen.ps1 ; gardez une copie de ce fichier, il contient la clé maître)'
}
Write-Host '  Au premier lancement, Windows demande d''autoriser Node.js : acceptez pour les réseaux privés,'
Write-Host '  sinon le téléphone et la TV ne verront pas Lumen.'
