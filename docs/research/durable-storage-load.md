# Durable storage load baseline

## Repeat the measurement

Start a local E2E stack using the
[daemon development instructions](https://github.com/getlarge/themoltnet/blob/main/apps/agent-daemon/README.md).
The benchmark uses that stack without restarting services. It creates an
isolated agent, profile, and tasks; cancels its tasks and deletes its profile
afterwards. As with the E2E harness, the test identity and stored task history
remain until the disposable database is reset. All configured service URLs must
use loopback.

```sh
NX_LOAD_DOT_ENV_FILES=false NX_DAEMON=false NX_NO_CLOUD=true \
  pnpm exec nx run @moltnet/tools:bench:durable \
  --concurrency=1,5,10 --characters=1024 --tokens-per-second=80 \
  --output=/tmp/durable-storage-benchmark.json

# Exercise more than one 50-commit replay page per conversation.
NX_LOAD_DOT_ENV_FILES=false NX_DAEMON=false NX_NO_CLOUD=true \
  pnpm exec nx run @moltnet/tools:bench:durable \
  --concurrency=5 --characters=8192 --tokens-per-second=200 \
  --output=/tmp/durable-storage-long-benchmark.json
```

The fixture runs Pi's native streaming generation and output-submission tool
through `ApiDurableStorage`, the SDK, REST API, PostgreSQL, and object storage.
It uses no paid model and starts no VM. Each concurrency level starts fresh
conversations, then closes and reconstructs their stores concurrently through
the API. The fixture fixes text chunk size at four characters.

The JSON report records commit counts and payload bytes, logical append and ID
allocation latency, read-header/body latency, full replay latency, failures, and
process heap samples. Commit payload bytes exclude HTTP headers and receipt
metadata. Latencies include retries. Heap samples include the whole benchmark
process and normal garbage collection; they are not retained bytes per store.

Task-message reporting is disabled to isolate conversation persistence. Profile
creation, claiming, replay, and cleanup are outside the execution throughput
window. Writer acquisition is inside that window; renewal runs normally. The
report does not count every HTTP retry or separate database time from blob I/O.
Use server tracing for that breakdown before attributing a slow append to a
particular backend. These measurements alone do not establish production
capacity.

## Local results, 2026-10-11

Client: Pi 1.0.0, PR #2660 base `54fdecd64` plus bounded SDK retries and writer
expiry fencing. Existing E2E API container image:
`sha256:5c35dff02968682e797cd660b647c4ff62eec540a8801bc9d03ac908af5c84f2`. The
server was not rebuilt for this run, so these results are a normal-write
baseline, not a before/after measurement of the duplicate-upload optimization.

| Concurrent streams | Text characters each | Fixture tokens/s | Commits | Commits/s | Payload bytes | Append p95 | Replay p95 | Failures |
| ------------------ | -------------------- | ---------------- | ------- | --------- | ------------- | ---------- | ---------- | -------- |
| 1                  | 1,024                | 80               | 42      | 11.4      | 23,813        | 19.7 ms    | 51.9 ms    | 0        |
| 5                  | 1,024                | 80               | 210     | 55.3      | 119,072       | 23.4 ms    | 123.2 ms   | 0        |
| 10                 | 1,024                | 80               | 412     | 102.5     | 235,261       | 34.9 ms    | 177.0 ms   | 0        |
| 5                  | 8,192                | 200              | 515     | 44.7      | 241,795       | 43.1 ms    | 244.9 ms   | 0        |

Every completed conversation also required 12 ID allocations. The longer run
read 15 pages across five stores. Counts vary with scheduling: Pi coalesces
pending partials while a commit is in flight. Lifecycle commits explain why a
short run can exceed ten commits per second per conversation overall.

The measured partial payloads are small, but each still incurs an API request,
authorization, database work, and object storage I/O. ID allocation is another
measurable source of requests. Keep the native commit cadence for now. Before
increasing deployment concurrency, repeat with representative conversation
lengths and tool output, collect backend timing, and establish an acceptable
append/replay latency budget. Consider ID range allocation or a configurable Pi
partial checkpoint interval only when those measurements identify the cost.

## Retry and persistence boundaries

- The SDK retries commit append, writer renewal, and read headers on network
  failures and HTTP 408/500/502/503/504, at most three times. Client backoff
  starts at 250 ms with jitter and is capped at one second; `Retry-After`
  remains a server minimum. Existing SDK rate-limit/auth handling remains
  underneath it.
- Append retries reuse the same serialized commit ID, expected sequence, and
  writes. Published matching receipts can be returned before uploading again.
  Authority and commit identity are checked before returning such a receipt and
  checked again when publishing after an upload.
- Each runtime request has one total budget of at most ten seconds, shortened to
  the last confirmed writer expiry. Cancellation bounds requests and backoff.
  The runtime independently stops model/tool work at lease expiry. Renewal does
  not revive an expired writer.
- Acquisition and ID allocation are not automatically replayed after ambiguous
  responses. Conflicts and permanent authorization/validation errors do not get
  transient retries. A read body that fails after headers still requires reopen;
  it is not blindly replayed after some commits may already have been consumed.
- A commit is acknowledged to Pi only after remote persistence is confirmed.
  These retries do not create an asynchronous upload queue or change Pi's
  lifecycle checkpoints.
