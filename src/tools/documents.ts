import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { subprocessEnvironment } from '../core/secrets.js';

export function tesseractFailure(error: { code?: unknown; exitCode?: unknown; stderr?: unknown; message?: unknown }): string | undefined {
  const code = String(error.code ?? error.exitCode ?? '');
  if (code === 'ENOENT' || code === '9009') return 'Tesseract OCR was not found in PATH. Install Tesseract and its pol and eng language data, make sure tesseract.exe is in PATH, then restart PolonRLM.';
  const detail = String(error.stderr ?? error.message ?? '');
  if (/failed loading language|error opening data file|could not initialize tesseract|tessdata/i.test(detail)) return 'Tesseract is installed, but language data is missing. Add pol.traineddata and eng.traineddata to tessdata, then check `tesseract --list-langs`.';
  return undefined;
}

export function selectOcrLanguage(requested: string, available: string[]): { language: string; warning?: string } {
  const installed = new Set(available);
  const wanted = requested.split('+');
  const selected = wanted.filter(language => installed.has(language));
  const missing = wanted.filter(language => !installed.has(language));
  if (!missing.length) return { language: requested };
  const fallback = selected.length ? selected.join('+') : installed.has('eng') ? 'eng' : available[0];
  if (!fallback) throw new Error('No Tesseract language data is installed.');
  return { language: fallback, warning: `OCR: missing languages ${missing.join(', ')}; using ${fallback}. Results may be less accurate. Add the missing .traineddata files for full accuracy.` };
}

async function findTesseractCommand(): Promise<string> {
  const candidates = new Set<string>();
  if (process.env.POLONRLM_TESSERACT) candidates.add(process.env.POLONRLM_TESSERACT);
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles;
    if (programFiles) candidates.add(path.join(programFiles, 'Tesseract-OCR', 'tesseract.exe'));
    try {
      const found = await execa('where.exe', ['tesseract.exe'], { reject: false, timeout: 3000, windowsHide: true });
      for (const command of found.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) if (!/\\WindowsApps\\/i.test(command)) candidates.add(command);
    } catch { /* PATH lookup is optional */ }
    candidates.add('tesseract.exe');
  } else candidates.add('tesseract');
  for (const command of candidates) {
    try {
      const result = await execa(command, ['--version'], { reject: false, timeout: 5000, windowsHide: true });
      if (result.exitCode === 0) return command;
    } catch { /* Try the next known install location */ }
  }
  throw new Error(tesseractFailure({ code: 'ENOENT' }));
}

