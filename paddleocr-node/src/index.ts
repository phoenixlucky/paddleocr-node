/**
 * paddleocr-node — Node.js 封装 PaddleOCR
 *
 * 通过 Python 子进程调用 PaddleOCR，支持识别图片和 PDF 中的文字。
 */

export { PaddleOcr } from './ocr';
export * from './types';
export { extractLines, extractTable, formatResultSummary } from './utils';

import { PaddleOcr } from './ocr';
import type { PaddleOcrOptions, OcrResult } from './types';

/**
 * 便捷函数：一次调用完成 OCR 识别
 *
 * @example
 * ```ts
 * const result = await recognize('scan.pdf', { lang: 'ch' });
 * console.log(result.fullText);
 * ```
 */
export async function recognize(
  filePath: string,
  options: PaddleOcrOptions = {}
): Promise<OcrResult> {
  const ocr = new PaddleOcr(options);
  try {
    return await ocr.recognizeFile(filePath);
  } finally {
    await ocr.close();
  }
}

/**
 * 便捷函数：识别 base64 图片
 */
export async function recognizeBase64(
  base64Data: string,
  options: PaddleOcrOptions = {}
): Promise<OcrResult> {
  const ocr = new PaddleOcr(options);
  try {
    return await ocr.recognizeBase64(base64Data);
  } finally {
    await ocr.close();
  }
}

export default PaddleOcr;
