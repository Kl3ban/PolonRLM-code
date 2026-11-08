import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';

export interface TextPoint { row: number; column: number }
export interface TextSelection { anchor: TextPoint; focus: TextPoint }
export const plainLine = (text: string): string => stripVTControlCharacters(text);
export function orderedSelection(selection: TextSelection): [TextPoint, TextPoint] {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column) ? [anchor, focus] : [focus, anchor];
}
export function selectionRange(selection: TextSelection, row: number, length: number): [number, number] {
  const [start, end] = orderedSelection(selection);
  return row < start.row || row > end.row ? [0, 0] : [row === start.row ? start.column : 0, row === end.row ? end.column : length];
}
export function selectedText(lines: readonly { text: string }[], selection: TextSelection): string {
  const [start, end] = orderedSelection(selection);
  return lines.slice(start.row, end.row + 1).map((line, index) => {
    const text = Array.from(plainLine(line.text));
    const [from, to] = selectionRange(selection, start.row + index, text.length);
    return text.slice(from, to).join('');
  }).join('\n');
}
export function columnAtCell(text: string, cell: number): number {
  let width = 0, column = 0;
  for (const character of plainLine(text)) {
    const size = stringWidth(character);
    if (width + size > cell) break;
    width += size; column++;
  }
  return column;
}
