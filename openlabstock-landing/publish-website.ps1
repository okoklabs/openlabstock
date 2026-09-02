[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SshTarget,

  [Parameter(Mandatory = $true)]
  [string]$Archive,

  [int]$Port = 22
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  throw '未找到 scp。请安装 Windows OpenSSH Client。'
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw '未找到 ssh。请安装 Windows OpenSSH Client。'
}

$archivePath = (Resolve-Path -LiteralPath $Archive -ErrorAction Stop).Path
$archiveName = Split-Path -Leaf $archivePath
if ($archiveName -notmatch '^[A-Za-z0-9._-]+\.tar\.gz$') {
  throw "压缩包文件名包含不安全字符：$archiveName"
}

$expected = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToUpperInvariant()
$checkDir = Join-Path $env:TEMP ("openlabstock-site-check-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $checkDir | Out-Null
try {
  & tar -xzf $archivePath -C $checkDir
  if ($LASTEXITCODE -ne 0) { throw "无法读取网站压缩包，退出码 $LASTEXITCODE" }
  $indexPath = Join-Path $checkDir 'index.html'
  if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw '网站压缩包缺少 index.html'
  }
  $expectedIndex = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash.ToUpperInvariant()
}
finally {
  Remove-Item -LiteralPath $checkDir -Recurse -Force -ErrorAction SilentlyContinue
}
$remoteArchive = "/tmp/$archiveName"
Write-Host "本地 SHA-256: $expected"
Write-Host "首页 SHA-256: $expectedIndex"
Write-Host "上传 $archiveName 到 $SshTarget`:$remoteArchive"

& scp -P $Port -- $archivePath "$SshTarget`:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw "scp 上传失败，退出码 $LASTEXITCODE" }

$remoteScript = @'
set -euo pipefail

ARCHIVE="__REMOTE_ARCHIVE__"
EXPECTED="__EXPECTED_SHA256__"
EXPECTED_INDEX="__EXPECTED_INDEX_SHA256__"
REMOTE_DIR=/var/www/openlabstock
STAGING="$(mktemp -d /tmp/openlabstock-site.XXXXXX)"
NEW_DIR="${REMOTE_DIR}.new.$$"
BACKUP="${REMOTE_DIR}-backup-$(date +%Y%m%d-%H%M%S)"
LIVE_HTML="$(mktemp /tmp/openlabstock-live.XXXXXX)"

cleanup() {
  rm -rf -- "$STAGING" "$NEW_DIR" "$LIVE_HTML"
}
trap cleanup EXIT

test "$(id -u)" -eq 0 || {
  echo "请使用有权写入 $REMOTE_DIR 的账号执行（建议 root 或具备等效 sudo 权限的维护账号）。" >&2
  exit 1
}
test -f "$ARCHIVE"
ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print toupper($1)}')"
test "$ACTUAL" = "$EXPECTED" || {
  echo "SHA-256 不匹配：$ACTUAL" >&2
  exit 1
}

tar -xzf "$ARCHIVE" -C "$STAGING"
test -f "$STAGING/index.html"
test -f "$STAGING/styles.css"
test -f "$STAGING/script.js"
test -d "$STAGING/assets"

install -d -m 755 "$REMOTE_DIR"
install -d -m 755 "$NEW_DIR"
cp -a "$STAGING/." "$NEW_DIR/"
chmod -R a+rX "$NEW_DIR"

if [ -e "$REMOTE_DIR" ]; then
  mv "$REMOTE_DIR" "$BACKUP"
fi
mv "$NEW_DIR" "$REMOTE_DIR"
rm -f -- "$ARCHIVE"

if ! curl --fail --silent --show-error --location https://openlabstock.com/ -o "$LIVE_HTML"; then
  echo "HTTPS 检查失败，恢复旧站。" >&2
  rm -rf -- "$REMOTE_DIR"
  if [ -e "$BACKUP" ]; then
    mv "$BACKUP" "$REMOTE_DIR"
  fi
  exit 1
fi
LIVE_SHA="$(sha256sum "$LIVE_HTML" | awk '{print toupper($1)}')"
if [ "$LIVE_SHA" != "$EXPECTED_INDEX" ]; then
  echo "公网首页内容校验失败：$LIVE_SHA" >&2
  rm -rf -- "$REMOTE_DIR"
  if [ -e "$BACKUP" ]; then
    mv "$BACKUP" "$REMOTE_DIR"
  fi
  exit 1
fi
printf '官网更新完成，首页 SHA-256：%s，旧站备份：%s\n' "$LIVE_SHA" "$BACKUP"
'@.Replace('__REMOTE_ARCHIVE__', $remoteArchive).Replace('__EXPECTED_SHA256__', $expected).Replace('__EXPECTED_INDEX_SHA256__', $expectedIndex)

Write-Host '服务器正在校验并切换网站文件。'
$remoteScript | & ssh -p $Port $SshTarget bash -s
if ($LASTEXITCODE -ne 0) { throw "远程更新失败，退出码 $LASTEXITCODE" }

Write-Host '官网发布完成。'
