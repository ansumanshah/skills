#!/bin/sh
# Self-check for build-queue: two jobs run side by side, a third only with memory to spare,
# --solo waits for every slot and blocks new jobs, status names holders, log records runs.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bq=$here/build-queue
BUILD_QUEUE_STATE_DIR=$(mktemp -d); export BUILD_QUEUE_STATE_DIR
BUILD_QUEUE_FAKE_FREE=30; export BUILD_QUEUE_FAKE_FREE  # real memory must not decide the timing tests; 30% allows two jobs, not three
trap 'rm -rf "$BUILD_QUEUE_STATE_DIR"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
try() { set +e; BUILD_QUEUE_TIMEOUT=0 "$bq" "$@" 2>/dev/null; code=$?; set -e; }
# Wait up to 10 s for N holders of a 'sleep 3' job: a loaded machine can take over a second to start one.
holders() { n=0; while [ "$n" -lt 20 ]; do [ "$("$bq" --status | grep -c 'by pid .*sleep 3')" -ge "$1" ] && return 0; sleep 0.5; n=$((n + 1)); done; return 1; }

[ "$("$bq" --status)" = free ] || fail "fresh state not free"
"$bq" sh -c 'exit 3' && fail "exit status not passed through" || [ $? -eq 3 ] || fail "wrong exit"

# Two slots: two jobs run at once, a third is skipped.
"$bq" sleep 3 & a=$!
"$bq" sleep 3 & b=$!
holders 2 || fail "status does not name both holders"
try true; [ "$code" -eq 75 ] || fail "third job exited $code, want 75"
BUILD_QUEUE_FAKE_FREE=100 "$bq" true || fail "third slot did not open with memory to spare"
try --solo true; [ "$code" -eq 75 ] || fail "solo ran while slots were busy"
printf 'pid=%s\n' $$ >"$BUILD_QUEUE_STATE_DIR/holder.0"  # a holder file mid-write: no start time yet
"$bq" --status | grep -q 'just finishing' || fail "status broke on a half-written holder"
BUILD_QUEUE_TIMEOUT=10 "$bq" true 2>/dev/null || fail "waiter never got a slot"
wait "$a" "$b"

# Solo: holds every slot, and nothing else starts while it runs.
"$bq" --solo sleep 3 & s=$!
holders 2 || fail "solo job does not hold every slot"
try true; [ "$code" -eq 75 ] || fail "a job started during a solo run"
wait "$s"

# Solo queued behind a running job takes over once it ends, and blocks new jobs meanwhile.
"$bq" sleep 3 & a=$!
sleep 1
BUILD_QUEUE_TIMEOUT=10 "$bq" --solo true 2>/dev/null & s=$!
sleep 1
try true; [ "$code" -eq 75 ] || fail "a job jumped ahead of a waiting solo job"
wait "$a"; wait "$s" || fail "queued solo job never ran"

# Fairness: a plain job that queued during a solo run goes before a solo job that queued after it.
order=$BUILD_QUEUE_STATE_DIR/order
"$bq" --solo sleep 3 & s=$!
sleep 1
BUILD_QUEUE_TIMEOUT=20 "$bq" sh -c "echo plain >> '$order'" 2>/dev/null & p=$!
sleep 1
BUILD_QUEUE_TIMEOUT=20 "$bq" --solo sh -c "echo solo >> '$order'" 2>/dev/null
wait "$s" "$p"
[ "$(tr '\n' ' ' <"$order")" = "plain solo " ] || fail "solo jumped an earlier plain job: $(tr '\n' ' ' <"$order")"

[ "$("$bq" --status)" = free ] || fail "slots not free at the end"

# Peak memory covers the job's whole process tree: an 80 MB child of a shell shows up.
# The job keeps reading its buffer: under memory pressure macOS swaps an idle one out within seconds.
"$bq" sh -c '/usr/bin/python3 -c "import os, time; b = os.urandom(80_000_000); end = time.time() + 5; [sum(b[::4096]) for _ in iter(lambda: time.time() < end, False)]"'
peak=$(tail -1 "$BUILD_QUEUE_STATE_DIR/log.tsv" | cut -f5)
[ ! -e .peak ] && [ -z "$(find "$BUILD_QUEUE_STATE_DIR" -name '*.peak')" ] || fail "a .peak file was left behind"
[ "$peak" -ge 60 ] || fail "peak memory $peak MB, want at least 60"

