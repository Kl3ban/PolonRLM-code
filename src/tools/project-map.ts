import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { execa } from 'execa';
import { rgPath } from '@vscode/ripgrep';
import ts from 'typescript-api';
import { z } from 'zod';
import type { ToolContext, ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import type { SessionStore } from '../core/store.js';

const SOURCE = /\.[cm]?[jt]sx?$|\.(?:py|rs|go)$/i;
const JS_TS_SOURCE = /\.[cm]?[jt]sx?$/i;
const TYPESCRIPT_SOURCE = /\.(?:tsx?|mts|cts)$/i;
const SKIP_SEGMENTS = new Set(['node_modules', '.git', '.polonrlm', '.januszgpt', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor']);
const SECRET_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?)(?:\/|$)/i;
const TEXT_MANIFESTS = new Set(['package.json', 'tsconfig.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'makefile', 'dockerfile', 'readme.md', 'agents.md', 'qwen.md', 'claude.md', 'contributing.md']);
const SOURCE_LIMIT = 1000;
const SOURCE_BYTES_LIMIT = 40_000_000;
const MAX_SYMBOLS_PER_FILE = 16;
const MAX_PROJECT_SYMBOLS = 600;
const MAX_IMPORT_LENGTH = 120;
const MAX_OUTPUT_IMPORTS = 800;
const MAX_OUTPUT_EXPORTS = 1200;

type ProjectLanguage = 'javascript' | 'typescript' | 'python' | 'go' | 'rust' | 'manifest';
type ProjectSymbol = { name: string; kind: string; visibility: 'public' | 'internal' };

interface CachedFile {
  size: string;
  mtimeNs: string;
  ino: string;
  contentHash: string;
  language: ProjectLanguage;
  imports: string[];
  exports: string[];
  symbols: ProjectSymbol[];
  manifest?: Record<string, unknown>;
}
interface ProjectIndexCache { version: 3; root: string; target: string; files: Record<string, CachedFile> }

const LANGUAGES = new Set<ProjectLanguage>(['javascript', 'typescript', 'python', 'go', 'rust', 'manifest']);

function isProjectSymbol(value: unknown): value is ProjectSymbol {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const symbol = value as Record<string, unknown>;
  return typeof symbol.name === 'string' && symbol.name.length > 0 && symbol.name.length <= 200 &&
    typeof symbol.kind === 'string' && symbol.kind.length > 0 && symbol.kind.length <= 32 &&
    (symbol.visibility === 'public' || symbol.visibility === 'internal');
}

function parseProjectIndexCache(value: unknown, root: string, target: string): ProjectIndexCache | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cache = value as Record<string, unknown>;
  if (cache.version !== 3 || cache.root !== root || cache.target !== target || !cache.files || typeof cache.files !== 'object' || Array.isArray(cache.files)) return undefined;
  const files: Record<string, CachedFile> = Object.create(null) as Record<string, CachedFile>;
  for (const [relative, raw] of Object.entries(cache.files)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const file = raw as Record<string, unknown>;
    if (typeof file.size !== 'string' || typeof file.mtimeNs !== 'string' || typeof file.ino !== 'string' ||
      typeof file.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(file.contentHash) ||
      typeof file.language !== 'string' || !LANGUAGES.has(file.language as ProjectLanguage) ||
      !Array.isArray(file.imports) || !file.imports.every(item => typeof item === 'string' && item.length <= MAX_IMPORT_LENGTH) ||
      file.imports.length > 40 || !Array.isArray(file.exports) || !file.exports.every(item => typeof item === 'string' && item.length <= MAX_IMPORT_LENGTH) ||
      file.exports.length > 30 || !Array.isArray(file.symbols) || file.symbols.length > MAX_SYMBOLS_PER_FILE || !file.symbols.every(isProjectSymbol)) continue;
    files[relative] = { size: file.size, mtimeNs: file.mtimeNs, ino: file.ino, contentHash: file.contentHash, language: file.language as ProjectLanguage,
      imports: file.imports as string[], exports: file.exports as string[], symbols: file.symbols as ProjectSymbol[],
      ...(file.manifest && typeof file.manifest === 'object' && !Array.isArray(file.manifest) ? { manifest: file.manifest as Record<string, unknown> } : {}) };
  }
  return { version: 3, root, target, files };
}

async function fingerprint(filename: string): Promise<Pick<CachedFile, 'size' | 'mtimeNs' | 'ino'>> {
  const value = await stat(filename, { bigint: true });
  if (!value.isFile()) throw new Error('Not a regular file.');
  return { size: value.size.toString(), mtimeNs: value.mtimeNs.toString(), ino: value.ino.toString() };
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameFingerprint(left: CachedFile | undefined, right: Pick<CachedFile, 'size' | 'mtimeNs' | 'ino'>, hash: string): boolean {
  return !!left && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ino === right.ino && left.contentHash === hash;
}

function exportNames(source: ts.SourceFile): string[] {
  const names = new Set<string>();
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) names.add(item.name.text);
      else if (!statement.exportClause) names.add('*');
      continue;
    }
    if (ts.isExportAssignment(statement)) { names.add('default'); continue; }
    if (!exported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) names.add(item.name.text);
    } else {
      const name = (statement as unknown as ts.NamedDeclaration).name;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) names.add(name.text);
      else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) names.add('default');
    }
  }
  return [...names].filter(name => name.length <= MAX_IMPORT_LENGTH).sort().slice(0, 30);
}

