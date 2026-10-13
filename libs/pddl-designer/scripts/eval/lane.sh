#!/bin/sh
# Run each example RUNS times in sequence (default 3), labelled
# <PREFIX>-<example>-<n>. Takes the same environment as run-example.sh.
#
#   PREFIX=<label-prefix> [RUNS=3] sh scripts/eval/lane.sh <example>...
set -u
: "${PREFIX:?PREFIX is required}"
RUNS="${RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
for EXAMPLE in "$@"; do
  n=1
  while [ "$n" -le "$RUNS" ]; do
    sh "$HERE/run-example.sh" "$EXAMPLE" "$PREFIX-$EXAMPLE-$n"
    n=$((n + 1))
  done
done
