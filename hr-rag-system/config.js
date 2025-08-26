module.exports = {
  // MongoDB Bağlantısı (LibreChat'in kullandığı aynı DB)
  mongodb: {
    uri: 'mongodb://127.0.0.1:27017/LibreChat',
    database: 'LibreChat',
    collection: 'hr_knowledge_base',
    useInMemory: true // MongoDB olmadan in-memory kullan
  },

  // OpenRouter API Ayarları
  openrouter: {
    apiKey: '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', // Yeni API anahtarını buraya yaz
    baseURL: 'https://openrouter.ai/api/v1',
    embeddingModel: 'local', // OpenRouter'da embedding yok, local kullanacağız
    chatModel: 'deepseek/deepseek-r1:free' // Güncel ücretsiz model
  },

  // RAG Ayarları
  rag: {
    chunkSize: 500,
    chunkOverlap: 50,
    topKResults: 5, // Daha fazla sonuç getir
    similarityThreshold: 0.3 // Daha düşük threshold (daha esnek eşleştirme)
  },

  // Server Ayarları
  server: {
    port: 3001,
    host: '0.0.0.0'
  }
};
