#!/usr/bin/env sh
# Copy source to a native Linux temporary directory; Git fixtures also use /tmp.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d /tmp/remote-portable.XXXXXX)
cp -R "$source_dir/." "$test_dir/"
cd "$test_dir"
python3 -m unittest discover -s tests -p "test*.py" -v
# Leave the test source directory for inspection. Fixtures clean up themselves.
printf 'Linux test source: %s\n' "$test_dir"
