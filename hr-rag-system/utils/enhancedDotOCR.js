/**
 * Gelişmiş DOT-OCR Sistemi - BACKUP (Qwen2.5-VL sistemine geçildi)
 * Akıllı görüntü işleme ve çoklu fallback mekanizmaları
 *
 * NOT: Bu dosya artık kullanılmıyor. Qwen2.5-VL modeli aktif sistem olarak kullanılıyor.
 * Eski DOT-OCR sistemi burada backup olarak saklanıyor.
 */

const LocalDotOCR = require('./localDotOCR');
const ImagePreprocessor = require('./imagePreprocessor');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

class EnhancedDotOCR {
  constructor(options = {}) {
    this.dotOCR = new LocalDotOCR(options);
    this.preprocessor = new ImagePreprocessor();
    this.enablePreprocessing = options.enablePreprocessing !== false;
    this.maxRetries = options.maxRetries || 1; // Tek retry yeterli
  }

  /**
   * TEK İŞLEM - Basit ve Direkt OCR
   */
  async extractTextSmart(imagePath, extractionType = 'table_text_tsv', options = {}) {
    try {
      console.log(`📷 DOT-OCR BAŞLATILIYOR: ${path.basename(imagePath)}`);

      // PREPROCESSING TAMAMEN KALDIRILDI - Orijinal görüntü kullanılır
      console.log('📸 Orijinal görüntü kullanılıyor (hiçbir değişiklik yok)');
      const processedPath = imagePath;

      // Önce orijinal görüntü ile dene
      console.log('🔄 Orijinal görüntü ile çıkarım yapılıyor...');
      let result = await this.extractWithRetry(processedPath, extractionType, 1);

      if (result.success) {
        let confidence = this.calculateConfidence(result);
        console.log(`✅ İlk çıkarım tamamlandı: ${confidence}% güven, ${result.text.length} karakter`);

        // Kelime bölünmesi problemi var mı kontrol et
        const hasWordSplitting = this.detectWordSplitting(result.text);
        console.log(`🔍 Kelime bölünmesi tespit edildi: ${hasWordSplitting}`);

        if (hasWordSplitting) {
          console.log('🔄 Problem tespit edildi, çoklu strateji deneniyor...');

          // Çeşitli stratejileri dene
          const strategyResults = await this.tryMultipleStrategies(imagePath, extractionType);

          // En iyi sonucu seç
          let bestResult = result;
          let bestScore = this.scoreResult(result, confidence, hasWordSplitting);

          console.log(`📊 Orijinal skor: ${bestScore} (güven: ${confidence}%, bölünme: ${hasWordSplitting})`);

          for (const strategyResult of strategyResults) {
            const score = this.scoreResult(strategyResult, strategyResult.confidence, strategyResult.hasWordSplitting);
            console.log(`📊 ${strategyResult.strategy} skor: ${score} (güven: ${strategyResult.confidence}%, bölünme: ${strategyResult.hasWordSplitting})`);

            if (score > bestScore) {
              bestResult = strategyResult;
              bestScore = score;
              console.log(`✅ ${strategyResult.strategy} daha iyi sonuç verdi!`);
            }
          }

          if (bestResult !== result) {
            result = bestResult;
            confidence = bestResult.confidence;
          }
        }

        // Metni temizle ve formatla
        const cleanText = this.cleanAndFormatText(result.text);

        return {
          ...result,
          text: cleanText,
          confidence: confidence,
          preprocessingApplied: hasWordSplitting,
          method: hasWordSplitting ? 'with_rotation' : 'single_direct'
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

    // TABLO FORMATINA DÖNÜŞTÜR
    cleaned = this.convertToTableFormat(cleaned);

    return cleaned.trim();
  }

  /**
   * Kelime bölünmesi (heceleme) problemi var mı kontrol eder
   * Ayrıca eksik şehir isimlerini de tespit eder
   */
  detectWordSplitting(text) {
    if (!text) return false;

    // Türkçe şehir isimlerinde heceleme paternleri
    const splittingPatterns = [
      /\bIS\s*TAN\s*BUL\b/i,  // İSTANBUL -> İS TAN BUL
      /\bIZ\s*MIR\b/i,        // İZMİR -> İZ MIR
      /\bAN\s*KAR\b/i,        // ANKARA -> AN KAR
      /\bTURK\s*I\s*YE\b/i,   // TÜRKİYE -> TURK I YE
      /\bAN\s*TAL\s*YA\b/i    // ANTALYA -> AN TAL YA
    ];

    // Genel eksik metin kontrolü - önceki sonuçlarla karşılaştır
    // Eğer çok az metin çıkarsa rotation dene
    if (text && text.length < 50) {
      console.log(`⚠️ Çok az metin tespit edildi (${text.length} karakter), rotation deneniyor`);
      return true;
    }

    return splittingPatterns.some(pattern => pattern.test(text));
  }

  /**
   * Farklı rotation açılarında çıkarım yapmayı dener
   * Genel dikey metin tespiti için çoklu açı desteği
   */
  /**
   * Çeşitli stratejilerle metin çıkarımı yapmayı dener
   * Genel yaklaşım: rotation + farklı extraction mode'ları
   */
  async tryMultipleStrategies(imagePath, extractionType) {
    const results = [];

    // Farklı stratejileri dene
    const strategies = [
      // Orijinal görüntü farklı mode'larla
      { type: 'original', mode: extractionType, rotation: 0 },
      { type: 'original', mode: 'text_only', rotation: 0 },
      { type: 'original', mode: 'form', rotation: 0 },

      // Rotation'lı görüntüler
      { type: 'rotation', mode: extractionType, rotation: 90 },
      { type: 'rotation', mode: extractionType, rotation: -90 },
      { type: 'rotation', mode: 'text_only', rotation: 90 },
      { type: 'rotation', mode: 'text_only', rotation: -90 }
    ];

    for (const strategy of strategies) {
      try {
        let targetPath = imagePath;
        let strategyName = strategy.type === 'original' ?
          `${strategy.mode} mode` :
          `${strategy.rotation}° rotation + ${strategy.mode}`;

        console.log(`🔄 ${strategyName} deneniyor...`);

        // Rotation gerekiyorsa uygula
        if (strategy.rotation !== 0) {
          targetPath = await this.applyRotation(imagePath, strategy.rotation);
          if (!targetPath) continue;
        }

        const result = await this.extractWithRetry(targetPath, strategy.mode, 1);

        if (result.success) {
          const confidence = this.calculateConfidence(result);
          const hasWordSplitting = this.detectWordSplitting(result.text);

          results.push({
            ...result,
            confidence: confidence,
            hasWordSplitting: hasWordSplitting,
            strategy: strategyName,
            path: targetPath
          });

          console.log(`✅ ${strategyName}: ${confidence}% güven, ${result.text.length} karakter`);

          // Geçici dosyaları temizle
          if (strategy.rotation !== 0) {
            try {
              fs.unlinkSync(targetPath);
            } catch (e) {
              console.warn('Geçici dosya temizlenemedi:', e.message);
            }
          }
        }
      } catch (error) {
        console.warn(`${strategy.type} strateji hatası:`, error.message);
      }
    }

    return results;
  }

  /**
   * Python ile istediğin açıda rotation uygular
   */
  async applyRotation(imagePath, degrees) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'preprocessing', 'rotate_image.py');
      const fileName = path.basename(imagePath, path.extname(imagePath));
      const ext = path.extname(imagePath);
      const outputPath = path.join(path.dirname(imagePath), `${fileName}_rotated_${degrees}${ext}`);

      const pythonProcess = spawn('python', [scriptPath, imagePath, outputPath, degrees.toString()], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          console.warn(`Rotation ${degrees}° başarısız:`, stderr);
          resolve(null);
        }
      });

