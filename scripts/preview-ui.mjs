// Render the real Ink component offscreen, then capture that frame for visual review.
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;
const { default: React } = await import('react');
const { render } = await import('ink-testing-library');
const { TerminalApp } = await import('../dist/ui/tui.js');
const { PROVIDER_PRESETS } = await import('../dist/providers/provider.js');
const { chromium } = await import('playwright');
const { mkdir, writeFile } = await import('node:fs/promises');
const { fileURLToPath } = await import('node:url');
const output = new URL('../docs/screenshots/', import.meta.url);
await mkdir(output, { recursive: true });
const state = { workspace: 'C:\\Projects\\PolonRLM', provider: 'google', model: 'gemini-3.5-flash-lite', mode: 'BUILD', cortex: 1, busy: false, status: 'Ready', messages: [], usage: { input: 0, output: 0, cached: 0, cost: 0, costKnown: false }, agents: [], theme: 'dark' };
const controller = { snapshot: () => ({ ...state, messages: [...state.messages] }), subscribe: () => () => {}, submit: async () => {}, cancel() {}, cycleMode() {}, close: async () => {}, setApprover() {}, listProviders() { return Object.values(PROVIDER_PRESETS).map(p => ({ id: p.id, url: p.baseURL, model: p.model })); }, async listModels() { throw new Error('No API key is configured. Add a key or choose another provider.'); } };
const app = render(React.createElement(TerminalApp, { controller }));
Object.defineProperty(app.stdout, 'columns', { configurable: true, value: 120 });
Object.defineProperty(app.stdout, 'rows', { configurable: true, value: 30 });
app.stdout.emit('resize');
await new Promise(resolve => setTimeout(resolve, 100));
function html(frame) {
  let foreground = '#e4e4e8', background = '#0c0c0c', bold = false, inverse = false;
  const lines = [''];
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const piece of frame.split(/(\x1b\[[0-9;]*m)/)) {
    if (piece.startsWith('\x1b[')) {
      const codes = piece.slice(2, -1).split(';').map(Number);
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index];
        if (code === 0) { foreground = '#e4e4e8'; background = '#0c0c0c'; bold = false; inverse = false; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 7) inverse = true;
        else if (code === 27) inverse = false;
        else if (code === 39) foreground = '#e4e4e8';
        else if (code === 49) background = '#0c0c0c';
        else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
          const color = `rgb(${codes.slice(index + 2, index + 5).join(',')})`;
          if (code === 38) foreground = color; else background = color;
          index += 4;
        }
      }
      continue;
    }
    const parts = piece.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (index) lines.push('');
      lines[lines.length - 1] += `<span style="color:${inverse ? background : foreground};background:${inverse ? foreground : background};font-weight:${bold ? 700 : 400}">${escape(parts[index])}</span>`;
    }
  }
  return lines.map(line => `<div class="row">${line}</div>`).join('');
}
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
try {
  const page = await browser.newPage({ viewport: { width: 1064, height: 636 }, deviceScaleFactor: 1 });
  for (const [name, command] of [['home', undefined], ['commands', '\u0010'], ['models-error', '\u000b'], ['api-key', '\u000c'], ['providers', '\u000f']]) {
    if (name === 'models-error' || name === 'providers') { app.stdin.write('\u001b'); await new Promise(resolve => setTimeout(resolve, 80)); }
    if (name === 'providers') { app.stdin.write('\u001b'); await new Promise(resolve => setTimeout(resolve, 80)); }
    if (command) { app.stdin.write(command); await new Promise(resolve => setTimeout(resolve, 80)); }
    const frame = app.lastFrame();
    const document = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0c0c0c}header{height:30px;box-sizing:border-box;background:#202023;color:#bbb;font:12px Segoe UI;padding:6px 14px}pre{margin:0;padding:12px 16px;color:#e4e4e8;font:14px/19.4px 'Cascadia Mono',Consolas,monospace;font-variant-ligatures:none;white-space:pre}.row{height:19.4px}.row span{display:inline-block;height:19.4px;vertical-align:top}</style><header>PolonRLM</header><pre>${html(frame)}</pre>`;
    await page.setContent(document);
    const target = new URL(`polonrlm-${name}.png`, output);
    await page.screenshot({ path: fileURLToPath(target), fullPage: true });
    await writeFile(new URL(`polonrlm-${name}.txt`, output), frame.replace(/\x1b\[[0-9;]*m/g, ''));
    console.log(`Saved polonrlm-${name}.png`);
  }
} finally { await browser.close(); app.unmount(); app.cleanup(); }
