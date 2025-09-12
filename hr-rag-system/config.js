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

  // RAG Ayarları (ULTRA OPTIMIZED v2.0 - PERFORMANCE FOCUSED)
  rag: {
    // === CHUNK OPTİMİZASYONU ===
    chunkSize: 600, // 400→600 (%50 artış) - Daha zengin context
    chunkOverlap: 120, // %20 overlap (optimal balance)
    maxContextLength: 8000, // 8K token context limit
    minChunkLength: 80, // Minimum chunk uzunluğu artırıldı
    
    // === RETRIEVAL STRATEJİSİ (PRECISION-FOCUSED) ===
    initialTopK: 20, // İlk retrieval - geniş ağ
    hybridTopK: 8, // Hibrit filtreleme sonrası (azaltıldı)
    preRerankTopK: 5, // Re-ranking öncesi final selection
    finalTopK: 3, // Ultra-precision final chunks (azaltıldı)
    similarityThreshold: 0.25, // Daha düşük threshold - esnek eşleştirme
    
    // === HİBRİT ARAMA AĞIRLIKLARI ===
    vectorWeight: 0.50, // Dense retrieval (embedding)
    keywordWeight: 0.25, // Sparse retrieval (BM25)
    semanticReRankWeight: 0.15, // Cross-encoder re-ranking
    contextMatchWeight: 0.10, // Chat history + intent matching
    
    // === GELİŞMİŞ BM25 PARAMETERS ===
    bm25_k1: 1.8, // Term frequency saturation (optimal)
    bm25_b: 0.6, // Document length normalization (tuned)
    bm25_k3: 500, // Query term frequency normalization
    
    // === ÇOKLU BENZERLİK METRİKLERİ ===
    enableMultiSimilarity: false, // Geçici olarak kapatıldı - embedding format sorunları çözülene kadar
    similarityMetrics: {
      cosine: 0.40, // Cosine similarity ağırlığı
      euclidean: 0.25, // Euclidean distance ağırlığı  
      jaccard: 0.20, // Jaccard index ağırlığı
      manhattan: 0.15 // Manhattan distance ağırlığı
    },
    
    // === QUERY EXPANSION ===
    enableAdvancedExpansion: true,
    expansionMethods: {
      synonyms: true, // Synonym expansion
      morphological: true, // Türkçe morfolojik genişletme
      semantic: true, // Semantic similarity expansion
      contextual: true // Context-aware expansion
    },
    maxExpansionTerms: 8,
    
    // === MULTI-STAGE RE-RANKING ===
    enableMultiStageReRanking: true,
    reRankingStages: {
      stage1_keyword: 0.25, // Keyword matching bonus
      stage2_semantic: 0.30, // Semantic similarity re-score
      stage3_context: 0.25, // Context relevance
      stage4_diversity: 0.20 // Result diversity
    },
    
    // === CONTEXT AWARE FEATURES ===
    contextBonus: 0.15, // Chat history context bonus (increased)
    recentBonus: 0.08, // Yeni dökümanlar için bonus (increased)
    categoryBonus: 0.12, // Same category bonus
    sourceReliabilityBonus: 0.05, // Güvenilir kaynak bonusu
    
    // === SEMANTİK ÇEŞİTLİLİK ===
    maxChunksPerCategory: 3, // Her kategoriden max chunk sayısı (increased)
    enableSemanticDiversity: true,
    diversityThreshold: 0.85, // Çok benzer içerikleri filtrele
    
    // === ANTI-REPETITION SYSTEM ===
    enableAntiRepetition: true, // Tekrar eden cevap engelleme
    repetitionMemorySize: 5, // Son N cevabı hatırla
    repetitionThreshold: 0.7, // Similarity threshold for repetition
    diversityEnforcement: 0.3, // Chunk diversity zorlama
    conversationAwareness: true, // Konuşma akışı farkındalığı
    
    // === PERFORMANS İZLEME ===
    enableChunkLogging: true, // Chunk detaylarını logla
    logMetrics: true, // Similarity metrics logla
    enablePerformanceMonitoring: true, // Performance tracking
    enableDebugMode: false // Debug modu (production'da kapalı)
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