      pythonProcess.on('error', (error) => {
        console.warn(`Rotation ${degrees}° script hatası:`, error.message);
        resolve(null);
      });
    });
  }

  /**
   * Python ile 90° saat yönü rotation uygular (geriye uyumluluk için)
   */
  async apply90DegreeRotation(imagePath) {
    return this.applyRotation(imagePath, 90);
  }

  /**
   * Metni tablo formatına dönüştür (TAB ve NEW LINE)
   * Genel algoritma ile herhangi bir tabloyu algılar ve düzenler
   */
  convertToTableFormat(text) {
    if (!text) return text;

    // Önce satırlara böl ve temizle
    const lines = text.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (lines.length === 0) return text;

    // Tek satırlık metinse olduğu gibi döndür
    if (lines.length === 1) {
      return lines[0];
    }

    // Tablo yapısını otomatik olarak algıla
    const tableStructure = this.analyzeTableStructure(lines);
    console.log(`📊 Tespit edilen tablo yapısı: ${tableStructure.rows}x${tableStructure.cols} (${lines.length} hücre)`);

    if (tableStructure.rows > 1 && tableStructure.cols > 1) {
      // Çoklu sütun tablo için yeniden düzenle
      const formattedTable = this.formatAsTable(lines, tableStructure.rows, tableStructure.cols);
      return formattedTable;
    }

    // Normal tablo formatı için (tek sütun veya düz metin)
    const formattedLines = lines.map(line => {
      // Çoklu boşlukları TAB'e çevir
      let formattedLine = line
        .replace(/\s{2,}/g, '\t')  // 2+ boşluk = TAB
        .replace(/\|\s*/g, '\t')   // | işaretleri = TAB
        .replace(/\s*\|\s*/g, '\t') // Boşluklu | = TAB
        .replace(/\s*,\s*/g, '\t') // Virgüller = TAB
        .replace(/\s+/g, '\t');    // Kalan çoklu boşluklar = TAB

      // Fazla TAB'leri temizle (en fazla 1 TAB)
      formattedLine = formattedLine.replace(/\t{2,}/g, '\t');

      // Baş ve sondaki TAB'leri kaldır
      formattedLine = formattedLine.replace(/^\t+|\t+$/g, '');

      return formattedLine;
    }).filter(line => line.length > 0);

    // Tekrar birleştir (her satır kendi new line'ında)
    return formattedLines.join('\n');
  }

  /**
   * Tablo yapısını analiz eder ve en uygun satır/sütun kombinasyonunu bulur
   */
  analyzeTableStructure(lines) {
    const totalCells = lines.length;

    // Mümkün olan tüm faktör kombinasyonlarını dene
    const factors = this.getFactors(totalCells);

    // Kareye en yakın olanı seç (en dengeli tablo)
    let bestStructure = { rows: totalCells, cols: 1, score: 0 };

    for (const rows of factors) {
      const cols = totalCells / rows;

      // Kareye yakınlık skorunu hesapla (1 = mükemmel kare)
      const squareScore = Math.min(rows / cols, cols / rows);
      const totalScore = squareScore + (rows > cols ? 0.1 : 0); // Satır ağırlıklı tercih

      if (totalScore > bestStructure.score) {
        bestStructure = { rows, cols, score: totalScore };
      }
    }

    return { rows: bestStructure.rows, cols: bestStructure.cols };
  }

  /**
   * Bir sayının tüm pozitif faktörlerini döndürür
   */
  getFactors(n) {
    const factors = [];
    for (let i = 1; i <= Math.sqrt(n); i++) {
      if (n % i === 0) {
        factors.push(i);
        if (i !== n / i) factors.push(n / i);
      }
    }
    return factors.sort((a, b) => a - b);
  }

  /**
   * Hücreleri tablo formatına dönüştürür
   */
  formatAsTable(cells, rows, cols) {
    const tableRows = [];

    for (let i = 0; i < rows; i++) {
      const startIdx = i * cols;
      const endIdx = startIdx + cols;
      const rowCells = cells.slice(startIdx, endIdx);
      const rowString = rowCells.join('\t');
      tableRows.push(rowString);
    }

    return tableRows.join('\n');
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
    if (!result.success || !result.text) {
      console.log('⚠️ Güven skoru hesaplanamadı: Başarısız sonuç veya boş metin');
      return 0;
    }

    let confidence = 50; // Baz puan
    let factors = [];

    // Metin uzunluğu faktörü
    if (result.text.length > 100) {
      confidence += 20;
      factors.push(`Uzun metin (+20)`);
    } else if (result.text.length > 50) {
      confidence += 10;
      factors.push(`Orta uzunluk (+10)`);
    } else {
      factors.push(`Kısa metin (0)`);
    }

    // Özel karakterler faktörü (tablo işaretleri)
    if (result.text.includes('\t') || result.text.includes('|')) {
      confidence += 15;
      factors.push(`Tablo işaretleri (+15)`);
    }

    // Türkçe karakterler faktörü
    const turkishChars = ['ç', 'ğ', 'ı', 'ö', 'ş', 'ü', 'Ç', 'Ğ', 'İ', 'Ö', 'Ş', 'Ü'];
    const hasTurkishChars = turkishChars.some(char => result.text.includes(char));
    if (hasTurkishChars) {
      confidence += 10;
      factors.push(`Türkçe karakterler (+10)`);
    }

    // İşlem süresi faktörü (çok hızlı = potansiyel problem)
    if (result.elapsedMs && result.elapsedMs > 5000) {
      confidence += 5;
      factors.push(`Uzun işlem süresi (+5)`);
    } else if (result.elapsedMs && result.elapsedMs < 2000) {
      confidence -= 5;
      factors.push(`Çok hızlı işlem (-5)`);
    }

    // Kelime bölünmesi cezası
    const hasWordSplitting = this.detectWordSplitting(result.text);
    if (hasWordSplitting) {
      confidence -= 20;
      factors.push(`Kelime bölünmesi (-20)`);
    }

    const finalConfidence = Math.min(Math.max(confidence, 0), 100);

    console.log(`📊 Güven skoru hesaplama: ${finalConfidence}%`);
    console.log(`   Faktörler: ${factors.join(', ')}`);
    console.log(`   Metin uzunluğu: ${result.text.length} karakter`);

    return finalConfidence;
  }

  /**
   * Sonuçları karşılaştırmak için kapsamlı skor hesaplar
   */
  scoreResult(result, confidence, hasWordSplitting) {
    let score = confidence;

    // Kelime bölünmesi çok ciddi bir ceza
    if (hasWordSplitting) {
      score -= 50; // Daha ağır ceza
    }

    // Metin kalitesi bonusları
    const textLength = result.text ? result.text.length : 0;

    // Çok kısa metin cezası
    if (textLength < 20) {
      score -= 15;
    }

    // Çok uzun metin bonusu
    if (textLength > 200) {
      score += 10;
    }

    // Metin çeşitliliği kontrolü (farklı kelime sayısı)
    const words = result.text ? result.text.split(/\s+/).filter(w => w.length > 2) : [];
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));

    if (uniqueWords.size > 5) {
      score += 15;
      console.log(`   📝 Çeşitli kelimeler tespit edildi (+15)`);
    } else if (uniqueWords.size > 2) {
      score += 5;
      console.log(`   📝 Bazı kelimeler tespit edildi (+5)`);
    }

    return Math.max(score, 0);
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
