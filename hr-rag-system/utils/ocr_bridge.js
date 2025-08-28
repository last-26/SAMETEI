const { spawn } = require('child_process');
const path = require('path');

function runPythonOCR(pdfPath, options = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'ocr_py.py');
    const pythonExec = process.env.PYTHON_PATH || 'python';
    const env = { ...process.env };
    if (options.lang) env.TESSERACT_LANG = options.lang;
    if (options.dpi) env.OCR_DPI = String(options.dpi);

    console.log(`[OCR] Python OCR çağrılıyor: ${pythonExec} ${scriptPath} (lang=${env.TESSERACT_LANG}, dpi=${env.OCR_DPI})`);

    const proc = spawn(pythonExec, [scriptPath, pdfPath], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr || `Python exited with code ${code}`));
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json.success === false) return reject(new Error(json.error || 'Python OCR failed'));
        resolve(json);
      } catch (e) {
        reject(new Error(`Invalid JSON from python: ${e.message}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`));
      }
    });
  });
}

module.exports = { runPythonOCR };