function jsTsSymbols(source: ts.SourceFile): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];
  const add = (name: string | undefined, kind: string, isPublic: boolean) => {
    if (!name || symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    symbols.push({ name, kind, visibility: isPublic ? 'public' : 'internal' });
  };
  for (const statement of source.statements) {
    const isPublic = ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) add(declaration.name.text, 'variable', isPublic);
    } else if (ts.isFunctionDeclaration(statement)) add(statement.name?.text, 'function', isPublic);
    else if (ts.isClassDeclaration(statement)) add(statement.name?.text, 'class', isPublic);
    else if (ts.isInterfaceDeclaration(statement)) add(statement.name.text, 'interface', isPublic);
    else if (ts.isTypeAliasDeclaration(statement)) add(statement.name.text, 'type', isPublic);
    else if (ts.isEnumDeclaration(statement)) add(statement.name.text, 'enum', isPublic);
  }
  return symbols;
}

// This intentionally masks comments and string bodies instead of parsing the
// language. It is enough to keep line-based symbol guesses out of comments and
// multiline literals while keeping the index small and dependency-free.
function maskNonCode(text: string, language: Exclude<ProjectLanguage, 'javascript' | 'typescript' | 'manifest'>): string {
  const chars = text.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'tripleSingle' | 'tripleDouble' | 'raw' = 'code';
  let blockDepth = 0;
  let escaped = false;
  let rawEnd = '';
  const blank = (index: number) => { if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!, next = text[i + 1] ?? '';
    if (state === 'line') {
      if (ch === '\n' || ch === '\r') state = 'code'; else blank(i);
      continue;
    }
    if (state === 'block') {
      if (language === 'rust' && ch === '/' && next === '*') { blank(i); blank(i + 1); blockDepth++; i++; continue; }
      if (ch === '*' && next === '/') { blank(i); blank(i + 1); i++; if (--blockDepth === 0) state = 'code'; continue; }
      blank(i); continue;
    }
    if (state === 'raw') {
      if (text.startsWith(rawEnd, i)) { for (let j = 0; j < rawEnd.length; j++) blank(i + j); i += rawEnd.length - 1; state = 'code'; continue; }
      blank(i); continue;
    }
    if (state === 'single' || state === 'double' || state === 'template' || state === 'tripleSingle' || state === 'tripleDouble') {
      const close = state === 'single' ? "'" : state === 'double' ? '"' : state === 'template' ? '`' : state === 'tripleSingle' ? "'''" : '"""';
      if (!escaped && text.startsWith(close, i)) {
        for (let j = 0; j < close.length; j++) blank(i + j);
        i += close.length - 1; state = 'code'; continue;
      }
      if (!escaped && ch === '\\') escaped = true; else escaped = false;
      blank(i); continue;
    }
    if (language === 'python' && ch === '#') { blank(i); state = 'line'; continue; }
    if (language !== 'python' && ch === '/' && next === '/') { blank(i); blank(i + 1); i++; state = 'line'; continue; }
    if (language !== 'python' && ch === '/' && next === '*') { blank(i); blank(i + 1); i++; blockDepth = 1; state = 'block'; continue; }
    if (language === 'rust' && ch === 'r') {
      const rawStart = /^r(#+)?"/.exec(text.slice(i));
      if (rawStart) { const hashes = rawStart[1] ?? ''; rawEnd = `"${hashes}`; for (let j = 0; j < rawStart[0].length; j++) blank(i + j); i += rawStart[0].length - 1; state = 'raw'; continue; }
    }
    if (language === 'python' && (ch === "'" || ch === '"') && text.slice(i, i + 3) === ch.repeat(3)) {
      for (let j = 0; j < 3; j++) blank(i + j); i += 2; state = ch === "'" ? 'tripleSingle' : 'tripleDouble'; escaped = false; continue;
    }
    if (language === 'rust' && ch === "'") {
      if (/^'(?:\\.|[^'\\\r\n])'/.test(text.slice(i))) { blank(i); state = 'single'; escaped = false; }
      continue; // Rust lifetime, not a string delimiter.
    }
    if (ch === "'") { blank(i); state = 'single'; escaped = false; }
    else if (ch === '"') { blank(i); state = 'double'; escaped = false; }
    else if (language === 'go' && ch === '`') { blank(i); state = 'template'; escaped = false; }
  }
  return chars.join('');
}

