const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { encoding_for_model } = require('tiktoken');
const config = require('../config');
// OCR import'ları - Sadece Qwen2.5-VL OCR
const LocalQwenVL = require('./localQwenVL'); // Ana ve tek OCR sistemi

class TextProcessor {
  constructor() {
    this.chunkSize = config.rag.chunkSize;
    this.chunkOverlap = config.rag.chunkOverlap;
    
    // Qwen2.5-VL OCR instance'ı oluştur (EN YÜKSEK ÖNCELİK)
    if (config.ocr?.qwenVL?.enabled) {
      this.localQwenVL = new LocalQwenVL('http://localhost:8000');
      console.log('[TextProcessor] Qwen2.5-VL OCR API bağlantısı hazır');
      
      // Başlangıçta sağlık kontrolü yap
      this.checkQwenVLHealth();
    } else {
      this.localQwenVL = null;
      console.log('[TextProcessor] Qwen2.5-VL OCR devre dışı');
    }

    
    try {
      this.encoder = encoding_for_model('gpt-3.5-turbo');
    } catch (error) {
      console.warn('⚠️ Tiktoken encoder yüklenemedi, alternatif kullanılacak');
      this.encoder = null;
    }
  }

  /**
   * Qwen2.5-VL sağlık kontrolü
   */
  async checkQwenVLHealth() {
    if (this.localQwenVL) {
      try {
        const health = await this.localQwenVL.checkHealth();
        if (health.status === 'healthy') {
          console.log('[TextProcessor] ✅ Qwen2.5-VL OCR API çalışıyor');
        } else {
          console.warn('[TextProcessor] ⚠️ Qwen2.5-VL OCR API hazır değil:', health.message);
        }
      } catch (error) {
        console.error('[TextProcessor] ❌ Qwen2.5-VL sağlık kontrolü hatası:', error.message);
      }
    }
  }

  /**
   * Token sayısını hesapla
   */
  getTokenCount(text) {
    if (this.encoder) {
      return this.encoder.encode(text).length;
    } else {
      // Alternatif yaklaşık hesaplama
      return Math.ceil(text.split(' ').length * 1.3);
    }
  }

