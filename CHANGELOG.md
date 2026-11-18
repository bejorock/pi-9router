# Changelog

## Unreleased

- Add a 240-second first-content deadline to 9router chat requests, including requests waiting for headers or receiving only keep-alives/empty events. Cancel only that request and immediately surface a distinct retryable error without waiting for adapter shutdown; ignore late events and preserve user cancellation.
- Add exact-boundary virtual-timer tests and accelerated actual-pi retry tests for silent requests, keep-alives, disabled/exhausted retries, content disarming, and workflow-style watchdog completion/reset.
- Generalize the request-only stream guard to all tool arguments, answer text, and exposed reasoning, with independent state per content block/channel. Detect sustained exact prose cycles and literal/JSON-escaped U+200B/U+200C cycles without tool-name, JSON-order, or quoted-content exemptions.
- Add a second sanitized incident replay, healthy structured-output controls, and actual pi retry tests for `find`, answer text, and reasoning. Document detection gaps and the ambiguity of intentional long exact repetition. Preserve native retry budgets, request-only cancellation, and user cancellation.
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
