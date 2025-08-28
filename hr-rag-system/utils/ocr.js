const fs = require('fs');
const path = require('path');
const os = require('os');
const { fromPath } = require('pdf2pic');
const tesseract = require('node-tesseract-ocr');
let Jimp = null;
try { Jimp = require('jimp'); } catch (_) { /* optional dependency */ }
const pdfParse = require('pdf-parse');
const config = require('../config');

// Tesseract PATH'e ekle (Windows için gerekli olabilir)
(() => {
  try {
    const tessPath = config.ocr?.tesseractPath;
    if (tessPath && fs.existsSync(tessPath)) {
      const binDir = path.dirname(tessPath);
      const currentPath = process.env.PATH || process.env.Path || '';
      if (!currentPath.toLowerCase().includes(binDir.toLowerCase())) {
        process.env.PATH = `${binDir};${currentPath}`;
      }
    }
  } catch (_) {
    // sessiz geç
  }
})();

/**
 * Basit temizlik
 */
function cleanText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * PDF'in ilk sayfalarındaki metin uzunluğuna göre image-based olup olmadığını tahmin et
 */
async function isImageBasedPdf(pdfPath) {
  try {
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    const text = cleanText(data.text || '');
    // 100 karakterden azsa büyük olasılıkla görüntü tabanlıdır
    return text.length < (config.ocr?.minTextThreshold || 100);
  } catch (e) {
    // Hata durumunda güvenli tarafta kal: OCR uygula
    return true;
  }
}

/**
 * PDF'i sayfa sayfa görüntüye çevirip Tesseract ile OCR
 */
async function ocrPdfToText(pdfPath, options = {}) {
  const lang = options.lang || config.ocr?.languages || 'tur+eng';
  const dpi = options.dpi || config.ocr?.dpi || 300;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ocr-'));

  try {
    const converter = fromPath(pdfPath, {
      density: dpi,
      saveFilename: 'page',
      savePath: tempDir,
      format: 'png',
      width: 2000,
      height: 2000,
      quality: 100
    });

    // Önce sayfa sayısını bulmak için pdf-parse
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    const totalPages = data.numpages || 1;

    const pageTexts = [];
    for (let i = 1; i <= totalPages; i++) {
      const out = await converter(i);
      let imagePath = out.path; // kaydedilen png dosya yolu

      // Ön-işleme: gri, kontrast, normalize, threshold
      try {
        if (Jimp) {
          const img = await Jimp.read(imagePath);
          img
            .grayscale()
            .contrast(0.5)
            .normalize()
            .brightness(0.05)
            .write(imagePath);
        }
      } catch (_) { /* sessiz geç */ }

      const baseOptions = {
        lang,
        oem: options.oem ?? 3,
        psm: options.psm ?? 6
      };
      // bazı sürümlerde executablePath desteklenir; varsa ekle
      if (config.ocr?.tesseractPath) {
        baseOptions.executablePath = config.ocr.tesseractPath;
      }

      // PSM 6 ve PSM 4 dene, en uzun metni seç
      const candidates = [];
      const opt6 = { ...baseOptions, psm: 6 };
      const opt4 = { ...baseOptions, psm: 4 };
      try { candidates.push(await tesseract.recognize(imagePath, opt6)); } catch (_) {}
      try { candidates.push(await tesseract.recognize(imagePath, opt4)); } catch (_) {}
      const text = cleanText(candidates.sort((a,b) => b.length - a.length)[0] || '');

      pageTexts.push(cleanText(text));
    }

    return {
      text: cleanText(pageTexts.join('\n\n')),
      totalPages
    };
  } finally {
    // temp dosyaları temizle
    try {
      const files = fs.readdirSync(tempDir);
      for (const f of files) {
        fs.unlinkSync(path.join(tempDir, f));
      }
      fs.rmdirSync(tempDir);
    } catch (_) {}
  }
}

module.exports = {
  isImageBasedPdf,
  ocrPdfToText,
  cleanText
};