# Tool caps: slot jobs get a parallelism cap unless they set one; solo jobs run uncapped.
bin=$BUILD_QUEUE_STATE_DIR/bin; mkdir -p "$bin"
for tool in xcodebuild gradlew swift; do printf '#!/bin/sh\necho "$*"\n' >"$bin/$tool"; chmod +x "$bin/$tool"; done
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" test)" = "test COMPILATION_CACHE_ENABLE_CACHING=YES -jobs 3 -maximum-parallel-testing-workers 2" ] || fail "xcodebuild not capped or cached"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" -jobs 8 test)" = "-jobs 8 test COMPILATION_CACHE_ENABLE_CACHING=YES -maximum-parallel-testing-workers 2" ] || fail "an explicit -jobs was overridden"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" --solo "$bin/xcodebuild" test)" = "test COMPILATION_CACHE_ENABLE_CACHING=YES" ] || fail "solo job was capped or not cached"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/gradlew" test)" = "test --build-cache --max-workers=3" ] || fail "gradle not capped or cached"
[ "$("$bq" --solo "$bin/gradlew" test --no-build-cache)" = "test --no-build-cache" ] || fail "an explicit --no-build-cache was overridden"
[ "$("$bq" --solo "$bin/xcodebuild" -exportArchive)" = "-exportArchive" ] || fail "xcodebuild without a build action got a build setting"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" -exportArchive)" = "-exportArchive" ] || fail "slot xcodebuild without build action got flags"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" -exportArchive -exportPath build)" = "-exportArchive -exportPath build" ] || fail "a flag value named like an action got build flags"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" -scheme test -quiet build)" = "-scheme test -quiet build COMPILATION_CACHE_ENABLE_CACHING=YES -jobs 3" ] || fail "a scheme named test was read as the test action"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" build)" = "build COMPILATION_CACHE_ENABLE_CACHING=YES -jobs 3" ] || fail "xcodebuild build got test worker flag"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/xcodebuild" test-without-building)" = "test-without-building -jobs 3 -maximum-parallel-testing-workers 2" ] || fail "xcodebuild test-without-building not capped"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/gradlew" test -- --foo)" = "test --build-cache --max-workers=3 -- --foo" ] || fail "gradle flags placed after --"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/swift" test --filter A)" = "test --filter A --jobs 3" ] || fail "swift test not capped"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/swift" test -- --filter A)" = "test --jobs 3 -- --filter A" ] || fail "swift --jobs placed after --"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" "$bin/swift" package resolve)" = "package resolve" ] || fail "swift package was changed"
# shellcheck disable=SC2016 # expanded by the job's shell
[ "$(BUILD_QUEUE_JOBS=3 "$bq" sh -c 'echo $CARGO_BUILD_JOBS')" = 3 ] || fail "cargo not capped"
[ "$(BUILD_QUEUE_JOBS=3 "$bq" --solo "$bin/swift" test 2>/dev/null)" = "test --jobs 3" ] || fail "--solo swift test was not run as a slot job"

# SwiftPM: a second job on the same package waits without a slot; another package runs beside it.
# shellcheck disable=SC2016 # expanded by the fake swift
printf '#!/bin/sh\n[ -z "${NAP:-}" ] || sleep "$NAP"\necho "$*"\n' >"$bin/swift"
pkg=$BUILD_QUEUE_STATE_DIR/pkg; mkdir -p "$pkg"
(cd "$pkg" && NAP=3 "$bq" "$bin/swift" build >/dev/null) & a=$!
n=0; until "$bq" --status | grep -q 'swift build'; do sleep 0.5; n=$((n + 1)); [ "$n" -lt 20 ] || fail "swift job never started"; done
set +e; out=$(BUILD_QUEUE_TIMEOUT=0 "$bq" "$bin/swift" test --package-path "$pkg" 2>&1); code=$?; set -e
[ "$code" -eq 75 ] || fail "second job on one SwiftPM package took a slot"
echo "$out" | grep -q 'without a slot' || fail "no same-package wait message"
try "$bin/swift" test >/dev/null; [ "$code" -eq 0 ] || fail "a job on another package was held back"
try "$bin/swift" test --package-path "$pkg" --scratch-path "$pkg/other-build" >/dev/null; [ "$code" -eq 0 ] || fail "a separate --scratch-path was held back"
wait "$a"

