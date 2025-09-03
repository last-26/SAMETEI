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
  async extractFromImage(imagePath, promptType = 'table_text_strict', customPrompt = null) {
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
            prompt: prompt
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

  // Çıktı düzenleme: TAB kolonlarını sabitle, eksik alanları doldur
  normalizeTableText(text) {
    if (!text) return text;
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    let notesIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (headerIdx === -1 && t && !t.toUpperCase().startsWith('NOTES:')) {
        headerIdx = i; // ilk dolu satırı başlık varsay
      }
      if (t.toUpperCase() === 'NOTES:' && notesIdx === -1) {
        notesIdx = i;
      }
    }
    if (headerIdx === -1) return text;
    const header = lines[headerIdx].replace(/[ \t]{2,}/g, '\t').replace(/\t+/g, '\t');
    const colCount = Math.max(2, header.split('\t').length);
    const out = [];
    // Başlık
    out.push(header);
    // Gövde (NOTES öncesine kadar)
    const endIdx = notesIdx === -1 ? lines.length : notesIdx;
    for (let i = headerIdx + 1; i < endIdx; i++) {
      let s = lines[i];
      if (!s.trim()) continue;
      // Çoklu boşlukları TAB'e çevir, çoklu TAB'i sadele
      s = s.replace(/[ \t]{2,}/g, '\t').replace(/\t+/g, '\t');
      let cells = s.split('\t');
      // Eğer tek parça kaldıysa (model tab koymamışsa), iki veya daha fazla boşluklara bak
      if (cells.length < 2) {
        s = s.replace(/ {2,}/g, '\t');
        cells = s.split('\t');
      }
      // Kolon sayısını sabitle
      if (cells.length < colCount) {
        while (cells.length < colCount) cells.push('');
      } else if (cells.length > colCount) {
        // Fazla kolonları son kolona birleştir
        cells = cells.slice(0, colCount - 1).concat([cells.slice(colCount - 1).join(' ')]);
      }
      out.push(cells.join('\t'));
    }
    // NOTES ve sonrası
    if (notesIdx !== -1) {
      out.push('');
      out.push('NOTES:');
      for (let i = notesIdx + 1; i < lines.length; i++) {
        out.push(lines[i]);
      }
    }
    return out.join('\n');
  }

  /**
   * Prompt şablonları - OCR odaklı
   */
  generatePrompt(type) {
    const prompts = {
      table_text_with_notes: `STRICT TABLE-TO-TEXT + NOTES (NO BORDERS)
Goal: Output the table as TAB-separated plain text, then append any non-table text (e.g., footnotes) as NOTES.
Rules for TABLE:
- First line: header row; then one line per row.
- EXACTLY ONE TAB (\t) between columns; no ASCII borders or '|' chars.
- Keep column count consistent across all rows; empty cells stay empty between tabs.
Rules for NOTES:
- After the table, add a blank line and a section header: NOTES:
- List each non-table line (e.g., below the grid) as a separate line under NOTES.
- Preserve characters and casing. Do not translate.
Output skeleton:
Header1\tHeader2\tHeader3
R1C1\tR1C2\tR1C3
R2C1\t\tR2C3

NOTES:
<line 1>
<line 2>`
    };

    return prompts['table_text_with_notes'];
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
