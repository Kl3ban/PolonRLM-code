# Provider catalog

The app includes 50 hosted API presets, three local server presets, and a custom endpoint form. Presets are connection settings, not a ranking or a guarantee that every account supports model discovery.

The provider catalog was last checked against [models.dev](https://models.dev/) on 2026-11-08. xAI's OpenAI-compatible base URL is documented in the [xAI REST API reference](https://docs.x.ai/developers/rest-api-reference/inference). The bundled catalog is in `src/providers/catalog.json`; PolonRLM does not download a provider catalog at startup.

Existing provider settings take precedence over presets when loading configuration. New presets remain available after upgrades.

Select **Provider**, press Alt+D, or use `/connect` to choose a provider. Enter a key or press Tab to keep the key or environment variable already configured. Model discovery is requested from the selected provider. If it is unavailable, press Ctrl+N in the model picker to enter an exact model ID.

The custom endpoint form accepts an OpenAI-compatible base URL, a model ID, and an optional API key. Keys are stored in the existing DPAPI vault on Windows. Preset files do not contain credentials.

Live inference has not been verified against every provider. Availability, credits, tool calling, and supported models depend on the provider and account.

