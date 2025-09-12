const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Local Qwen2.5-VL OCR API Client
 * api.py ile iletişim kurar
 */
class LocalQwenVL {
  constructor(apiUrl = 'http://localhost:8000') {
    this.apiUrl = apiUrl;
    this.timeout = 0; // Timeout kaldırıldı (sınırsız bekleme)
    this.maxRetries = 1; // Retry azaltıldı
    this.retryDelay = 1000;
  }

  /**
   * API sağlık kontrolü
   */
  async checkHealth() {
    try {
      const response = await axios.get(`${this.apiUrl}/health`, {
        timeout: 10000
      });
      
      if (response.status === 200) {
        const data = response.data;
        return {
          status: data.model_loaded ? 'healthy' : 'model_not_loaded',
          message: data.model_loaded ? 'Qwen2.5-VL modeli hazır' : 'Model henüz yüklenmemiş',
          modelLoaded: data.model_loaded,
          device: data.device || 'unknown',
          gpuMemory: data.gpu_memory || 0,
          gpuUsed: data.gpu_used || 0
        };
      }
      
      return {
        status: 'error',
        message: `API yanıt hatası: ${response.status}`
      };
      
    } catch (error) {
      return {
        status: 'error',
        message: error.code === 'ECONNREFUSED' 
          ? 'API servisi çalışmıyor (python api.py ile başlatın)'
          : error.message
      };
    }
  }

