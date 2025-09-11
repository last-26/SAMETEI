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

  // Ollama API Ayarları
  ollama: {
    baseURL: 'http://localhost:11434', // Ollama varsayılan URL'si
    model: 'llama3.1:8b-instruct-q4_0', // İndirdiğiniz model
    embeddingModel: 'local', // Local TF-IDF embedding kullanacağız
    retry: {
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffFactor: 2
    },
    timeout: 0 // Timeout kaldırıldı - GPU model yükleme için
  },

  // RAG Ayarları (Optimized)
  rag: {
    chunkSize: 500,
    chunkOverlap: 85,
    topKResults: 5, // Daha fazla sonuç getir
    similarityThreshold: 0.35, // Daha düşük threshold (daha esnek eşleştirme)
    
    // Advanced Search Parameters
    vectorWeight: 0.7, // Vector search ağırlığı (0.0-1.0)
    keywordWeight: 0.3, // Keyword search ağırlığı (0.0-1.0)
    contextBonus: 0.1, // Chat history context bonus
    recentBonus: 0.05, // Yeni dökümanlar için bonus
    minChunkLength: 50, // Minimum chunk uzunluğu
    
    // BM25 Parameters
    bm25_k1: 1.5, // Term frequency saturation parameter
    bm25_b: 0.75, // Document length normalization parameter
    
    // Semantic Diversity
    maxChunksPerCategory: 2, // Her kategoriden max chunk sayısı
    enableSemanticDiversity: true,
    
    // Re-ranking Parameters
    enableReRanking: true,
    contextImportance: 0.8, // Query terms importance
    historyImportance: 0.4, // Chat history terms importance
    
    // Logging
    enableChunkLogging: true, // Chunk detaylarını logla
    logMetrics: true // Similarity metrics logla
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
    port: 3002, // Docker rag_api ile çakışmayı önlemek için 3002'ye değiştirdim
    host: '0.0.0.0'
  },

  // Support Ayarları
  support: {
    fallbackMessage: "Üzgünüm, bu konu hakkında bilgi bulunamadı. Lütfen başka bir soru sorun veya HR ekibimizle iletişime geçin."
  }
};