  /**
   * CSV dosyasını oku ve parse et
   */
  async processCSV(filePath) {
    return new Promise((resolve, reject) => {
      const results = [];
      
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          // CSV'deki her satırı işle
          if (row.soru && row.cevap) {
            results.push({
              content: `SORU: ${row.soru}\n\nCEVAP: ${row.cevap}`,
              metadata: {
                source: 'hr_procedures.csv',
                category: row.kategori || 'genel',
                keywords: row.anahtar_kelimeler || '',
                type: 'qa_pair'
              }
            });
          }
        })
        .on('end', () => {
          console.log(`✅ CSV işlendi: ${results.length} soru-cevap çifti`);
          resolve(results);
        })
        .on('error', (error) => {
          console.error('❌ CSV okuma hatası:', error);
          reject(error);
        });
    });
  }

  /**
   * Metni chunk'lara böl
   */
  chunkText(text, metadata = {}) {
    const chunks = [];
    const sentences = this.splitIntoSentences(text);
    
    let currentChunk = '';
    let currentTokens = 0;
    
    for (const sentence of sentences) {
      const sentenceTokens = this.getTokenCount(sentence);
      
      // Eğer tek cümle chunk size'ı geçiyorsa, zorla böl
      if (sentenceTokens > this.chunkSize) {
        if (currentChunk) {
          chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
          currentChunk = '';
          currentTokens = 0;
        }
        
        // Uzun cümleyi kelime bazında böl
        const words = sentence.split(' ');
        let wordChunk = '';
        let wordTokens = 0;
        
        for (const word of words) {
          const wordTokenCount = this.getTokenCount(word);
          if (wordTokens + wordTokenCount > this.chunkSize) {
            if (wordChunk) {
              chunks.push(this.createChunk(wordChunk, metadata, chunks.length));
            }
            wordChunk = word;
            wordTokens = wordTokenCount;
          } else {
            wordChunk += (wordChunk ? ' ' : '') + word;
            wordTokens += wordTokenCount;
          }
        }
        
        if (wordChunk) {
          chunks.push(this.createChunk(wordChunk, metadata, chunks.length));
        }
        continue;
      }
      
      // Normal chunk işleme
      if (currentTokens + sentenceTokens > this.chunkSize) {
        chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
        
        // Overlap için önceki chunk'ın son kısmını al
        const overlapSentences = this.getOverlapContent(currentChunk);
        currentChunk = overlapSentences + ' ' + sentence;
        currentTokens = this.getTokenCount(currentChunk);
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
        currentTokens += sentenceTokens;
      }
    }
    
    // Son chunk'ı ekle
    if (currentChunk) {
      chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
    }
    
    return chunks;
  }

  /**
   * Cümlelere ayır
   */
  splitIntoSentences(text) {
    // Basit cümle ayırma (Türkçe için iyileştirilebilir)
    // T.C formatını korumak için önce geçici değiştir
    const tempText = text.replace(/T\.C/g, 'T_TEMP_C');
    
    const sentences = tempText
      .split(/[.!?\n]+/)
      .map(s => s.trim().replace(/T_TEMP_C/g, 'T.C'))
      .filter(s => s.length > 0);
    
    return sentences;
  }

  /**
   * Overlap için içerik al
   */
  getOverlapContent(text) {
    const tokens = this.getTokenCount(text);
    if (tokens <= this.chunkOverlap) {
      return text;
    }
    
    // Son chunkOverlap kadar token'ı al (yaklaşık)
    const words = text.split(' ');
    let overlapText = '';
    let overlapTokens = 0;
    
    for (let i = words.length - 1; i >= 0 && overlapTokens < this.chunkOverlap; i--) {
      const word = words[i];
      overlapText = word + (overlapText ? ' ' + overlapText : '');
      overlapTokens = this.getTokenCount(overlapText);
    }
    
    return overlapText;
  }

  /**
   * Chunk oluştur
   */
  createChunk(content, metadata, index) {
    return {
      content: content.trim(),
      metadata: {
        ...metadata,
        chunkIndex: index,
        tokenCount: this.getTokenCount(content.trim())
      }
    };
  }

  /**
   * PDF'in image-based olup olmadığını kontrol et
   */
  async isImageBasedPdf(pdfPath) {
    try {
      const buffer = fs.readFileSync(pdfPath);
      const data = await pdfParse(buffer);
      const text = this.cleanText(data.text || '');
      // Çok az metin varsa büyük olasılıkla görüntü tabanlıdır
      return text.length < (config.ocr?.minTextThreshold || 10);
    } catch (e) {
      // Hata durumunda güvenli tarafta kal: OCR uygula
      return true;
    }
  }

  /**
   * PDF'in ilk sayfasını image'a çevir (Python ile)
   */
  async convertPdfToImage(pdfPath) {
    try {
      const { spawn } = require('child_process');
      const tempDir = path.join(__dirname, '..', 'temp');
      
      // Temp dizin yoksa oluştur
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const outputPath = path.join(tempDir, `temp_${Date.now()}.png`);
      
      // Python ile PDF'i image'a çevir
      const pythonScript = `
import sys
from pdf2image import convert_from_path
import os

pdf_path = sys.argv[1]
output_path = sys.argv[2]

try:
    # PDF'in ilk sayfasını PNG'ye çevir
    images = convert_from_path(pdf_path, first_page=1, last_page=1, dpi=300)
    if images:
        images[0].save(output_path, 'PNG')
        print(output_path)
    else:
        print("ERROR: No images converted")
except Exception as e:
    print(f"ERROR: {e}")
`;
      
      const tempScriptPath = path.join(tempDir, `convert_${Date.now()}.py`);
      fs.writeFileSync(tempScriptPath, pythonScript);
      
      return new Promise((resolve) => {
        const python = spawn('python', [tempScriptPath, pdfPath, outputPath]);
        let output = '';
        
        python.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        python.on('close', (code) => {
          // Geçici script dosyasını temizle
          if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
          }
          
          if (code === 0 && output.trim() && !output.includes('ERROR')) {
            const imagePath = output.trim();
            if (fs.existsSync(imagePath)) {
              resolve(imagePath);
            } else {
              resolve(null);
            }
          } else {
            console.error('[PDF to Image] Python hatası:', output);
            resolve(null);
          }
        });
      });
      
    } catch (error) {
      console.error('[PDF to Image] Hata:', error.message);
      return null;
    }
  }

  /**
   * Dosyayı işle
   */
  async processDocument(filePath, metadata = {}) {
    const extension = filePath.split('.').pop().toLowerCase();

    switch (extension) {
      case 'csv': {
        return await this.processCSV(filePath);
      }
      case 'txt': {
        const txtContent = fs.readFileSync(filePath, 'utf-8');
        return this.chunkText(this.cleanText(txtContent), {
          ...metadata,
          source: path.basename(filePath),
          type: 'text_document'
        });
      }
      case 'pdf': {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(dataBuffer);
        let text = this.cleanText(pdfData.text || '');

        // OCR kontrolü: metin azsa veya image-based PDF ise OCR uygula
        const needOcr = text.length < (config.ocr?.minTextThreshold || 10) || await this.isImageBasedPdf(filePath);

        if (needOcr) {
          // ÖNCELİK 1: Qwen2.5-VL OCR (EN YÜKSEK ÖNCELİK)
          if (this.localQwenVL && config.ocr?.qwenVL?.enabled) {
            try {
              console.log(`[Qwen2.5-VL] Form/tablo analizi başlatılıyor: ${path.basename(filePath)}`);

              // PDF'i image'a çevir
              const imagePath = await this.convertPdfToImage(filePath);
              if (imagePath) {
                const qwenResult = await this.localQwenVL.extractFromImage(imagePath, 'table');

                if (qwenResult.success && qwenResult.text && qwenResult.text.length > 10) {
                  text = qwenResult.text;
                  console.log(`[Qwen2.5-VL] ✅ Başarılı: ${text.length} karakter, ${qwenResult.elapsedMs}ms`);

                  // Geçici image dosyasını temizle
                  if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                  }

                  return [{
                    content: text.trim(),
                    metadata: {
                      ...metadata,
                      source: path.basename(filePath),
                      type: 'pdf_document',
                      pageCount: 1,
                      ocrProcessed: true,
                      ocrProvider: 'qwen2.5-vl',
                      ocrModel: 'Qwen2.5-VL-3B-Instruct',
                      processingTime: qwenResult.processingTime,
                      tokensUsed: qwenResult.tokensUsed
                    }
                  }];
                }
              }
          } catch (e) {
            console.error(`[Qwen2.5-VL] PDF OCR hatası:`, e.message);
          }
          }


          // OCR başarısız oldu, normal metin işleme ile devam et
          console.log(`[OCR] Tüm OCR yöntemleri başarısız, normal PDF metin işleme ile devam ediliyor`);
        }

        return this.chunkText(text, {
          ...metadata,
          source: path.basename(filePath),
          type: 'pdf_document',
          pageCount: pdfData.numpages || undefined
        });
      }
      case 'docx': {
        const dataBuffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        const text = this.cleanText(result.value || '');
        return this.chunkText(text, {
          ...metadata,
          source: path.basename(filePath),
          type: 'docx_document'
        });
      }
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'bmp':
      case 'gif':
      case 'tiff':
      case 'webp': {
        // Görüntü dosyaları için direkt OCR
        let ocrText = '';
        let ocrMetadata = {};

        // ÖNCELİK 1: Qwen2.5-VL OCR (EN YÜKSEK ÖNCELİK)
        if (!ocrText && this.localQwenVL && config.ocr?.qwenVL?.enabled) {
          try {
            const qwenResult = await this.localQwenVL.extractFromImage(filePath, 'table');
            if (qwenResult.success && qwenResult.text) {
              ocrText = qwenResult.text;
              ocrMetadata = {
                ocrProvider: 'qwen2.5-vl',
                ocrModel: 'Qwen2.5-VL-3B-Instruct',
                processingTime: qwenResult.processingTime,
                tokensUsed: qwenResult.tokensUsed
              };
              console.log(`[Qwen2.5-VL] Görüntü başarılı: ${ocrText.length} karakter, ${qwenResult.elapsedMs}ms`);
            }
          } catch (e) {
            console.error(`[Qwen2.5-VL] Görüntü OCR hatası:`, e.message);
          }
        }

        
        if (ocrText) {
          return [{
            content: ocrText.trim(),
            metadata: {
              ...metadata,
              source: path.basename(filePath),
              type: 'image_document',
              ocrProcessed: true,
              ...ocrMetadata
            }
          }];
        }
        
        throw new Error('OCR başarısız oldu');
      }
      default: {
        throw new Error(`Desteklenmeyen dosya formatı: ${extension}`);
      }
    }
  }

  /**
   * Text temizleme
   */
  cleanText(text) {
    return text
      .replace(/\r\n/g, '\n')           // Windows satır sonları
      .replace(/\r/g, '\n')             // Mac satır sonları  
      .replace(/\n{3,}/g, '\n\n')       // Çoklu boş satırlar
      .replace(/\s{2,}/g, ' ')          // Çoklu boşluklar
      .replace(/\t/g, ' ')              // Tab karakterleri
      .replace(/T\.C/g, 'T.C')          // T.C formatını koru
      .trim();
  }

  /**
   * Türkçe metin geliştirme (OCR sonrası)
   */
  enhanceTurkishText(text) {
    if (!text) return text;
    
    // Türkçe karakter ve kelime düzeltmeleri
    const turkishFixes = {
      // OCR'da sık karışan karakterler
      'rn': 'm', 'ri': 'n', 'cl': 'd', 'Il': 'll',
      '0': 'O', '5': 'S', '1': 'I', '8': 'B', '6': 'G',
      // Türkçe kelime düzeltmeleri
      'Tanhi': 'Tarihi', 'tanhi': 'tarihi', 'Tanh': 'Tarih',
      'Yen': 'Yeri', 'yen': 'yeri', 'Ginş': 'Giriş', 'ginş': 'giriş',
      'Toni': 'Türü', 'toni': 'türü',
      'Binmi': 'Birimi', 'binmi': 'birimi',
      'Baslama': 'Başlama', 'baslama': 'başlama',
      'edenm': 'ederim', 'Edenm': 'Ederim',
      'Numarasi': 'Numarası', 'numarasi': 'numarası',
      'tanhler': 'tarihler', 'Tanhler': 'Tarihler',
      'belirtigim': 'belirttiğim', 'belirtiğim': 'belirttiğim',
      'iznin': 'iznin', 'İznin': 'İznin'
    };

    let enhanced = text;
    
    // Karakter düzeltmeleri
    for (const [wrong, correct] of Object.entries(turkishFixes)) {
      enhanced = enhanced.replace(new RegExp(wrong, 'g'), correct);
    }

    // Tablo yapısını koruma - | karakterlerini düzenle
    enhanced = enhanced.replace(/\s*\|\s*/g, ' | ');
    
    // Tarih formatlarını düzelt (OCR'da bozulan O ve I karakterleri)
    enhanced = enhanced.replace(/O(\d)/g, '0$1');  // O2 -> 02
    enhanced = enhanced.replace(/(\d)O/g, '$10');  // 2O -> 20
    enhanced = enhanced.replace(/(\d{2})\s+O(\d)/g, '$1.0$2');  // 02 O1 -> 02.01
    enhanced = enhanced.replace(/(\d{2})\s+(\d{2})\s+(\d{4})/g, '$1.$2.$3');  // 02 01 2020 -> 02.01.2020
    
    // I harfi düzeltmeleri (OCR'da 1 rakamı I olarak okunuyor)
    enhanced = enhanced.replace(/(\d{2})\s+I(\d)/g, '$1.0$2');  // 02 I1 -> 02.01
    enhanced = enhanced.replace(/(\d{2})\s+(\d{2})\s+I(\d{4})/g, '$1.$2.0$3');  // 02 01 I2020 -> 02.01.02020
    enhanced = enhanced.replace(/(\d{2})\s+I(\d)\s+(\d{4})/g, '$1.0$2.$3');  // 02 I1 2020 -> 02.01.2020
    
    // T.C düzeltmeleri - daha kapsamlı
    enhanced = enhanced.replace(/T\s*C(?!\w)/g, 'T.C');  // T C -> T.C
    enhanced = enhanced.replace(/T\s*Ç(?!\w)/g, 'T.C');  // T Ç -> T.C
    
    // Form alanları için düzenleme
    enhanced = enhanced.replace(/T C/g, 'T.C.');
    enhanced = enhanced.replace(/İZİN TALEP FORMU/g, 'İZİN TALEP FORMU');
    enhanced = enhanced.replace(/İŞVEREN ONAYI/g, 'İŞVEREN ONAYI');
    
    return enhanced;
  }
}

module.exports = TextProcessor;