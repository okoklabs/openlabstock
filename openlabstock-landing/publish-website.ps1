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
$remoteArchive = "/tmp/$archiveName"
Write-Host "本地 SHA-256: $expected"
Write-Host "上传 $archiveName 到 $SshTarget`:$remoteArchive"

& scp -P $Port -- $archivePath "$SshTarget`:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw "scp 上传失败，退出码 $LASTEXITCODE" }

$remoteScript = @'
set -euo pipefail

ARCHIVE="__REMOTE_ARCHIVE__"
EXPECTED="__EXPECTED_SHA256__"
REMOTE_DIR=/var/www/openlabstock
STAGING="$(mktemp -d /tmp/openlabstock-site.XXXXXX)"
NEW_DIR="${REMOTE_DIR}.new.$$"
BACKUP="${REMOTE_DIR}-backup-$(date +%Y%m%d-%H%M%S)"

cleanup() {
  rm -rf -- "$STAGING" "$NEW_DIR"
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

if ! curl --fail --silent --show-error --head https://openlabstock.com/ >/dev/null; then
  echo "HTTPS 检查失败，恢复旧站。" >&2
  rm -rf -- "$REMOTE_DIR"
  if [ -e "$BACKUP" ]; then
    mv "$BACKUP" "$REMOTE_DIR"
  fi
  exit 1
fi
printf '官网更新完成，旧站备份：%s\n' "$BACKUP"
'@.Replace('__REMOTE_ARCHIVE__', $remoteArchive).Replace('__EXPECTED_SHA256__', $expected)

Write-Host '服务器正在校验并切换网站文件。'
$remoteScript | & ssh -p $Port $SshTarget bash -s
if ($LASTEXITCODE -ne 0) { throw "远程更新失败，退出码 $LASTEXITCODE" }

Write-Host '官网发布完成。'
