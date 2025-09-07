/**
 * Local Qwen2.5-VL-3B-Instruct OCR Wrapper
 * Sadece görüntüden metin çıkarma için optimize edilmiş
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

class LocalQwenOCR {
  constructor(apiUrl = 'http://localhost:8000') {
    this.apiUrl = apiUrl;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * API sağlık kontrolü
   */
  async checkHealth() {
    try {
      const response = await axios.get(`${this.apiUrl}/health`);
      return response.data;
    } catch (error) {
      console.error('[LocalQwenOCR] Sağlık kontrolü başarısız:', error.message);
      return { status: 'error', error: error.message };
    }
  }

  /**
   * Görüntüden metin çıkarma (OCR)
   */
  async extractFromImage(imagePath, promptType = 'table_text_tsv_strict', customPrompt = null, options = {}) {
    try {
      console.log(`[LocalQwenOCR] ${promptType} analizi başlatılıyor: ${path.basename(imagePath)}`);
      
      // Görüntüyü base64'e çevir
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      
      // Prompt tipine göre talimat oluştur (opsiyonel özel prompt)
      const prompt = customPrompt ?? this.generatePrompt(promptType);
      
      // API'ye istek gönder (süre ölçümü)
      const t0 = Date.now();
      const response = await this.retryRequest(async () => {
        return await axios.post(
          `${this.apiUrl}/ocr`,
          {
            image: base64Image,
            prompt: prompt,
            // Sunucu artık genel amaçlı seçenekleri destekliyor.
            // options.strategy: 'auto' | 'text' | 'table' | 'form' | 'key_value'
            // options.output: 'text' | 'markdown' | 'json'
            // options.headers: string[]
            ...(options.strategy ? { strategy: options.strategy } : {}),
            ...(options.output ? { output: options.output } : {}),
            ...(options.headers ? { headers: options.headers } : {}),
          },
          {
            // timeout: 0 yaparak sınırsız; axios'ta 0 zaten sınırsızdır
            timeout: 0,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
      });

      if (response.data.success) {
        let outText = response.data.text || '';
        // TAB normalizasyonu: table_text modlarında sütun sayısını sabitle
        if ((promptType || '').startsWith('table_text')) {
          outText = this.normalizeTableText(outText);
        }
        const elapsedMs = Date.now() - t0;
        console.log(`[LocalQwenOCR] Başarılı: ${outText.length} karakter | Süre: ${elapsedMs} ms`);
        
        return {
          success: true,
          text: outText,
          model: 'Qwen2.5-VL-3B-Instruct (Local OCR)',
          promptType: promptType,
          elapsedMs
        };
      } else {
        throw new Error(response.data.error || 'Bilinmeyen hata');
      }
      
    } catch (error) {
      console.error('[LocalQwenOCR] Hata:', error.message);
      return {
        success: false,
        error: error.message,
        text: '',
        model: 'Qwen2.5-VL-3B-Instruct (Local OCR)'
      };
    }
  }

  // Çıktı düzenleme: Basit TSV normalizasyonu
  normalizeTableText(text) {
    if (!text) return text;

    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return text;

    // İlk satırı başlık olarak kabul et
    const header = lines[0].replace(/[ \t]{2,}/g, '\t').replace(/\t+/g, '\t');
    const colCount = header.split('\t').length;

    const result = [header];

    for (let i = 1; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      // Çoklu boşlukları TAB'e çevir
      line = line.replace(/[ \t]{2,}/g, '\t').replace(/\t+/g, '\t');
      let cells = line.split('\t');

      // Tek hücre ise sonraki satırla birleştir
      if (cells.length === 1 && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine) {
          const nextCells = nextLine.replace(/[ \t]{2,}/g, '\t').replace(/\t+/g, '\t').split('\t');
          if (nextCells.length >= 2) {
            cells = [cells[0], ...nextCells];
            i++; // sonraki satırı atla
          }
        }
      }

      // Kolon sayısını sabitle
      if (cells.length < colCount) {
        while (cells.length < colCount) cells.push('');
      } else if (cells.length > colCount) {
        cells = cells.slice(0, colCount - 1).concat([cells.slice(colCount - 1).join(' ')]);
      }

      result.push(cells.join('\t'));
    }

    return result.join('\n');
  }

  /**
   * Prompt şablonları - OCR odaklı
   */
  generatePrompt(type) {
    return `Extract the table as plain TSV format:
- Use TAB (\t) to separate columns
- Each row ends with newline (\n)
- First line is header
- Keep all columns aligned with TABs
- No extra text or formatting`;
  }

  /**
   * Retry mechanism for API calls
   */
  async retryRequest(requestFn, retries = this.maxRetries) {
    for (let i = 0; i < retries; i++) {
      try {
        return await requestFn();
      } catch (error) {
        console.log(`[LocalQwenOCR] Deneme ${i + 1}/${retries} başarısız:`, error.message);
        
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * (i + 1)));
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Batch processing for multiple images
   */
  async processMultipleImages(imagePaths, promptType = 'form') {
    const results = [];
    
    for (const imagePath of imagePaths) {
      console.log(`[LocalQwenOCR] İşleniyor: ${path.basename(imagePath)}`);
      const result = await this.extractFromImage(imagePath, promptType);
      results.push({
        file: path.basename(imagePath),
        ...result
      });
      
      // Rate limiting - API'yi zorlamayalım
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return results;
  }
}

module.exports = LocalQwenOCR;
