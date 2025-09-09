// .env dosyasından environment variable'ları yükle
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

module.exports = {
  // MongoDB Bağlantısı (LibreChat'in kullandığı aynı DB)
  mongodb: {
    uri: 'mongodb://127.0.0.1:27017/LibreChat',
    database: 'LibreChat',
    collection: 'hr_knowledge_base',
    useInMemory: false // MongoDB kullan
  },

  // OpenRouter API Ayarları
  openrouter: {
    apiKey: process.env.OPENROUTER_KEY, // .env dosyasından API key'i al
    baseURL: 'https://openrouter.ai/api/v1',
    embeddingModel: 'local', // OpenRouter'da embedding yok, local kullanacağız
    chatModel: 'mistralai/mistral-7b-instruct:free',
    retry: {
      maxRetries: 5,
      initialDelayMs: 1000,
      backoffFactor: 2,
      // Modeller sırasıyla denenir (Llama -> Mistral -> DeepSeek)
      fallbackModels: [
        'meta-llama/llama-4-maverick:free',
        'deepseek/deepseek-chat-v3.1:free',
        'qwen/qwen3-235b-a22b:free',
        'openai/gpt-oss-20b:free',
        'deepseek/deepseek-chat-v3-0324:free'
      ]
    }
  },

  // RAG Ayarları
  rag: {
    chunkSize: 300,
    chunkOverlap: 75,
    topKResults: 5, // Daha fazla sonuç getir
    similarityThreshold: 0.3 // Daha düşük threshold (daha esnek eşleştirme)
  },

  // OCR Ayarları - Sadece Qwen2.5-VL
  ocr: {
    // Ana ve tek provider: Qwen2.5-VL
    provider: 'qwen2.5-vl',

    // QWEN2.5-VL AYARLARI (API TABANLI - TEK OCR SİSTEMİ)
    qwenVL: {
      enabled: true,
      apiUrl: 'http://localhost:8000', // api.py servisi
      modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
      defaultType: 'table', // table | form | text
      timeout: 0, // Timeout kaldırıldı (sınırsız bekleme)
      maxRetries: 1, // Retry azaltıldı
      retryDelay: 1000,
      supportedFormats: ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp'],
      minPixels: 256 * 28 * 28,
      maxPixels: 1280 * 28 * 28
    },
    
    // Genel OCR ayarları
    minTextThreshold: 10, // PDF'de minimum metin karakteri
    
    // API tabanlı OCR için özel ayarlar
    api: {
      checkHealthOnStartup: true, // Başlangıçta API sağlığını kontrol et
      healthCheckInterval: 60000, // 1 dakikada bir sağlık kontrolü
      autoRetryOnFailure: true // Başarısızlıkta otomatik tekrar dene
    }
  },

  // Qwen OCR API Server Ayarları
  qwenOcrApi: {
    enabled: true,
    autoStart: false, // Manuel başlatma tercih ediliyor
    serverUrl: 'http://localhost:8000',
    pythonScript: './api.py', // Python API script yolu
    startupTimeout: 60000, // Başlangıç timeout (ms)
    healthCheckInterval: 30000, // Sağlık kontrolü aralığı (ms)
    maxRetries: 3,
    retryDelay: 1000,
    requireGpu: false, // GPU zorunlu değil
    fallbackOnError: true // Hata durumunda fallback'lere geç
  },

  // Server Ayarları
  server: {
    port: 3001,
    host: '0.0.0.0'
  },

  // Support Ayarları
  support: {
    fallbackMessage: "Üzgünüm, bu konu hakkında bilgi bulunamadı. Lütfen başka bir soru sorun veya HR ekibimizle iletişime geçin."
  }
};
