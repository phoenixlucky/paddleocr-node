/**
 * PaddleOCR Web 服务 — 一键启动 OCR 识别界面
 *
 * 启动: npm run web
 * 访问: http://localhost:3100
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import type { Server } from 'http';
import { PaddleOcr } from '../ocr';
import type { PaddleOcrOptions } from '../types';

// ─── 配置 ──────────────────────────────────────────────

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3100;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_ROOT = process.env.PADDLEOCR_DATA_ROOT || (process.platform === 'win32' ? 'D:\\paddleocr_data' : path.join(require('os').homedir(), 'paddleocr_data'));

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/webp',
  'application/pdf',
];

function decodeUploadFileName(fileName: string): string {
  if (!/[\u0080-\u00ff]/.test(fileName)) return fileName;
  const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? fileName : decoded;
}

// ─── 存储 ──────────────────────────────────────────────

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
fs.mkdirSync(DATA_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(decodeUploadFileName(file.originalname)) || '.bin';
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype) ||
        /\.(jpg|jpeg|png|bmp|tiff?|webp|pdf)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件类型: ${file.mimetype}`));
    }
  },
});

// ─── Express 应用 ─────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 静态文件 — 前端页面
const webDir = path.resolve(__dirname, '..', '..', 'web');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
}

// ─── OCR 引擎（延迟初始化） ────────────────────────────

let ocrEngine: PaddleOcr | null = null;
let ocrEngineKey = '';
let engineBusy = false;
let httpServer: Server | null = null;

async function getEngine(options?: PaddleOcrOptions): Promise<PaddleOcr> {
  const opts: PaddleOcrOptions = {
    lang: options?.lang || 'ch',
    ocrVersion: options?.ocrVersion || 'PP-OCRv6',
    device: options?.device || 'auto',
    textDetThresh: options?.textDetThresh ?? 0.3,
    textDetBoxThresh: options?.textDetBoxThresh ?? 0.5,
    startupTimeoutMs: options?.ocrVersion === 'Unlimited-OCR' ? 120000 : 60000,
    requestTimeoutMs: options?.ocrVersion === 'Unlimited-OCR' ? 1800000 : 600000,
  };
  const nextKey = `${opts.lang}:${opts.ocrVersion}:${opts.device}`;
  if (!ocrEngine || ocrEngineKey !== nextKey) {
    if (ocrEngine) await ocrEngine.close();
    ocrEngine = new PaddleOcr(opts);
    ocrEngineKey = nextKey;
  }
  return ocrEngine;
}

const MODELS = [
  { id: 'PP-OCRv6', name: 'PP-OCRv6', provider: 'PaddleOCR', default: true },
  { id: 'PP-OCRv5', name: 'PP-OCRv5', provider: 'PaddleOCR' },
  { id: 'PP-OCRv4', name: 'PP-OCRv4', provider: 'PaddleOCR' },
  { id: 'Unlimited-OCR', name: 'Unlimited-OCR', provider: 'HuggingFace', repo: 'baidu/Unlimited-OCR', size: '6.78GB' },
];

const MODEL_PATHS = {
  root: DATA_ROOT,
  paddleOcrHome: DATA_ROOT,
  huggingFaceHub: path.join(DATA_ROOT, 'huggingface', 'hub'),
};
fs.mkdirSync(MODEL_PATHS.huggingFaceHub, { recursive: true });

function dataRootPythonPath(): string {
  return process.platform === 'win32'
    ? path.join(DATA_ROOT, 'conda-env', 'python.exe')
    : path.join(DATA_ROOT, 'conda-env', 'bin', 'python');
}

function modelPath(id: string): string {
  if (id === 'Unlimited-OCR') {
    return path.join(MODEL_PATHS.huggingFaceHub, 'models--baidu--Unlimited-OCR');
  }
  return MODEL_PATHS.paddleOcrHome;
}

function isUnlimitedCached(): boolean {
  const dir = path.join(modelPath('Unlimited-OCR'), 'snapshots');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) =>
    fs.existsSync(path.join(dir, name, 'model-00001-of-000001.safetensors')));
}

function modelStatus(id: string) {
  if (id === 'Unlimited-OCR') return isUnlimitedCached() ? 'downloaded' : 'not_downloaded';
  return 'on_demand';
}

function findPython(): string {
  const dataRootPython = dataRootPythonPath();
  if (fs.existsSync(dataRootPython)) return dataRootPython;

  const metaPath = path.join(DATA_ROOT, 'python-path.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.python && fs.existsSync(meta.python)) return meta.python;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runPython(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(findPython(), args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PADDLEOCR_DATA_ROOT: DATA_ROOT,
        PADDLEOCR_HOME: MODEL_PATHS.paddleOcrHome,
        HF_HOME: path.join(DATA_ROOT, 'huggingface'),
        HUGGINGFACE_HUB_CACHE: MODEL_PATHS.huggingFaceHub,
      },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve((stdout || '').trim());
    });
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── API 路由 ─────────────────────────────────────────

/** 上传并识别文件 */
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请上传文件' });
      return;
    }

    if (engineBusy) {
      res.status(429).json({ error: '引擎忙，请稍后重试' });
      return;
    }

    const filePath = req.file.path;
    const fileName = decodeUploadFileName(req.file.originalname);
    const fileSize = formatFileSize(req.file.size);

    // 从查询参数读取 OCR 选项
    const lang = (req.query.lang as string) || 'ch';
    const ocrVersion = (req.query.ocrVersion as string) || 'PP-OCRv6';
    const enableTable = req.query.enableTable !== '0'; // 默认 true

    console.log(`\n[OCR] 收到文件: ${fileName} (${fileSize})`);
    console.log(`[OCR] 语言: ${lang}, 模型: ${ocrVersion}`);
    console.time(`[OCR] 总耗时`);

    engineBusy = true;
    const engine = await getEngine({ lang, ocrVersion });
    const result = await engine.recognizeFile(filePath, { enableTable });

    console.timeEnd(`[OCR] 总耗时`);
    const totalTables = result.pages.reduce((sum, page) => sum + (page.tables?.length || 0), 0);
    console.log(`[OCR] 完成: ${result.totalPages} 页, ${result.fullText.length} 字符, ${totalTables} 个表格`);

    // 提取每页的文本行（阅读顺序）
    const pagesWithLines = result.pages.map((page) => {
      const lines = page.boxes
        .filter((b) => b.text.trim())
        .sort((a, b) => {
          const ay = a.box.reduce((s, p) => s + p[1], 0) / a.box.length;
          const by = b.box.reduce((s, p) => s + p[1], 0) / b.box.length;
          if (Math.abs(ay - by) < 10) {
            const ax = a.box.reduce((s, p) => s + p[0], 0) / a.box.length;
            const bx = b.box.reduce((s, p) => s + p[0], 0) / b.box.length;
            return ax - bx;
          }
          return ay - by;
        })
        .map((b) => ({ text: b.text, score: b.score, box: b.box }));

      return { ...page, lines };
    });

    res.json({
      success: true,
      fileName,
      fileSize,
      source: result.source,
      totalPages: result.totalPages,
      totalTables,
      fullText: result.fullText,
      pages: pagesWithLines,
    });
  } catch (err: any) {
    console.error('[OCR] 错误:', err);
    res.status(500).json({ error: err.message || 'OCR 识别失败' });
  } finally {
    engineBusy = false;
    // 清理上传文件（保留最近几个）
    cleanupOldFiles();
  }
});

