# Secret Scanning

Every Nx project except the workspace root has a cached `secretlint` target that
scans the project's files with
[Secretlint](https://github.com/secretlint/secretlint). CI runs it through
`nx affected`, so a pull request scans only the projects it changes.

## Targets

The local plugin `tools/nx-plugins/secretlint` infers the targets. Both run the
Secretlint CLI from the workspace root, so every `.gitignore` applies, including
the root one.

| Target                                | Runs                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<project>:secretlint`                | `secretlint '<projectRoot>/**/*' --secretlintrc <config>`                                                                |
| `@moltnet/tools:secretlint:workspace` | `secretlint` over every directory and file outside all projects, such as `.github/**/*`, `infra/ory/**/*` and root files |

The plugin computes the workspace target's globs from the project roots, so
nothing has to be maintained by hand. Each target's inputs are its globs, its
config, any local rule files the config names, every `.secretlintignore` in the
workspace, and the Secretlint packages. A cached result is replayed only when
none of them changed.

A project that contains nested projects, such as `packages/cli`, also scans
their files with its own config. The nested projects scan them again in their
own targets. A nested project's `.secretlintrc.json` therefore does not exempt a
file from the parent's scan: repeat the override in the parent's config.

Secretlint skips binary files, so it does not inspect keystores or other binary
credential files. It also never scans `.secretlintrc*` and `.secretlintignore*`
files, so keep secrets out of `allows` patterns.

Every path matching `.gitignore` is skipped, including tracked files. CI fails
when a tracked file matches `.gitignore`, so such a file cannot go unscanned.

Nx does not see files listed in `.nxignore`, such as `infra/ory/project.json`,
so no affected target covers them. CI scans every tracked `.nxignore`d file on
each run instead.

```bash
pnpm exec nx run @moltnet/rest-api:secretlint                   # one project
pnpm exec nx affected -t secretlint secretlint:workspace        # what CI runs
pnpm run secretlint                                             # everything
pnpm exec nx run-many -t secretlint secretlint:workspace --skip-nx-cache   # full rescan
```

Findings are masked in the output, so CI logs never print the matched value.

## Configuration

The root `.secretlintrc.json` applies to every project that has no config of its
own, and to the workspace target. Read it for the enabled rules and `allows`
patterns.

A change to the root config marks every project as affected, so CI rescans those
projects with the new rules.

The runtime scanner in `libs/secret-scanner` checks untrusted agent output with
its own rules and ignores suppression comments; this repository scan honours
them.

To use different rules in one project, add `{projectRoot}/.secretlintrc.json`.
It replaces the root config for that project; it does not extend it.

## False positives

Suppress a fixture next to it, for the one rule that reports it, with a reason:

```ts
// secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- fake credentials in a URL fixture
'https://user:pass@example.test',
```

For a multi-line fixture, wrap it in `// secretlint-disable <rule> -- <reason>`
and `// secretlint-enable <rule>`. Do not disable a whole file: it would also
hide a real secret added later.

Add an `allows` pattern to `.secretlintrc.json` only for a value that recurs
across many files, such as a local development password.

Do not add a `.secretlintignore` file. The CLI honours one in any directory, so
it could hide files from every scan; CI fails when one is committed. Suppress
findings inline instead.

A fixture that must contain the text of a suppression directive, for example to
test that a scanner ignores it, has to split the directive across string
literals. Secretlint reads the directive anywhere in a file, not only in
comments, and would otherwise apply it to the rest of the file.
