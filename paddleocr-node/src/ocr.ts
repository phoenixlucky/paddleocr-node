/**
 * PaddleOCR 引擎核心 — 管理 Python 子进程，通过 JSON-line 协议调用 OCR
 */
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { TextDecoder } from 'util';
import type {
  PaddleOcrOptions,
  OcrResult,
  ClientRequest,
  ServerResultMessage,
  ServerReadyMessage,
} from './types';

/** 解析中的消息缓冲区 */
interface PendingRequest {
  resolve: (value: OcrResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** Python 解释器查找结果 */
interface PythonInfo {
  cmd: string;
  version: string;
}

function decodeProcessLog(data: Buffer): string {
  const utf8 = data.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;

  try {
    return new TextDecoder('gb18030').decode(data);
  } catch {
    return utf8;
  }
}

const DATA_ROOT = process.env.PADDLEOCR_DATA_ROOT || (process.platform === 'win32' ? 'D:\\paddleocr_data' : path.join(require('os').homedir(), 'paddleocr_data'));
const PADDLEOCR_HOME = DATA_ROOT;
const HUGGINGFACE_HUB = path.join(DATA_ROOT, 'huggingface', 'hub');
const CONDA_META_PATH = path.join(DATA_ROOT, 'python-path.json');

export class PaddleOcr {
  private _proc: ChildProcess | null = null;
  private _pending = new Map<number, PendingRequest>();
  private _requestCounter = 0;
  private _buffer = '';
  private _options: Required<PaddleOcrOptions>;
  private _ready = false;
  private _closed = false;

  // 默认选项
  private static DEFAULTS: PaddleOcrOptions = {
    lang: 'ch',
    ocrVersion: 'PP-OCRv6',
    device: 'auto',
    textDetThresh: 0.3,
    textDetBoxThresh: 0.5,
    textRecScoreThresh: 0,
    pdfDpi: 200,
    startupTimeoutMs: 30000,
    requestTimeoutMs: 300000,
    returnWordBox: false,
  };

  constructor(options: PaddleOcrOptions = {}) {
    this._options = { ...PaddleOcr.DEFAULTS, ...options } as Required<PaddleOcrOptions>;
  }

  // --------------- 公共 API ---------------

  /**
   * 识别图片或 PDF 文件中的文字
   * @param input 文件路径或 base64 编码的图片数据
   * @param inputType 输入类型: 'file' | 'base64'
   * @param options 可选额外参数（如 enableTable）
   */
  async recognize(input: string, inputType: 'file' | 'base64' = 'file', options?: Record<string, unknown>): Promise<OcrResult> {
    await this._ensureRunning();

    const id = ++this._requestCounter;
    const request: ClientRequest = {
      id,
      type: 'ocr',
      input,
      inputType,
    };
    if (options && Object.keys(options).length > 0) {
      (request as any).options = options;
    }

    return new Promise<OcrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`OCR 请求超时 (${this._options.requestTimeoutMs}ms)`));
      }, this._options.requestTimeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      this._sendLine(request);
    });
  }

  /**
   * 识别图片或 PDF 文件 — 便捷方法
   * @param filePath 图片或 PDF 文件路径
   * @param options 可选额外参数（如 enableTable）
   */
  async recognizeFile(filePath: string, options?: Record<string, unknown>): Promise<OcrResult> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    return this.recognize(path.resolve(filePath), 'file', options);
  }

  /**
   * 识别 base64 编码的图片
   * @param base64Data base64 编码的图片数据
   */
  async recognizeBase64(base64Data: string): Promise<OcrResult> {
    return this.recognize(base64Data, 'base64');
  }

  /**
   * 关闭引擎，释放 Python 子进程
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    if (!this._proc || !this._ready) {
      this._cleanup();
      return;
    }

    // 发送退出消息
    const id = ++this._requestCounter;
    this._sendLine({ id, type: 'exit' });

    // 等待进程退出
    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this._proc?.kill('SIGKILL');
        resolve();
      }, 5000);

      if (this._proc) {
        this._proc.on('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      }

      // 同时清理 pending
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('引擎已关闭'));
      }
      this._pending.clear();
      this._cleanup();
    });
  }

  /** 引擎是否就绪 */
  get isReady(): boolean {
    return this._ready;
  }

  // --------------- 内部方法 ---------------

  private async _ensureRunning(): Promise<void> {
    if (this._closed) {
      throw new Error('引擎已关闭，请创建新实例');
    }
    if (this._ready) return;

    const pythonCmd = await this._findPython();
    fs.mkdirSync(PADDLEOCR_HOME, { recursive: true });
    fs.mkdirSync(HUGGINGFACE_HUB, { recursive: true });

    const scriptPath = this._options.serverScriptPath
      ? this._options.serverScriptPath
      : path.join(__dirname, '..', 'python', 'ocr_server.py');

    // 获取 Python 脚本的绝对路径
    const scriptAbsPath = path.resolve(scriptPath);
    if (!fs.existsSync(scriptAbsPath)) {
      throw new Error(`找不到 Python 服务脚本: ${scriptAbsPath}`);
    }

    // 将初始选项作为命令行参数传给 Python 脚本
    const initOptions = JSON.stringify(this._serializeOptions());

    return new Promise<void>((resolve, reject) => {
      const startupTimer = setTimeout(() => {
        this._cleanup();
        reject(new Error(`Python 服务启动超时 (${this._options.startupTimeoutMs}ms)`));
      }, this._options.startupTimeoutMs);

      try {
        const proc = spawn(pythonCmd.cmd, [scriptAbsPath, initOptions], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PADDLEOCR_DATA_ROOT: DATA_ROOT,
            PADDLEOCR_HOME,
            HF_HOME: path.join(DATA_ROOT, 'huggingface'),
            HUGGINGFACE_HUB_CACHE: HUGGINGFACE_HUB,
            PYTHONUNBUFFERED: '1',
            // 强制 Python 使用 UTF-8 输出，防止含中文/特殊字符时 GBK 编码崩溃
            PYTHONIOENCODING: 'utf-8',
            // 抑制 PaddlePaddle oneDNN 调试日志污染 stdout
            GLOG_minloglevel: '2',
          },
        });

        this._proc = proc;

        // 处理 stdout — 接收 JSON 行
        proc.stdout!.on('data', (data: Buffer) => {
          this._buffer += data.toString('utf8');
          this._processBuffer();
        });

        // 处理 stderr — 仅打日志
        proc.stderr!.on('data', (data: Buffer) => {
          const text = decodeProcessLog(data).trim();
          if (text) {
            console.error(`[paddleocr:stderr] ${text}`);
          }
        });

        // 监听退出
        proc.on('exit', (code, signal) => {
          this._ready = false;
          const errMsg = `Python 进程已退出 (code=${code}, signal=${signal})`;

          for (const [, pending] of this._pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(errMsg));
          }
          this._pending.clear();

          if (!this._closed) {
            console.error(`[paddleocr] ${errMsg}`);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(startupTimer);
          this._cleanup();
          reject(new Error(`启动 Python 进程失败: ${err.message}`));
        });

        // 等待 ready 消息
        const readyCheck = () => {
          // _processBuffer 会在收到 ready 时设置 this._ready = true
          if (this._ready) {
            clearTimeout(startupTimer);
            resolve();
          } else if (!this._proc) {
            clearTimeout(startupTimer);
            reject(new Error('进程已终止'));
          } else {
            setTimeout(readyCheck, 100);
          }
        };
        readyCheck();
      } catch (err) {
        clearTimeout(startupTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 处理接收到的缓冲区数据，提取完整的 JSON 行
   */
  private _processBuffer(): void {
    while (this._buffer.includes('\n')) {
      const nlIndex = this._buffer.indexOf('\n');
      const line = this._buffer.slice(0, nlIndex).trim();
      this._buffer = this._buffer.slice(nlIndex + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line);

        // 处理 ready 消息
        if (msg.type === 'ready') {
          const readyMsg = msg as ServerReadyMessage;
          console.error(`[paddleocr] 服务就绪 (PID: ${readyMsg.pid}, 版本: ${readyMsg.version})`);
          this._ready = true;
          continue;
        }

        // 处理 result 消息
        if (msg.type === 'result') {
          const result = msg as ServerResultMessage;
          const pending = this._pending.get(result.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(result.id);

            if (result.success && result.data) {
              pending.resolve(result.data as OcrResult);
            } else {
              pending.reject(new Error(result.error || 'OCR 识别失败'));
            }
          }
          continue;
        }

        // 处理错误消息
        if (msg.type === 'error') {
          console.error(`[paddleocr] 服务错误: ${msg.message}`);
          if (msg.traceback) {
            console.error(msg.traceback);
          }
          continue;
        }
      } catch (err) {
        // 不以 { 开头的行是 PaddlePaddle 调试日志（如 OneDNN），静默跳过
        if (line.trimStart().startsWith('{')) {
          console.error(`[paddleocr] JSON 解析失败: ${line.slice(0, 200)}`);
        }
      }
    }
  }

  /**
   * 发送一行 JSON 到 Python 进程的 stdin
   */
  private _sendLine(msg: ClientRequest): void {
    if (!this._proc || !this._proc.stdin) {
      throw new Error('Python 进程未就绪');
    }
    const line = JSON.stringify(msg) + '\n';
    this._proc.stdin.write(line, 'utf8');
  }

  /**
   * 查找可用的 Python 解释器
   * 优先级: 1) 用户显式指定 pythonPath  2) Conda 环境元数据  3) PATH 扫描
   */
  private async _findPython(): Promise<PythonInfo> {
    if (this._options.pythonPath) {
      return { cmd: this._options.pythonPath, version: 'custom' };
    }

    // (A) 优先使用 D:\paddleocr_data 下的 Conda 环境
    const dataRootPython = process.platform === 'win32'
      ? path.join(DATA_ROOT, 'conda-env', 'python.exe')
      : path.join(DATA_ROOT, 'conda-env', 'bin', 'python');
    if (fs.existsSync(dataRootPython)) {
      return { cmd: dataRootPython, version: 'data-root' };
    }

    // (B) 尝试从 Conda 环境元数据读取
    const condaPy = this._findCondaPython();
    if (condaPy) return condaPy;

    // (C) 扫描 PATH
    const candidates = process.platform === 'win32'
      ? ['python', 'python3', 'py']
      : ['python3', 'python'];

    for (const cmd of candidates) {
      try {
        const { execSync } = await import('child_process');
        const output = execSync(`${cmd} --version`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        });
        const version = output.trim();
        const match = version.match(/Python (\d+\.\d+)/);
        if (match && parseFloat(match[1]) >= 3.8) {
          return { cmd, version };
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      '未找到 Python 3.8+ 解释器。请安装 Python / Conda 并确保在 PATH 中。'
    );
  }

  /**
   * 读取 D:\paddleocr_data\python-path.json，验证并返回 Conda 环境的 Python 路径
   */
  private _findCondaPython(): PythonInfo | null {
    try {
      const { execSync } = require('child_process');
      if (!require('fs').existsSync(CONDA_META_PATH)) return null;

      const meta = JSON.parse(require('fs').readFileSync(CONDA_META_PATH, 'utf8'));
      const pyPath = meta.python;

      if (!pyPath || !require('fs').existsSync(pyPath)) {
        console.error(`[paddleocr] Conda 元数据中的 Python 路径无效: ${pyPath}`);
        return null;
      }

      // 验证可执行
      const out = execSync(`"${pyPath}" --version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const version = out.trim();
      console.error(`[paddleocr] 使用 Conda 环境 Python: ${pyPath} (${version})`);
      return { cmd: pyPath, version };
    } catch {
      return null;
    }
  }

  /**
   * 序列化选项，去掉 Node.js 特有的字段
   */
  private _serializeOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    const keys: (keyof PaddleOcrOptions)[] = [
      'lang', 'ocrVersion', 'device', 'textDetThresh', 'textDetBoxThresh',
      'textRecScoreThresh', 'returnWordBox', 'textDetInputShape',
      'textRecInputShape', 'pdfDpi', 'extraArgs', 'textDetectionModelName',
      'textRecognitionModelName', 'engine', 'useDocOrientationClassify',
      'useDocUnwarping', 'useTextlineOrientation',
    ];
    for (const key of keys) {
      const val = this._options[key];
      if (val !== undefined) {
        opts[key] = val;
      }
    }
    return opts;
  }

  /**
   * 清理内部状态
   */
  private _cleanup(): void {
    this._ready = false;
    if (this._proc) {
      try {
        this._proc.kill();
      } catch {
        // 忽略
      }
      this._proc = null;
    }
  }
}