/** 可选模型列表 */
app.get('/api/models', (_req, res) => {
  res.json({
    paths: {
      ...MODEL_PATHS,
      python: dataRootPythonPath(),
      activePython: findPython(),
    },
    models: MODELS.map((model) => ({
      ...model,
      status: modelStatus(model.id),
      path: modelPath(model.id),
    })),
  });
});

/** 按需下载/缓存单个模型 */
app.post('/api/models/:id/download', async (req, res) => {
  const model = MODELS.find((m) => m.id === req.params.id);
  if (!model) {
    res.status(404).json({ error: '未知模型' });
    return;
  }
  if (engineBusy) {
    res.status(429).json({ error: '引擎忙，请稍后再下载模型' });
    return;
  }

  engineBusy = true;
  try {
    if (model.id === 'Unlimited-OCR') {
      await runPython([
        '-c',
        'from huggingface_hub import snapshot_download; snapshot_download("baidu/Unlimited-OCR")',
      ], 60 * 60 * 1000);
    } else {
      await runPython([
        '-c',
        `from paddleocr import PaddleOCR; PaddleOCR(lang="ch", ocr_version="${model.id}")`,
      ], 20 * 60 * 1000);
    }
    res.json({ success: true, model: model.id, status: modelStatus(model.id) });
  } catch (err: any) {
    const hint = model.id === 'Unlimited-OCR'
      ? '请先安装可选依赖: pip install torch torchvision transformers einops addict easydict psutil huggingface_hub'
      : '请检查 PaddleOCR/PaddlePaddle 是否已安装。';
    res.status(500).json({ error: `${err.message}\n${hint}` });
  } finally {
    engineBusy = false;
  }
});

/** 服务器和引擎状态 */
app.get('/api/status', async (_req, res) => {
  res.json({
    status: 'ok',
    engineReady: ocrEngine?.isReady ?? false,
    engineBusy,
    uptime: process.uptime(),
  });
});

/** 关闭引擎 */
app.post('/api/shutdown', async (_req, res) => {
  if (ocrEngine) {
    await ocrEngine.close();
    ocrEngine = null;
    ocrEngineKey = '';
  }
  res.json({ success: true, message: '引擎已关闭' });
});

// ─── 文件清理 ─────────────────────────────────────────

function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
      .map((f) => ({
        name: f,
        time: fs.statSync(path.join(UPLOAD_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);

    // 保留最近 20 个文件
    if (files.length > 20) {
      for (const f of files.slice(20)) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f.name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ─── 错误处理 ─────────────────────────────────────────

app.use((err: any, _req: any, res: any, _next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `文件过大，最大 100MB` });
      return;
    }
    res.status(400).json({ error: `上传错误: ${err.message}` });
    return;
  }
  console.error('[Server]', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ─── 启动 ─────────────────────────────────────────────

async function start() {
  console.log('\n[启动] PaddleOCR Web 服务');
  console.log('[启动] 模型按需加载，不会在启动时下载全部模型');

  httpServer = app.listen(PORT, HOST, () => {
    const url = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  🌐 PaddleOCR Web 界面`);
    console.log(`  ${url}`);
    console.log(`${'='.repeat(50)}\n`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[启动] 端口 ${PORT} 已被占用，请关闭占用进程或设置 PORT 环境变量`);
    } else {
      console.error('[启动] Web 服务监听失败:', err);
    }
    process.exit(1);
  });

  httpServer.on('close', () => {
    console.log('[关闭] Web 服务监听已关闭');
  });
}

// ─── 优雅退出 ─────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[关闭] 正在关闭 OCR 引擎...');
  httpServer?.close();
  if (ocrEngine) {
    await ocrEngine.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  httpServer?.close();
  if (ocrEngine) {
    await ocrEngine.close();
  }
  process.exit(0);
});

start();
