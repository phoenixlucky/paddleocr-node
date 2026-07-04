#!/usr/bin/env node
/**
 * 安装后脚本：自动检测 Python / Conda 环境，安装 PaddleOCR 及其依赖
 *
 * 优先级：
 *   1. Conda/Mamba 自动创建隔离环境 → D:\paddleocr_data\conda-env\
 *   2. 系统 PATH 中的 Python 3.8+
 *   3. 兜底输出手动安装指引
 *
 * Conda 环境的信息会写入 D:\paddleocr_data\python-path.json，
 * 运行时会被 src/ocr.ts 优先读取。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── 路径常量 ────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const PADDLEOCR_HOME = process.env.PADDLEOCR_DATA_ROOT || (IS_WIN ? 'D:\\paddleocr_data' : path.join(require('os').homedir(), 'paddleocr_data'));
const CONDA_ENV_DIR = path.join(PADDLEOCR_HOME, 'conda-env');
const META_PATH = path.join(PADDLEOCR_HOME, 'python-path.json');
process.env.PADDLEOCR_DATA_ROOT = PADDLEOCR_HOME;
process.env.PADDLEOCR_HOME = PADDLEOCR_HOME;
process.env.HF_HOME = path.join(PADDLEOCR_HOME, 'huggingface');
process.env.HUGGINGFACE_HUB_CACHE = path.join(PADDLEOCR_HOME, 'huggingface', 'hub');

// ─── 颜色 ────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

function log(m)  { console.log(`${colors.cyan}[paddleocr-node]${colors.reset} ${m}`); }
function warn(m) { console.log(`${colors.yellow}[paddleocr-node] ⚠ ${m}${colors.reset}`); }
function error(m){ console.log(`${colors.red}[paddleocr-node] ✗ ${m}${colors.reset}`); }
function success(m){ console.log(`${colors.green}[paddleocr-node] ✔ ${m}${colors.reset}`); }

function getPaddleOcrVersion(pythonCmd) {
  try {
    return execSync(
      `"${pythonCmd}" -c "import paddleocr; print(paddleocr.__version__)"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }
    ).trim();
  } catch {
    return null;
  }
}

function isSupportedPaddleOcrVersion(version) {
  const match = version && version.match(/^(\d+)\.(\d+)/);
  return Boolean(match && Number(match[1]) === 3 && Number(match[2]) === 7);
}

// ─── 查找系统 Python ─────────────────────────────────
function findSystemPython() {
  const candidates = IS_WIN ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      });
      const m = out.match(/Python (\d+\.\d+)/);
      if (m && parseFloat(m[1]) >= 3.8) return { cmd, version: out.trim() };
    } catch { /* next */ }
  }
  return null;
}

// ─── 查找 Conda ──────────────────────────────────────
function findConda() {
  const candidates = ['conda', 'mamba', 'micromamba'];
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
      });
      return { cmd, version: out.trim() };
    } catch { /* next */ }
  }
  return null;
}

// ─── Conda 环境管理 ──────────────────────────────────
/**
 * Conda 环境下 Python 可执行文件路径
 */
function condaPythonPath() {
  return IS_WIN
    ? path.join(CONDA_ENV_DIR, 'python.exe')
    : path.join(CONDA_ENV_DIR, 'bin', 'python');
}

function condaEnvExists() {
  const pyPath = condaPythonPath();
  return fs.existsSync(pyPath);
}

function createCondaEnv(condaCmd) {
  log('正在通过 Conda 创建 Python 隔离环境...');
  log(`  环境路径: ${CONDA_ENV_DIR}`);
  log(`  这可能需要 2-5 分钟，请耐心等待...`);

  // 1. 创建环境
  try {
    execSync(
      `${condaCmd} create -p "${CONDA_ENV_DIR}" -c conda-forge --override-channels python=3.10 -y -q`,
      { stdio: 'inherit', timeout: 600000 }
    );
  } catch (e) {
    throw new Error(`Conda 环境创建失败: ${e.message}`);
  }

  const pyPath = condaPythonPath();
  if (!fs.existsSync(pyPath)) {
    throw new Error(`环境创建后未找到 Python: ${pyPath}`);
  }
  success('Conda 环境创建完成');
  return pyPath;
}

