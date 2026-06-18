# paddleocr-node

> Node.js 封装 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — 通过 Python 子进程调用百度飞桨 OCR 引擎，支持识别**图片**和 **PDF** 中的文字。

[![npm version](https://img.shields.io/npm/v/paddleocr-node.svg)](https://www.npmjs.com/package/paddleocr-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🚀 一键启动

本项目提供 `start.bat`（Windows）一键启动脚本，**无需手动安装依赖和编译**，双击即可运行 Web 服务：

```bash
# 只需双击 start.bat，它将自动：
# 1. 检查 Node.js、npm、Python 环境
# 2. 安装 npm 依赖（npm install）
# 3. 编译 TypeScript（npm run build）
# 4. 启动 Web 服务 → http://localhost:3100
```

> **用法：** 在项目根目录双击 `start.bat`，打开浏览器访问 `http://localhost:3100` 即可上传图片/PDF 进行识别。

---

## 特性

- ✅ **图片文字识别** — JPG / PNG / BMP / TIFF 等常见格式
- ✅ **PDF 文字/表格解析** — 使用 pdfplumber 直接解析机器生成 PDF，扫描件自动回退 OCR
- ✅ **多语言支持** — 中文简体/繁体、英文、日文、韩文等 80+ 语言
- ✅ **PaddleOCR 3.7** — 默认 PP-OCRv6 medium，支持 tiny / small / medium 三档模型
- ✅ **GPU/CPU 自动检测** — 有 GPU 自动用 GPU
- ✅ **TypeScript 类型** — 完整的类型定义
- ✅ **纯文本/逐框结果** — 获取全文或每个文本框的坐标+内容+置信度
- ✅ **表格格式重建** — 图片和 PDF 中的表格按行列返回，并提供 Markdown 表格

## 前置条件

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| [Python](https://www.python.org/downloads/) | ≥ 3.8 | 运行 PaddleOCR 所需 |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 3.7.x | npm postinstall 自动安装或升级 |
| [pdfplumber](https://github.com/jsvine/pdfplumber) | ≥ 0.11 | PDF 文本和表格解析，自动安装 |
| [PyMuPDF](https://pypi.org/project/PyMuPDF/) | ≥ 1.23 | 扫描 PDF 回退 OCR 时用于 PDF 转图片 |

> **Windows 用户注意：** 需要安装 Microsoft Visual C++ Redistributable。推荐使用 Python 3.10+。

## 安装

```bash
npm install paddleocr-node
```

安装时会自动检测 Python 环境并安装 PaddleOCR 依赖（约 2-5 分钟）。

如果自动安装失败，请手动安装 Python 依赖：

```bash
pip install "paddleocr>=3.7,<3.8" pdfplumber PyMuPDF Pillow
```

## 快速开始

### 方式一：便捷函数（一次性调用）

```ts
import { recognize } from 'paddleocr-node';

// 识别图片
const result = await recognize('invoice.jpg', { lang: 'ch' });
console.log(result.fullText);

// 识别 PDF
const pdfResult = await recognize('document.pdf', { lang: 'en' });
console.log(pdfResult.fullText);
```

### 方式二：引擎类（复用连接，推荐）

```ts
import { PaddleOcr } from 'paddleocr-node';

const ocr = new PaddleOcr({
  lang: 'ch',
  ocrVersion: 'PP-OCRv6',
});

try {
  // 多次调用复用同一个 Python 进程
  const result1 = await ocr.recognizeFile('scan1.pdf');
  const result2 = await ocr.recognizeFile('scan2.jpg');

  console.log(result1.fullText);
  console.log(result2.fullText);
} finally {
  await ocr.close(); // 关闭 Python 进程
}
```

### 方式三：识别 base64 图片

```ts
import { PaddleOcr } from 'paddleocr-node';

const ocr = new PaddleOcr({ lang: 'en' });
const base64Data = 'iVBORw0KGgo...'; // 不含 data:image/... 前缀
const result = await ocr.recognizeBase64(base64Data);
console.log(result.fullText);
await ocr.close();
```

## API 文档

### `PaddleOcr` 类

```ts
class PaddleOcr {
  constructor(options?: PaddleOcrOptions);

  // 识别文件（图片或 PDF）
  recognizeFile(filePath: string): Promise<OcrResult>;

  // 识别 base64 编码的图片
  recognizeBase64(base64Data: string): Promise<OcrResult>;

  // 指定输入类型
  recognize(input: string, inputType?: 'file' | 'base64'): Promise<OcrResult>;

  // 关闭引擎
  close(): Promise<void>;

  // 引擎是否就绪
  get isReady(): boolean;
}
```

### `recognize()` 便捷函数

```ts
function recognize(filePath: string, options?: PaddleOcrOptions): Promise<OcrResult>;
function recognizeBase64(base64Data: string, options?: PaddleOcrOptions): Promise<OcrResult>;
```

### 配置选项 `PaddleOcrOptions`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `lang` | `string` | `'ch'` | 识别语言：`ch`, `en`, `japan`, `chinese_cht` 等 |
| `ocrVersion` | `string` | `'PP-OCRv6'` | 模型版本：`PP-OCRv3` ~ `PP-OCRv6` |
| `textDetectionModelName` | `string` | `PP-OCRv6_medium_det` | v6 检测模型：tiny / small / medium |
| `textRecognitionModelName` | `string` | `PP-OCRv6_medium_rec` | v6 识别模型：tiny / small / medium |
| `engine` | `string` | Paddle 默认值 | `paddle_static` / `paddle_dynamic` / `transformers` / `onnxruntime` |
| `useDocOrientationClassify` | `boolean` | Paddle 默认值 | 文档方向分类 |
| `useDocUnwarping` | `boolean` | Paddle 默认值 | 文档图像矫正 |
| `useTextlineOrientation` | `boolean` | Paddle 默认值 | 文本行方向分类 |
| `device` | `'cpu'\|'gpu'\|'auto'` | `'auto'` | 运行设备 |
| `textDetThresh` | `number` | `0.3` | 文本检测置信度阈值 |
| `textDetBoxThresh` | `number` | `0.5` | 检测框阈值 |
| `textRecScoreThresh` | `number` | `0` | 识别得分阈值 |
| `returnWordBox` | `boolean` | `false` | 返回单词级文本框 |
| `pdfDpi` | `number` | `200` | 扫描 PDF 回退 OCR 时的转图片 DPI（越高越清晰但越慢） |
| `pythonPath` | `string` | 自动查找 | 指定 Python 解释器路径 |
| `startupTimeoutMs` | `number` | `30000` | 服务启动超时 |
| `requestTimeoutMs` | `number` | `300000` | 单次 OCR 请求超时 |

### 返回结果 `OcrResult`

```ts
interface OcrResult {
  source: string;         // 源文件路径
  totalPages: number;     // 总页数
  pages: OcrPageResult[]; // 每页结果
  fullText: string;       // 全部文本（所有页拼接）
}

interface OcrPageResult {
  page: number;           // 页码（从 1 开始）
  boxes: OcrTextBox[];    // 该页所有文本框
  tables?: OcrTableResult[]; // 该页识别到的表格
  fullText: string;       // 该页完整文本
}

interface OcrTextBox {
  box: number[][];        // 四角坐标 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
  text: string;           // 识别文本
  score: number;          // 置信度 (0~1)
}

interface OcrTableResult {
  rows: string[][];       // 表格单元格，按行列排列
  rowCount: number;       // 行数
  columnCount: number;    // 列数
  bbox: number[];         // 表格区域 [x1, y1, x2, y2]
  confidence: number;     // 表格填充完整度 (0~1)
  markdown: string;       // Markdown 表格，便于复制和下载
}
```

### 工具函数

```ts
import { extractLines, extractTable, formatResultSummary } from 'paddleocr-node';

// 提取去重后的文本行（按阅读顺序排序）
const lines = extractLines(result);

// 近似提取表格结构
const rows = extractTable(result.pages[0].boxes);

// 格式化结果摘要
console.log(formatResultSummary(result));
```

## 完整示例

### 批量识别 PDF 并导出文本

```ts
import { PaddleOcr } from 'paddleocr-node';
import { writeFileSync } from 'fs';

async function batchOcr(filePaths: string[]) {
  const ocr = new PaddleOcr({ lang: 'ch', pdfDpi: 300 });

  for (const file of filePaths) {
    console.log(`正在识别: ${file}`);
    const result = await ocr.recognizeFile(file);
    const txtPath = file.replace(/\.(pdf|jpg|png)$/i, '.txt');
    writeFileSync(txtPath, result.fullText, 'utf8');
    console.log(`已保存: ${txtPath}`);
  }

  await ocr.close();
}
```

### 错误处理

```ts
import { PaddleOcr } from 'paddleocr-node';

const ocr = new PaddleOcr({ lang: 'en' });

try {
  const result = await ocr.recognizeFile('unknown.pdf');
} catch (err) {
  if (err.message.includes('Python 进程已退出')) {
    console.error('Python 服务崩溃，请检查 PaddleOCR 安装');
  } else if (err.message.includes('请求超时')) {
    console.error('识别超时，可增大 requestTimeoutMs');
  } else {
    console.error('OCR 失败:', err.message);
  }
} finally {
  await ocr.close();
}
```

## 架构说明

```
┌─────────────────────────────────┐
│         Node.js 进程             │
│  ┌───────────────────────────┐  │
│  │     PaddleOcr 类          │  │
│  │  - 管理 Python 子进程     │  │
│  │  - JSON-line 协议通信     │  │
│  └────────┬──────────────────┘  │
│           │ stdin/stdout         │
│           │ JSON-line 协议       │
└───────────┼─────────────────────┘
            │
┌───────────┼─────────────────────┐
│  ┌────────┴──────────────────┐  │
│  │   Python 子进程            │  │
│  │  ocr_server.py             │  │
│  │  ┌──────────────────────┐  │  │
│  │  │  PaddleOCR (PP-OCRv6)│  │  │
│  │  ├──────────────────────┤  │  │
│  │  │  pdfplumber (PDF表格) │  │  │
│  │  │  PyMuPDF (扫描PDF回退)│  │  │
│  │  └──────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## 常见问题

**Q: 首次识别很慢？**
首次运行会下载 OCR 模型（约 100-200MB），后续将缓存到 `~/.paddleocr/`。

**Q: 如何指定 GPU？**
设置 `device: 'gpu'`，需要安装 PaddlePaddle GPU 版本。详见 [PaddleOCR 文档](https://github.com/PaddlePaddle/PaddleOCR)。

**Q: 支持哪些语言？**
支持 80+ 语言，包括：`ch`, `en`, `japan`, `korean`, `chinese_cht`, `ta`, `te`, `ka`, `latin`, `arabic`, `cyrillic`, `devanagari` 等。

**Q: PDF 识别慢怎么办？**
机器生成 PDF 会优先使用 pdfplumber 直接解析，通常较快。扫描 PDF 会回退 OCR，可降低 `pdfDpi`（如 150）或使用 `ocrVersion: 'PP-OCRv4'`（更快但精度略低）。

## 许可证

MIT
