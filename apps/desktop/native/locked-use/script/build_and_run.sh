#!/usr/bin/env bash
set -euo pipefail

locked_use_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
locked_use_mode="${1:-run}"
case "$locked_use_mode" in
  run|--verify|--debug) ;;
  *) echo "usage: $0 [run|--verify|--debug]" >&2; exit 2 ;;
esac

# Only the short-lived offline checker is eligible for replacement.
pkill -x LingLockedUsePolicyChecks >/dev/null 2>&1 || true
node "$locked_use_root/../../scripts/build-locked-use.ts"
locked_use_bin="$(swift build --package-path "$locked_use_root" -c release --show-bin-path)/LingLockedUsePolicyChecks"
if [[ "$locked_use_mode" == "--debug" ]]; then
  exec lldb -- "$locked_use_bin"
fi
exec "$locked_use_bin"
