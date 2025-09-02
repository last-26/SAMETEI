/**
 * OpenRouter Vision OCR Implementation
 * Görüntü işlemede güçlü AI modelleri kullanarak OCR ve form analizi
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

class OpenRouterVisionOCR {
  constructor(apiKey, model = 'qwen/qwen2.5-vl-32b-instruct:free') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseURL = 'https://openrouter.ai/api/v1';
  }

  /**
   * Form görüntüsünden metin ve yapısal bilgileri çıkar
   * @param {string} imagePath - Görüntü dosyası yolu
   * @param {string} promptType - 'ocr', 'form', 'table' gibi
   * @returns {Object} - {text, structuredData, success}
   */
  async extractFromImage(imagePath, promptType = 'form') {
    try {
      console.log(`[Vision OCR] ${promptType} analizi başlatılıyor: ${path.basename(imagePath)}`);
      
      // Görüntüyü base64'e çevir
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = this.getMimeType(imagePath);
      
      // Prompt tipine göre talimat oluştur
      const prompt = this.generatePrompt(promptType);
      
      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        {
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`
                  }
                }
              ]
            }
          ],
          max_tokens: 2000,
          temperature: 0.1 // OCR için düşük temperature
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3001', // OpenRouter gereksinimi
          },
          timeout: 30000 // 30 saniye timeout
        }
      );

      const result = response.data.choices[0].message.content;
      const tokensUsed = response.data.usage?.total_tokens || 0;
      
      console.log(`[Vision OCR] ${tokensUsed} token kullanıldı, model: ${this.model}`);
      
      // Form prompt'u için sadece düz metin, JSON parse etme
      let structuredData = null;
      let text = result;
      
      // Eğer form prompt'u ise JSON parse etme, direkt metin kullan
      if (promptType === 'form') {
        // Sadece düz metin kullan
        text = result.trim();
      } else {
        // Diğer prompt türleri için JSON parse et
        try {
          const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/);
          if (jsonMatch) {
            structuredData = JSON.parse(jsonMatch[1]);
            text = structuredData.all_text || result;
          } else if (result.startsWith('{') && result.endsWith('}')) {
            structuredData = JSON.parse(result);
            text = structuredData.all_text || result;
          }
        } catch (e) {
          console.log('[Vision OCR] JSON parse edilemedi, düz metin olarak kullanılıyor');
        }
      }

      console.log(`[Vision OCR] Başarılı: ${text.length} karakter çıkarıldı`);
      
      return {
        success: true,
        text: text,
        structuredData: structuredData,
        model: this.model,
        tokensUsed: tokensUsed,
        promptType: promptType
      };

    } catch (error) {
      console.error('[Vision OCR] Hata:', error.response?.data || error.message);
      return {
        success: false,
        error: error.message,
        text: '',
        structuredData: null,
        model: this.model
      };
    }
  }

  /**
   * Prompt tipine göre uygun talimat oluştur
   */
  generatePrompt(type) {
    const prompts = {
      ocr: `Bu görüntüdeki tüm metinleri dikkatli bir şekilde oku ve çıkar. 
             Türkçe karakterleri doğru tanı. Sadece görünen metni döndür.`,
      
      form: `Bu görüntüdeki TÜM metinleri, yazıları ve kelimeleri dikkatli bir şekilde oku ve çıkar. 
             
             KRİTİK: Görüntüdeki HER ŞEYİ oku:
             - Form başlıkları ve etiketleri
             - RENKLİ METİNLER (kırmızı, mavi, yeşil, sarı arkaplanlı yazılar)
             - Dikey yazılmış metinler
             - Küçük yazılar ve notlar
             - Tablo içerikleri
             - Test amaçlı yazılar
             - Renkli kutulardaki yazılar
             - Arkaplan renkli alanlardaki metinler
             
             ÖZELLİKLE DİKKAT: Renkli arkaplanlı metinleri kaçırma!
             
             Türkçe karakterleri doğru tanı (ğ, ü, ş, ı, ö, ç).
             
             Çıktı formatı: Sadece düz metin, JSON değil.
             
             Örnek çıktı (TÜM metinler dahil):
             X ŞİRKETİ
             İZİN TALEP FORMU
             Form No. 2025-001
             Personel No.
             Ad Soyadı
             Departman
             İzin Başlangıç Tarihi
             İzin Bitiş Tarihi
             İzin Türü:
             Yıllık İzin
             Mazeret İzni
             Sağlık İzni
             Diğer:
             Okuma Test Tablosu
             KIRMIZI
             MAVI
             YEŞİİ
             YEŞEI
             MAVI
             SARI
             İmza (Personel)
             İmza (Yönetici)
             Tarih`,
      
      table: `Bu tablo görüntüsünü analiz et ve JSON formatında yapılandırılmış veri olarak çıkar:
              {
                "table_title": "başlık",
                "headers": ["kolon1", "kolon2", ...],
                "rows": [
                  ["değer1", "değer2", ...],
                  ...
                ],
                "metadata": {
                  "row_count": sayı,
                  "column_count": sayı
                },
                "all_text": "tüm metin"
              }`,
      
      invoice: `Bu fatura görüntüsünü analiz et ve şu bilgileri JSON formatında çıkar:
               {
                 "invoice_number": "fatura no",
                 "date": "tarih",
                 "company": "firma adı", 
                 "total_amount": "toplam tutar",
                 "items": [
                   {"description": "açıklama", "amount": "tutar"},
                   ...
                 ],
                 "all_text": "tüm metin"
               }`
    };

    return prompts[type] || prompts.ocr;
  }

  /**
   * Dosya uzantısından MIME type belirle
   */
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/jpeg';
  }

  /**
   * Rate limiting için bekleme
   */
  async rateLimitDelay(ms = 1500) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Fallback model ile tekrar dene
   */
  async extractWithFallback(imagePath, promptType = 'form', fallbackModels = []) {
    let lastError = null;
    
    // Ana model ile dene
    let result = await this.extractFromImage(imagePath, promptType);
    if (result.success) {
      return result;
    }
    
    lastError = result.error;
    console.log(`[Vision OCR] Ana model başarısız, fallback modeller deneniyor...`);
    
    // Fallback modeller ile dene
    for (const fallbackModel of fallbackModels) {
      console.log(`[Vision OCR] Fallback model deneniyor: ${fallbackModel}`);
      this.model = fallbackModel;
      
      await this.rateLimitDelay();
      result = await this.extractFromImage(imagePath, promptType);
      
      if (result.success) {
        console.log(`[Vision OCR] Fallback model başarılı: ${fallbackModel}`);
        return result;
      }
      
      lastError = result.error;
    }
    
    return {
      success: false,
      error: `Tüm modeller başarısız. Son hata: ${lastError}`,
      text: '',
      structuredData: null
    };
  }
}

module.exports = OpenRouterVisionOCR;
