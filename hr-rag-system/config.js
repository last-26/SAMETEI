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
    apiKey: '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',
    baseURL: 'https://openrouter.ai/api/v1',
    embeddingModel: 'local', // OpenRouter'da embedding yok, local kullanacağız
    chatModel: 'deepseek/deepseek-r1:free' // Güncel ücretsiz model
  },

  // RAG Ayarları
  rag: {
    chunkSize: 500,
    chunkOverlap: 50,
    topKResults: 3,
    similarityThreshold: 0.7
  },

  // Server Ayarları
  server: {
    port: 3001,
    host: '0.0.0.0'
  }
};