function installDepsViaConda(pyPath, condaCmd) {
  const reqPath = path.join(__dirname, '..', 'python', 'requirements.txt');
  if (!fs.existsSync(reqPath)) {
    warn('找不到 requirements.txt，跳过依赖安装');
    return;
  }

  log('正在安装 PaddleOCR 及依赖到 Conda 环境...');
  try {
    execSync(
      `"${pyPath}" -m pip install --no-cache-dir -r "${reqPath}"`,
      { stdio: 'inherit', timeout: 600000 }
    );
    success('PaddleOCR 依赖安装完成');
  } catch (e) {
    throw new Error(`PaddleOCR 安装失败: ${e.message}`);
  }

  // 验证关键包（带重试和详细错误）
  // paddle: 包名是 paddlepaddle，但 import 名是 paddle
  const verifiers = [
    { pkg: 'paddle', importName: 'paddle', pipName: 'paddlepaddle' },
    { pkg: 'paddleocr', importName: 'paddleocr', pipName: 'paddleocr' },
    { pkg: 'pdfplumber', importName: 'pdfplumber', pipName: 'pdfplumber' },
    { pkg: 'fitz', importName: 'fitz', pipName: 'PyMuPDF' },
  ];

  for (const { pkg, importName, pipName } of verifiers) {
    let verified = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = execSync(`"${pyPath}" -c "import ${importName}; print(getattr(${importName}, '__version__', 'ok'))"`, {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
        });
        log(`${pkg} ${out.trim()} ✓`);
        verified = true;
        break;
      } catch (e) {
        const stderr = (e.stderr || '').toString().trim().slice(0, 200);
        if (attempt === 1) {
          // 等 2 秒后重试（可能是文件系统延迟 / 缓存刷新）
          const sleepUntil = Date.now() + 2000;
          while (Date.now() < sleepUntil) { /* busy-wait */ }
        } else {
          warn(`${pkg} 验证未通过: ${stderr || e.message}`);

          // paddle 缺失时尝试 conda install 作为 fallback
          if (pkg === 'paddle' && condaCmd) {
            warn(`尝试通过 ${condaCmd} 安装 paddlepaddle...`);
            try {
              execSync(
                `${condaCmd} install -p "${CONDA_ENV_DIR}" -c conda-forge --override-channels paddlepaddle -y`,
                { stdio: 'inherit', timeout: 600000 }
              );
              // 再次验证
              execSync(`"${pyPath}" -c "import paddle; print(paddle.__version__)"`, {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
              });
              success('paddlepaddle 通过 conda 安装成功 ✓');
            } catch (e2) {
              warn(`conda 安装 paddlepaddle 也失败: ${e2.message}`);
              warn(`请手动执行: ${condaCmd} install -p "${CONDA_ENV_DIR}" -c conda-forge --override-channels paddlepaddle`);
            }
          } else {
            warn(`如果使用中有问题，请手动执行: "${pyPath}" -m pip install ${pipName}`);
          }
        }
      }
    }
  }
}

