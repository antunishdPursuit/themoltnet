#!/bin/sh
# Run the PDDL designer once on one example, with a poller scoped to a fresh
# correlation id that is stopped when the run ends.
#
#   TEAM=<team-id> DIARY=<diary-id> RUNS_DIR=<dir> \
#     [PROFILE=<profile>] [AGENT=<agent>] [EXAMPLES_DIR=<dir>] [EXTRA="<cli flags>"] \
#     sh scripts/eval/run-example.sh <example> <label>
#
# Writes <RUNS_DIR>/run-<label>.json, daemon-<label>.log and cli-<label>.err.
set -u
EXAMPLE="$1"
LABEL="$2"
: "${TEAM:?TEAM is required}" "${DIARY:?DIARY is required}" "${RUNS_DIR:?RUNS_DIR is required}"
LIB="$(cd "$(dirname "$0")/../.." && pwd)"
EXAMPLES_DIR="${EXAMPLES_DIR:-$LIB/examples}"
PROFILE="${PROFILE:-legreffier-pddl-designer-v1}"
AGENT="${AGENT:-legreffier}"
CORR=$(node -e 'console.log(crypto.randomUUID())')
mkdir -p "$RUNS_DIR"

moltnet-agent poll --team "$TEAM" --agent "$AGENT" --profile "$PROFILE" \
  --task-types freeform --correlation-id "$CORR" --general \
  --workspace-strategy none > "$RUNS_DIR/daemon-$LABEL.log" 2>&1 &
POLLER=$!

cd "$LIB" || exit 1
# shellcheck disable=SC2086
pnpm --silent cli \
  --description "$EXAMPLES_DIR/$EXAMPLE/description.md" \
  --problem "$EXAMPLES_DIR/$EXAMPLE/situation.md" \
  --domain-name "$EXAMPLE" --problem-name "$LABEL" \
  --team "$TEAM" --diary "$DIARY" --profile "$PROFILE" \
  --correlation "$CORR" --out "$RUNS_DIR/run-$LABEL.json" ${EXTRA:-} \
  2> "$RUNS_DIR/cli-$LABEL.err"
CODE=$?

kill -TERM "$POLLER" 2>/dev/null
wait "$POLLER" 2>/dev/null
echo "$LABEL exit=$CODE correlation=$CORR"
tail -1 "$RUNS_DIR/cli-$LABEL.err"