# Help, CLI flags (--wait, --timeout), and nested build-queue (re-entrancy).
"$bq" --help | grep -q 'BUILD_QUEUE_MIN_FREE' || fail "--help truncated or non-zero"
"$bq" --help | grep -q -- '--wait' || fail "--help missing --wait"
"$bq" --wait --solo true || fail "--wait --solo failed"
"$bq" --timeout 0 true || fail "--timeout 0 failed"
"$bq" --solo "$bq" --solo true || fail "nested solo inside solo deadlocked"
"$bq" "$bq" true || fail "nested slot inside slot failed"
set +e; "$bq" "$bq" --solo true 2>/dev/null; nested_code=$?; set -e
[ "$nested_code" -eq 64 ] || fail "nested solo inside slot exited $nested_code, want 64"

# Multiline / tab command args must not corrupt log.tsv.
"$bq" sh -c 'printf "ok\n"' "arg	with	tab" >/dev/null
last_cols=$(tail -1 "$BUILD_QUEUE_STATE_DIR/log.tsv" | awk -F'\t' '{ print NF }')
[ "$last_cols" -eq 10 ] || fail "multiline/tab command broke log.tsv columns ($last_cols)"

# Corrupt/empty wait file must not stall or error a solo job.
: >"$BUILD_QUEUE_STATE_DIR/wait.$$"
"$bq" --solo --timeout 1 true || fail "empty wait file broke solo"
rm -f "$BUILD_QUEUE_STATE_DIR/wait.$$"

# Memory: low free memory holds a job back only while another heavy job runs.
"$bq" sleep 3 & a=$!
sleep 1
set +e; out=$(BUILD_QUEUE_FAKE_FREE=10 BUILD_QUEUE_TIMEOUT=0 "$bq" true 2>&1); code=$?; set -e
[ "$code" -eq 75 ] || fail "started beside a running job at 10% free"
echo "$out" | grep -q 'waiting for memory' || fail "no memory wait message"
wait "$a"
BUILD_QUEUE_FAKE_FREE=10 BUILD_QUEUE_TIMEOUT=0 "$bq" true || fail "a lone job was held back by low memory"
[ "$(tail -1 "$BUILD_QUEUE_STATE_DIR/log.tsv" | cut -f6)" = 10 ] || fail "free memory not logged"

# Cold builds: a run far slower than the same command usually takes is flagged and logged,
# scoped to the current repo/checkout so other repos do not cause false positives.
nap=$BUILD_QUEUE_STATE_DIR/nap; echo 0 >"$nap"
for _ in 1 2 3; do "$bq" sh -c "sleep \$(cat '$nap')"; done
echo 2 >"$nap"
BUILD_QUEUE_COLD_MIN=1 "$bq" sh -c "sleep \$(cat '$nap')" 2>&1 | grep -q 'cold build' || fail "slow run not flagged cold"
[ "$(tail -1 "$BUILD_QUEUE_STATE_DIR/log.tsv" | cut -f8)" = cold ] || fail "cold run not marked in the log"
other=$BUILD_QUEUE_STATE_DIR/other-dir; mkdir -p "$other"
(cd "$other" && BUILD_QUEUE_COLD_MIN=1 "$bq" sh -c "sleep \$(cat '$nap')" 2>&1) | grep -q 'cold build' && fail "unrelated directory falsely flagged cold" || true
[ "$(tail -1 "$BUILD_QUEUE_STATE_DIR/log.tsv" | cut -f8)" = - ] || fail "unrelated directory marked cold in log"

# Verify log has header + all expected runs and skips.
rows=$("$bq" --log 100 | wc -l)
[ "$rows" -eq 53 ] || fail "log should hold header + 52 rows, has $rows"
[ "$(grep -c "$(printf '\tskip\t')" "$BUILD_QUEUE_STATE_DIR/log.tsv")" -eq 6 ] || fail "skips are not logged"
grep -q "$(printf '\tsolo\t')" "$BUILD_QUEUE_STATE_DIR/log.tsv" || fail "solo runs are not marked"
echo "ok: build-queue"
