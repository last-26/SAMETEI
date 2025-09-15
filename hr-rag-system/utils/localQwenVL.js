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
    
    // STABILITE ODAKLI CONNECTION AYARLARI (ConnectionResetError önleme)
    const http = require('http');
    this.axiosConfig = {
      timeout: 0, // OCR için sınırsız bekleme
      headers: {
        'Connection': 'close',  // Her istek sonrası temiz kapanma
        'Content-Type': 'application/json',
        'User-Agent': 'HR-RAG-OCR-Client/1.0',
        'Keep-Alive': 'timeout=0'  // Keep-alive kapalı
      },
      httpAgent: new http.Agent({
        keepAlive: false,       // Connection pooling kapalı
        maxSockets: 1,          // Tek socket kullan
        timeout: 0,             // Socket timeout kaldır
        freeSocketTimeout: 0,   // Free socket timeout kaldır
        socketActiveTTL: 0      // Socket TTL kaldır
      }),
      maxContentLength: 50 * 1024 * 1024, // 50MB limit
      maxBodyLength: 50 * 1024 * 1024,     // 50MB limit
      validateStatus: function (status) {
        return status < 400; // Sadece 4xx+ errorları reject et
      }
    };
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
            ...this.axiosConfig  // Optimized connection ayarları (headers dahil)
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
   * Form çıkarma için prompt (dikey layout odaklı)
   */
  getFormPrompt() {
    return `TASK: Extract form content with VERTICAL field layout - each field on separate line.

🎯 CRITICAL RULE: NEVER use horizontal table format for forms!

LAYOUT REQUIREMENTS:
✅ CORRECT - VERTICAL (each field on new line):
İZİN TALEP FORMU
T.C Kimlik Numarası
Adı Soyadı
Çalışma Yeri / Birimi
Görevi / Unvanı
İşe Giriş Tarihi

❌ WRONG - HORIZONTAL (do not use this):
T.C Kimlik Numarası | Adı Soyadı | Çalışma Yeri

EXTRACTION RULES:
1. Each field label goes on a separate line
2. Empty fields: show label only (no values)
3. Filled fields: show "Label: Value" format
4. Preserve Turkish characters: ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü
5. Form title at the top

SPECIAL ELEMENTS:
- Checkboxes: □ (empty) or ☑ (checked)
- Signatures: [İmza] if signed, blank if empty
- Dates: Keep format (DD.MM.YYYY)
- Empty areas: Leave blank

SECTIONS:
- Main form fields (vertical list)
- Form text/description (natural paragraphs)
- Approval section (İşveren Onayı)

OUTPUT FORMAT:
- Plain text only
- No markdown, no tables, no pipes (|)
- Start with form title
- Each field on new line
- Natural paragraph breaks for text sections

QUALITY:
- 100% accurate Turkish text
- Mark unclear text as [?]
- Priority: Accuracy over speed`;
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
   * Hibrit çıkarma için prompt (hem text hem table hem form)
   */
  getHybridPrompt() {
    return `TASK: Extract ALL content from the image with intelligent formatting detection.

SMART CONTENT DETECTION:
1. **FORMS**: Vertical field layout (each field on new line)
2. **TABLES**: Horizontal data layout (TAB-separated columns)
3. **TEXT**: Natural paragraph flow
4. **MIXED**: Preserve each content type appropriately

FORMATTING BY CONTENT TYPE:

📋 FORMS (İzin Talep Formu, başvuru formları):
- Each field label on separate line
- Field format: "Label:" or just "Label"
- Empty fields: Leave blank line or show field name only
- Example:
  FORM TITLE
  Field 1 Name
  Field 2 Name
  Field 3 Name

📊 TABLES (veri tabloları, çizelgeler):  
- Use TAB (\\t) between columns
- Use NEWLINE (\\n) between rows
- Example: Col1\\tCol2\\tCol3\\nData1\\tData2\\tData3

📝 REGULAR TEXT:
- Natural paragraph breaks
- Preserve original spacing

FORM DETECTION CRITERIA:
- Contains "FORM", "FORMU", "TALEP", "BAŞVURU" in title
- Has vertical field layout structure
- Shows input fields or boxes
- Has form-like appearance

TABLE DETECTION CRITERIA:
- Clear column/row structure
- Multiple data entries
- Tabular data presentation

TURKISH CHARACTER SUPPORT:
- Perfect preservation: ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü
- Keep all accented characters exactly

SPECIAL ELEMENTS:
- Checkboxes: □ (empty) or ☑ (checked)
- Signatures: [İmza] if signed, blank if empty
- Dates: Keep exact format (DD.MM.YYYY)

OUTPUT REQUIREMENTS:
- Start with content immediately
- No explanations or markdown
- Preserve document hierarchy
- Group related sections

CRITICAL: For FORMS, use VERTICAL layout (newlines between fields).
For TABLES, use HORIZONTAL layout (tabs between columns).`;
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
