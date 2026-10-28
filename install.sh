#!/usr/bin/env bash
set -Eeuo pipefail

readonly ACS_REPOSITORY="matrix8412/ACS"
readonly ACS_DEFAULT_REF="v2.0.0"

SOURCE_REF="${ACS_REF:-$ACS_DEFAULT_REF}"
INSTALL_DIR="${ACS_INSTALL_DIR:-/opt/acs}"
SERVICE_USER="${ACS_SERVICE_USER:-acs}"
OS_RELEASE_FILE="${ACS_OS_RELEASE_FILE:-/etc/os-release}"
TEMP_DIR=""

log() { printf '[ACS] %s\n' "$*"; }
fail() { printf '[ACS] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT
trap 'fail "Installation failed at line ${LINENO}."' ERR

validate_platform() {
  [[ -r "$OS_RELEASE_FILE" ]] || fail "Cannot read $OS_RELEASE_FILE."

  local distro_id distro_version pretty_name
  distro_id="$(. "$OS_RELEASE_FILE"; printf '%s' "${ID:-}")"
  distro_version="$(. "$OS_RELEASE_FILE"; printf '%s' "${VERSION_ID:-}")"
  pretty_name="$(. "$OS_RELEASE_FILE"; printf '%s' "${PRETTY_NAME:-$distro_id $distro_version}")"

  case "$distro_id:$distro_version" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13)
      log "Supported platform detected: $pretty_name"
      ;;
    *)
      fail "Unsupported platform: $pretty_name. Supported releases are Ubuntu 22.04/24.04/26.04 LTS and Debian 12/13."
      ;;
  esac
}

validate_inputs() {
  [[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || fail "Install directory must be an absolute path other than /."
  [[ "$INSTALL_DIR" != *$'\n'* && "$INSTALL_DIR" != *$'\r'* ]] || fail "Install directory contains invalid characters."
  [[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ && "$SOURCE_REF" != *..* ]] || fail "Source revision contains invalid characters."
  [[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "Service account is not a valid Linux username."
}

if [[ "${ACS_INSTALLER_TEST:-0}" == "1" ]]; then
  validate_platform
  validate_inputs
  log "Installer validation passed."
  exit 0
fi

[[ ${EUID} -eq 0 ]] || fail "Run with root privileges: curl -fsSL <installer-url> | sudo bash"
validate_platform
validate_inputs
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
[[ -d /run/systemd/system ]] || fail "The host is not booted with systemd. Containers and WSL are not supported by this installer."

export DEBIAN_FRONTEND=noninteractive
log "Installing bootstrap dependencies"
apt-get update -qq
apt-get install -y -qq ca-certificates curl rsync tar

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating dedicated service account: $SERVICE_USER"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
[[ "$(id -u "$SERVICE_USER")" -ne 0 ]] || fail "Service account must not be root."

TEMP_DIR="$(mktemp -d -t acs-install.XXXXXXXX)"
archive="$TEMP_DIR/source.tar.gz"
source_dir="$TEMP_DIR/source"
archive_url="https://codeload.github.com/${ACS_REPOSITORY}/tar.gz/${SOURCE_REF}"

log "Downloading ${ACS_REPOSITORY}@${SOURCE_REF}"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 "$archive_url" -o "$archive"
mkdir -p "$source_dir"
tar -xzf "$archive" -C "$source_dir" --strip-components=1
[[ -x "$source_dir/auto-setup.sh" || -f "$source_dir/auto-setup.sh" ]] || fail "Downloaded archive does not contain auto-setup.sh."
grep -q '^module github.com/matrix8412/acs$' "$source_dir/backend/go.mod" || fail "Downloaded archive failed the repository identity check."

marker="$INSTALL_DIR/.acs-managed-install"
if [[ -d "$INSTALL_DIR" && ! -f "$marker" ]] && [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  fail "$INSTALL_DIR already exists and is not managed by the installer. Choose another install directory or move the existing directory."
fi

install -d -m 0755 "$INSTALL_DIR"
printf 'status=installing\nrepository=%s\nref=%s\n' "$ACS_REPOSITORY" "$SOURCE_REF" >"$marker"
rsync -a --delete \
  --exclude '/.acs-managed-install' \
  --exclude '/backend/.env' \
  --exclude '/backend/uploads/' \
  "$source_dir/" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/setup.sh" "$INSTALL_DIR/auto-setup.sh"

log "Running the production installer"
ACS_SERVICE_USER="$SERVICE_USER" bash "$INSTALL_DIR/auto-setup.sh"

printf 'status=installed\nrepository=%s\nref=%s\ninstalled_at=%s\n' \
  "$ACS_REPOSITORY" "$SOURCE_REF" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$marker"

log "Installation finished successfully"
log "Source: ${ACS_REPOSITORY}@${SOURCE_REF}"
log "Path:   $INSTALL_DIR"
