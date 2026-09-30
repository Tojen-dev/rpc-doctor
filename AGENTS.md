# RPC Doctor maintenance

Work within this repository. Read README.md and docs/ROADMAP.md before implementation.
Keep the tool small, portable, and dependency-free unless a dependency is justified.

For each development increment, select one unfinished roadmap item and implement
its acceptance criteria with focused behavior tests and documentation. Run
`npm run check` and `npm test`. Local test servers require loopback networking.
Keep the CLI demo working. Mark an item complete only after verification.

Commit one coherent, useful improvement at a time with accurate authorship and real
timestamps. Do not manufacture empty commits, split trivial edits to meet a quota,
or claim unfinished features. Preserve user changes; never force-push or rewrite
published history. If the working tree contains unrelated changes, stop before
staging and ask for direction. Do not add automated authorship trailers.

For scheduled maintenance, the user authorized one improvement and push per run,
twice daily, to origin/main. Fetch and fast-forward only before work. If the remote
diverged, tests fail, or access is unavailable, leave a clear report and do not push.
Stage only files belonging to the selected improvement. Check staged content for
secrets. Update the roadmap in the same commit, not a separate bookkeeping commit.
Do not change external service settings, create credentials, or publish to npm.

Use local fake RPCs for tests. Only run a small live smoke test when necessary;
never send transactions or access wallet keys. Raw endpoint URLs, auth headers,
provider error messages, and request secrets must stay out of output and fixtures.
Keep failed attempts observable; do not hide failures behind retries or percentiles.

After all 45 roadmap items are complete, stop scheduled development and notify the
user. Further work requires a new scope rather than an endless stream of commits.
