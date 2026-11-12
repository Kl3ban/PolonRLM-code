import { createHash, randomUUID } from 'node:crypto';
import type { Frame, Locator, Page } from 'playwright';
import { safeBrowserUrl, safeDiagnosticText } from './browser-output.js';

type SnapshotNode = { ref?: string; role?: string; name?: string; text?: string; children?: (SnapshotNode | string)[]; [key: string]: unknown };
type Snapshot = { id: string; scope: string; elements: Record<string, unknown>[]; text: string; truncated: boolean };

/** Native Playwright refs preserve element identity; no DOM attributes or overlays are injected. */
export class BrowserSnapshots {
  private pages = new WeakMap<Page, { latest: Snapshot; history: Snapshot[] }>();
  private epochs = new WeakMap<Page, string>();
  invalidate(page: Page): void { this.pages.delete(page); this.epochs.set(page, randomUUID()); }
  target(page: Page, ref: string, snapshotId?: string): Locator {
    const snapshot = this.pages.get(page)?.latest;
    if (!snapshot || snapshotId !== snapshot.id || !snapshot.elements.some(element => element.ref === ref)) {
      throw new Error('Stale or unknown browser ref. Run browser snapshot and use its ref and snapshotId.');
    }
    return page.getByRef(ref);
  }
  async capture(page: Page, root: Locator, scope: string, limit: number, maxChars: number, timeout: number, signal: AbortSignal, since?: string): Promise<string> {
    const tree = await root.ariaSnapshotJSON({ mode: 'ai', depth: 12, timeout, signal }) as SnapshotNode[];
    const elements: Record<string, unknown>[] = [], text: string[] = [];
    let total = 0, scanned = 0;
    const walk = (node: SnapshotNode | string, field = false): void => {
      if (++scanned > 10000) return;
      if (typeof node === 'string') { if (!field && text.join(' ').length < 1600) text.push(safeDiagnosticText(node)); return; }
      const editable = field || ['textbox', 'searchbox', 'combobox'].includes(node.role ?? '');
      if (node.ref) {
        total++;
        if (elements.length < limit) {
          const item: Record<string, unknown> = { ref: node.ref, role: node.role, name: safeDiagnosticText(node.name ?? '').slice(0, 160) };
          for (const key of ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'required', 'invalid', 'level', 'placeholder', 'url']) {
            const value = node[key];
            if (value !== undefined) item[key] = key === 'url' ? safeBrowserUrl(String(value)) : typeof value === 'string' ? safeDiagnosticText(value).slice(0, 160) : value;
          }
          elements.push(item);
        }
      }
      if (!editable && node.text && text.join(' ').length < 1600) text.push(safeDiagnosticText(node.text));
      for (const child of node.children ?? []) walk(child, editable);
    };
    for (const node of tree) walk(node);
    const content = { scope, elements, text: text.join(' ').slice(0, 1600), truncated: total > elements.length || scanned > 10000 };
    // Store exactly the elements delivered to the model, including when output is bounded.
    while (JSON.stringify(content).length > maxChars - 400 && content.text.length > 100) { content.text = content.text.slice(0, Math.floor(content.text.length / 2)); content.truncated = true; }
    while (JSON.stringify(content).length > maxChars - 400 && elements.length) { elements.pop(); content.truncated = true; }
    if (!this.epochs.has(page)) this.epochs.set(page, randomUUID());
    const id = createHash('sha256').update(this.epochs.get(page)! + page.url() + JSON.stringify(content)).digest('hex').slice(0, 12);
    const previous = this.pages.get(page), baseline = previous?.history.find(item => item.id === since && item.scope === scope);
    const snapshot = { id, ...content };
    this.pages.set(page, { latest: snapshot, history: [snapshot, ...(previous?.history.filter(item => item.id !== id) ?? [])].slice(0, 4) });
    const base = { snapshotId: id, url: safeBrowserUrl(page.url()), total, truncated: content.truncated };
    if (baseline && baseline.id === id) return JSON.stringify({ snapshotId: id, unchanged: true });
    if (baseline) {
      const old = new Map(baseline.elements.map(item => [item.ref, item]));
      const next = new Set(elements.map(item => item.ref));
      const delta = { ...base, delta: true,
        added: elements.filter(item => !old.has(item.ref)),
        changed: elements.filter(item => old.has(item.ref) && JSON.stringify(old.get(item.ref)) !== JSON.stringify(item)),
        removed: baseline.elements.filter(item => !next.has(item.ref)).map(item => item.ref),
        ...(content.text === baseline.text ? {} : { text: content.text }),
      };
      if (JSON.stringify(delta).length <= maxChars) return JSON.stringify(delta);
      // A partial delta cannot serve as a reliable baseline for the next call.
      return JSON.stringify({ ...base, reset: true, elements, text: content.text });
    }
    return JSON.stringify({ ...base, ...(since ? { reset: true } : {}), elements, text: content.text });
  }
}

