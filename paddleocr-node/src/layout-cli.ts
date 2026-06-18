/**
 * layout-cli.ts — 命令行工具：识别文本 + 表格，保持原文件排版输出
 *
 * 用法:
 *   npx ts-node src/layout-cli.ts <图片或PDF文件路径>
 *
 * 输出: 文本与表格按阅读顺序穿插排列，保持原文件排版
 */

import { PaddleOcr } from './ocr';
import type { OcrResult, OcrTextBox, OcrTableResult } from './types';
import * as fs from 'fs';
import * as path from 'path';

interface LayoutItem {
  type: 'text' | 'table';
  y: number;
  content?: string;
  tableData?: OcrTableResult;
}

/**
 * 将一页 OCR 结果中的文本行和表格按 Y 坐标（阅读顺序）穿插合并
 */
function mergeByLayout(page: { boxes: OcrTextBox[]; tables?: OcrTableResult[] }): LayoutItem[] {
  const items: LayoutItem[] = [];

  // 文本行处理
  const textLines = (page.boxes || [])
    .filter(b => b.text.trim())
    .map(b => {
      const yCenter = b.box.reduce((s, p) => s + p[1], 0) / b.box.length;
      const xCenter = b.box.reduce((s, p) => s + p[0], 0) / b.box.length;
      return { y: yCenter, x: xCenter, text: b.text.trim() };
    });

  // 按 Y 排序后合并为段落
  textLines.sort((a, b) => a.y - b.y);
  const paragraphs: { y: number; lines: typeof textLines }[] = [];
  let currentPara: { y: number; lines: typeof textLines } | null = null;

  for (const line of textLines) {
    if (!currentPara || Math.abs(line.y - currentPara.y) > 14) {
      currentPara = { y: line.y, lines: [line] };
      paragraphs.push(currentPara);
    } else {
      currentPara.lines.push(line);
      currentPara.y = (currentPara.y * (currentPara.lines.length - 1) + line.y) / currentPara.lines.length;
    }
  }

  for (const p of paragraphs) {
    p.lines.sort((a, b) => a.x - b.x);
    items.push({ type: 'text', y: p.y, content: p.lines.map(l => l.text).join(' ') });
  }

  // 表格处理
  const tables = (page.tables || []).filter(t => t.rows && t.rows.length > 0);
  for (const t of tables) {
    const yCenter = t.bbox ? (t.bbox[1] + t.bbox[3]) / 2 : 0;
    items.push({ type: 'table', y: yCenter, tableData: t });
  }

  // 按 Y 坐标排序（阅读顺序）
  items.sort((a, b) => a.y - b.y);
  return items;
}

/**
 * 生成布局保留的文本输出
 */
function formatLayoutPreserved(result: OcrResult): string {
  const output: string[] = [];

  for (const page of result.pages) {
    if (result.totalPages > 1) {
      output.push(`═══════════ 第 ${page.page} 页 ═══════════`);
      output.push('');
    }

    const items = mergeByLayout(page);

    for (const item of items) {
      if (item.type === 'text') {
        output.push(item.content || '');
        output.push('');
      } else if (item.type === 'table' && item.tableData) {
        // 输出 Markdown 表格
        output.push(item.tableData.markdown || '');
        output.push('');
      }
    }
  }

  return output.join('\n').trim();
}

/**
 * 生成详细布局报告（含坐标信息）
 */
function formatLayoutDetail(result: OcrResult): string {
  const output: string[] = [];

  for (const page of result.pages) {
    if (result.totalPages > 1) {
      output.push(`═══════════ 第 ${page.page} 页 ═══════════`);
      output.push('');
    }

    const items = mergeByLayout(page);

    for (const item of items) {
      if (item.type === 'text') {
        output.push(`[文本 y=${item.y.toFixed(0)}] ${item.content}`);
        output.push('');
      } else if (item.type === 'table' && item.tableData) {
        const t = item.tableData;
        output.push(`[表格 y=${item.y.toFixed(0)} ${t.rowCount}×${t.columnCount}]`);
        output.push(t.markdown || '');
        output.push('');
      }
    }
  }

  return output.join('\n').trim();
}

// ─── 主程序 ──────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const mode = args.includes('--detail') ? 'detail' : 'normal';
  const outputPath = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;

  if (!filePath || args.includes('--help') || args.includes('-h')) {
    console.log(`
用法: npx ts-node src/layout-cli.ts [选项] <文件路径>

选项:
  -o <路径>    输出到文件（默认输出到控制台）
  --detail     显示详细坐标信息

说明:
  识别图片或 PDF 中的文本和表格，按阅读顺序穿插输出，保持原排版。

示例:
  npx ts-node src/layout-cli.ts test.jpg
  npx ts-node src/layout-cli.ts document.pdf -o result.txt
  npx ts-node src/layout-cli.ts scan.png --detail
`);
    process.exit(filePath ? 0 : 1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`错误: 文件不存在: ${filePath}`);
    process.exit(1);
  }

  console.error(`[layout-cli] 正在识别: ${filePath}`);
  console.error(`[layout-cli] 语言: ch, 模型: PP-OCRv6`);

  const ocr = new PaddleOcr({
    lang: 'ch',
    ocrVersion: 'PP-OCRv6',
  });

  try {
    const startTime = Date.now();
    const result = await ocr.recognizeFile(filePath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const totalTables = result.pages.reduce((sum, p) => sum + (p.tables?.length || 0), 0);
    console.error(`[layout-cli] ✅ 完成: ${result.totalPages} 页, ${result.fullText.length} 字符, ${totalTables} 个表格, 耗时 ${elapsed}s`);

    const output = mode === 'detail'
      ? formatLayoutDetail(result)
      : formatLayoutPreserved(result);

    if (outputPath) {
      fs.writeFileSync(outputPath, output, 'utf8');
      console.error(`[layout-cli] 已保存到: ${path.resolve(outputPath)}`);
    } else {
      console.log(output);
    }
  } catch (err: any) {
    console.error(`[layout-cli] ❌ 识别失败: ${err.message}`);
    process.exit(1);
  } finally {
    await ocr.close();
  }
}

main();