function verifyExistingCondaDeps(pyPath, condaCmd) {
  const verifiers = [
    { pkg: 'paddle', importName: 'paddle', pipName: 'paddlepaddle' },
    { pkg: 'paddleocr', importName: 'paddleocr', pipName: 'paddleocr' },
    { pkg: 'pdfplumber', importName: 'pdfplumber', pipName: 'pdfplumber' },
    { pkg: 'fitz', importName: 'fitz', pipName: 'PyMuPDF' },
  ];

  for (const { pkg, importName, pipName } of verifiers) {
    try {
      const out = execSync(`"${pyPath}" -c "import ${importName}; print(getattr(${importName}, '__version__', 'ok'))"`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
      });
      log(`${pkg} ${out.trim()} ✓`);
    } catch (e) {
      warn(`${pkg} 未安装，正在补装 ${pipName}...`);
      try {
        execSync(`"${pyPath}" -m pip install ${pipName}`, {
          stdio: 'inherit', timeout: 300000,
        });
        success(`${pipName} 安装完成`);
      } catch (e2) {
        if (pkg === 'paddle' && condaCmd) {
          warn(`pip 安装 paddlepaddle 失败，尝试通过 ${condaCmd} 安装...`);
          try {
            execSync(`${condaCmd} install -p "${CONDA_ENV_DIR}" -c conda-forge --override-channels paddlepaddle -y`, {
              stdio: 'inherit', timeout: 600000,
            });
            success('paddlepaddle 通过 conda 安装成功');
          } catch (e3) {
            warn(`paddlepaddle 安装失败: ${e3.message}`);
          }
        } else {
          warn(`${pipName} 安装失败: ${e2.message}`);
          warn(`如果使用中有问题，请手动执行: "${pyPath}" -m pip install ${pipName}`);
        }
      }
    }
  }
}