function nonJsIndex(text: string, language: 'python' | 'go' | 'rust'): { imports: string[]; symbols: ProjectSymbol[] } {
  const codeLines = maskNonCode(text, language).split(/\r?\n/);
  const rawLines = text.split(/\r?\n/);
  const foundImports = new Set<string>();
  const symbols: ProjectSymbol[] = [];
  const addSymbol = (symbol: ProjectSymbol) => { if (symbols.length < MAX_SYMBOLS_PER_FILE) symbols.push(symbol); };
  let goImportBlock = false;
  for (let index = 0; index < codeLines.length; index++) {
    const code = codeLines[index] ?? '', raw = rawLines[index] ?? '';
    if (language === 'python') {
      const imported = /^\s*from\s+([.\w]+)\s+import\b/.exec(code)?.[1];
      if (imported) foundImports.add(imported);
      else {
        const list = /^\s*import\s+(.+)$/.exec(code)?.[1];
        if (list) for (const part of list.split(',')) { const name = /^\s*([.\w]+)/.exec(part)?.[1]; if (name) foundImports.add(name); }
      }
      if (/^\s/.test(code)) continue;
      let match = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(code);
      if (match) addSymbol({ name: match[1]!, kind: 'function', visibility: match[1]!.startsWith('_') ? 'internal' : 'public' });
      else if ((match = /^class\s+([A-Za-z_]\w*)\b/.exec(code))) addSymbol({ name: match[1]!, kind: 'class', visibility: match[1]!.startsWith('_') ? 'internal' : 'public' });
    } else if (language === 'go') {
      if (/^\s*import\s*\(/.test(code)) { goImportBlock = true; continue; }
      if (goImportBlock) {
        if (/^\s*\)/.test(code)) { goImportBlock = false; continue; }
        const specifier = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(raw)?.[1]; if (specifier) foundImports.add(specifier);
        continue;
      }
      const singleImport = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(raw)?.[1];
      if (singleImport && /^\s*import\b/.test(code)) foundImports.add(singleImport);
      if (/^\s/.test(code)) continue;
      let match = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(code);
      if (match) addSymbol({ name: match[1]!, kind: 'function', visibility: /^[A-Z]/.test(match[1]!) ? 'public' : 'internal' });
      else if ((match = /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface|\w+)/.exec(code))) addSymbol({ name: match[1]!, kind: 'type', visibility: /^[A-Z]/.test(match[1]!) ? 'public' : 'internal' });
      else if ((match = /^(var|const)\s+([A-Za-z_]\w*)\b/.exec(code))) addSymbol({ name: match[2]!, kind: match[1] === 'const' ? 'constant' : 'variable', visibility: /^[A-Z]/.test(match[2]!) ? 'public' : 'internal' });
    } else {
      const imported = /^\s*(?:pub\s+)?use\s+(.+?)\s*;/.exec(code)?.[1];
      if (imported) foundImports.add(imported);
      if (/^\s/.test(code)) continue;
      const visibility = /^(?:pub(?:\([^)]*\))?\s+)/.test(code) ? 'public' : 'internal';
      const declaration = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]+")?)\s+)*(fn|struct|enum|trait|type|const|static|mod|macro_rules!)\s+([A-Za-z_]\w*)/.exec(code);
      if (declaration) addSymbol({ name: declaration[2]!, kind: declaration[1] === 'fn' ? 'function' : declaration[1] === 'macro_rules!' ? 'macro' : declaration[1]!, visibility });
    }
  }
  return { imports: [...foundImports].filter(name => name.length <= MAX_IMPORT_LENGTH).sort().slice(0, 40), symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE) };
}

