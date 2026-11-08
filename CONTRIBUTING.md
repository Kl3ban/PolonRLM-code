# Contributing

Thanks for taking a look at PolonRLM. Small fixes and clear bug reports are welcome. For a larger change, please open an issue first so we can agree on the approach.

## Development setup

You need Node.js 24 or newer. The local web search helper also needs Python 3.11 or newer.

~~~sh
npm ci
npm run check
npm test
npm run build
~~~

Use `npm start` or `npm run dev` while working on the terminal app. The regular test suite uses local fixtures and does not need an AI API key. `npm run test:live` calls a real provider and may spend API credits, so it should not be part of routine CI.

## Before opening a change

- Keep API keys, local settings, session databases, and personal project files out of commits.
- Add or update a focused test when changing behavior.
- Keep permission checks in place for tools that write files, run processes, or interact with websites.
- Update the command or feature documentation when users need to know about a new setting.
- Keep user-facing text and documentation in English.
