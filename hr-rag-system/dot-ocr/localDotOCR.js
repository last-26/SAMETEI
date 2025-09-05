/**
 * Local DOT-OCR Wrapper (GOT-OCR2)
 * Gelişmiş görüntü OCR işleme için tasarlandı
 * Mevcut LocalQwenOCR yapısıyla uyumlu
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class LocalDotOCR {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || 'python';
    this.servicePath = options.servicePath || path.join(__dirname, '..', 'dot-ocr', 'dot_ocr_service.py');
    this.modelPath = options.modelPath || "C:\\Users\\samet\\Downloads\\GOT-OCR2_0";
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.defaultExtractionType = options.defaultExtractionType || 'table_text_tsv';

    // Servis durumu
    this.isServiceReady = false;
    this.lastHealthCheck = null;
    this.healthCheckInterval = 30000; // 30 saniye

    console.log('[LocalDotOCR] DOT-OCR servis bağlantısı hazır');
    console.log(`[LocalDotOCR] Model yolu: ${this.modelPath}`);
  }

  /**
   * Servis sağlık kontrolü
   */
  async checkHealth() {
    try {
      // Basit bir test çalıştır
      const testResult = await this._runPythonCommand(['--help']);

      if (testResult.success) {
        this.isServiceReady = true;
        this.lastHealthCheck = Date.now();
        return { status: 'healthy', message: 'DOT-OCR servis çalışıyor' };
      } else {
        this.isServiceReady = false;
        return { status: 'error', message: testResult.error };
      }
    } catch (error) {
      console.error('[LocalDotOCR] Sağlık kontrolü hatası:', error.message);
      this.isServiceReady = false;
      return { status: 'error', error: error.message };
    }
  }

  /**
   * Görüntüden metin çıkarma (Ana fonksiyon)
   */
  async extractFromImage(imagePath, extractionType = null, options = {}) {
    try {
      console.log(`[LocalDotOCR] ${extractionType || this.defaultExtractionType} analizi başlatılıyor: ${path.basename(imagePath)}`);

      // Görüntü dosyasının varlığını kontrol et
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Görüntü dosyası bulunamadı: ${imagePath}`);
      }

      // Çıkarım türü
      const type = extractionType || this.defaultExtractionType;

      // Özel prompt (varsa)
      const customPrompt = options.customPrompt || null;

      // Süre ölçümü
      const t0 = Date.now();

      // Python servisini çalıştır
      const result = await this._runOCR(imagePath, type, customPrompt);

      if (result.success) {
        const elapsedMs = Date.now() - t0;
        console.log(`[LocalDotOCR] ✅ Başarılı: ${result.text.length} karakter | Süre: ${elapsedMs} ms`);

        return {
          success: true,
          text: result.text,
          model: 'GOT-OCR2 (Local DOT-OCR)',
          extractionType: type,
          elapsedMs,
          processingTime: result.processing_time,
          device: result.device
        };
      } else {
        throw new Error(result.error || 'Bilinmeyen hata');
      }

    } catch (error) {
      console.error('[LocalDotOCR] Hata:', error.message);
      return {
        success: false,
        error: error.message,
        text: '',
        model: 'GOT-OCR2 (Local DOT-OCR)'
      };
    }
  }

  /**
   * Python OCR servisini çalıştır
   */
  async _runOCR(imagePath, extractionType, customPrompt) {
    return new Promise((resolve, reject) => {
      const args = [this.servicePath, imagePath, '--type', extractionType];

      // Model yolu
      if (this.modelPath) {
        args.push('--model-path', this.modelPath);
      }

      // Özel prompt
      if (customPrompt) {
        args.push('--custom-prompt', customPrompt);
      }

      console.log(`[LocalDotOCR] Python komutu: ${this.pythonPath} ${args.join(' ')}`);

      const python = spawn(this.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        try {
          if (code === 0) {
            const result = JSON.parse(stdout.trim());
            resolve(result);
          } else {
            console.error('[LocalDotOCR] Python stderr:', stderr);
            resolve({
              success: false,
              error: `Python çıkış kodu: ${code}, Hata: ${stderr}`
            });
          }
        } catch (parseError) {
          console.error('[LocalDotOCR] JSON parse hatası:', parseError);
          console.error('[LocalDotOCR] Raw output:', stdout);
          resolve({
            success: false,
            error: `JSON parse hatası: ${parseError.message}`
          });
        }
      });

      python.on('error', (error) => {
        console.error('[LocalDotOCR] Python başlatma hatası:', error);
        resolve({
          success: false,
          error: `Python başlatma hatası: ${error.message}`
        });
      });

      // Timeout kaldırıldı - sınırsız bekleme
      // setTimeout(() => {
      //   python.kill();
      //   resolve({
      //     success: false,
      //     error: 'İşlem zaman aşımına uğradı'
      //   });
      // }, 90000);
    });
  }

  /**
   * Genel Python komutu çalıştır (test için)
   */
  async _runPythonCommand(args) {
    return new Promise((resolve) => {
      const python = spawn(this.pythonPath, args, {
        cwd: path.dirname(this.servicePath),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code
        });
      });

      python.on('error', (error) => {
        resolve({
          success: false,
          error: error.message
        });
      });
    });
  }

  /**
   * Batch processing for multiple images
   */
  async processMultipleImages(imagePaths, extractionType = null, options = {}) {
    const results = [];
    const type = extractionType || this.defaultExtractionType;

    for (const imagePath of imagePaths) {
      console.log(`[LocalDotOCR] İşleniyor: ${path.basename(imagePath)}`);

      const result = await this.extractFromImage(imagePath, type, options);
      results.push({
        file: path.basename(imagePath),
        path: imagePath,
        ...result
      });

      // Rate limiting - sistemi yormayalım
      if (options.rateLimit !== false) {
        await new Promise(resolve => setTimeout(resolve, options.rateLimit || 500));
      }
    }

    return results;
  }

  /**
   * Servis konfigürasyonu
   */
  getConfig() {
    return {
      pythonPath: this.pythonPath,
      servicePath: this.servicePath,
      modelPath: this.modelPath,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay,
      defaultExtractionType: this.defaultExtractionType,
      isServiceReady: this.isServiceReady
    };
  }

  /**
   * Servis yeniden başlatma
   */
  async restart() {
    console.log('[LocalDotOCR] Servis yeniden başlatılıyor...');
    this.isServiceReady = false;
    this.lastHealthCheck = null;

    // Kısa bekleme
    await new Promise(resolve => setTimeout(resolve, 1000));

    return await this.checkHealth();
  }
}

module.exports = LocalDotOCR;
