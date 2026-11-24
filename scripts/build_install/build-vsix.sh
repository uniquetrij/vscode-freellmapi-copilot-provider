#!/bin/sh
# POSIX wrapper so packaging works from macOS and Linux without remembering the
# Node entry point.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/build-vsix.js" "$@"
