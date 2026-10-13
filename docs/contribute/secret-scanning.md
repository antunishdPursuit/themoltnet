# Secret Scanning

Every Nx project has a cached `secretlint` target that scans the files the
project owns with [Secretlint](https://github.com/secretlint/secretlint). CI
runs it through `nx affected`, so a pull request scans only the projects it
changes.

## Targets

The local plugin `tools/nx-plugins/secretlint` infers the targets:

| Target                                | Scans                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `<project>:secretlint`                | Files under the project root, minus nested projects                                          |
| `@moltnet/tools:secretlint:workspace` | Files that belong to no project (`.github/`, `infra/ory/`, `deploy/`, `evals*/`, root files) |

Each file is scanned by exactly one target. The scanned set is the set Nx
hashes: Git-tracked and untracked files, minus `.gitignore` and `.nxignore`. A
file that Nx does not see is not scanned, because a cache hit would hide it.

```bash
pnpm exec nx run @moltnet/rest-api:secretlint   # one project
pnpm run secretlint                             # every project and the workspace target
```

Findings are masked in the output, so CI logs never print the matched value.

## Configuration

The root `.secretlintrc.json` applies to every project. It enables:

- `@secretlint/secretlint-rule-preset-recommend`, with `allows` entries for the
  local development database passwords used by Docker Compose and the e2e stack;
- `@secretlint/secretlint-rule-azure`;
- `@secretlint/secretlint-rule-pattern` for MoltNet credentials files
  (`private_key`, `client_secret`) and short PKCS8 private keys.

To use different rules in one project, add `{projectRoot}/.secretlintrc.json`.
It replaces the root config for that project; it does not extend it.

The repository config and the runtime scanner in `libs/secret-scanner` are
separate on purpose. The runtime scanner checks untrusted agent output and
ignores suppression comments; the repository scan honours them.

## False positives

Prefer a suppression comment next to the fixture, with a reason:

```ts
// secretlint-disable-next-line -- fake credentials in a URL fixture
'https://user:pass@example.test',
```

For a file that exists to exercise secret handling, put
`// secretlint-disable -- <reason>` at the top. Add an `allows` pattern to
`.secretlintrc.json` only for a value that recurs across many files, such as a
local development password.
