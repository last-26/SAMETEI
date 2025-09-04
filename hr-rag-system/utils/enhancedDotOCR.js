/**
 * Gelişmiş DOT-OCR Sistemi
 * Akıllı görüntü işleme ve çoklu fallback mekanizmaları
 */

const LocalDotOCR = require('./localDotOCR');
const ImagePreprocessor = require('./imagePreprocessor');
const path = require('path');
const fs = require('fs');

class EnhancedDotOCR {
  constructor(options = {}) {
    this.dotOCR = new LocalDotOCR(options);
    this.preprocessor = new ImagePreprocessor();
    this.enablePreprocessing = options.enablePreprocessing !== false;
    this.maxRetries = options.maxRetries || 3;
    this.fallbackStrategies = options.fallbackStrategies || ['preprocessing', 'alternative_type', 'retry'];
    this.tryRotations = options.tryRotations !== false; // 90° denemeleri varsayılan açık
  }

  /**
   * Basitleştirilmiş OCR - sadece temel işleme
   */
  async extractTextSmart(imagePath, extractionType = 'table_text_tsv', options = {}) {
    try {
      console.log(`📷 DOT-OCR başlatılıyor: ${path.basename(imagePath)}`);

      // Önce basit grayscale uygula
      console.log('🎨 Basit grayscale uygulanıyor...');
      const processedPath = await this.applySimpleGrayscale(imagePath);

      // 90° rotasyon denemeleri: orijinal + sol + sağ
      const candidatePaths = [processedPath];
      let rotatedLeftPath = null;
      let rotatedRightPath = null;
      if (this.tryRotations && extractionType === 'text_only') {
        console.log('🧭 90° döndürme denemeleri hazırlanıyor...');
        rotatedLeftPath = await this.rotateImage90(processedPath, 'left');
        rotatedRightPath = await this.rotateImage90(processedPath, 'right');
        if (rotatedLeftPath) candidatePaths.push(rotatedLeftPath);
        if (rotatedRightPath) candidatePaths.push(rotatedRightPath);
      }

      // Adayların hepsinden çıkarım yap ve en iyi metni seç
      console.log('🔄 OCR çıkarımı yapılıyor...');
      const results = [];
      for (const p of candidatePaths) {
        const r = await this.extractWithRetry(p, extractionType);
        if (r.success) {
          r.confidence = this.calculateConfidence(r);
          results.push(r);
        }
      }

      // Geçici döndürülmüş dosyaları temizle
      try { if (rotatedLeftPath && rotatedLeftPath !== processedPath) fs.unlinkSync(rotatedLeftPath); } catch(e) {}
      try { if (rotatedRightPath && rotatedRightPath !== processedPath) fs.unlinkSync(rotatedRightPath); } catch(e) {}

      if (results.length > 0) {
        // En iyi sonucu seç ve tüm sonuçları satır bazında birleştir
        const best = results.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
        const combinedText = this.mergeByLines(results.map(r => r.text));

        const cleanText = this.cleanAndFormatText(combinedText);
        const finalConfidence = Math.max(...results.map(r => r.confidence || 0));
        console.log(`✅ Başarılı: ${finalConfidence}% güven, ${cleanText.length} karakter (rotasyon denendi)`);

        return {
          ...best,
          text: cleanText,
          confidence: finalConfidence,
          preprocessingApplied: false,
          method: this.tryRotations ? 'rotation_candidates' : 'direct'
        };
      }

      return {
        success: false,
        error: result.error || 'Çıkarım başarısız',
        text: '',
        confidence: 0
      };

    } catch (error) {
      console.error(`❌ OCR hatası: ${error.message}`);
      return {
        success: false,
        error: error.message,
        text: '',
        confidence: 0
      };
    }
  }

