#!/bin/sh
# The CLI appends --source/--protocol/--boundary flags to this hook. They are
# ignored on purpose: the manifest is a static file, and `cat` would treat each
# flag as a filename and fail.
cat "$(dirname "$0")/../slack-app-manifest.json"
