/**
 * PaddleOCR Node.js 封装 — 类型定义
 */

/** OCR 引擎配置选项 */
export interface PaddleOcrOptions {
  /**
   * 识别语言，默认 "ch"
   * - ch: 中文简体
   * - en: 英文
   * - japan: 日文
   * - chinese_cht: 中文繁体
   * - 更多语言见 PaddleOCR 文档
   */
  lang?: string;

  /**
   * OCR 模型版本，默认 "PP-OCRv6"
   * 可选: "PP-OCRv3" | "PP-OCRv4" | "PP-OCRv5" | "PP-OCRv6"
   */
  ocrVersion?: string;

  /** PP-OCRv6 检测模型档位；不设置时使用 3.7 默认的 medium 模型 */
  textDetectionModelName?:
    | 'PP-OCRv6_tiny_det'
    | 'PP-OCRv6_small_det'
    | 'PP-OCRv6_medium_det'
    | string;

  /** PP-OCRv6 识别模型档位；不设置时使用 3.7 默认的 medium 模型 */
  textRecognitionModelName?:
    | 'PP-OCRv6_tiny_rec'
    | 'PP-OCRv6_small_rec'
    | 'PP-OCRv6_medium_rec'
    | string;

  /** PaddleOCR 3.7 推理引擎 */
  engine?: 'paddle' | 'paddle_static' | 'paddle_dynamic' | 'transformers' | 'onnxruntime';

  /** 是否启用文档方向分类 */
  useDocOrientationClassify?: boolean;

  /** 是否启用文档图像矫正 */
  useDocUnwarping?: boolean;

  /** 是否启用文本行方向分类 */
  useTextlineOrientation?: boolean;

  /**
   * 运行设备，默认 "auto" (自动选择 GPU/CPU)
   * 可选: "cpu" | "gpu" | "auto"
   */
  device?: 'cpu' | 'gpu' | 'auto' | `gpu:${number}` | `npu:${number}` | `xpu:${number}`;

  /**
   * 检测阈值（文本检测置信度），默认 0.3
   */
  textDetThresh?: number;

  /**
   * 检测框阈值，默认 0.5
   */
  textDetBoxThresh?: number;

  /**
   * 识别得分阈值，默认 0
   */
  textRecScoreThresh?: number;

  /**
   * Python 解释器路径，默认自动查找 python3/python
   */
  pythonPath?: string;

  /**
   * Python 服务脚本路径，默认使用内置脚本
   */
  serverScriptPath?: string;

  /**
   * 服务启动超时（毫秒），默认 30000
   */
  startupTimeoutMs?: number;

  /**
   * 单次 OCR 请求超时（毫秒），默认 300000 (5分钟)
   */
  requestTimeoutMs?: number;

  /**
   * 返回单词级别（细粒度）的文本框，默认 false
   */
  returnWordBox?: boolean;

  /** 文本检测输入形状，例如 [3, 1024, 1024] */
  textDetInputShape?: number[];

  /** 文本识别输入形状，例如 [3, 48, 320] */
  textRecInputShape?: number[];

  /** PDF 转图片的 DPI，默认 200 */
  pdfDpi?: number;

  /** 额外的 Python 参数 */
  extraArgs?: Record<string, unknown>;
}

/** 单个文本框结果 */
export interface OcrTextBox {
  /** 文本框四角坐标 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] */
  box: number[][];
  /** 识别的文本内容 */
  text: string;
  /** 置信度 (0~1) */
  score: number;
}

/** 单个表格识别结果 */
export interface OcrTableResult {
  /** 表格单元格内容，二维数组按行列排列 */
  rows: string[][];
  /** 行数 */
  rowCount: number;
  /** 列数 */
  columnCount: number;
  /** 表格区域边界 [x1, y1, x2, y2] */
  bbox: number[];
  /** 表格填充置信度/完整度 (0~1) */
  confidence: number;
  /** Markdown 表格，便于复制和下载 */
  markdown: string;
}

/** 单页/单图 OCR 结果 */
export interface OcrPageResult {
  /** 页码（从 1 开始，图片固定为 1） */
  page: number;
  /** 该页所有文本框 */
  boxes: OcrTextBox[];
  /** 该页识别到的表格 */
  tables?: OcrTableResult[];
  /** 该页预览图 data URL（PDF 按页预览时使用） */
  previewImage?: string;
  /** 该页完整文本（按阅读顺序拼接） */
  fullText: string;
}

/** OCR 整体结果 */
export interface OcrResult {
  /** 原文件路径 */
  source: string;
  /** 总页数 */
  totalPages: number;
  /** 每页结果 */
  pages: OcrPageResult[];
  /** 全部文本（所有页拼接） */
  fullText: string;
}

/** Python 服务启动消息 */
export interface ServerReadyMessage {
  type: 'ready';
  version: string;
  pid: number;
}

/** Python 服务错误消息 */
export interface ServerErrorMessage {
  type: 'error';
  message: string;
  traceback?: string;
}

/** Python 服务结果消息 */
export interface ServerResultMessage {
  type: 'result';
  id: number;
  success: boolean;
  data?: {
    source: string;
    totalPages: number;
    pages: {
      page: number;
      boxes: { box: number[][]; text: string; score: number }[];
      tables?: OcrTableResult[];
      previewImage?: string;
      fullText: string;
    }[];
    fullText: string;
  };
  error?: string;
}

/** Node → Python 请求消息 */
export interface ClientRequest {
  id: number;
  type: 'ocr' | 'ping' | 'exit';
  /** 文件路径（优先）或 base64 图像数据 */
  input?: string;
  /** 输入类型 */
  inputType?: 'file' | 'base64';
  /** OCR 参数覆盖 */
  options?: Record<string, unknown>;
}