  /**
   * Görüntüden metin çıkarma
   */
  async extractFromImage(imagePath, extractionType = 'text', customPrompt = null) {
    const startTime = Date.now();
    
    try {
      // Dosya var mı kontrol et
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Görüntü dosyası bulunamadı: ${imagePath}`);
      }

      // Desteklenen formatları kontrol et
      const supportedFormats = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp'];
      const fileExt = path.extname(imagePath).toLowerCase();
      if (!supportedFormats.includes(fileExt)) {
        throw new Error(`Desteklenmeyen görüntü formatı: ${fileExt}`);
      }

      // Görüntüyü base64'e çevir
      const imageBuffer = fs.readFileSync(imagePath);
      const imageBase64 = imageBuffer.toString('base64');

      // Prompt belirle
      let prompt = customPrompt;
      if (!prompt) {
        switch (extractionType) {
          case 'form':
            prompt = this.getFormPrompt();
            break;
          case 'table':
            prompt = this.getTablePrompt();
            break;
          case 'hybrid':
            prompt = this.getHybridPrompt();
            break;
          case 'text':
          default:
            prompt = this.getTextPrompt();
            break;
        }
      }

      // API isteği
      const requestData = {
        image: imageBase64,
        prompt: prompt,
        max_tokens: 2048
      };

      console.log(`[Qwen OCR] ${path.basename(imagePath)} işleniyor...`);

      let lastError = null;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const response = await axios.post(`${this.apiUrl}/ocr`, requestData, {
            timeout: this.timeout || 0, // Timeout kaldırıldı
            headers: {
              'Content-Type': 'application/json'
            }
          });

          if (response.status === 200) {
            const result = response.data;
            const elapsedMs = Date.now() - startTime;

            if (result.success) {
              return {
                success: true,
                text: result.text || '',
                processingTime: result.processing_time || 0,
                elapsedMs: elapsedMs,
                model: 'Qwen2.5-VL-3B-Instruct',
                extractionType: extractionType,
                tokensUsed: Math.ceil((prompt.length + result.text.length) / 4) // Yaklaşık token sayısı
              };
            } else {
              throw new Error(result.error || 'OCR işlemi başarısız');
            }
          } else {
            throw new Error(`API yanıt hatası: ${response.status}`);
          }

        } catch (error) {
          lastError = error;
          
          if (attempt < this.maxRetries) {
            console.log(`[Qwen OCR] Deneme ${attempt}/${this.maxRetries} başarısız, tekrar deneniyor...`);
            await this.sleep(this.retryDelay * attempt); // Exponential backoff
          }
        }
      }

      // Tüm denemeler başarısız
      throw lastError;

    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      
      return {
        success: false,
        error: error.message,
        elapsedMs: elapsedMs,
        model: 'Qwen2.5-VL-3B-Instruct'
      };
    }
  }

  /**
   * Metin çıkarma için prompt
   */
  getTextPrompt() {
    return `TASK: Extract ALL textual content from the image completely and accurately.

RULES:
1. Extract ONLY the text visible in the image.  
2. Do NOT add explanations, comments, or extra information.  
3. Leave empty areas EMPTY (no guessing, no filling).  
4. Preserve Turkish characters (ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü).  

TABLE FORMATTING:
- Separate cells in the same row with 4 spaces.  
- End each row with a new line.  
- Keep empty cells empty.  
- Maintain cell order left to right, top to bottom.  

SPECIAL CASES:
- Read text on colored backgrounds.  
- Read vertical/rotated text.  
- Form fields:  
  * Filled field → write its content.  
  * Empty field → leave blank.  
  * Checkbox → □ (empty) or ☑ (checked).  
- Preserve numeric values exactly (including dots, commas).  
- Preserve date formats as written (e.g., ____/__/____).  

OUTPUT:
- Plain text only.  
- Preserve original layout.  
- No intro or outro text.  
- No code blocks.  

PRIORITY:
1. Accuracy (only 100% certain text).  
2. Completeness (all readable text).  
3. Format preservation (tables/forms).  

Uncertain character → [?]  
Unreadable section → [...]`;
  }

  /**
   * Form çıkarma için prompt
   */
  getFormPrompt() {
    return `TASK: Extract ALL content from this form document with maximum accuracy.

EXTRACTION RULES:
1. Extract ALL visible text, labels, and field values
2. Preserve Turkish characters perfectly (ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü)
3. Show form structure clearly with labels and values
4. Keep empty fields empty (do not guess or fill)

FORM ELEMENTS:
- Field labels: Extract exactly as shown
- Field values: Extract only if clearly filled
- Checkboxes: □ (empty) or ☑ (checked)
- Signatures: [İmza] if signed, [İmzasız] if empty
- Dates: Preserve exact format (DD.MM.YYYY or DD/MM/YYYY)
- Numbers: Keep all digits, dots, and commas exactly

LAYOUT PRESERVATION:
- Maintain visual structure and spacing
- Group related fields together
- Separate sections with blank lines
- Use consistent formatting

OUTPUT FORMAT:
- Plain text only
- No explanations or comments
- No markdown or code blocks
- Preserve original Turkish text exactly

QUALITY STANDARDS:
- Only extract text you can read with 100% confidence
- Mark uncertain characters as [?]
- Mark unreadable sections as [...]
- Prioritize accuracy over completeness`;
  }

  /**
   * Tablo çıkarma için prompt
   */
  getTablePrompt() {
    return `TASK: Extract table data with PERFECT tab-separated formatting.

CRITICAL FORMATTING RULES:
1. Use TAB character (\\t) to separate each column - MANDATORY
2. Use NEWLINE (\\n) to separate each row - MANDATORY
3. NO SPACES between columns - ONLY TABS
4. Extract ALL table content including headers

TABLE STRUCTURE:
- First row: Column headers separated by \\t
- Following rows: Data cells separated by \\t
- Empty cells: Leave empty but keep \\t separators
- Multi-line content within cell: Replace newlines with space

TURKISH CHARACTER SUPPORT:
- Preserve: ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü
- Keep all accented characters exactly as shown

OUTPUT REQUIREMENTS:
- ONLY the table content with \\t and \\n separators
- NO explanations, NO markdown formatting
- NO code blocks, NO extra text
- Start directly with the header row
- End with the last data row

QUALITY STANDARDS:
- 100% accurate text recognition
- Perfect tab separation between columns
- Complete table structure preservation
- Mark uncertain text as [?] if unclear`;
  }

  /**
   * Hibrit çıkarma için prompt (hem text hem table)
   */
  getHybridPrompt() {
    return `TASK: Extract ALL content from the image with optimal formatting for both text and tables.

CONTENT DETECTION & FORMATTING:
1. TABLES: Use TAB character (\\t) between columns, NEWLINE (\\n) between rows
2. REGULAR TEXT: Use natural paragraph spacing and line breaks
3. MIXED CONTENT: Preserve both table structure and text flow

FORMATTING RULES:
- Tables: Column1\\tColumn2\\tColumn3\\n (tab-separated)
- Text: Natural paragraph breaks with proper spacing
- Forms: Label: Value format or structured layout
- Lists: Maintain bullet points or numbering

TURKISH CHARACTER SUPPORT:
- Perfect preservation: ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü
- Maintain all accented characters exactly as shown
- Preserve special punctuation and symbols

SPECIAL CASES:
- Colored backgrounds: Read text regardless of background color
- Rotated text: Extract vertical/angled text properly
- Form fields: Show filled values, leave empty fields blank
- Checkboxes: □ (empty) or ☑ (checked)
- Mixed layouts: Maintain spatial relationships

OUTPUT STRUCTURE:
- Start with main content immediately
- No introductory text or explanations
- No markdown formatting or code blocks
- Preserve original document flow and hierarchy
- Group related content together

QUALITY STANDARDS:
- 100% accurate text recognition
- Complete content extraction
- Proper format preservation
- Mark uncertain characters as [?]
- Mark unreadable sections as [...]

PRIORITY ORDER:
1. Extract all readable text with perfect accuracy
2. Maintain proper table formatting where applicable
3. Preserve document structure and relationships`;
  }

  /**
   * Sleep yardımcı fonksiyonu
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Konfigürasyon bilgilerini döndür
   */
  getConfig() {
    return {
      apiUrl: this.apiUrl,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay,
      model: 'Qwen2.5-VL-3B-Instruct'
    };
  }
}

module.exports = LocalQwenVL;
