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
      // Modeller sırasıyla denenir (OpenAI -> Mistral -> DeepSeek)
      fallbackModels: [
        'mistralai/mistral-small-3.2-24b-instruct:free',
        'google/gemma-3n-e2b-it:free',
        'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
        'deepseek/deepseek-r1-0528-qwen3-8b:free',
        'deepseek/deepseek-r1-0528:free',
        'openai/gpt-oss-20b:free'
      ]
    }
  },

  // RAG Ayarları
  rag: {
    chunkSize: 750,
    chunkOverlap: 125,
    topKResults: 5, // Daha fazla sonuç getir
    similarityThreshold: 0.3 // Daha düşük threshold (daha esnek eşleştirme)
  },

  // OCR Ayarları - Local Model desteği ile güncellendi
  ocr: {
    // Ana provider: Local Model öncelikli
    provider: 'local-qwen',
    
    // LOCAL MODEL AYARLARI (YENİ)
    useLocalModel: true, // Local modeli etkinleştir
    localModelUrl: 'http://localhost:8000', // Python API sunucu adresi
    localModelPriority: 1, // Öncelik sırası (1 = en yüksek)
    
    // OpenRouter Vision Ayarları (fallback olarak)
    preferVision: true, // Local başarısız olursa OpenRouter'ı dene
    vision: {
      model: 'qwen/qwen2.5-vl-32b-instruct:free', // En iyi performans/hız dengesi
      fallbackModels: [
        'qwen/qwen2.5-vl-72b-instruct:free',      // En yüksek doğruluk
        'meta-llama/llama-3.2-11b-vision-instruct:free',
        'google/gemma-3-27b-it:free',
        'mistralai/mistral-small-3.1-24b-instruct:free'
      ],
      temperature: 0.1,  // OCR için düşük
      maxTokens: 2000,
      rateLimitDelay: 1500, // ms cinsinden bekleme
      timeout: 30000, // 30 saniye timeout
    },
    
    // Tesseract OCR (son çare)
    enableFallback: true,
    tesseract: {
      path: process.env.TESSERACT_PATH || 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
      languages: process.env.TESSERACT_LANG || 'tur+eng',
      dpi: parseInt(process.env.OCR_DPI) || 600,
      minTextThreshold: 30,
      preferPython: true,
      
      preprocessing: {
        enableColorRemoval: true,
        enableContrastEnhancement: true,
        enableNoiseReduction: true,
        enableBinaryThreshold: true
      },
      
      formProcessing: {
        enableRegionExtraction: true,
        enableTableDetection: true,
        minRegionArea: 500,
        maxRegionsPerPage: 8,
        confidenceThreshold: 20
      }
    },
    
    // Genel OCR ayarları
    minTextThreshold: 30, // PDF'de minimum metin karakteri
    preferredOrder: ['local-qwen', 'openrouter-vision', 'tesseract'], // Deneme sırası
  },

  // Local Model için ek ayarlar
  localModel: {
    enabled: true,
    autoStart: false, // Python sunucusunu otomatik başlat
    pythonPath: 'python', // Python executable yolu
    serverScript: './qwen_local_server.py', // Python script yolu
    startupTimeout: 60000, // Başlangıç timeout (ms)
    healthCheckInterval: 30000, // Sağlık kontrolü aralığı (ms)
    maxRetries: 3,
    retryDelay: 1000,
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