  /**
   * Basit grayscale uygulama
   */
  async applySimpleGrayscale(imagePath) {
    try {
      // Dosya sistem modüllerini import et
      const fs = require('fs');
      const { spawn } = require('child_process');

      return new Promise((resolve) => {
        // Basit grayscale için Python script oluştur ve çalıştır
        const scriptContent = `
import sys
import cv2
import os

input_path = sys.argv[1]
output_path = sys.argv[2]

try:
    # Görüntüyü yükle
    image = cv2.imread(input_path)
    if image is None:
        print(f"Hata: Görüntü yüklenemedi")
        sys.exit(1)

    # Basit grayscale dönüşümü
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    # Hafif normalizasyon (çok yumuşak)
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)

    # Sonucu kaydet
    cv2.imwrite(output_path, gray)
    print(f"Grayscale uygulandı: {output_path}")

except Exception as e:
    print(f"Grayscale hatası: {e}")
    # Hata durumunda orijinal dosyayı kopyala
    import shutil
    shutil.copy2(input_path, output_path)
`;

        const tempScript = path.join(this.preprocessor.tempDir, 'simple_grayscale.py');
        fs.writeFileSync(tempScript, scriptContent);

        const outputPath = path.join(this.preprocessor.tempDir,
          `gray_${Date.now()}_${path.basename(imagePath)}`);

        const python = spawn('python', [tempScript, imagePath, outputPath]);

        python.on('close', (code) => {
          // Geçici script'i temizle
          try { fs.unlinkSync(tempScript); } catch(e) {}

          if (code === 0 && fs.existsSync(outputPath)) {
            resolve(outputPath);
          } else {
            console.log('⚠️ Grayscale başarısız, orijinal kullanılıyor');
            resolve(imagePath);
          }
        });

        python.on('error', () => {
          try { fs.unlinkSync(tempScript); } catch(e) {}
          resolve(imagePath);
        });
      });

    } catch (error) {
      console.log('⚠️ Grayscale hatası, orijinal kullanılıyor');
      return imagePath;
    }
  }

  /**
   * Metni temizle ve doğal formata çevir
   */
  cleanAndFormatText(text) {
    if (!text) return text;

    // JSON escape karakterlerini gerçek karakterlere çevir
    let cleaned = text
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");

    // Gereksiz boşlukları temizle
    cleaned = cleaned.replace(/[ \t]+/g, ' ');
    cleaned = cleaned.replace(/\n\s+/g, '\n');

    // Fazla boş satırları kaldır
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Büyük harfli bölünmüş kelimeleri birleştir (örn. "IS TAN BUL" -> "ISTANBUL")
    const isUpperTurkish = (s) => /^[A-ZÇĞİÖŞÜ]+$/.test(s);
    const isSmallUpperChunk = (tok) => isUpperTurkish(tok) && tok.length <= 3;

    const mergeLine = (line) => {
      const tokens = line.split(' ');
      const merged = [];
      let buffer = [];

      const flushBuffer = () => {
        if (buffer.length >= 2) {
          merged.push(buffer.join(''));
        } else if (buffer.length === 1) {
          merged.push(buffer[0]);
        }
        buffer = [];
      };

      const bufferTotalLen = () => buffer.reduce((s, t) => s + t.length, 0);

      for (const tok of tokens) {
        if (isSmallUpperChunk(tok)) {
          // Eğer eklemek sınırları aşacaksa önce buffer'ı yaz
          const wouldExceedTokenCount = buffer.length + 1 > 3; // en fazla 3 parça
          const wouldExceedTotalLen = bufferTotalLen() + tok.length > 8; // toplam 8 harf sınırı
          if (wouldExceedTokenCount || wouldExceedTotalLen) {
            flushBuffer();
          }
          buffer.push(tok);
          continue;
        }

        // Büyük harf küçük parça olmayan bir token'a geçiliyorsa buffer'ı yaz
        flushBuffer();
        merged.push(tok);
      }

      // Satır sonu
      flushBuffer();
      return merged.join(' ');
    };

    cleaned = cleaned
      .split('\n')
      .map((line) => mergeLine(line.trim()))
      .map((line) => this.correctLineWithDictionary(line))
      .join('\n');

    return cleaned.trim();
  }

