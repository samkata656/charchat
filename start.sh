#!/bin/sh
# Usage:  ./start.sh            (this computer only)
#         ./start.sh --lan      (reachable from other devices, e.g. over Tailscale)
cd "$(dirname "$0")"
exec python3 server.py --no-browser "$@"