function writeCondaMeta(pyPath) {
  if (!fs.existsSync(PADDLEOCR_HOME)) {
    fs.mkdirSync(PADDLEOCR_HOME, { recursive: true });
  }
  const meta = {
    type: 'conda',
    envPath: CONDA_ENV_DIR,
    python: pyPath,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf8');
  log(`元数据已写入: ${META_PATH}`);
}

// ─── 传统 pip 安装（已有系统 Python） ────────────────
function installViaPip(py) {
  const reqPath = path.join(__dirname, '..', 'python', 'requirements.txt');
  if (!fs.existsSync(reqPath)) {
    warn('找不到 requirements.txt，跳过自动安装');
    return;
  }

  const installedVersion = getPaddleOcrVersion(py.cmd);
  if (isSupportedPaddleOcrVersion(installedVersion)) {
    success(`PaddleOCR ${installedVersion} 已安装`);
  } else {
    if (installedVersion) {
      log(`检测到 PaddleOCR ${installedVersion}，正在升级到 3.7.x...`);
    } else {
      log('正在安装 PaddleOCR 3.7.x 及依赖（首次安装可能需要 2-5 分钟）...');
    }
    try {
      execSync(`"${py.cmd}" -m pip install --upgrade -r "${reqPath}"`, {
        stdio: 'inherit', timeout: 600000,
      });
      const currentVersion = getPaddleOcrVersion(py.cmd);
      if (!isSupportedPaddleOcrVersion(currentVersion)) {
        throw new Error(`安装后检测到 PaddleOCR ${currentVersion || 'unknown'}，需要 3.7.x`);
      }
      success(`PaddleOCR ${currentVersion} 依赖安装完成`);
    } catch {
      warn('自动安装 PaddleOCR 失败，请手动执行:');
      warn(`  ${py.cmd} -m pip install -r "${reqPath}"`);
      return;
    }
  }

  // 检查 PyMuPDF
  try {
    execSync(`${py.cmd} -c "import fitz"`, { stdio: 'ignore', timeout: 5000 });
    success('PyMuPDF 已安装（支持扫描 PDF 回退 OCR）');
  } catch {
    warn('PyMuPDF 未安装，扫描 PDF 回退 OCR 将不可用');
    warn(`  ${py.cmd} -m pip install PyMuPDF`);
  }

  // 检查 pdfplumber
  try {
    execSync(`${py.cmd} -c "import pdfplumber"`, { stdio: 'ignore', timeout: 5000 });
    success('pdfplumber 已安装（支持 PDF 文本/表格解析）');
  } catch {
    warn('pdfplumber 未安装，正在单独安装...');
    try {
      execSync(`${py.cmd} -m pip install pdfplumber`, {
        stdio: 'inherit', timeout: 300000,
      });
      success('pdfplumber 安装完成（支持 PDF 文本/表格解析）');
    } catch {
      warn('pdfplumber 安装失败，PDF 文本/表格解析将不可用');
      warn(`  ${py.cmd} -m pip install pdfplumber`);
    }
  }

  // 如果 Conda 环境先前存在但未使用，清除旧元数据
  if (fs.existsSync(META_PATH)) {
    try { fs.unlinkSync(META_PATH); } catch { /* ignore */ }
  }
}

// ─── 主流程 ──────────────────────────────────────────
function main() {
  log(`${colors.bold}正在检查 Python / Conda + PaddleOCR 环境...${colors.reset}`);

  // 1. 检查已有的 Conda 环境元数据是否仍有效
  if (fs.existsSync(META_PATH)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      const pyPath = meta.python;
      if (pyPath && fs.existsSync(pyPath)) {
        // 验证 paddle 框架已真正安装且版本兼容（避开 3.3.x OneDNN bug）
        try {
          const out = execSync(`"${pyPath}" -c "import paddle; print(paddle.__version__)"`, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
          });
          const ver = out.trim();
          // 3.3.x 有 ConvertPirAttribute2RuntimeAttribute bug
          if (ver.startsWith('3.3.')) {
            warn(`paddlepaddle ${ver} 存在兼容性问题，降级中...`);
            fs.unlinkSync(META_PATH);
          } else {
            success(`复用 Conda 环境: ${pyPath} (paddle v${ver})`);
            const ocrVersion = getPaddleOcrVersion(pyPath);
            if (!isSupportedPaddleOcrVersion(ocrVersion)) {
              log(`PaddleOCR ${ocrVersion || '未安装'}，正在安装 3.7.x...`);
              installDepsViaConda(pyPath, null);
            }
            verifyExistingCondaDeps(pyPath, null);
            return; // 一切就绪
          }
        } catch {
          warn('Conda 环境中 paddlepaddle 未安装，重新安装依赖');
          fs.unlinkSync(META_PATH);
        }
      } else {
        warn('Conda 环境元数据过期，重新检查');
        fs.unlinkSync(META_PATH);
      }
    } catch { /* ignore stale meta */ }
  }

  // 2. 优先使用 D:\paddleocr_data 下的 Conda 环境
  log('正在查找 Conda...');
  const conda = findConda();
  if (conda) {
    success(`找到 ${conda.cmd} (${conda.version})`);

    // 检查是否已有环境
    let pyPath;
    if (condaEnvExists()) {
      pyPath = condaPythonPath();
      log(`已有 Conda 环境: ${CONDA_ENV_DIR}`);
    } else {
      pyPath = createCondaEnv(conda.cmd);
    }

    installDepsViaConda(pyPath, conda.cmd);
    writeCondaMeta(pyPath);
    success(`Conda 环境就绪: ${pyPath}`);
    log(`${colors.bold}paddleocr-node 初始化完成${colors.reset}`);
    return;
  }

  // 3. 找系统 Python
  const sysPy = findSystemPython();
  if (sysPy) {
    success(`找到系统 Python: ${sysPy.cmd} (${sysPy.version})`);
    installViaPip(sysPy);
    log(`${colors.bold}paddleocr-node 初始化完成${colors.reset}`);
    return;
  }

  // 4. 兜底
  warn('未找到 Python 3.8+ 解释器，也未找到 Conda。');
  warn('请选择以下方式之一安装:');
  warn('  📦 方式一: 安装 Conda (推荐) — https://docs.conda.io/');
  warn('  🐍 方式二: 安装 Python — https://www.python.org/downloads/');
  warn('安装后重新执行: npm rebuild paddleocr-node');
  warn('或手动安装: pip install "paddleocr>=3.7,<3.8" pdfplumber PyMuPDF Pillow');
  process.exit(0);
}

main();