  /**
   * Satır bazında metinleri birleştir ve tekrarlı satırları kaldır
   */
  mergeByLines(textArray) {
    const norm = (s) => s
      .replace(/[\t ]+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .toUpperCase();
    const seen = new Set();
    const lines = [];
    for (const t of textArray) {
      if (!t) continue;
      for (const line of String(t).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const key = norm(trimmed);
        if (!seen.has(key)) {
          seen.add(key);
          lines.push(trimmed);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * Görüntüyü 90° döndür (left|right)
   */
  async rotateImage90(imagePath, direction = 'left') {
    try {
      const fs = require('fs');
      const { spawn } = require('child_process');
      const rotationCode = direction === 'right' ? 'cv2.ROTATE_90_CLOCKWISE' : 'cv2.ROTATE_90_COUNTERCLOCKWISE';
      const scriptContent = `
import sys, cv2
inp, outp = sys.argv[1], sys.argv[2]
img = cv2.imread(inp)
if img is None:
    raise SystemExit(1)
rot = cv2.rotate(img, ${rotationCode})
cv2.imwrite(outp, rot)
print(outp)
`;
      const tempScript = path.join(this.preprocessor.tempDir, `rotate90_${Date.now()}.py`);
      fs.writeFileSync(tempScript, scriptContent);
      const outputPath = path.join(this.preprocessor.tempDir, `${direction}_90_${Date.now()}_${path.basename(imagePath)}`);
      return await new Promise((resolve) => {
        const py = spawn('python', [tempScript, imagePath, outputPath]);
        py.on('close', (code) => {
          try { fs.unlinkSync(tempScript); } catch(_) {}
          if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath); else resolve(null);
        });
        py.on('error', () => {
          try { fs.unlinkSync(tempScript); } catch(_) {}
          resolve(null);
        });
      });
    } catch (_) {
      return null;
    }
  }

  /**
   * Türkçe kelimeleri sözlükle doğrula ve düzelt
   */
  correctLineWithDictionary(line) {
    const dictionary = [
      'KIRMIZI', 'MAVİ', 'YEŞİL', 'SARI', 'MOR', 'TURUNCU',
      'ANKARA', 'ANTALYA', 'İSTANBUL', 'İZMİR', 'TÜRKİYE'
    ];

    const tokens = line.split(' ').filter(t => t.length > 0);
    const corrected = [];

    for (let i = 0; i < tokens.length; i++) {
      const current = tokens[i];
      const next = tokens[i + 1] || '';

      const attemptFix = (candidate) => {
        const best = this.findBestDictionaryMatch(candidate, dictionary);
        if (best && best.distance <= 2) {
          return best.word;
        }
        return null;
      };

      // Önce tek token dene
      let fixed = attemptFix(current);

      // Olmadıysa küçük bir token ile birleştirerek dene
      if (!fixed && next && next.length <= 2) {
        const joined = (current + next).replace(/!/g, 'I');
        const fixedJoined = attemptFix(joined);
        if (fixedJoined) {
          fixed = fixedJoined;
          i += 1; // bir token atla
        }
      }

      corrected.push(fixed || current);
    }

    return corrected.join(' ');
  }

  /**
   * Sözlükte en yakın eşleşmeyi bul
   */
  findBestDictionaryMatch(token, dict) {
    const normTok = this.normalizeForCompare(token);
    let best = null;
    for (const w of dict) {
      const nw = this.normalizeForCompare(w);
      const d = this.levenshtein(normTok, nw);
      if (best === null || d < best.distance) {
        best = { word: w, distance: d };
      }
    }
    return best;
  }

  /**
   * Türkçe karşılaştırma için normalize et
   */
  normalizeForCompare(s) {
    if (!s) return '';
    const up = String(s).toUpperCase()
      .replace(/İ/g, 'I')
      .replace(/İ/g, 'I')
      .replace(/Ş/g, 'S')
      .replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U')
      .replace(/Ö/g, 'O')
      .replace(/Ç/g, 'C')
      .replace(/Â|Ê|Î|Ô|Û/g, m => ({ 'Â':'A','Ê':'E','Î':'I','Ô':'O','Û':'U' }[m]))
      .replace(/!/g, 'I');
    return up.replace(/[^A-Z]/g, '');
  }

  /**
   * Basit Levenshtein mesafesi
   */
  levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  /**
   * Retry mekanizması ile çıkarım
   */
  async extractWithRetry(imagePath, extractionType, maxRetries = this.maxRetries) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Deneme ${attempt}/${maxRetries}: ${extractionType}`);

        const result = await this.dotOCR.extractFromImage(imagePath, extractionType);

        if (result.success) {
          return result;
        }

        if (attempt < maxRetries) {
          console.log(`⚠️ Deneme ${attempt} başarısız, ${1000 * attempt}ms bekleniyor...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }

      } catch (error) {
        console.error(`❌ Deneme ${attempt} hatası: ${error.message}`);

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return {
      success: false,
      error: `Maksimum deneme sayısına ulaşıldı (${maxRetries})`,
      text: ''
    };
  }

  /**
   * Sonuç güven skorunu hesapla
   */
  calculateConfidence(result) {
    if (!result.success || !result.text) return 0;

    let confidence = 50; // Baz puan

    // Metin uzunluğu faktörü
    if (result.text.length > 100) confidence += 20;
    else if (result.text.length > 50) confidence += 10;

    // Özel karakterler faktörü (tablo işaretleri)
    if (result.text.includes('\t') || result.text.includes('|')) confidence += 15;

    // Türkçe karakterler faktörü
    const turkishChars = ['ç', 'ğ', 'ı', 'ö', 'ş', 'ü', 'Ç', 'Ğ', 'İ', 'Ö', 'Ş', 'Ü'];
    const hasTurkishChars = turkishChars.some(char => result.text.includes(char));
    if (hasTurkishChars) confidence += 10;

    // İşlem süresi faktörü (çok hızlı = potansiyel problem)
    if (result.elapsedMs && result.elapsedMs > 5000) confidence += 5;

    return Math.min(confidence, 100);
  }

  /**
   * Toplu işleme için optimize edilmiş yöntem
   */
  async processBatch(imagePaths, extractionType = 'table_text_tsv', options = {}) {
    const results = [];
    const batchSize = options.batchSize || 3;

    console.log(`📦 Toplu işleme başlatılıyor: ${imagePaths.length} görüntü`);

    for (let i = 0; i < imagePaths.length; i += batchSize) {
      const batch = imagePaths.slice(i, i + batchSize);
      console.log(`🔄 Batch ${Math.floor(i/batchSize) + 1}: ${batch.length} görüntü işleniyor`);

      const batchPromises = batch.map(async (imagePath) => {
        try {
          const result = await this.extractTextSmart(imagePath, extractionType, options);
          return {
            imagePath,
            fileName: path.basename(imagePath),
            ...result
          };
        } catch (error) {
          return {
            imagePath,
            fileName: path.basename(imagePath),
            success: false,
            error: error.message,
            text: '',
            confidence: 0
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Rate limiting
      if (i + batchSize < imagePaths.length) {
        console.log('⏳ Rate limiting: 2 saniye bekleniyor...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // İstatistikler
    const successful = results.filter(r => r.success).length;
    const avgConfidence = results.reduce((sum, r) => sum + (r.confidence || 0), 0) / results.length;

    console.log(`✅ Toplu işleme tamamlandı:`);
    console.log(`   Başarılı: ${successful}/${results.length}`);
    console.log(`   Ortalama güven: ${avgConfidence.toFixed(1)}%`);

    return results;
  }

  /**
   * Sistem durumunu kontrol et
   */
  async getSystemStatus() {
    try {
      const dotOCRHealth = await this.dotOCR.checkHealth();
      const config = this.dotOCR.getConfig();

      return {
        status: dotOCRHealth.status === 'healthy' ? 'ready' : 'error',
        dotOCR: dotOCRHealth,
        config: config,
        preprocessing: {
          enabled: this.enablePreprocessing,
          strategies: this.fallbackStrategies
        },
        capabilities: {
          imagePreprocessing: true,
          multiStrategyFallback: true,
          batchProcessing: true,
          confidenceScoring: true
        }
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }
}

module.exports = EnhancedDotOCR;
