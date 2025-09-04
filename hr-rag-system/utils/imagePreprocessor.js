/**
 * Gelişmiş Görüntü Ön İşleme
 * DOT-OCR için görüntü optimizasyonu
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ImagePreprocessor {
  constructor() {
    this.pythonPath = 'python';
    this.tempDir = path.join(__dirname, '..', 'temp');
  }

  /**
   * Görüntüyü analiz et ve çok basit ön işleme uygula
   */
  async preprocessImage(imagePath, options = {}) {
    try {
      console.log(`🔍 Basit görüntü ön işleme başlatılıyor: ${path.basename(imagePath)}`);

      const {
        enhanceContrast = true,  // Sadece bunu tut
        removeBackground = false, // Devre dışı
        detectRotation = false,   // Devre dışı
        denoise = false,          // Devre dışı
        optimizeForOCR = false    // Devre dışı
      } = options;

      let processedPath = imagePath;

      // Sadece çok basit kontrast geliştirme (grayscale)
      if (enhanceContrast) {
        console.log('🎨 Basit grayscale dönüşümü uygulanıyor...');
        processedPath = await this.enhanceContrast(processedPath);
      }

      // Diğer işlemler tamamen kaldırıldı - çok agresifti

      console.log(`✅ Basit ön işleme tamamlandı: ${path.basename(processedPath)}`);
      return processedPath;

    } catch (error) {
      console.error(`❌ Ön işleme hatası: ${error.message}`);
      console.log('⚠️ Orijinal görüntü kullanılacak');
      return imagePath; // Hata durumunda orijinal görüntüyü döndür
    }
  }

  /**
   * Kontrast geliştirme
   */
  async enhanceContrast(imagePath) {
    return this.runPythonScript('enhance_contrast.py', imagePath);
  }

  /**
   * Arka plan temizleme
   */
  async removeBackground(imagePath) {
    return this.runPythonScript('remove_background.py', imagePath);
  }

  /**
   * Döndürme tespiti ve düzeltme
   */
  async detectAndCorrectRotation(imagePath) {
    return this.runPythonScript('correct_rotation.py', imagePath);
  }

  /**
   * Gürültü azaltma
   */
  async denoise(imagePath) {
    return this.runPythonScript('denoise.py', imagePath);
  }

  /**
   * OCR için optimizasyon
   */
  async optimizeForOCR(imagePath) {
    return this.runPythonScript('optimize_ocr.py', imagePath);
  }

  /**
   * Python script çalıştırma yardımcı fonksiyonu
   */
  async runPythonScript(scriptName, imagePath) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'preprocessing', scriptName);

      if (!fs.existsSync(scriptPath)) {
        console.warn(`⚠️ Script bulunamadı: ${scriptName}, atlanıyor`);
        resolve(imagePath);
        return;
      }

      const outputPath = path.join(this.tempDir, `preprocessed_${Date.now()}_${path.basename(imagePath)}`);

      const python = spawn(this.pythonPath, [scriptPath, imagePath, outputPath]);

      python.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          console.warn(`⚠️ ${scriptName} başarısız, orijinal görüntü kullanılıyor`);
          resolve(imagePath);
        }
      });

      python.on('error', (error) => {
        console.warn(`⚠️ ${scriptName} hatası: ${error.message}`);
        resolve(imagePath);
      });
    });
  }

  /**
   * Görüntü özelliklerini analiz et
   */
  async analyzeImage(imagePath) {
    try {
      const analysis = await this.runPythonScript('analyze_image.py', imagePath);

      // Basit analiz (dosya boyutu, format vb.)
      const stats = fs.statSync(imagePath);
      const fileSizeKB = Math.round(stats.size / 1024);

      return {
        fileSize: fileSizeKB,
        format: path.extname(imagePath).toLowerCase(),
        hasColorBackground: this.detectColorBackground(imagePath),
        hasVerticalText: this.detectVerticalText(imagePath),
        needsPreprocessing: fileSizeKB > 500 // 500KB üzeri görüntüler için
      };
    } catch (error) {
      return {
        fileSize: 0,
        format: 'unknown',
        hasColorBackground: false,
        hasVerticalText: false,
        needsPreprocessing: false
      };
    }
  }

  /**
   * Renkli arka plan tespiti (basit yaklaşım)
   */
  detectColorBackground(imagePath) {
    // Dosya adına göre basit tespit
    const fileName = path.basename(imagePath).toLowerCase();
    return fileName.includes('color') || fileName.includes('form') || fileName.includes('table');
  }

  /**
   * Dikey metin tespiti (basit yaklaşım)
   */
  detectVerticalText(imagePath) {
    // Dosya adına göre basit tespit
    const fileName = path.basename(imagePath).toLowerCase();
    return fileName.includes('vertical') || fileName.includes('rotate');
  }
}

module.exports = ImagePreprocessor;
