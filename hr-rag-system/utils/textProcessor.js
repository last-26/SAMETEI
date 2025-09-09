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
      this.localQwenVL = new LocalQwenVL(config.ocr.qwenVL.apiUrl || 'http://localhost:8000');
      
      // Config'den timeout ayarlarını al
      if (config.ocr.qwenVL.timeout !== undefined) {
        this.localQwenVL.timeout = config.ocr.qwenVL.timeout;
      }
      if (config.ocr.qwenVL.maxRetries !== undefined) {
        this.localQwenVL.maxRetries = config.ocr.qwenVL.maxRetries;
      }
      
      console.log(`[TextProcessor] Qwen2.5-VL OCR API bağlantısı hazır (timeout: ${this.localQwenVL.timeout || 'sınırsız'})`);
      
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
  async convertPdfToImage(pdfPath, pageNumber = 1) {
    try {
      const { spawn } = require('child_process');
      const tempDir = path.join(__dirname, '..', 'temp');
      
      // Temp dizin yoksa oluştur
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const outputPath = path.join(tempDir, `temp_page${pageNumber}_${Date.now()}.png`);
      
      // Python ile PDF'i image'a çevir
      const pythonScript = `
# -*- coding: utf-8 -*-
import sys
from pdf2image import convert_from_path
import os
import io

# UTF-8 encoding için
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

pdf_path = sys.argv[1]
output_path = sys.argv[2]
page_num = int(sys.argv[3]) if len(sys.argv) > 3 else 1

try:
    # Belirtilen sayfayı PNG'ye çevir
    images = convert_from_path(pdf_path, first_page=page_num, last_page=page_num, dpi=300)
    if images:
        images[0].save(output_path, 'PNG')
        print(output_path)
    else:
        print("ERROR: No images converted")
except Exception as e:
    print(f"ERROR: {str(e)}")
`;
      
      const tempScriptPath = path.join(tempDir, `convert_${Date.now()}.py`);
      fs.writeFileSync(tempScriptPath, pythonScript, 'utf8');
      
      return new Promise((resolve) => {
        const python = spawn('python', [tempScriptPath, pdfPath, outputPath, pageNumber.toString()], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let output = '';
        
        python.stdout.on('data', (data) => {
          output += data.toString('utf8');
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
   * İki metin arasındaki benzerlik oranını hesapla (Jaccard similarity)
   */
  calculateTextSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    // Metinleri temizle ve kelimelere böl
    const words1 = new Set(text1.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));
    
    // Jaccard similarity: intersection / union
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Metinlerin duplicate olup olmadığını kontrol et
   */
  isDuplicateText(text1, text2, threshold = 0.7) {
    const similarity = this.calculateTextSimilarity(text1, text2);
    console.log(`[Duplicate Check] Benzerlik oranı: ${(similarity * 100).toFixed(1)}% (eşik: ${(threshold * 100)}%)`);
    return similarity >= threshold;
  }

  /**
   * Birden fazla metin kaynağını birleştir ve duplicateları temizle
   */
  mergeDedupedTexts(sources) {
    if (!sources || sources.length === 0) return [];
    if (sources.length === 1) return sources;

    const uniqueTexts = [];
    const processedTexts = [];

    for (const source of sources) {
      if (!source.content || source.content.trim().length < 20) continue;

      let isDuplicate = false;
      for (const existing of processedTexts) {
        if (this.isDuplicateText(source.content, existing.content)) {
          console.log(`[Duplicate] ${source.type} içeriği ${existing.type} ile benzer, atlandı`);
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        uniqueTexts.push(source);
        processedTexts.push(source);
        console.log(`[Unique] ${source.type} içeriği eklendi (${source.content.length} karakter)`);
      }
    }

    return uniqueTexts;
  }

  /**
   * PDF'i sayfa bazında metne böl
   */
  async extractPageTexts(pdfPath) {
    try {
      const { spawn } = require('child_process');
      const tempDir = path.join(__dirname, '..', 'temp');
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Python ile PDF'deki her sayfanın metnini ayrı ayrı çıkar
      const pythonScript = `
# -*- coding: utf-8 -*-
import sys
import fitz  # PyMuPDF
import json
import io

# UTF-8 encoding için
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

pdf_path = sys.argv[1]

try:
    doc = fitz.open(pdf_path)
    page_texts = {}
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text().strip()
        # Boş veya çok kısa metinleri filtrele
        if len(text) > 5:
            page_texts[str(page_num + 1)] = text  # 1-based sayfa numarası
        else:
            page_texts[str(page_num + 1)] = ""
    
    doc.close()
    print(json.dumps(page_texts, ensure_ascii=False, indent=None))
        
except Exception as e:
    print(f"ERROR: {str(e)}")
`;
      
      const tempScriptPath = path.join(tempDir, `extract_pages_${Date.now()}.py`);
      fs.writeFileSync(tempScriptPath, pythonScript, 'utf8');
      
      return new Promise((resolve) => {
        const python = spawn('python', [tempScriptPath, pdfPath], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let output = '';
        
        python.stdout.on('data', (data) => {
          output += data.toString('utf8');
        });
        
        python.on('close', (code) => {
          // Geçici script dosyasını temizle
          if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
          }
          
          const outputStr = output.trim();
          
          if (!outputStr.startsWith('ERROR:')) {
            try {
              const pageTexts = JSON.parse(outputStr);
              resolve(pageTexts);
            } catch (e) {
              console.error('[PDF Page Extract] JSON parse hatası:', e.message);
              resolve({});
            }
          } else {
            console.error('[PDF Page Extract] Python hatası:', outputStr);
            resolve({});
          }
        });
      });
      
    } catch (error) {
      console.error('[PDF Page Extract] Hata:', error.message);
      return {};
    }
  }

  /**
   * PDF'deki tüm sayfaları kontrol et ve resim içeren sayfaları tespit et
   */
  async detectPagesWithImages(pdfPath) {
    try {
      const { spawn } = require('child_process');
      const tempDir = path.join(__dirname, '..', 'temp');
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Python ile PDF'deki resimleri tespit et
      const pythonScript = `
# -*- coding: utf-8 -*-
import sys
from pdf2image import convert_from_path
import fitz  # PyMuPDF
import os
import io

# UTF-8 encoding için
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

pdf_path = sys.argv[1]

try:
    # PDF'i aç
    doc = fitz.open(pdf_path)
    pages_with_images = []
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        image_list = page.get_images()
        text_length = len(page.get_text().strip())
        
        # Sayfa resim içeriyorsa veya çok az metin içeriyorsa OCR gerekli
        if len(image_list) > 0 or text_length < 50:
            pages_with_images.append(page_num + 1)  # 1-based sayfa numarası
    
    doc.close()
    
    if pages_with_images:
        print("PAGES_WITH_IMAGES:" + ",".join(map(str, pages_with_images)))
    else:
        print("NO_IMAGES_FOUND")
        
except Exception as e:
    # Fallback: pdf2image ile kontrol et
    try:
        images = convert_from_path(pdf_path, dpi=150)
        total_pages = len(images)
        print(f"FALLBACK_ALL_PAGES:1-{total_pages}")
    except Exception as e2:
        print(f"ERROR: {str(e2)}")
`;
      
      const tempScriptPath = path.join(tempDir, `detect_images_${Date.now()}.py`);
      fs.writeFileSync(tempScriptPath, pythonScript, 'utf8');
      
      return new Promise((resolve) => {
        const python = spawn('python', [tempScriptPath, pdfPath], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let output = '';
        
        python.stdout.on('data', (data) => {
          output += data.toString('utf8');
        });
        
        python.on('close', (code) => {
          // Geçici script dosyasını temizle
          if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
          }
          
          const outputStr = output.trim();
          
          if (outputStr.startsWith('PAGES_WITH_IMAGES:')) {
            const pageNumbers = outputStr.replace('PAGES_WITH_IMAGES:', '').split(',').map(num => parseInt(num));
            resolve(pageNumbers);
          } else if (outputStr.startsWith('FALLBACK_ALL_PAGES:')) {
            const range = outputStr.replace('FALLBACK_ALL_PAGES:', '');
            const [start, end] = range.split('-').map(num => parseInt(num));
            const allPages = Array.from({length: end - start + 1}, (_, i) => start + i);
            resolve(allPages);
          } else if (outputStr === 'NO_IMAGES_FOUND') {
            resolve([]);
          } else {
            console.error('[PDF Image Detection] Python hatası:', outputStr);
            resolve([]);
          }
        });
      });
      
    } catch (error) {
      console.error('[PDF Image Detection] Hata:', error.message);
      return [];
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
        
        console.log(`[PDF] ${path.basename(filePath)} - ${pdfData.numpages} sayfa başlatılıyor`);

        // 1. Resim içeren sayfaları tespit et
        const pagesWithImages = await this.detectPagesWithImages(filePath);
        console.log(`[PDF] Resim içeren sayfalar: ${pagesWithImages.length > 0 ? pagesWithImages.join(', ') : 'yok'}`);

        // 2. Sayfa bazında metinleri çıkar
        const pageTexts = await this.extractPageTexts(filePath);
        console.log(`[PDF] ${Object.keys(pageTexts).length} sayfa metni çıkarıldı`);

        let allContent = [];

        // 3. Sıralı işleme: Her sayfayı sırayla işle
        for (let pageNum = 1; pageNum <= pdfData.numpages; pageNum++) {
          const isImagePage = pagesWithImages.includes(pageNum);
          
          if (isImagePage && this.localQwenVL && config.ocr?.qwenVL?.enabled) {
            // Resim içeren sayfa: Hibrit işleme (PDF Text + Text OCR + Table OCR)
            try {
              console.log(`[PDF] Sayfa ${pageNum}: Hibrit işleme başlatılıyor...`);
              
              // 1. Normal PDF metni al (hızlı)
              const pageText = pageTexts[pageNum.toString()];
              const sources = [];

              if (pageText && pageText.length > 10) {
                sources.push({
                  content: this.cleanText(pageText),
                  type: 'pdf_text',
                  source: 'pdf_parser'
                });
                console.log(`[PDF] Sayfa ${pageNum}: PDF metin çıkarıldı (${pageText.length} karakter)`);
              }

              // 2. OCR işlemleri
              const imagePath = await this.convertPdfToImage(filePath, pageNum);
              if (imagePath) {
                console.log(`[PDF] Sayfa ${pageNum}: OCR işlemleri başlatılıyor...`);
                
                // 2a. Text OCR (paragraflar, normal metinler için)
                try {
                  const textOcrResult = await this.localQwenVL.extractFromImage(imagePath, 'text');
                  if (textOcrResult.success && textOcrResult.text && textOcrResult.text.length > 20) {
                    sources.push({
                      content: textOcrResult.text.trim(),
                      type: 'ocr_text',
                      source: 'qwen2.5-vl',
                      processingTime: textOcrResult.processingTime,
                      tokensUsed: textOcrResult.tokensUsed
                    });
                    console.log(`[PDF] Sayfa ${pageNum}: Text OCR tamamlandı (${textOcrResult.text.length} karakter, ${textOcrResult.elapsedMs}ms)`);
                  }
                } catch (e) {
                  console.error(`[PDF] Sayfa ${pageNum} Text OCR hatası:`, e.message);
                }

                // 2b. Table OCR (tablolar, formlar için)
                try {
                  const tableOcrResult = await this.localQwenVL.extractFromImage(imagePath, 'table');
                  if (tableOcrResult.success && tableOcrResult.text && tableOcrResult.text.length > 20) {
                    sources.push({
                      content: tableOcrResult.text.trim(),
                      type: 'ocr_table',
                      source: 'qwen2.5-vl',
                      processingTime: tableOcrResult.processingTime,
                      tokensUsed: tableOcrResult.tokensUsed
                    });
                    console.log(`[PDF] Sayfa ${pageNum}: Table OCR tamamlandı (${tableOcrResult.text.length} karakter, ${tableOcrResult.elapsedMs}ms)`);
                  }
                } catch (e) {
                  console.error(`[PDF] Sayfa ${pageNum} Table OCR hatası:`, e.message);
                }

                // Geçici image dosyasını temizle
                if (fs.existsSync(imagePath)) {
                  fs.unlinkSync(imagePath);
                }
              }

              // 3. Duplicate kontrolü ve birleştirme
              console.log(`[PDF] Sayfa ${pageNum}: ${sources.length} kaynak bulundu, duplicate kontrolü yapılıyor...`);
              const uniqueSources = this.mergeDedupedTexts(sources);

              // 4. Benzersiz içerikleri chunk'la
              let pageChunkCount = 0;
              for (const source of uniqueSources) {
                const chunks = this.chunkText(source.content, {
                  ...metadata,
                  source: path.basename(filePath),
                  type: 'pdf_document',
                  pageNumber: pageNum,
                  totalPages: pdfData.numpages,
                  ocrProcessed: source.type.startsWith('ocr_'),
                  ocrProvider: source.source === 'qwen2.5-vl' ? 'qwen2.5-vl' : undefined,
                  ocrModel: source.source === 'qwen2.5-vl' ? 'Qwen2.5-VL-3B-Instruct' : undefined,
                  contentType: source.type,
                  processingTime: source.processingTime,
                  tokensUsed: source.tokensUsed
                });
                
                allContent = allContent.concat(chunks);
                pageChunkCount += chunks.length;
              }

              console.log(`[PDF] ✅ Sayfa ${pageNum}: ${pageChunkCount} chunk (${uniqueSources.length} benzersiz kaynak)`);

            } catch (e) {
              console.error(`[PDF] Sayfa ${pageNum} hibrit işleme hatası:`, e.message);
              
              // Hata durumunda normal metni kullan
              const pageText = pageTexts[pageNum.toString()];
              if (pageText && pageText.length > 10) {
                const textChunks = this.chunkText(this.cleanText(pageText), {
                  ...metadata,
                  source: path.basename(filePath),
                  type: 'pdf_document',
                  pageNumber: pageNum,
                  totalPages: pdfData.numpages,
                  ocrProcessed: false,
                  fallbackFromOcr: true
                });
                allContent = allContent.concat(textChunks);
                console.log(`[PDF] ⚠️ Sayfa ${pageNum}: Fallback ile ${textChunks.length} chunk`);
              }
            }
          } else {
            // Normal sayfa: Direkt metin işle
            const pageText = pageTexts[pageNum.toString()];
            if (pageText && pageText.length > 10) {
              const textChunks = this.chunkText(this.cleanText(pageText), {
                ...metadata,
                source: path.basename(filePath),
                type: 'pdf_document',
                pageNumber: pageNum,
                totalPages: pdfData.numpages,
                ocrProcessed: false
              });
              allContent = allContent.concat(textChunks);
              console.log(`[PDF] ✅ Sayfa ${pageNum}: ${textChunks.length} metin chunk`);
            } else {
              console.log(`[PDF] ⚪ Sayfa ${pageNum}: Boş veya çok az metin`);
            }
          }
        }

        // Sonuç raporu
        const ocrChunks = allContent.filter(chunk => chunk.metadata.ocrProcessed);
        const textChunks = allContent.filter(chunk => !chunk.metadata.ocrProcessed);
        const textOcrChunks = allContent.filter(chunk => chunk.metadata.contentType === 'ocr_text');
        const tableOcrChunks = allContent.filter(chunk => chunk.metadata.contentType === 'ocr_table');
        const pdfTextChunks = allContent.filter(chunk => chunk.metadata.contentType === 'pdf_text' || !chunk.metadata.contentType);
        
        console.log(`[PDF] ✅ ${path.basename(filePath)} tamamlandı:`);
        console.log(`  - Toplam chunk: ${allContent.length}`);
        console.log(`  - PDF metin chunk: ${pdfTextChunks.length}`);
        console.log(`  - Text OCR chunk: ${textOcrChunks.length}`);
        console.log(`  - Table OCR chunk: ${tableOcrChunks.length}`);
        console.log(`  - Resim sayfaları: ${pagesWithImages.join(', ')}`);
        console.log(`  - İşlenen sayfalar: 1-${pdfData.numpages}`);

        return allContent.length > 0 ? allContent : [{
          content: 'PDF işlenemedi',
          metadata: {
            ...metadata,
            source: path.basename(filePath),
            type: 'pdf_document',
            pageCount: pdfData.numpages || undefined,
            error: 'no_content_extracted'
          }
        }];
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