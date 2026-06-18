/**
 * paddleocr-node 快速测试 / 使用示例
 *
 * 运行: npx ts-node src/test.ts  或  node dist/test.js
 */

import { PaddleOcr, recognize } from './index';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('用法: npx ts-node src/test.ts <图片或PDF路径>');
    console.log('');
    console.log('示例 — 使用 PaddleOcr 类（推荐）:');
    console.log('');
    console.log('  import { PaddleOcr } from "paddleocr-node";');
    console.log('');
    console.log('  const ocr = new PaddleOcr({ lang: "ch" });');
    console.log('  const result = await ocr.recognizeFile("scan.pdf");');
    console.log('  console.log(result.fullText);');
    console.log('  await ocr.close();');
    console.log('');
    console.log('示例 — 便捷函数:');
    console.log('');
    console.log('  import { recognize } from "paddleocr-node";');
    console.log('  const result = await recognize("photo.jpg", { lang: "en" });');
    console.log('  console.log(result.fullText);');
    process.exit(0);
  }

  // ===== 使用便捷函数 =====
  console.log(`\n📄 正在识别: ${filePath}`);
  console.time('OCR 耗时');

  try {
    const result = await recognize(filePath, {
      lang: 'ch',
      ocrVersion: 'PP-OCRv6',
    });

    console.timeEnd('OCR 耗时');
    console.log(`\n✅ 识别完成`);
    console.log(`   源文件: ${result.source}`);
    console.log(`   总页数: ${result.totalPages}`);
    console.log(`   表格数量: ${result.pages.reduce((sum, page) => sum + (page.tables?.length || 0), 0)}`);
    console.log(`   总文本长度: ${result.fullText.length} 字符`);
    console.log(`\n📝 识别文本:\n${'='.repeat(50)}`);
    console.log(result.fullText);
    console.log('='.repeat(50));

    const firstTable = result.pages.flatMap((page) => page.tables || [])[0];
    if (firstTable) {
      console.log(`\n▦ 表格识别 (第 1 个):`);
      console.log(firstTable.markdown);
    }

    // 打印详细文本框信息（前 10 个）
    if (result.pages.length > 0 && result.pages[0].boxes.length > 0) {
      console.log(`\n📦 文本框详情 (前 10 个):`);
      for (const box of result.pages[0].boxes.slice(0, 10)) {
        const topLeft = box.box[0];
        console.log(`   [(${topLeft[0]}, ${topLeft[1]})] score=${box.score.toFixed(3)}: "${box.text}"`);
      }
    }
  } catch (err) {
    console.error('❌ 识别失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
