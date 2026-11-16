# Changelog

## Unreleased

- Add a request-only prompt compatibility workaround exclusively for `9router/ag/*` using OpenAI Chat Completions: replace pi's exact default identity and remove only its recognized built-in documentation block. Preserve custom prompts, tools, project content, user/history messages, other models, and other providers.
- Add model-switch, non-mutation, custom-docs, and actual pi wire-level isolation regression tests.

## 0.2.0

- Verify compatibility with pi 1.5.2 and 9router 0.5.119 while preserving the native provider/auth/catalog integration.
- Use pi's effective discovery endpoint and resolved web-tool endpoint/headers.
- Discover supported thinking levels from 9router, including explicit off, always-on thinking, and advertised `xhigh`/`max` levels. Keep the OpenAI request envelope so 9router handles backend translation.
- Propagate web-tool cancellation through discovery, requests, and fallback attempts.
- Update search content/answer parsing for current 9router responses.
- Truncate large web-tool output and save the full formatted output to a temporary file.
- Declare the host-provided `typebox` peer and add type checking plus regression tests.
- Guard the recorded unfinished bash argument-loop signature using bounded per-call detection and request-only cancellation; surface a fixed retryable stream error through pi's native retry policy. Preserve user cancellation and never repair/execute partial calls.
- Add sanitized incident replay, false-positive controls, and real pi HTTP 200/201 guard/retry integration tests. Document narrow detection scope and the native-catalog prerequisite.
- Correct installation/configuration documentation. No system-prompt reasoning injection is added.
