# Maintained cwd fork upgrades

`Hoder-zyf/prime-agent`, branch `fix/update`, maintains the session working-directory fixes as source commits. Upgrade by merging a selected upstream release into those commits, then validate an independent candidate. This is not a binary patch or a version-specific fingerprint replacement.

Use this path until the fixes are merged and included in an official release. `prime-agent update` and `/update` follow official release channels; they do not maintain this fork's commits. Future upstream changes can cause merge conflicts or new failures. A successful merge is not a compatibility guarantee.

## Prepare the source base

Use a separate source checkout of the maintained branch. Do not use or edit a checkout that a running daemon uses, including a live checkout under `/tmp`.

Requirements:

- Git, a current Node.js 22 release or newer, and npm 11.10 or newer. The project requires at least Node.js 22.8.0; the selected npm version must also support that Node version.
- A full-history source checkout on a maintained branch, not a detached HEAD. It must be clean and committed, with the fixes and upgrade tool present. Commit intended changes first; do not discard someone else's changes to make it clean.
- An `origin` remote that points to `Hoder-zyf/prime-agent`, not the official upstream repository. Verify both fetch and push URLs.
- A new absolute destination path on a fast local filesystem, outside the source checkout, with an existing parent directory. An existing destination is not reused.
- Access to the selected upstream ref and the npm registry for dependency installation.

Keep `package-lock.json` and the seven-day dependency age policy in `.npmrc`. Do not bypass that policy for routine upgrades. Use a separate toolchain if the host's npm is too old; upgrading the running application's toolchain is not part of candidate preparation.

Source startup reads many files. Slow or NFS-backed storage can exceed the process tests' readiness limits. Use fast local storage for the candidate and validation. Resource or filesystem startup failures still fail validation; stop and diagnose them. Do not increase test deadlines or retry until green. Local-disk performance is not evidence of compatibility with a future upstream release.

From the maintained source root, inspect the base:

```sh
git status --short
git log -1 --oneline
git remote -v
git remote get-url --push origin
```

`git status --short` must be empty. Check that the committed fixes are present and that `origin` belongs to the user fork before proceeding.

## Prepare and validate a candidate

The required arguments are `--upstream-ref TAG --destination NEW_ABSOLUTE_PATH`. Replace the example tag and path with the release you reviewed and a new absolute path:

```sh
npm run update:cwd-fork -- \
  --upstream-ref vX.Y.Z \
  --destination /absolute/path/to/prime-agent-candidate-vX.Y.Z
```

The direct entry point is `node scripts/update-cwd-fork.mjs` with the same arguments. Use `npm run update:cwd-fork -- --help` for usage.

The default upstream URL is `https://github.com/PrimeIntellect-ai/prime-agent.git`. `--upstream-url URL` accepts a credential-free HTTPS URL or an absolute local repository path; use it only when you trust that repository. Prefer an explicit release tag rather than a moving branch. Validation executes repository code. Environment isolation is not a filesystem or security sandbox; only validate trusted source and upstream code.

The tool clones the exact committed source head into an independent destination and uses Git merge to retain the maintained commits while incorporating the selected upstream ref. Candidate `origin` retains the source checkout's fork remote; the upstream source is separate. It does not push, publish, create a pull request, replace a launcher, or stop a daemon.

Validation checks the npm version, installs the locked dependencies with `npm ci --ignore-scripts`, runs `npm run check` and `npm run check:test-policy`, then runs the focused cwd tests and the standard-library upgrade-tool tests. The candidate test-policy base is the fetched upstream commit. A formatter change is not silently accepted as a passing validation: the tracked tree must stay clean after each step. Test state is isolated from the user's configuration and sessions. Tests do not need provider credentials.

The selected commits are recorded in `.git/cwd-update/inputs.json`. Only a fully successful run writes `.git/cwd-update/receipt.json`. Inspect that receipt and the validation output before approving the candidate. A failed run does not produce a success receipt.

Validation state uses a short private temporary path (`/tmp/pcw-XXXXXX` on POSIX) to avoid Unix-socket path limits. The metadata records it as `validationRoot`; this temporary state is removed after validation. The candidate and its Git metadata are retained separately.

