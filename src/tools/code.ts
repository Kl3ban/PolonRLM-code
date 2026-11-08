import ts from 'typescript-api';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { execa } from 'execa';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { contentHash } from './checkpoints.js';

export function registerCodeTools(registry: ToolRegistry, workspace: Workspace): void {
  const position = z.object({ path: z.string(), line: z.number().int().positive(), column: z.number().int().positive() });
  async function project(filename: string) {
    const target = await workspace.resolve(filename);
    const listed = await execa('rg', ['--files', '--glob', '*.{ts,tsx,js,jsx,mts,cts,json}', '--glob', '!node_modules', '--glob', '!.git', '--glob', '!.polonrlm', '--glob', '!.januszgpt'], { cwd: workspace.root, windowsHide: true, timeout: 10000, maxBuffer: 1000000, reject: false });
    if (listed.exitCode !== 0 && listed.exitCode !== 1) throw new Error('Code indexing requires ripgrep (rg).');
    const paths = [...new Set([filename, ...listed.stdout.split(/\r?\n/).filter(Boolean)])];
    if (paths.length > 500) throw new Error('Project exceeds the 500-file index limit. Narrow the workspace.');
    const files = new Map<string, string>(); let size = 0;
    for (const name of paths) { const resolved = await workspace.resolve(name); const text = await workspace.readText(name); size += Buffer.byteLength(text); if (size > 20000000) throw new Error('Code index exceeds 20 MB.'); files.set(resolved, text); }
    const lib = path.dirname(ts.getDefaultLibFilePath({}));
    const allowed = (name: string) => { try { const actual = realpathSync(name); return path.dirname(actual) === lib && /^lib\..*\.d\.ts$/.test(path.basename(actual)); } catch { return false; } };
    const read = (name: string) => files.get(path.resolve(name)) ?? (allowed(name) ? ts.sys.readFile(name) : undefined);
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, checkJs: true, skipLibCheck: true, noEmit: true };
    const config = files.get(path.join(workspace.root, 'tsconfig.json'));
    if (config) {
      const parsed = ts.parseConfigFileTextToJson('tsconfig.json', config);
      if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
      Object.assign(options, ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions ?? {}, workspace.root).options, { noEmit: true });
    }
    const host: ts.LanguageServiceHost = { getScriptFileNames: () => [...files.keys()].filter(name => /\.[cm]?[jt]sx?$/.test(name)), getScriptVersion: () => '1', getScriptSnapshot: name => { const text = read(name); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); }, getCurrentDirectory: () => workspace.root, getCompilationSettings: () => options, getDefaultLibFileName: options => ts.getDefaultLibFilePath(options), fileExists: name => read(name) !== undefined, readFile: read, readDirectory: () => [...files.keys()] };
    const service = ts.createLanguageService(host);
    const source = service.getProgram()?.getSourceFile(target);
    if (!source) { service.dispose(); throw new Error('Supported files: TypeScript and JavaScript.'); }
    return { service, source, target, files };
  }
  const offset = (source: ts.SourceFile, line: number, column: number) => { if (line > source.getLineStarts().length) throw new Error('Line is outside the file.'); const at = source.getPositionOfLineAndCharacter(line - 1, column - 1); if (at > source.text.length) throw new Error('Column is outside the file.'); return at; };
  const location = (file: string, span: ts.TextSpan, service: ts.LanguageService) => { const source = service.getProgram()?.getSourceFile(file); const pos = source?.getLineAndCharacterOfPosition(span.start); return { path: path.relative(workspace.root, file), line: pos ? pos.line + 1 : undefined, column: pos ? pos.character + 1 : undefined, start: span.start, length: span.length }; };
  registry.add('code_diagnostics', 'Real TypeScript/JavaScript syntactic and semantic diagnostics from the TypeScript language service. Disk files only; no arbitrary compiler plugins.', z.object({ path: z.string() }), true, async args => {
    const p = await project(args.path); try { return [...p.service.getSyntacticDiagnostics(p.target), ...p.service.getSemanticDiagnostics(p.target)].slice(0, 100).map(d => ({ ...location(p.target, { start: d.start ?? 0, length: d.length ?? 0 }, p.service), code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })); } finally { p.service.dispose(); }
  });
  for (const name of ['symbol_definition', 'symbol_references', 'symbol_hover'] as const) registry.add(name, 'TypeScript/JavaScript semantic symbol navigation. Positions are 1-based UTF-16.', position, true, async args => {
    const p = await project(args.path); try { const at = offset(p.source, args.line, args.column); if (name === 'symbol_hover') { const info = p.service.getQuickInfoAtPosition(p.target, at); return info ? { text: ts.displayPartsToString(info.displayParts), documentation: ts.displayPartsToString(info.documentation) } : { found: false }; } const found = name === 'symbol_definition' ? p.service.getDefinitionAtPosition(p.target, at) : p.service.getReferencesAtPosition(p.target, at); return (found ?? []).slice(0, 100).map(item => location(item.fileName, item.textSpan, p.service)); } finally { p.service.dispose(); }
  });
  registry.add('rename_symbol', 'Semantically rename a TypeScript/JavaScript symbol across indexed workspace files. Preview with apply=false in any mode; applying requires BUILD and follows the configured write permission policy. Applying uses permission-checked atomic file writes and stale-content checks; multi-file changes may be partial.', position.extend({ newName: z.string().regex(/^[A-Za-z_$][\w$]*$/), apply: z.boolean().default(false) }), false, async (args, context) => {
    const p = await project(args.path); try {
      const at = offset(p.source, args.line, args.column); const info = p.service.getRenameInfo(p.target, at);
      if (!info.canRename) throw new Error(info.localizedErrorMessage);
      const found = p.service.findRenameLocations(p.target, at, false, false, true) ?? [];
      const groups = new Map<string, ts.RenameLocation[]>();
      for (const item of found) { const file = path.resolve(item.fileName); if (!p.files.has(file)) throw new Error('Rename target is outside the project index.'); const group = groups.get(file) ?? []; group.push(item); groups.set(file, group); }
      const changes = [...groups].map(([file, edits]) => { const before = p.files.get(file)!; let after = before; for (const edit of edits.sort((a,b) => b.textSpan.start-a.textSpan.start)) after = after.slice(0, edit.textSpan.start) + (edit.prefixText ?? '') + args.newName + (edit.suffixText ?? '') + after.slice(edit.textSpan.start + edit.textSpan.length); const parsed = ts.createSourceFile(file, after, ts.ScriptTarget.Latest, true) as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }; if (parsed.parseDiagnostics.length) throw new Error('Rename would introduce a syntax error.'); return { path: path.relative(workspace.root, file), before, after }; });
      if (!args.apply) return changes.map(change => ({ path: change.path, beforeHash: contentHash(change.before), preview: change.after.slice(0, 3000) }));
      const applied: string[] = [];
      for (const change of changes) { context.signal.throwIfAborted(); try { await workspace.change('rename_symbol', change.path, current => { if (current !== change.before) throw new Error('File changed since analysis.'); return change.after; }, context.mode, context.signal); applied.push(change.path); } catch (error: any) { return { applied, failed: change.path, error: error.message }; } }
      return { applied };
    } finally { p.service.dispose(); }
  }, args => args.apply === true);
  registry.add('code_outline', 'List declaration names, AST kinds and source positions for a TypeScript/JavaScript file.', z.object({ path: z.string() }), true, async args => {
    const source = ts.createSourceFile(args.path, await workspace.readText(args.path), ts.ScriptTarget.Latest, true); const nodes: unknown[] = [];
    const visit = (node: ts.Node) => { if (nodes.length >= 150) return; const named = node as ts.NamedDeclaration; if (named.name && (ts.isDeclarationStatement(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node))) { const pos = source.getLineAndCharacterOfPosition(node.getStart(source)); nodes.push({ name: named.name.getText(source), kind: ts.SyntaxKind[node.kind], line: pos.line + 1, column: pos.character + 1 }); } ts.forEachChild(node, visit); }; visit(source); return nodes;
  });
  const ast = z.object({ path: z.string(), kind: z.string(), contains: z.string().default('') });
  registry.add('ast_search', 'Search real TypeScript/JavaScript AST nodes by SyntaxKind name (e.g. CallExpression, FunctionDeclaration) and optional literal text. Returns UTF-16 ranges and source hash.', ast, true, async args => {
    const text = await workspace.readText(args.path), source = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
    const kind = (ts.SyntaxKind as any)[args.kind]; if (typeof kind !== 'number') throw new Error('Unknown TypeScript SyntaxKind.');
    const matches: unknown[] = []; const visit = (node: ts.Node) => { if (matches.length >= 100) return; if (node.kind === kind && node.getText(source).includes(args.contains)) matches.push({ start: node.getStart(source), end: node.end, text: node.getText(source).slice(0, 1500) }); ts.forEachChild(node, visit); }; visit(source); return { hash: contentHash(text), matches };
  });
  registry.add('ast_edit', 'Replace exactly one previously observed TypeScript/JavaScript AST node. Requires source hash and exact node range from ast_search. Rejects syntactically invalid output.', z.object({ path: z.string(), hash: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), replacement: z.string().max(1000000) }), false, async (args, context) => workspace.change('ast_edit', args.path, before => {
    if (before === null || contentHash(before) !== args.hash) throw new Error('Hash is stale. Run ast_search again.');
    const source = ts.createSourceFile(args.path, before, ts.ScriptTarget.Latest, true); let found = false;
    const visit = (node: ts.Node) => { if (node.getStart(source) === args.start && node.end === args.end) found = true; ts.forEachChild(node, visit); }; visit(source);
    if (!found || args.end <= args.start) throw new Error('Range does not identify an AST node.');
    const after = before.slice(0, args.start) + args.replacement + before.slice(args.end);
    const parsed = ts.createSourceFile(args.path, after, ts.ScriptTarget.Latest, true) as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] };
    if (parsed.parseDiagnostics.length) throw new Error('Change would introduce a syntax error.'); return after;
  }, context.mode, context.signal));
}
