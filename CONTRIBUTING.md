# Contributing

Start with a small, reproducible problem or one unchecked item in
[the roadmap](docs/ROADMAP.md). Open an issue before a large new feature.

Use Node.js 22 or newer. Run `npm ci`, `npm run check`, and `npm test`.
The project uses native ES modules, the built-in test runner, two-space indentation,
and no runtime dependencies. Avoid a dependency unless it has a clear benefit.

Include tests for behavior changes, especially error handling and measurement
semantics. Use synthetic local servers instead of live RPC providers in tests.
Update documentation when CLI behavior or the JSON format changes. Do not silently
change units, percentile definitions, or the meaning of a health status.

One commit should describe one coherent improvement, with its tests and docs.
Use descriptive messages such as `feat: add endpoint labels` or
`fix: handle an empty batch response`. Use real commit timestamps and authorship.

Never commit real endpoint keys, credentials, local configurations, or raw provider
responses. Use `.example` domains and synthetic addresses in fixtures.
Reports and errors must not expose endpoint URLs or provider-controlled messages.
