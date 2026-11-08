import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment } from './types.js';

export function imageFromBuffer(data: Buffer, name: string): ImageAttachment {
  if (!data.length || data.length > 8_000_000) throw new Error('Image must be between 1 byte and 8 MB.');
  let mediaType: ImageAttachment['mediaType'];
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mediaType = 'image/png';
  else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mediaType = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) mediaType = 'image/gif';
  else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') mediaType = 'image/webp';
  else throw new Error('Supported image formats: PNG, JPEG, WebP, and GIF.');
  return { data: data.toString('base64'), mediaType, tokenEstimate: 20000, name: path.basename(name) };
}

/** Explicit user-selected local files only. Never fetch URLs or trust file extensions. */
export async function loadUserImage(filename: string): Promise<ImageAttachment> {
  const metadata = await stat(filename);
  if (!metadata.isFile() || metadata.size > 8_000_000) throw new Error('Image file must be 8 MB or smaller.');
  return imageFromBuffer(await readFile(filename), filename);
}
