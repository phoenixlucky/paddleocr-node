/**
 * 工具函数
 */
import type { OcrResult, OcrTextBox } from './types';

/**
 * 从 OCR 结果中提取去重后的纯文本行
 * 按 y 坐标排序（阅读顺序），合并同行文本
 */
export function extractLines(result: OcrResult, yThreshold: number = 10): string[] {
  if (!result || !result.pages) return [];

  const lines: { y: number; text: string }[] = [];

  for (const page of result.pages) {
    for (const box of page.boxes) {
      if (!box.text.trim()) continue;
      // 使用文本框顶部 y 坐标
      const yCenter = box.box.reduce((sum, p) => sum + p[1], 0) / box.box.length;
      lines.push({ y: yCenter, text: box.text.trim() });
    }
  }

  // 按 y 排序（阅读顺序）
  lines.sort((a, b) => {
    if (Math.abs(a.y - b.y) < yThreshold) return 0;
    return a.y - b.y;
  });

  return lines.map((l) => l.text);
}

/**
 * 从 OCR 结果中提取结构化表格（按行/列近似分组）
 * 注意：这只是一个近似算法，复杂表格建议使用 PaddleOCR 的表格识别功能
 */
export function extractTable(
  pageBoxes: OcrTextBox[],
  xThreshold: number = 30,
  yThreshold: number = 10
): string[][] {
  if (!pageBoxes || pageBoxes.length === 0) return [];

  // 按 y 分组
  const rows: { y: number; boxes: OcrTextBox[] }[] = [];

  for (const box of pageBoxes) {
    if (!box.text.trim()) continue;
    const yCenter = box.box.reduce((sum, p) => sum + p[1], 0) / box.box.length;

    // 找现有行
    let found = false;
    for (const row of rows) {
      if (Math.abs(row.y - yCenter) <= yThreshold) {
        row.boxes.push(box);
        // 更新平均 y
        row.y = (row.y * (row.boxes.length - 1) + yCenter) / row.boxes.length;
        found = true;
        break;
      }
    }
    if (!found) {
      rows.push({ y: yCenter, boxes: [box] });
    }
  }

  // 每行内按 x 排序
  for (const row of rows) {
    row.boxes.sort((a, b) => {
      const ax = a.box.reduce((sum, p) => sum + p[0], 0) / a.box.length;
      const bx = b.box.reduce((sum, p) => sum + p[0], 0) / b.box.length;
      return ax - bx;
    });
  }

  // 按 y 排序
  rows.sort((a, b) => a.y - b.y);

  return rows.map((row) => row.boxes.map((b) => b.text));
}

/**
 * 以纯文本格式输出结果摘要
 */
export function formatResultSummary(result: OcrResult): string {
  const parts: string[] = [
    `文件: ${result.source}`,
    `总页数: ${result.totalPages}`,
    '',
  ];

  for (const page of result.pages) {
    parts.push(`--- 第 ${page.page} 页 ---`);
    parts.push(page.fullText);
    parts.push('');
  }

  return parts.join('\n');
}
