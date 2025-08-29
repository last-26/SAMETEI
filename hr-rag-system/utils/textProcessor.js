const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { encoding_for_model } = require('tiktoken');
const config = require('../config');
// OCR import'ları kaldırıldı, sadece Python bridge kullanılacak
const { runPythonOCR } = require('./ocr_bridge');

class TextProcessor {
  constructor() {
    this.chunkSize = config.rag.chunkSize;
    this.chunkOverlap = config.rag.chunkOverlap;
    
    try {
      this.encoder = encoding_for_model('gpt-3.5-turbo');
    } catch (error) {
      console.warn('⚠️ Tiktoken encoder yüklenemedi, alternatif kullanılacak');
      this.encoder = null;
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
    return text
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
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
      // 50 karakterden azsa büyük olasılıkla görüntü tabanlıdır
      return text.length < (config.ocr?.minTextThreshold || 50);
    } catch (e) {
      // Hata durumunda güvenli tarafta kal: OCR uygula
      return true;
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
        const needOcr = text.length < (config.ocr?.minTextThreshold || 50) || await this.isImageBasedPdf(filePath);
        
        if (needOcr) {
          try {
            console.log(`[OCR] Python OCR çağrılıyor: ${path.basename(filePath)}`);
            const py = await runPythonOCR(filePath, { 
              lang: process.env.TESSERACT_LANG || 'tur+eng', 
              dpi: config.ocr?.dpi || 450
            });
            
            if (py && py.text && py.text.length > 10) {
              text = this.cleanText(py.text);
              console.log(`[OCR] Python OCR başarılı, ${text.length} karakter okundu`);
            }
          } catch (e) {
            console.error(`[OCR] Python OCR hatası:`, e.message);
            // OCR başarısız olsa bile mevcut metni kullan
          }
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
      .trim();
  }
}

module.exports = TextProcessor;