export const DEFAULT_STYLES = ['display', 'visibility', 'opacity', 'position', 'pointer-events', 'color', 'background-color', 'font-size', 'font-weight', 'margin', 'padding', 'z-index'];

/** Runs inside the browser. Never serializes scripts, event handlers or form values. */
export function inspectElement(element: Element, options: { view: 'element' | 'dom'; depth: number; limit: number; styles: string[]; matchedRules?: boolean }): unknown {
  const doc = element.ownerDocument, win = doc.defaultView!;
  const describe = {
    parent(node: Element): Element | null { return node.parentElement ?? (node.getRootNode() instanceof win.ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null); },
    field(node: Element): boolean { return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || (node as HTMLElement).isContentEditable; },
    inside(node: Element | null): boolean { while (node) { if (node === element) return true; node = describe.parent(node); } return false; },
    brief(node: Element): Record<string, unknown> {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return { tag: node.tagName.toLowerCase(), omitted: true };
    const attributes: Record<string, string> = {};
    for (const attr of Array.from(node.attributes)) {
      if (Object.keys(attributes).length >= 20) break;
      if (/^(id|class|role|name|type|title|alt|href|src|placeholder|disabled|required|readonly|tabindex|data-testid|aria-[\w-]+)$/.test(attr.name)) attributes[attr.name] = attr.value.slice(0, 200);
    }
    const form = describe.field(node);
    const directText = form ? '' : Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { tag: node.tagName.toLowerCase(), attributes, ...(directText ? { text: directText } : {}) };
  } };
  if (options.view === 'dom') {
    let count = 0, truncated = false;
    const walker = { walk(node: Element, depth: number): Record<string, unknown> | undefined {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return undefined;
      if (++count > options.limit) { truncated = true; return undefined; }
      const children = describe.field(node) ? [] : [...Array.from(node.children), ...Array.from(node.shadowRoot?.children ?? [])];
      const result = describe.brief(node);
      if (depth > 0) result.children = children.map(child => walker.walk(child, depth - 1)).filter(Boolean);
      else if (children.length) { result.childCount = children.length; truncated = true; }
      return result;
    } };
    const tree = walker.walk(element, options.depth);
    return { tree, nodes: Math.min(count, options.limit), truncated };
  }
  const rect = element.getBoundingClientRect(), css = win.getComputedStyle(element);
  const x = Math.max(0, rect.left) + Math.max(0, Math.min(rect.right, win.innerWidth) - Math.max(0, rect.left)) / 2;
  const y = Math.max(0, rect.top) + Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(0, rect.top)) / 2;
  let hit = doc.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
  const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
  const visible = rect.width > 0 && rect.height > 0 && css.visibility !== 'hidden' && css.display !== 'none' && css.opacity !== '0';
  const ancestors: Record<string, unknown>[] = [];
  let parent = describe.parent(element);
  while (parent && ancestors.length < 4) { ancestors.push(describe.brief(parent)); parent = describe.parent(parent); }
  let ruleInfo: Record<string, unknown> | undefined;
  if (options.matchedRules) {
    const matched: unknown[] = []; let unreadable = 0, scanned = 0;
    const reader = { rules(rules: CSSRuleList, source: string) {
      for (const rule of Array.from(rules)) {
        if (++scanned > 3000 || matched.length >= Math.min(options.limit, 20)) return;
        if (rule.type === 1) {
          const style = rule as CSSStyleRule;
          try {
            if (element.matches(style.selectorText)) matched.push({ selector: style.selectorText.slice(0, 300), source,
              properties: Object.fromEntries(options.styles.filter(key => style.style.getPropertyValue(key)).map(key => [key, style.style.getPropertyValue(key).slice(0, 200) + (style.style.getPropertyPriority(key) ? ' !important' : '')])) });
          } catch { /* Pseudo elements and browser-specific selectors may not match Element.matches. */ }
        } else if ('cssRules' in rule) {
          const group = rule as CSSGroupingRule & { conditionText?: string };
          if (rule.type === 4 && group.conditionText && !win.matchMedia(group.conditionText).matches) continue;
          if (rule.type === 12 && group.conditionText && !win.CSS.supports(group.conditionText)) continue;
          reader.rules(group.cssRules, source);
        }
      }
    } };
    const root = element.getRootNode();
    const sheets = root instanceof win.ShadowRoot ? [...Array.from(root.querySelectorAll('style,link[rel="stylesheet"]')).map(node => (node as HTMLStyleElement).sheet).filter((sheet): sheet is CSSStyleSheet => !!sheet), ...root.adoptedStyleSheets] : [...Array.from(doc.styleSheets), ...doc.adoptedStyleSheets];
    for (const sheet of new Set(sheets)) { try { reader.rules(sheet.cssRules, sheet.href ?? 'inline'); } catch { unreadable++; } }
    ruleInfo = { matchedRules: matched, unreadableStylesheets: unreadable, rulesTruncated: scanned > 3000 || matched.length >= Math.min(options.limit, 20) };
  }
  const math = { round(value: number) { return Math.round(value * 100) / 100; } };
  return { ...describe.brief(element),
    box: { x: math.round(rect.x), y: math.round(rect.y), width: math.round(rect.width), height: math.round(rect.height) },
    state: { connected: element.isConnected, visible, inViewport, disabled: element.matches(':disabled') || !!element.closest('[aria-disabled="true"]'), editable: !element.matches(':disabled,[readonly]') && (element.matches('textarea,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="hidden"])') || (element as HTMLElement).isContentEditable), receivesPointer: inViewport && describe.inside(hit) && css.pointerEvents !== 'none', pointerTest: 'center of this frame viewport; probe checks full Playwright click actionability' },
    ...(hit && !describe.inside(hit) ? { blockedBy: describe.brief(hit) } : {}),
    styles: Object.fromEntries(options.styles.map(key => [key, css.getPropertyValue(key).slice(0, 200)])),
    ...(ruleInfo ?? {}), ancestors, children: describe.field(element) ? [] : Array.from(element.children).slice(0, options.limit).map(describe.brief),
    childCount: element.children.length,
  };
}

export async function inspectPerformance(frame: Frame): Promise<unknown> {
  return frame.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const math = { round(value: number) { return Math.round(value * 100) / 100; } };
    return { readyState: document.readyState, domElements: document.getElementsByTagName('*').length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      ...(nav ? { navigation: { dnsMs: math.round(nav.domainLookupEnd - nav.domainLookupStart), connectMs: math.round(nav.connectEnd - nav.connectStart), ttfbMs: math.round(nav.responseStart - nav.requestStart), domContentLoadedMs: math.round(nav.domContentLoadedEventEnd), loadMs: math.round(nav.loadEventEnd), transferBytes: nav.transferSize } } : {}),
      paint: performance.getEntriesByType('paint').map(item => ({ name: item.name, ms: math.round(item.startTime) })),
      resources: { count: resources.length, transferBytes: resources.reduce((sum, item) => sum + item.transferSize, 0), slowest: [...resources].sort((a, b) => b.duration - a.duration).slice(0, 8).map(item => ({ url: item.name, type: item.initiatorType, durationMs: math.round(item.duration), transferBytes: item.transferSize })) },
      note: 'Page timing data, not a CPU profile. Cross-origin transfer sizes may be unavailable.',
    };
  });
}
