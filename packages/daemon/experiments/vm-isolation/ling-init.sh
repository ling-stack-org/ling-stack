#!/bin/sh
set -eu
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
/usr/bin/busybox --install -s /usr/bin
fail() { echo "LING_VM_SETUP_FAILED $1"; poweroff -f; while :; do sleep 1; done; }
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev
mkdir -p /input /output
modprobe virtiofs || fail virtiofs
mount -t virtiofs ling-input /input || fail input
mount -t virtiofs ling-output /output || fail output
echo LING_VM_READY
case " $(cat /proc/cmdline) " in
  *' ling_mode=cancel '*) while :; do sleep 1; done ;;
esac
read_ok=false; readonly_ok=false; canary_ok=false; network_ok=false; output_ok=false
[ "$(cat /input/allowed.txt)" = 'research input' ] && read_ok=true
if ! echo denied >/input/forbidden.txt 2>/dev/null; then readonly_ok=true; fi
[ ! -e /private-canary ] && [ ! -e /input/../private-canary ] && [ ! -e /input/unshared-canary ] && canary_ok=true
[ "$(ls /sys/class/net)" = 'lo' ] && network_ok=true
if printf 'research artifact\n' >/output/result.txt; then output_ok=true; fi
# Host export must reject this symlink even though the guest may create it.
ln -s /etc/passwd /output/symlink.txt
echo "LING_VM_RESULT {\"readAllowed\":$read_ok,\"readOnlyWriteDenied\":$readonly_ok,\"unsharedCanaryAbsent\":$canary_ok,\"noNetworkDevice\":$network_ok,\"outputWritten\":$output_ok}"
read -r ack </dev/hvc0
[ "$ack" = ACK ] || fail host_ack
sync
poweroff -f