function projectLanguage(filename: string): Exclude<ProjectLanguage, 'manifest'> {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.py') return 'python';
  if (extension === '.go') return 'go';
  if (extension === '.rs') return 'rust';
  return TYPESCRIPT_SOURCE.test(filename) ? 'typescript' : 'javascript';
}

function imports(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) found.add(specifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      found.add(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].filter(name => name.length <= MAX_IMPORT_LENGTH).sort().slice(0, 40);
}

function manifestSummary(relative: string, text: string): Record<string, unknown> | undefined {
  const base = path.basename(relative).toLowerCase();
  try {
    if (base === 'package.json') {
      const value = JSON.parse(text);
      return { path: relative, name: typeof value.name === 'string' ? value.name : undefined,
        packageManager: typeof value.packageManager === 'string' ? value.packageManager : undefined,
        scripts: Object.keys(value.scripts ?? {}).slice(0, 40),
        dependencies: [...new Set([...Object.keys(value.dependencies ?? {}), ...Object.keys(value.devDependencies ?? {}), ...Object.keys(value.optionalDependencies ?? {})])].sort().slice(0, 80) };
    }
    if (base === 'cargo.toml') {
      const name = /^\s*name\s*=\s*["']([^"']+)/m.exec(text)?.[1];
      const edition = /^\s*edition\s*=\s*["']([^"']+)/m.exec(text)?.[1];
      return { path: relative, name, edition };
    }
    if (base === 'go.mod') return { path: relative, module: /^\s*module\s+(\S+)/m.exec(text)?.[1], go: /^\s*go\s+(\S+)/m.exec(text)?.[1] };
    if (base === 'pyproject.toml') return { path: relative, name: /^\s*name\s*=\s*["']([^"']+)/m.exec(text)?.[1], requiresPython: /^\s*requires-python\s*=\s*["']([^"']+)/m.exec(text)?.[1] };
    return { path: relative, lines: text.split(/\r?\n/).length };
  } catch { return { path: relative, invalid: true }; }
}

function resolveRelativeImport(from: string, specifier: string, indexed: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  for (const suffix of extensions) {
    const candidate = suffix ? `${base}${suffix}` : base;
    if (indexed.has(path.normalize(candidate))) return path.normalize(candidate);
  }
  return undefined;
}

export function registerProjectMap(registry: ToolRegistry, workspace: Workspace, store?: SessionStore): void {
  registry.add('project_map', 'Build or incrementally refresh a read-only architecture index: source inventory, JS/TS import graph and exports, best-effort top-level symbols and imports for Python, Go and Rust, plus root manifests and scripts. The non-JS/TS parser is heuristic, not compiler-grade. Cache stores file metadata, content hashes and summaries, never source text or secrets. Content is re-read for hash validation; unchanged files are not reparsed. Set refresh=true to reparse unchanged files.',
    z.object({ path: z.string().default('.'), maxFiles: z.number().int().min(20).max(SOURCE_LIMIT).default(120), refresh: z.boolean().default(false) }), true,
    async (args, context: ToolContext) => {
      const target = await workspace.resolve(args.path);
      await workspace.list(args.path);
      // Subagents scan disposable overlays. Do not retain one index row per
      // temporary worktree in the user's persistent project database.
      const cacheEnabled = !!store && !context.isolated;
      const listed = await execa(rgPath, ['--files', '--hidden', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.polonrlm/**', '--glob', '!**/.januszgpt/**', '--glob', '!**/dist/**', '--glob', '!**/build/**', '--glob', '!**/coverage/**', '--glob', '!**/.next/**', '--glob', '!**/.venv/**', '--glob', '!**/vendor/**', '--glob', '!**/.env*', '--glob', '!**/*.{lock,pem,key,p12,pfx,crt,cer,der,sqlite,db,log,bin}', '--', target], {
        cwd: workspace.root, windowsHide: true, timeout: 15000, maxBuffer: 5_000_000, reject: false, cancelSignal: context.signal,
      });
      context.signal.throwIfAborted();
      if (listed.exitCode !== 0 && listed.exitCode !== 1) throw new Error(`Project scan failed (ripgrep exit ${listed.exitCode ?? 'unknown'}): ${listed.stderr || listed.shortMessage}`);
      const discoveredPaths = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean).map(value => path.resolve(value)))].filter(absolute => {
        const relative = path.relative(workspace.root, absolute).replaceAll('\\', '/');
        return !relative.startsWith('../') && !path.isAbsolute(relative) && !SECRET_PATH.test(relative) && !relative.split('/').some(part => SKIP_SEGMENTS.has(part.toLowerCase()));
      });
      const fileListTruncated = discoveredPaths.length > 5000;
      const allPaths = discoveredPaths.slice(0, 5000);
      const relative = (absolute: string) => path.relative(workspace.root, absolute).replaceAll('\\', '/');
      const folders = new Map<string, number>();
      const byExtension = new Map<string, number>();
      for (const absolute of allPaths) {
        const rel = relative(absolute), parts = rel.split('/');
        if (parts.length > 1) folders.set(parts[0]!, (folders.get(parts[0]!) ?? 0) + 1);
        const ext = path.extname(absolute).toLowerCase() || '[no extension]'; byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1);
      }
      const targetRelative = path.relative(workspace.root, target).replaceAll('\\', '/') || '.';
      let priorCache: ProjectIndexCache | undefined;
      if (cacheEnabled && store && !args.refresh) {
        try { priorCache = parseProjectIndexCache(store.projectIndex(workspace.root, targetRelative), workspace.root, targetRelative); }
        catch { /* A damaged optional index must never prevent a fresh project scan. */ }
      }
      const nextFiles: Record<string, CachedFile> = Object.create(null) as Record<string, CachedFile>;
      let cachedFiles = 0, refreshedFiles = 0, sourceBytesRead = 0, sourceBytesParsed = 0, sourceBytesConsidered = 0, skippedSources = 0;
      const sourcePaths = allPaths.filter(absolute => SOURCE.test(absolute)).slice(0, args.maxFiles);
      const moduleMap = new Map<string, { language: ProjectLanguage; imports: string[]; exports: string[]; symbols: ProjectSymbol[] }>();
      const external = new Map<string, number>();
      const edges: Array<{ from: string; to: string }> = [];
      const manifests: Record<string, unknown>[] = [];
      const manifestPaths = allPaths.filter(absolute => TEXT_MANIFESTS.has(path.basename(absolute).toLowerCase()) && path.dirname(absolute) === target).slice(0, 12);
      for (const absolute of manifestPaths) {
        context.signal.throwIfAborted();
        const rel = relative(absolute);
        try {
          const filename = await workspace.resolve(rel);
          const fingerprinted = await fingerprint(filename);
          const text = await workspace.readText(rel);
          const hash = contentHash(text);
          const previous = priorCache?.files[rel];
          if (!args.refresh && sameFingerprint(previous, fingerprinted, hash) && previous?.manifest) {
            manifests.push(previous.manifest); nextFiles[rel] = previous; cachedFiles++; continue;
          }
          const summary = manifestSummary(rel, text)!;
          manifests.push(summary); nextFiles[rel] = { ...fingerprinted, contentHash: hash, language: 'manifest', imports: [], exports: [], symbols: [], manifest: summary }; refreshedFiles++;
        } catch { /* unreadable, oversized, or changed manifest: omit it */ }
      }
      for (const [index, absolute] of sourcePaths.entries()) {
        context.signal.throwIfAborted();
        const rel = relative(absolute);
        let language: ProjectLanguage, fileImports: string[], fileExports: string[], symbols: ProjectSymbol[];
        try {
          const filename = await workspace.resolve(rel);
          const fingerprinted = await fingerprint(filename);
          const fileBytes = Number(fingerprinted.size);
          if (!Number.isSafeInteger(fileBytes) || sourceBytesConsidered + fileBytes > SOURCE_BYTES_LIMIT) {
            skippedSources += sourcePaths.length - index; break;
          }
          sourceBytesConsidered += fileBytes;
          const text = await workspace.readText(rel);
          const textBytes = Buffer.byteLength(text);
          sourceBytesRead += textBytes;
          const hash = contentHash(text);
          language = projectLanguage(absolute);
          const previous = priorCache?.files[rel];
          if (!args.refresh && previous && sameFingerprint(previous, fingerprinted, hash) && !previous.manifest) {
            fileImports = previous.imports; fileExports = previous.exports; symbols = previous.symbols; language = previous.language; nextFiles[rel] = previous; cachedFiles++;
          } else {
            sourceBytesParsed += textBytes;
            if (language === 'javascript' || language === 'typescript') {
              const kind = /\.tsx$/i.test(absolute) ? ts.ScriptKind.TSX : TYPESCRIPT_SOURCE.test(absolute) ? ts.ScriptKind.TS : /\.jsx$/i.test(absolute) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
              const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, kind);
              fileImports = imports(source); fileExports = exportNames(source); symbols = jsTsSymbols(source);
            } else {
              const parsed = nonJsIndex(text, language); fileImports = parsed.imports; fileExports = []; symbols = parsed.symbols;
            }
            nextFiles[rel] = { ...fingerprinted, contentHash: hash, language, imports: fileImports, exports: fileExports, symbols }; refreshedFiles++;
          }
        } catch { skippedSources++; continue; }
        moduleMap.set(path.normalize(absolute), { language, imports: fileImports, exports: fileExports, symbols });
      }
      const indexed = new Set(moduleMap.keys());
      for (const [absolute, entry] of moduleMap) {
        if (entry.language !== 'javascript' && entry.language !== 'typescript') continue;
        for (const specifier of entry.imports) {
          const resolved = resolveRelativeImport(absolute, specifier, indexed);
          if (resolved && edges.length < 1200) edges.push({ from: relative(absolute), to: relative(resolved) });
          else if (!specifier.startsWith('.')) external.set(specifier, (external.get(specifier) ?? 0) + 1);
        }
      }
      let emittedSymbols = 0, omittedSymbolCount = 0, emittedImports = 0, omittedImportCount = 0, emittedExports = 0, omittedExportCount = 0;
      const moduleEntries = [...moduleMap].slice(0, args.maxFiles).map(([absolute, entry]) => {
        const room = Math.max(0, MAX_PROJECT_SYMBOLS - emittedSymbols);
        const visibleSymbols = entry.symbols.slice(0, room);
        const visibleImports = entry.imports.slice(0, Math.min(12, MAX_OUTPUT_IMPORTS - emittedImports));
        const visibleExports = entry.exports.slice(0, Math.min(20, MAX_OUTPUT_EXPORTS - emittedExports));
        emittedSymbols += visibleSymbols.length;
        emittedImports += visibleImports.length;
        emittedExports += visibleExports.length;
        omittedSymbolCount += entry.symbols.length - visibleSymbols.length;
        omittedImportCount += entry.imports.length - visibleImports.length;
        omittedExportCount += entry.exports.length - visibleExports.length;
        return { path: relative(absolute), ...entry, imports: visibleImports, exports: visibleExports, symbols: visibleSymbols };
      });
      for (const [, entry] of [...moduleMap].slice(args.maxFiles)) {
        omittedSymbolCount += entry.symbols.length;
        omittedImportCount += entry.imports.length;
        omittedExportCount += entry.exports.length;
      }
      let cachePersisted = false;
      if (cacheEnabled && store) {
        try {
          store.saveProjectIndex(workspace.root, targetRelative, { version: 3, root: workspace.root, target: targetRelative, files: nextFiles } satisfies ProjectIndexCache);
          cachePersisted = true;
        } catch { /* Indexing remains useful when the local cache cannot be saved. */ }
      }
      const rootFiles = allPaths.filter(absolute => path.dirname(absolute) === target && (TEXT_MANIFESTS.has(path.basename(absolute).toLowerCase()) || /\.(?:sln|csproj|xcodeproj)$/i.test(absolute))).map(relative).slice(0, 80);
      const omitted = Math.max(0, allPaths.length - sourcePaths.length - manifestPaths.length);
      return {
        root: workspace.root,
        filesSeen: allPaths.length,
        sourceFilesFound: allPaths.filter(absolute => SOURCE.test(absolute)).length,
        sourceFilesIndexed: moduleEntries.length,
        sourceBytesRead,
        sourceBytesParsed,
        truncated: fileListTruncated || sourcePaths.length < allPaths.filter(absolute => SOURCE.test(absolute)).length || skippedSources > 0,
        skippedSources,
        topLevelAreas: [...folders].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([name, files]) => ({ name, files })),
        filesByExtension: [...byExtension].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([extension, files]) => ({ extension, files })),
        rootFiles,
        manifests,
        modules: moduleEntries,
        symbolCount: emittedSymbols,
        omittedIndexedSymbolCount: omittedSymbolCount,
        omittedImportCount,
        omittedExportCount,
        importEdges: edges,
        externalImports: [...external].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([name, references]) => ({ name, references })),
        omittedFileCount: omitted,
        index: { mode: args.refresh ? 'forced-refresh' : 'incremental', cacheAvailable: cacheEnabled, loadedExisting: !!priorCache, cachedFiles, refreshedFiles, persisted: cachePersisted },
      };
    });
}
