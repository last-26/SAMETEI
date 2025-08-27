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
    chatModel: 'deepseek/deepseek-r1-0528:free',
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
    chunkSize: 500,
    chunkOverlap: 50,
    topKResults: 5, // Daha fazla sonuç getir
    similarityThreshold: 0.3 // Daha düşük threshold (daha esnek eşleştirme)
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
