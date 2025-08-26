const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { encoding_for_model } = require('tiktoken');
const config = require('../config');

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
          
          if (wordTokens + wordTokenCount > this.chunkSize && wordChunk) {
            chunks.push(this.createChunk(wordChunk.trim(), metadata, chunks.length));
            wordChunk = '';
            wordTokens = 0;
          }
          
          wordChunk += word + ' ';
          wordTokens += wordTokenCount;
        }
        
        if (wordChunk.trim()) {
          chunks.push(this.createChunk(wordChunk.trim(), metadata, chunks.length));
        }
        
        continue;
      }
      
      // Normal chunk işlemi
      if (currentTokens + sentenceTokens > this.chunkSize && currentChunk) {
        chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
        
        // Overlap için son cümleleri korу
        const overlapSentences = this.getLastSentences(currentChunk, this.chunkOverlap);
        currentChunk = overlapSentences + sentence + ' ';
        currentTokens = this.getTokenCount(currentChunk);
      } else {
        currentChunk += sentence + ' ';
        currentTokens += sentenceTokens;
      }
    }
    
    // Son chunk'ı ekle
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
    }
    
    return chunks;
  }

  /**
   * Cümlelere ayır (Türkçe uyumlu)
   */
  splitIntoSentences(text) {
    // Türkçe noktalama işaretleri de dahil
    const sentenceEnders = /[.!?;]\s+/g;
    let sentences = text.split(sentenceEnders);
    
    // Boş cümleleri filtrele ve temizle
    return sentences
      .map(s => s.trim())
      .filter(s => s.length > 10); // Çok kısa cümleleri atla
  }

  /**
   * Son N token kadar cümleleri al (overlap için)
   */
  getLastSentences(text, tokenLimit) {
    const sentences = this.splitIntoSentences(text);
    let overlapText = '';
    let tokenCount = 0;
    
    for (let i = sentences.length - 1; i >= 0; i--) {
      const sentence = sentences[i];
      const sentenceTokens = this.getTokenCount(sentence);
      
      if (tokenCount + sentenceTokens > tokenLimit) {
        break;
      }
      
      overlapText = sentence + ' ' + overlapText;
      tokenCount += sentenceTokens;
    }
    
    return overlapText;
  }

  /**
   * Chunk objesi oluştur
   */
  createChunk(content, metadata, index) {
    return {
      content: content.trim(),
      metadata: {
        ...metadata,
        chunkIndex: index,
        tokenCount: this.getTokenCount(content),
        createdAt: new Date()
      }
    };
  }

  /**
   * Mevcut hr_procedures.csv'yi işle
   */
  async processHRProcedures(csvPath = '../hr_procedures.csv') {
    try {
      const fullPath = require('path').resolve(__dirname, csvPath);
      const qaData = await this.processCSV(fullPath);
      
      // Her soru-cevap çiftini zaten optimal boyutta olduğu için chunk'lamaya gerek yok
      const processedData = qaData.map((item, index) => ({
        ...item,
        metadata: {
          ...item.metadata,
          chunkIndex: index,
          tokenCount: this.getTokenCount(item.content),
          processedAt: new Date()
        }
      }));
      
      console.log(`✅ HR Prosedürleri işlendi: ${processedData.length} kayıt`);
      return processedData;
    } catch (error) {
      console.error('❌ HR prosedürleri işleme hatası:', error);
      throw error;
    }
  }

  /**
   * Genel dokuman işleme (PDF, Word, txt için genişletilebilir)
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
        const text = this.cleanText(pdfData.text || '');
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
