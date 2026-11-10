# Provider catalog

The app includes 51 hosted API presets, three local server presets, and a custom endpoint form. Presets are connection settings, not a ranking or a guarantee that every account supports model discovery.

The provider catalog was last checked against [models.dev](https://models.dev/) on 2026-11-08. xAI's OpenAI-compatible base URL is documented in the [xAI REST API reference](https://docs.x.ai/developers/rest-api-reference/inference). The bundled catalog is in `src/providers/catalog.json`; PolonRLM does not download a provider catalog at startup.

Existing provider settings take precedence over presets when loading configuration. New presets remain available after upgrades.

NVIDIA NIM uses a longer default request timeout because free inference can take several minutes to start. Change it for the selected provider with `/settings provider.requestTimeoutMs 300000`; the value is milliseconds and can be set from 1,000 to 600,000. Other providers continue to use the global request timeout.

Temporary network failures, request timeouts, provider overloads, rate limits, and empty replies are retried on the same model after 10 seconds. The status line shows each retry. Cancel or Ctrl+C stops the wait. A response that already streamed text is never replayed. Retries count toward the shared model-call, token, and cost limits.

Select **Provider**, press Alt+D, or use `/connect` to choose a provider. TeamRouter is available as a built-in OpenAI-compatible preset at `https://api.teamorouter.com/v1`; select `/connect teamorouter`, enter the key with `/key`, and use `/models` to discover available models. Enter a key or press Tab to keep the key or environment variable already configured. Model discovery is requested from the selected provider. If it is unavailable, press Ctrl+N in the model picker to enter an exact model ID.

The custom endpoint form accepts an OpenAI-compatible base URL, a model ID, and an optional API key. Keys are stored in the existing DPAPI vault on Windows. Preset files do not contain credentials.

Live inference has not been verified against every provider. Availability, credits, tool calling, and supported models depend on the provider and account.

