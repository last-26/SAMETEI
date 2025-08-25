const OpenRouterClient = require('./utils/openrouter');
const MongoDBVectorDB = require('./utils/mongodb');
const TextProcessor = require('./utils/textProcessor');
const config = require('./config');

class HRRAGSystem {
  constructor() {
    this.openrouter = new OpenRouterClient();
    this.vectorDB = new MongoDBVectorDB();
    this.textProcessor = new TextProcessor();
    this.isInitialized = false;
  }

  /**
   * Sistemi başlat
   */
  async initialize() {
    try {
      console.log('🚀 SAMETEI HR RAG System başlatılıyor...');
      
      // MongoDB'ye bağlan
      await this.vectorDB.connect();
      
      // Sistem istatistiklerini göster
      const stats = await this.vectorDB.getStats();
      console.log(`📊 Mevcut döküman sayısı: ${stats.documentCount}`);
      
      if (stats.embeddingDimension) {
        console.log(`🔢 Embedding boyutu: ${stats.embeddingDimension}`);
      }
      
      this.isInitialized = true;
      console.log('✅ HR RAG System hazır!');
      
    } catch (error) {
      console.error('❌ Sistem başlatma hatası:', error);
      throw error;
    }
  }

  /**
   * HR prosedürlerini yükle ve embed et
   */
  async loadHRProcedures(csvPath = '../hr_procedures.csv') {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      console.log('📚 HR prosedürleri yükleniyor...');
      
      // CSV'yi işle
      const procedures = await this.textProcessor.processHRProcedures(csvPath);
      
      console.log('🧠 Embeddinglar oluşturuluyor...');
      
      // Batch olarak embedding oluştur
      const contents = procedures.map(p => p.content);
      const embeddings = await this.openrouter.createEmbeddings(contents);
      
      // Embedding'leri prosedürlerle birleştir
      const documentsWithEmbeddings = procedures.map((procedure, index) => ({
        ...procedure,
        embedding: embeddings[index],
        createdAt: new Date()
      }));
      
      // MongoDB'ye kaydet
      await this.vectorDB.insertKnowledge(documentsWithEmbeddings);
      
      console.log(`✅ ${procedures.length} HR prosedürü yüklendi ve embed edildi!`);
      return documentsWithEmbeddings;
      
    } catch (error) {
      console.error('❌ HR prosedürü yükleme hatası:', error);
      throw error;
    }
  }

  /**
   * Kullanıcı sorusuna cevap üret (Ana RAG fonksiyonu)
   */
  async query(userQuestion, options = {}) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      const {
        topK = config.rag.topKResults,
        includeMetadata = true,
        temperature = 0.2
      } = options;
      
      console.log(`❓ Soru: "${userQuestion}"`);
      
      // 1. Kullanıcı sorgusu için embedding oluştur
      const queryEmbedding = await this.openrouter.createEmbedding(userQuestion);
      
      // 2. Vector search ile en yakın dökümanları bul
      const relevantDocs = await this.vectorDB.vectorSearch(queryEmbedding, topK);
      
      if (relevantDocs.length === 0) {
        console.log('⚠️ Hiç ilgili döküman bulunamadı, fallback kullanılıyor');
        return await this.openrouter.hrChatCompletion(
          userQuestion, 
          "Genel HR bilgileri mevcut değil. İK departmanı ile iletişime geçin."
        );
      }
      
      // 3. Context oluştur
      const context = relevantDocs
        .map((doc, index) => `[${index + 1}] ${doc.content}`)
        .join('\n\n');
      
      console.log(`📋 ${relevantDocs.length} ilgili döküman bulundu`);
      console.log(`📝 Context uzunluğu: ${this.textProcessor.getTokenCount(context)} token`);
      
      // 4. LLM ile cevap üret
      const response = await this.openrouter.hrChatCompletion(userQuestion, context);
      
      // 5. Response objesi oluştur
      const result = {
        question: userQuestion,
        answer: response,
        sources: relevantDocs.map(doc => ({
          content: doc.content.substring(0, 200) + '...',
          category: doc.metadata?.category || 'unknown',
          source: doc.metadata?.source || 'unknown',
          score: doc.score || 0
        })),
        metadata: {
          retrievedDocuments: relevantDocs.length,
          totalTokensUsed: this.textProcessor.getTokenCount(context + userQuestion + response),
          timestamp: new Date()
        }
      };
      
      console.log(`✅ Cevap üretildi (${result.metadata.totalTokensUsed} token)`);
      return result;
      
    } catch (error) {
      console.error('❌ Query hatası:', error);
      
      // Hata durumunda fallback cevap
      return {
        question: userQuestion,
        answer: "Özür dilerim, şu an teknik bir sorun yaşıyorum. Lütfen sorunuzu İK departmanımıza iletin: ik@sametei.com (Dahili: 101)",
        sources: [],
        error: error.message,
        metadata: {
          hasError: true,
          timestamp: new Date()
        }
      };
    }
  }

  /**
   * Batch query işlemi (test için)
   */
  async batchQuery(questions) {
    const results = [];
    
    for (const question of questions) {
      console.log(`\n--- ${questions.indexOf(question) + 1}/${questions.length} ---`);
      const result = await this.query(question);
      results.push(result);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return results;
  }

  /**
   * Knowledge base'i güncelle
   */
  async updateKnowledgeBase(newData) {
    try {
      console.log('🔄 Knowledge base güncelleniyor...');
      
      // Yeni veriyi işle
      const processedData = await this.textProcessor.processDocument(newData);
      
      // Embedding oluştur
      const contents = processedData.map(d => d.content);
      const embeddings = await this.openrouter.createEmbeddings(contents);
      
      // Veriyi birleştir ve kaydet
      const documentsWithEmbeddings = processedData.map((doc, index) => ({
        ...doc,
        embedding: embeddings[index],
        updatedAt: new Date()
      }));
      
      await this.vectorDB.insertKnowledge(documentsWithEmbeddings);
      
      console.log(`✅ ${processedData.length} yeni döküman eklendi`);
      return documentsWithEmbeddings;
      
    } catch (error) {
      console.error('❌ Knowledge base güncelleme hatası:', error);
      throw error;
    }
  }

  /**
   * Sistemi temizle
   */
  async clearKnowledgeBase() {
    try {
      await this.vectorDB.clearKnowledgeBase();
      console.log('🗑️ Knowledge base temizlendi');
    } catch (error) {
      console.error('❌ Temizleme hatası:', error);
      throw error;
    }
  }

  /**
   * Sistem istatistikleri
   */
  async getSystemStats() {
    try {
      const dbStats = await this.vectorDB.getStats();
      
      return {
        database: dbStats,
        config: {
          chunkSize: config.rag.chunkSize,
          topKResults: config.rag.topKResults,
          similarityThreshold: config.rag.similarityThreshold
        },
        models: {
          embedding: config.openrouter.embeddingModel,
          chat: config.openrouter.chatModel
        },
        status: this.isInitialized ? 'ready' : 'not_initialized'
      };
    } catch (error) {
      console.error('❌ Stats alma hatası:', error);
      return { error: error.message };
    }
  }

  /**
   * Sistemı kapat
   */
  async shutdown() {
    try {
      await this.vectorDB.shutdown();
      console.log('👋 RAG System kapatıldı');
    } catch (error) {
      console.error('❌ Kapatma hatası:', error);
    }
  }
}

module.exports = HRRAGSystem;