The source checkout and running daemon remain unchanged on success or failure. On a merge conflict or validation failure, the candidate remains available for inspection. Do not deploy it. Inspect its status and logs, repair only the candidate, and review and commit any repair. Then prepare a new candidate from that clean maintained checkout and rerun all checks. Do not force an old destination to be overwritten or treat a partial merge as success.

## Push only after validation

Pushing is a separate, manual action. First review the candidate's commits and diff, confirm all checks passed, and verify that its `origin` fetch and push URLs resolve to `Hoder-zyf/prime-agent`. Never use the official upstream remote as a push target.

```sh
CANDIDATE=/absolute/path/to/prime-agent-candidate-vX.Y.Z
git -C "$CANDIDATE" status --short
git -C "$CANDIDATE" remote -v
git -C "$CANDIDATE" remote get-url --push origin
# Only after the clean-tree, validation, and user-fork checks above:
git -C "$CANDIDATE" push origin HEAD:refs/heads/fix/update
```

This is a normal push. A non-fast-forward update is rejected. If that happens, stop, obtain the current maintained branch in a separate clean source checkout, and prepare a new candidate. Never use a force push. Neither the tool nor CI submits an upstream pull request.

## Validation-only CI

[Maintained cwd](../../../.github/workflows/maintained-cwd.yml) runs on pushes to `fix/update` and supports manual `workflow_dispatch`. It only validates the selected commit. It has `contents: read` permission and does not release, publish, push, or activate anything.

GitHub requires the workflow file on the fork's default branch for manual dispatch. If it exists only on `fix/update`, use push validation. Changing the default branch or adding the workflow there is a separate user decision.

CI uses Node.js 22 and pinned npm 11.10.0. It fetches full history so the test-policy base `HEAD^` exists, installs with `npm ci --ignore-scripts`, and runs:

- `npm run check`, including `check:test-policy`, followed by a tracked clean-tree check.
- `node --test scripts/test-update-cwd-fork.mjs` for the standard-library upgrade-tool tests.
- The four focused test files below with one worker and two fixed shuffle seeds. The first failure stops validation; these are not retry-to-green runs.

The source-native test command runs from `packages/coding-agent`:

```sh
node ../../node_modules/tsx/dist/cli.mjs ../../node_modules/vitest/dist/cli.js --run \
  test/daemon-supervisor-process.test.ts test/session-cwd.test.ts \
  test/agents-view-state.test.ts test/daemon-mode.test.ts \
  --maxWorkers=1 --bail=1
```

Use the workflow's isolation when reproducing this command. CI creates owner-private directories under a unique `RUNNER_TEMP` path and starts validation with a clean environment. `HOME`, the XDG directories, `PRIME_AGENT_CODING_AGENT_DIR`, and temporary-file paths are private. It does not inherit provider credentials or set a shared `PRIME_AGENT_SESSION_DIR`. Daemon state is not uploaded as a CI artifact.

## Activate only in an approved idle window

Preparation and a green CI result do not activate the candidate. Leave the existing runtime unchanged until the user approves a separate maintenance window.

Keep production source and its dependencies in a durable local location outside disposable cleanup paths such as `/tmp` and `RUNNER_TEMP`. A temporary validation candidate is not a production installation. If deployment moves the candidate, repeat validation at its final location before switching launchers.

1. Review all results and record the current launcher and source location for rollback.
2. Ask the user to confirm that all sessions, workers, and background tasks are idle and saved. Closing a terminal does not stop a resident worker.
3. Only after that approval, use the existing launcher's normal `shutdown` command and verify a clean stop. If it is busy or cannot stop cleanly, stop the activation procedure. Do not escalate automatically to `shutdown --force` or kill processes.
4. Manually select the validated candidate's `prime-agent.sh` launcher, then start it from the intended project directory. Do not overwrite files used by the old runtime or silently replace an installer-managed launcher.
5. Check the resumed session's cwd and project skills. Keep the previous checkout and launcher until the new version is confirmed. Code rollback does not guarantee reversal of future session-data migrations.

Launcher changes, service changes, and production daemon restarts are outside this upgrade tool and CI workflow.
