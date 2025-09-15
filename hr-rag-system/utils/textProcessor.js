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
        
        // Tablo içeriği ise farklı strateji uygula
        if (this.isTableContent(sentence)) {
          // Tablo içeriği için satır bazlı bölme
          const tableLines = sentence.split('\n');
          let lineChunk = '';
          let lineTokens = 0;
          
          for (const line of tableLines) {
            const lineTokenCount = this.getTokenCount(line);
            if (lineTokens + lineTokenCount > this.chunkSize) {
              if (lineChunk) {
                chunks.push(this.createChunk(lineChunk, metadata, chunks.length));
              }
              lineChunk = line;
              lineTokens = lineTokenCount;
            } else {
              lineChunk += (lineChunk ? '\n' : '') + line;
              lineTokens += lineTokenCount;
            }
          }
          
          if (lineChunk) {
            chunks.push(this.createChunk(lineChunk, metadata, chunks.length));
          }
        } else {
          // Normal metin için kelime bazlı bölme
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
        }
        continue;
      }
      
      // Normal chunk işleme
      if (currentTokens + sentenceTokens > this.chunkSize) {
        chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
        
        // Overlap için önceki chunk'ın son kısmını al
        const overlapSentences = this.getOverlapContent(currentChunk);
        
        // Tablo içeriği için farklı birleştirme stratejisi
        const separator = this.isTableContent(sentence) || this.isTableContent(overlapSentences) ? '\n' : ' ';
        currentChunk = overlapSentences + separator + sentence;
        currentTokens = this.getTokenCount(currentChunk);
      } else {
        // Tablo içeriği için farklı birleştirme stratejisi
        const separator = this.isTableContent(sentence) || this.isTableContent(currentChunk) ? '\n' : ' ';
        currentChunk += (currentChunk ? separator : '') + sentence;
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
   * Cümlelere ayır (tablo formatını koruyan)
   */
  splitIntoSentences(text) {
    // Tablo içeriği tespit et
    if (this.hasTableContent(text)) {
      return this.splitTableAwareText(text);
    }
    
    // Normal metin için basit cümle ayırma (Türkçe için iyileştirilebilir)
    // T.C formatını korumak için önce geçici değiştir
    const tempText = text.replace(/T\.C/g, 'T_TEMP_C');
    
    const sentences = tempText
      .split(/[.!?\n]+/)
      .map(s => s.trim().replace(/T_TEMP_C/g, 'T.C'))
      .filter(s => s.length > 0);
    
    return sentences;
  }
  
  /**
   * Tablo içeriği tespit et
   */
  hasTableContent(text) {
    if (!text) return false;
    
    // Form ise tablo değil
    if (this.isFormContent(text)) return false;
    
    // TAB karakteri varlığını kontrol et
    const hasTabChars = text.includes('\t');
    
    // Çoklu satırda TAB karakteri varsa tablo muhtemel
    if (hasTabChars) {
      const lines = text.split('\n');
      let tabLines = 0;
      for (const line of lines) {
        if (line.includes('\t')) {
          tabLines++;
        }
      }
      // En az 2 satırda TAB varsa tablo
      return tabLines >= 2;
    }
    
    return false;
  }
  
  /**
   * Tablo formatını koruyarak metni böl
   */
  splitTableAwareText(text) {
    const lines = text.split('\n');
    const chunks = [];
    let currentTableBlock = '';
    let inTable = false;
    
    for (const line of lines) {
      const lineHasTabs = line.includes('\t');
      
      if (lineHasTabs) {
        // Tablo satırı
        if (!inTable && currentTableBlock) {
          // Önceki normal metni ekle
          chunks.push(...this.splitNormalText(currentTableBlock));
          currentTableBlock = '';
        }
        currentTableBlock += (currentTableBlock ? '\n' : '') + line;
        inTable = true;
      } else {
        // Normal metin satırı
        if (inTable && currentTableBlock) {
          // Tablo bloğunu ekle (bütün olarak)
          chunks.push(currentTableBlock);
          currentTableBlock = '';
        }
        currentTableBlock += (currentTableBlock ? '\n' : '') + line;
        inTable = false;
      }
    }
    
    // Son bloğu ekle
    if (currentTableBlock) {
      if (inTable) {
        chunks.push(currentTableBlock);
      } else {
        chunks.push(...this.splitNormalText(currentTableBlock));
      }
    }
    
    return chunks.filter(chunk => chunk.trim().length > 0);
  }
  
  /**
   * Normal metni cümlelere böl
   */
  splitNormalText(text) {
    // T.C formatını korumak için önce geçici değiştir
    const tempText = text.replace(/T\.C/g, 'T_TEMP_C');
    
    const sentences = tempText
      .split(/[.!?]+/)  // Sadece noktalama ile böl (newline'ı koruyoruz)
      .map(s => s.trim().replace(/T_TEMP_C/g, 'T.C'))
      .filter(s => s.length > 0);
    
    return sentences;
  }
  
  /**
   * Text parçasının tablo içeriği olup olmadığını kontrol et
   */
  isTableContent(text) {
    if (!text || typeof text !== 'string') return false;
    
    // Form içeriği değilse ve TAB içeriyorsa tablo
    return text.includes('\t') && !this.isFormContent(text);
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
      console.log(`[PDF→IMG] Sayfa ${pageNumber} image'a çevriliyor: ${path.basename(outputPath)}`);
      
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
    # Belirtilen sayfayı PNG'ye çevir (DPI düşürüldü: performans optimizasyonu)
    images = convert_from_path(pdf_path, first_page=page_num, last_page=page_num, dpi=150)
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
          
          console.log(`[PDF→IMG] Python işlemi tamamlandı - kod: ${code}, çıktı: "${output.trim()}"`);
          
          if (code === 0 && output.trim() && !output.includes('ERROR')) {
            const imagePath = output.trim();
            if (fs.existsSync(imagePath)) {
              console.log(`[PDF→IMG] ✅ Sayfa ${pageNumber} image başarıyla oluşturuldu: ${path.basename(imagePath)}`);
              resolve(imagePath);
            } else {
              console.error(`[PDF→IMG] ❌ Image dosyası oluşturulamadı: ${imagePath}`);
              resolve(null);
            }
          } else {
            console.error(`[PDF→IMG] ❌ Python hatası (kod: ${code}):`, output);
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
    console.log(`[Dedup] ${sources.length} kaynak duplicate kontrolünde...`);
    
    if (!sources || sources.length === 0) {
      console.log(`[Dedup] Boş kaynak listesi`);
      return [];
    }
    if (sources.length === 1) {
      console.log(`[Dedup] Tek kaynak, duplicate kontrolü atlandı`);
      return sources;
    }

    const uniqueTexts = [];
    const processedTexts = [];

    for (const [index, source] of sources.entries()) {
      console.log(`[Dedup] Kaynak ${index + 1}/${sources.length}: ${source.type} (${source.content?.length || 0} karakter)`);
      
      if (!source.content || source.content.trim().length < 5) { // 20'den 5'e düşürüldü
        console.warn(`[Dedup] ⚠️ Kaynak ${index + 1} çok kısa, atlandı: "${source.content?.substring(0, 50)}..."`);
        continue;
      }

      let isDuplicate = false;
      for (const existing of processedTexts) {
        if (this.isDuplicateText(source.content, existing.content)) {
          console.log(`[Dedup] 🔄 Kaynak ${index + 1} (${source.type}) duplicate → ${existing.type} ile benzer, atlandı`);
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        uniqueTexts.push(source);
        processedTexts.push(source);
        console.log(`[Dedup] ✅ Kaynak ${index + 1} (${source.type}) benzersiz → eklendi (${source.content.length} karakter)`);
      }
    }

    console.log(`[Dedup] 🎯 Sonuç: ${sources.length} → ${uniqueTexts.length} benzersiz kaynak`);
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
        return this.hrAwareChunkText(this.cleanText(txtContent), {
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
                
                // 2. Akıllı OCR Sistemi - Form tespit ile dinamik extraction
                try {
                  const startOcr = Date.now();
                  console.log(`[PDF] Sayfa ${pageNum}: 🔄 OCR başlıyor... (bekleyin, büyük resimler 1-2 dakika sürebilir)`);
                  
                  // Akıllı form tespit ve optimal OCR stratejisi
                  const ocrResult = await this.smartOCRWithFormDetection(imagePath);
                  const ocrDuration = Date.now() - startOcr;
                  console.log(`[PDF] Sayfa ${pageNum}: ✅ OCR tamamlandı (${(ocrDuration/1000).toFixed(1)}s) - type: ${ocrResult.detectedType}, textLength: ${ocrResult.text?.length || 0}`);
                  
                  if (ocrResult.success && ocrResult.text) {
                    const rawOcrContent = ocrResult.text.trim();
                    const ocrContent = this.cleanOCRText(rawOcrContent); // OCR format koruyucu temizlik
                    
                    // Minimum uzunluk kontrolü daha esnek yapıldı
                    if (ocrContent.length > 5) { // 20'den 5'e düşürdük
                      sources.push({
                        content: ocrContent,
                        type: `ocr_${ocrResult.detectedType}`,
                        source: 'qwen2.5-vl',
                        processingTime: ocrResult.processingTime,
                        tokensUsed: ocrResult.tokensUsed
                      });
                      console.log(`[PDF] Sayfa ${pageNum}: ✅ ${ocrResult.detectedType} OCR başarılı - ${ocrContent.length} karakter eklendi (${ocrResult.elapsedMs}ms)`);
                    } else {
                      console.warn(`[PDF] Sayfa ${pageNum}: ⚠️ OCR sonucu çok kısa: "${ocrContent}" (${ocrContent.length} karakter)`);
                    }
                  } else {
                    console.warn(`[PDF] Sayfa ${pageNum}: ⚠️ OCR başarısız - success: ${ocrResult.success}, text var: ${!!ocrResult.text}`);
                  }
                } catch (e) {
                  console.error(`[PDF] Sayfa ${pageNum}: ❌ Hybrid OCR hatası:`, e.message);
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
                const chunks = this.hrAwareChunkText(source.content, {
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
                const textChunks = this.hrAwareChunkText(this.cleanText(pageText), {
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
              const textChunks = this.hrAwareChunkText(this.cleanText(pageText), {
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
        return this.hrAwareChunkText(text, {
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

        // ÖNCELİK 1: Qwen2.5-VL OCR (AKILLI FORM TESPİT İLE)
        if (!ocrText && this.localQwenVL && config.ocr?.qwenVL?.enabled) {
          try {
            const ocrResult = await this.smartOCRWithFormDetection(filePath);
            if (ocrResult.success && ocrResult.text) {
              ocrText = this.cleanOCRText(ocrResult.text); // OCR format koruyucu temizlik
              ocrMetadata = {
                ocrProvider: 'qwen2.5-vl',
                ocrModel: 'Qwen2.5-VL-3B-Instruct',
                processingTime: ocrResult.processingTime,
                tokensUsed: ocrResult.tokensUsed,
                detectedType: ocrResult.detectedType
              };
              console.log(`[Qwen2.5-VL] Görüntü başarılı (${ocrResult.detectedType}): ${ocrText.length} karakter, ${ocrResult.elapsedMs}ms`);
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
   * Text temizleme (Normal belgeler için)
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
   * OCR Text temizleme (Format koruyucu)
   */
  cleanOCRText(text) {
    if (!text) return text;
    
    console.log('[OCR-Clean] OCR format koruyucu temizlik başlıyor...');
    
    let cleaned = text
      .replace(/\r\n/g, '\n')           // Windows satır sonları
      .replace(/\r/g, '\n')             // Mac satır sonları  
      .replace(/\n{4,}/g, '\n\n\n')     // 4+ boş satır → 3 boş satır
      .replace(/T\.C/g, 'T.C')          // T.C formatını koru
      .trim();
    
    // Form içeriği tespiti ve düzeltmesi (tablo formatından önce!)
    if (this.isFormContent(cleaned)) {
      console.log('[OCR-Clean] Form içeriği tespit edildi, dikey format uygulanıyor...');
      cleaned = this.fixFormFormatting(cleaned);
    } else {
      // Tablo formatı düzenlemesi (sadece form değilse)
      cleaned = this.cleanTableFormat(cleaned);
    }
    
    console.log('[OCR-Clean] ✅ OCR temizlik tamamlandı - format korundu');
    return cleaned;
  }
  
  /**
   * Form içeriği tespit et
   */
  isFormContent(text) {
    if (!text) return false;
    
    const formIndicators = [
      /FORM/i, /FORMU/i, /TALEP/i, /BAŞVURU/i,
      /T\.C.*Kimlik/i, /Adı.*Soyadı/i,
      /İzin.*Türü/i, /Çalışma.*Yeri/i,
      /İmza/i, /Tarih.*:/i
    ];
    
    // En az 2 form göstergesi varsa form olarak kabul et
    let matches = 0;
    for (const indicator of formIndicators) {
      if (indicator.test(text)) {
        matches++;
      }
    }
    
    return matches >= 2;
  }
  
  /**
   * Form formatını düzelt (yataydan dikeye)
   */
  fixFormFormatting(text) {
    let fixed = text;
    
    // Tab-separated form fields'ları newline'a çevir
    const lines = fixed.split('\n');
    const fixedLines = [];
    
    for (const line of lines) {
      if (line.includes('\t') && this.looksLikeFormFields(line)) {
        // Form alanlarını tab'dan ayır ve her birini yeni satıra koy
        const fields = line.split('\t')
          .map(field => field.trim())
          .filter(field => field.length > 0);
        
        // Boş veya sadece çizgi içeren alanları filtrele
        const meaningfulFields = fields.filter(field => 
          field.length > 0 && 
          !field.match(/^-+$/) && 
          !field.match(/^_+$/)
        );
        
        fixedLines.push(...meaningfulFields);
      } else {
        fixedLines.push(line);
      }
    }
    
    return fixedLines.join('\n');
  }
  
  /**
   * Satırın form alanları gibi göründüğünü kontrol et
   */
  looksLikeFormFields(line) {
    if (!line) return false;
    
    const fieldPatterns = [
      /Kimlik.*Numaras[ıi]/i,
      /Ad[ıi].*Soyad[ıi]/i,
      /Çal[ıi]şma.*Yeri/i,
      /G[oö]revi/i,
      /Telefon/i,
      /İzin.*T[uü]r[uü]/i,
      /Tarih/i,
      /S[uü]resi/i,
      /Adres/i
    ];
    
    return fieldPatterns.some(pattern => pattern.test(line));
  }

  /**
   * Akıllı OCR sistemi - Form tespit ile optimal extraction
   */
  async smartOCRWithFormDetection(imagePath) {
    try {
      console.log(`[Smart-OCR] 🧠 Akıllı form tespit başlıyor...`);
      
      // 1. AŞAMA: Hızlı text OCR ile içerik tipini tespit et
      const quickScanResult = await this.localQwenVL.extractFromImage(imagePath, 'text');
      
      if (!quickScanResult.success || !quickScanResult.text) {
        console.warn(`[Smart-OCR] ⚠️ Hızlı tarama başarısız, hybrid'e fallback`);
        return await this.localQwenVL.extractFromImage(imagePath, 'hybrid');
      }
      
      const quickText = quickScanResult.text;
      console.log(`[Smart-OCR] 📄 Hızlı tarama sonucu: ${quickText.substring(0, 100)}...`);
      
      // 2. AŞAMA: Form tespiti
      const isForm = this.isFormContent(quickText);
      console.log(`[Smart-OCR] 🔍 Form tespiti: ${isForm ? '✅ FORM' : '❌ TABLO/TEXT'}`);
      
      let finalResult;
      
      if (isForm) {
        // 3A. FORM TESPİT EDİLDİ - Form-optimized OCR yap
        console.log(`[Smart-OCR] 📋 Form tespit edildi, özel form OCR uygulanıyor...`);
        finalResult = await this.localQwenVL.extractFromImage(imagePath, 'form');
        
        // Form OCR başarısız olursa text sonucunu kullan
        if (!finalResult.success) {
          console.warn(`[Smart-OCR] ⚠️ Form OCR başarısız, text sonucu kullanılıyor`);
          finalResult = quickScanResult;
        }
        
        finalResult.detectedType = 'form';
      } else {
        // 3B. TABLO/TEXT - Hybrid OCR yap
        console.log(`[Smart-OCR] 📊 Tablo/Text tespit edildi, hybrid OCR uygulanıyor...`);
        finalResult = await this.localQwenVL.extractFromImage(imagePath, 'hybrid');
        
        // Hybrid başarısız olursa text sonucunu kullan
        if (!finalResult.success) {
          console.warn(`[Smart-OCR] ⚠️ Hybrid OCR başarısız, text sonucu kullanılıyor`);
          finalResult = quickScanResult;
        }
        
        finalResult.detectedType = 'hybrid';
      }
      
      console.log(`[Smart-OCR] ✅ Tamamlandı - tip: ${finalResult.detectedType}, uzunluk: ${finalResult.text?.length || 0}`);
      return finalResult;
      
    } catch (error) {
      console.error(`[Smart-OCR] ❌ Hata:`, error.message);
      // Hata durumunda basit hybrid OCR'a fallback
      return await this.localQwenVL.extractFromImage(imagePath, 'hybrid');
    }
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

    // TABLO FORMAT DÜZELTMESİ - OCR sonrası temizlik (önce table format düzelt)
    enhanced = this.cleanTableFormat(enhanced);
    
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

  /**
   * OCR sonrası tablo formatını düzenle
   */
  cleanTableFormat(text) {
    if (!text) return text;
    
    let cleaned = text;
    
    // 1. Gereksiz | karakterlerini temizle (OCR artifacts)
    cleaned = cleaned.replace(/\|\s*\|\s*\|/g, '|'); // ||| → |
    cleaned = cleaned.replace(/\|\s*\|/g, '|'); // || → |
    cleaned = cleaned.replace(/^\s*\|\s*/gm, ''); // Başlangıçtaki |
    cleaned = cleaned.replace(/\s*\|\s*$/gm, ''); // Sondaki |
    
    // 2. OCR'dan gelen bozuk table separatorları düzelt
    cleaned = cleaned.replace(/\s*\|\s*/g, '\t'); // | → TAB
    
    // 3. Çoklu TAB'ları tek TAB'a çevir
    cleaned = cleaned.replace(/\t+/g, '\t');
    
    // 4. Boş satırları temizle (sadece TAB/space içerenler)
    cleaned = cleaned.replace(/^[\t\s]*$/gm, '');
    
    // 5. Çoklu newline'ları temizle
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    
    console.log(`[TableFormat] OCR tablo formatı temizlendi`);
    return cleaned.trim();
  }

  /**
   * HR-AWARE GELIŞMIŞ CHUNKLAMA (Kullanıcı önerileri uygulandı)
   * - Başlık/madde bazlı chunklama
   * - Liste yapılarını koruma
   * - Q&A çiftleri tespit etme
   * - Recursive chunklama
   */
  hrAwareChunkText(text, metadata = {}) {
    const config = require('../config');
    const hrConfig = config.rag.hrAwareChunking;
    
    if (!hrConfig.enabled) {
      // HR-aware chunklama kapalıysa normal chunklama kullan
      return this.chunkText(text, metadata);
    }
    
    console.log(`[HR-Chunking] Gelişmiş HR-aware chunklama başlatılıyor...`);
    
    const chunks = [];
    
    // 1. Q&A Çiftlerini Tespit Et
    if (hrConfig.qaPairDetection) {
      const qaPairs = this.detectQAPairs(text);
      if (qaPairs.length > 0) {
        console.log(`[HR-Chunking] ${qaPairs.length} Q&A çifti tespit edildi`);
        for (const [index, qa] of qaPairs.entries()) {
          chunks.push(this.createChunk(qa, {
            ...metadata,
            type: 'qa_pair',
            qaIndex: index
          }, chunks.length));
        }
        return chunks;
      }
    }
    
    // 2. Yapısal Chunklama (Başlık/Bölüm Bazlı)
    if (hrConfig.structureAware) {
      const structuredChunks = this.structuralChunking(text, metadata, hrConfig);
      if (structuredChunks.length > 0) {
        return structuredChunks;
      }
    }
    
    // 3. Fallback: Gelişmiş Cümle Bazlı Chunklama
    return this.enhancedSentenceChunking(text, metadata, hrConfig);
  }

  /**
   * Q&A çiftlerini tespit et
   */
  detectQAPairs(text) {
    const qaPairs = [];
    const lines = text.split('\n');
    
    let currentQ = '';
    let currentA = '';
    let inQA = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Soru pattern'ları
      const questionPatterns = [
        /^S\d*[\):]?\s*(.+\?)/i, // S1) Soru?
        /^Soru\s*\d*[\):]?\s*(.+)/i, // Soru 1: 
        /^Q\d*[\):]?\s*(.+)/i, // Q1) 
        /^\d+\.\s*(.+\?)/i, // 1. Soru?
      ];
      
      // Cevap pattern'ları
      const answerPatterns = [
        /^C\d*[\):]?\s*(.+)/i, // C1) Cevap
        /^Cevap\s*\d*[\):]?\s*(.+)/i, // Cevap 1:
        /^A\d*[\):]?\s*(.+)/i, // A1)
        /^Yanıt\s*\d*[\):]?\s*(.+)/i, // Yanıt:
      ];
      
      let isQuestion = questionPatterns.some(pattern => pattern.test(line));
      let isAnswer = answerPatterns.some(pattern => pattern.test(line));
      
      if (isQuestion) {
        // Önceki Q&A çiftini tamamla
        if (currentQ && currentA) {
          qaPairs.push(`SORU: ${currentQ}\n\nCEVAP: ${currentA}`);
        }
        currentQ = line;
        currentA = '';
        inQA = true;
      } else if (isAnswer && currentQ) {
        currentA = line;
      } else if (inQA && line.length > 0) {
        // Multi-line cevap
        if (currentA) {
          currentA += '\n' + line;
        } else if (currentQ && !isQuestion) {
          currentA = line;
        }
      }
    }
    
    // Son Q&A çiftini ekle
    if (currentQ && currentA) {
      qaPairs.push(`SORU: ${currentQ}\n\nCEVAP: ${currentA}`);
    }
    
    return qaPairs;
  }

  /**
   * Yapısal chunklama (başlık/bölüm bazlı)
   */
  structuralChunking(text, metadata, hrConfig) {
    const chunks = [];
    const sections = this.identifySections(text, hrConfig.sectionBoundaries);
    
    if (sections.length <= 1) {
      return []; // Yapısal bölüm bulunamazsa fallback'e git
    }
    
    console.log(`[HR-Chunking] ${sections.length} yapısal bölüm tespit edildi`);
    
    for (const [index, section] of sections.entries()) {
      const sectionChunks = this.recursiveChunking(section.content, {
        ...metadata,
        sectionTitle: section.title,
        sectionIndex: index,
        type: 'structured_section'
      }, hrConfig);
      
      chunks.push(...sectionChunks);
    }
    
    return chunks;
  }

  /**
   * Bölümleri tanımla
   */
  identifySections(text, boundaries) {
    const sections = [];
    const lines = text.split('\n');
    
    let currentSection = { title: '', content: '' };
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Başlık tespit et
      const isHeader = boundaries.some(boundary => 
        trimmedLine.startsWith(boundary) || 
        trimmedLine.toUpperCase().includes(boundary)
      );
      
      if (isHeader && currentSection.content) {
        // Önceki bölümü kaydet
        sections.push(currentSection);
        currentSection = { title: trimmedLine, content: '' };
      } else if (isHeader) {
        currentSection.title = trimmedLine;
      } else {
        currentSection.content += line + '\n';
      }
    }
    
    // Son bölümü ekle
    if (currentSection.content.trim()) {
      sections.push(currentSection);
    }
    
    return sections;
  }

  /**
   * Recursive chunklama (LangChain mantığı)
   */
  recursiveChunking(text, metadata, hrConfig) {
    const chunks = [];
    const maxChunkSize = this.chunkSize;
    
    // Önce paragraf bazlı ayır
    const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
    
    let currentChunk = '';
    let currentTokens = 0;
    
    for (const paragraph of paragraphs) {
      const paraTokens = this.getTokenCount(paragraph);
      
      if (currentTokens + paraTokens <= maxChunkSize) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        currentTokens += paraTokens;
      } else {
        // Mevcut chunk'ı kaydet
        if (currentChunk.trim()) {
          chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
        }
        
        // Yeni chunk başlat (overlap ile)
        if (paraTokens > maxChunkSize) {
          // Paragraf çok büyükse sentence bazlı böl
          const sentenceChunks = this.enhancedSentenceChunking(paragraph, metadata, hrConfig);
          chunks.push(...sentenceChunks);
          currentChunk = '';
          currentTokens = 0;
        } else {
          // Overlap ekle
          const overlapContent = this.getOverlapContent(currentChunk);
          currentChunk = overlapContent + (overlapContent ? '\n\n' : '') + paragraph;
          currentTokens = this.getTokenCount(currentChunk);
        }
      }
    }
    
    // Son chunk'ı ekle
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(currentChunk, metadata, chunks.length));
    }
    
    return chunks;
  }

  /**
   * Gelişmiş cümle bazlı chunklama
   */
  enhancedSentenceChunking(text, metadata, hrConfig) {
    // Liste yapılarını koru
    if (hrConfig.listPreservation) {
      text = this.preserveListStructures(text, hrConfig.listPatterns);
    }
    
    // Normal sentence chunklama
    return this.chunkText(text, metadata);
  }

  /**
   * Liste yapılarını koru
   */
  preserveListStructures(text, listPatterns) {
    let preservedText = text;
    
    // Liste öğelerini bir arada tut
    for (const pattern of listPatterns) {
      const regex = new RegExp(`(${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]+(?:\\n(?!\\s*${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^\\n]*)*)`, 'g');
      preservedText = preservedText.replace(regex, (match) => {
        return match.replace(/\n/g, ' '); // Liste içi satır sonlarını space'e çevir
      });
    }
    
    return preservedText;
  }
}

module.exports = TextProcessor;