export function registerDocumentTools(registry: ToolRegistry, workspace: Workspace): void {
  registry.add('read_document', 'Read PDF text, DOCX paragraphs and XLSX sheets without executing macros or formulas. Bounded page, row and output counts.', z.object({ path: z.string(), from: z.number().int().positive().default(1), count: z.number().int().min(1).max(50).default(20) }), true, async (args, context) => {
    const target = await workspace.resolve(args.path); const stat = await lstat(target);
    if (!stat.isFile() || stat.size > 50_000_000) throw new Error('Document must be a regular file no larger than 50 MB.');
    const extension = args.path.split('.').at(-1)?.toLowerCase();
    if (extension === 'txt' || extension === 'md' || extension === 'csv' || extension === 'json' || extension === 'xml' || extension === 'html') return (await workspace.readText(args.path)).slice(0, 50000);
    const data = await readFile(target); context.signal.throwIfAborted();
    if (extension === 'pdf') {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loading = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true } as any);
      const document = await loading.promise;
      try {
        if (args.from > document.numPages) throw new Error(`PDF has ${document.numPages} pages.`);
        const last = Math.min(document.numPages, args.from + args.count - 1); let output = `PDF: ${document.numPages} pages; pages ${args.from}-${last}\n`;
        for (let pageNumber = args.from; pageNumber <= last; pageNumber++) {
          context.signal.throwIfAborted(); const page = await document.getPage(pageNumber); const content = await page.getTextContent();
          const text = content.items.map((item: any) => typeof item.str === 'string' ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
          output += `\n--- Page ${pageNumber} ---\n${text || '[no text layer; the document may be a scan]'}`;
          if (output.length > 50000) return output.slice(0, 50000) + '\n[truncated at 50,000 characters]';
        }
        return output;
      } finally { await loading.destroy(); }
    }
    if (extension === 'docx') {
      const result = await mammoth.extractRawText({ buffer: data });
      return result.value.slice(0, 50000) + (result.value.length > 50000 ? '\n[truncated at 50,000 characters]' : '');
    }
    if (extension === 'xlsx') {
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(data as any);
      const sheets = workbook.worksheets.slice(0, 20); let output = '';
      for (const sheet of sheets) {
        output += `\n## Arkusz: ${sheet.name}\n`;
        const start = Math.max(1, args.from); const end = Math.min(sheet.rowCount, start + args.count - 1, 2000);
        for (let row = start; row <= end; row++) {
          const cells = sheet.getRow(row).values as ExcelJS.CellValue[];
          output += `${row}: ${cells.slice(1, 41).map(value => {
            if (value instanceof Date) return value.toISOString();
            if (value && typeof value === 'object') {
              if ('text' in value) return String(value.text ?? '');
              if ('richText' in value) return value.richText.map(part => part.text).join('');
              if ('result' in value) return String(value.result ?? '[formula]');
              if ('formula' in value || 'sharedFormula' in value) return '[formula]';
              if ('error' in value) return `[error: ${String(value.error)}]`;
              return '[complex value]';
            }
            return String(value ?? '');
          }).join('\t')}\n`;
          if (output.length > 50000) return output.slice(0, 50000) + '\n[truncated at 50,000 characters]';
        }
      }
      return output || '[empty workbook]';
    }
    throw new Error('Supported formats: PDF, DOCX, XLSX, TXT, MD, CSV, JSON, XML, and HTML.');
  });

  registry.add('ocr_image', 'Extract Polish/English text from a workspace image using the installed Tesseract CLI. Does not modify files.', z.object({ path: z.string(), language: z.enum(['pol+eng', 'pol', 'eng']).default('pol+eng') }), false, async (args, context) => {
    const target = await workspace.resolve(args.path); const stat = await lstat(target);
    if (!stat.isFile() || stat.size > 25_000_000 || !/\.(png|jpe?g|webp|tiff?)$/i.test(target)) throw new Error('OCR supports PNG, JPEG, WebP, and TIFF up to 25 MB.');
    await workspace.permissions.check('ocr_image', 'shell', `Run local OCR on ${args.path}.`, undefined, context.mode, context.signal);
    try {
      const command = await findTesseractCommand();
      const languageResult = await execa(command, ['--list-langs'], { cwd: workspace.root, env: subprocessEnvironment(context.isolated), windowsHide: true, timeout: 10000, maxBuffer: 100000, reject: false, cancelSignal: context.signal });
      if (languageResult.exitCode !== 0) throw new Error(tesseractFailure(languageResult) ?? (languageResult.stderr || 'Could not read Tesseract languages.'));
      const available = languageResult.stdout.split(/\r?\n/).slice(1).map(value => value.trim()).filter(value => /^[a-z0-9_]+$/i.test(value));
      const selected = selectOcrLanguage(args.language, available);
      const result = await execa(command, [target, 'stdout', '-l', selected.language, '--psm', '6'], { cwd: workspace.root, env: subprocessEnvironment(context.isolated), windowsHide: true, timeout: 120000, maxBuffer: 1_000_000, reject: false, cancelSignal: context.signal });
      if (result.timedOut) throw new Error('OCR timed out after 120 seconds.');
      if (result.exitCode !== 0) throw new Error(tesseractFailure(result) ?? (result.stderr || `Tesseract exited with code ${result.exitCode}.`));
      return `${selected.warning ? selected.warning + '\n' : ''}${result.stdout.slice(0, 30000) || '[no text detected]'}`;
    } catch (error: any) {
      const diagnosis = tesseractFailure(error);
      if (diagnosis) throw new Error(diagnosis);
      throw error;
    }
  });
}
