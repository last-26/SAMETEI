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

      // Qwen2.5-VL OCR API durumunu kontrol et (Ana OCR sistemi)
      console.log('🔍 OCR sistemi kontrol ediliyor...');
      try {
        const LocalQwenVL = require('./utils/localQwenVL');
        const qwenVL = new LocalQwenVL(config.ocr?.qwenVL?.apiUrl || 'http://localhost:8000');
        const health = await qwenVL.checkHealth();
        if (health.status === 'healthy') {
          console.log('✅ Qwen2.5-VL OCR API aktif ve hazır');
          console.log(`   - Model: ${health.modelLoaded ? 'Yüklendi' : 'Yüklenmedi'}`);
          console.log(`   - Cihaz: ${health.device}`);
          if (health.gpuMemory > 0) {
            console.log(`   - GPU Bellek: ${health.gpuUsed.toFixed(1)}GB / ${health.gpuMemory.toFixed(1)}GB`);
          }
        } else {
          console.log(`⚠️ Qwen2.5-VL OCR API durumu: ${health.message}`);
          if (health.status === 'model_not_loaded') {
            console.log('   💡 İpucu: python api.py ile servisi başlattığınızdan emin olun');
          }
        }
      } catch (e) {
        console.log('❌ Qwen2.5-VL OCR API bağlantısı kurulamadı:', e.message);
        console.log('   💡 İpucu: python api.py komutu ile OCR API servisini başlatın');
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
   * Bir klasörden desteklenen tüm belgeleri içe aktar ve embed et (Akıllı yükleme)
   */
  async loadDocumentsFromDir(dirPath) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      const loadStartMs = Date.now();

      const fs = require('fs');
      const path = require('path');
      const absoluteDir = path.resolve(dirPath);
      console.log(`📁 Klasörden içe aktarma: ${absoluteDir}`);

      if (!fs.existsSync(absoluteDir)) {
        throw new Error(`Klasör bulunamadı: ${absoluteDir}`);
      }

      // Mevcut veritabanı durumunu kontrol et
      const dbStats = await this.vectorDB.getDatabaseStats();
      console.log(`📊 Mevcut durum: ${dbStats.documentCount} döküman, ${dbStats.uniqueFiles} dosya`);

      // Sadece yeni dosyaları tespit et
      const newFiles = await this.vectorDB.getNewFiles(absoluteDir);
      
      if (newFiles.length === 0) {
        console.log('✅ Tüm dosyalar zaten yüklenmiş, yeni işlem yapılmıyor');
        return [];
      }

      console.log(`🆕 ${newFiles.length} yeni dosya bulundu, işleniyor...`);

      // Dosyaları sırayla işle (API limitleri için güvenli)
      const allChunks = [];
      for (const file of newFiles) {
        try {
          const chunks = await this.textProcessor.processDocument(file, { source: 'procedures' });
          chunks.forEach((c, idx) => {
            c.metadata = {
              ...c.metadata,
              sourceFile: path.basename(file),
              fileHash: this.vectorDB.calculateFileHash(file),
              loadedAt: new Date()
            };
          });
          allChunks.push(...chunks);
          console.log(`✅ İşlendi: ${path.basename(file)} -> ${chunks.length} chunk`);
        } catch (e) {
          console.error(`❌ Dosya işlenemedi: ${file} - ${e.message}`);
        }
      }

      if (allChunks.length === 0) {
        console.log('⚠️ İşlenecek içerik bulunamadı');
        return [];
      }

      console.log('🧠 Embeddinglar oluşturuluyor...');
      const contents = allChunks.map(d => d.content);
      const embeddings = await this.openrouter.createEmbeddings(contents);

      const documentsWithEmbeddings = allChunks.map((doc, index) => ({
        ...doc,
        embedding: embeddings[index],
        createdAt: new Date(),
        metadata: {
          ...doc.metadata,
          type: doc.metadata?.type || 'document_chunk'
        }
      }));

      await this.vectorDB.insertKnowledge(documentsWithEmbeddings);

      // Güncel istatistikleri göster
      const newStats = await this.vectorDB.getDatabaseStats();
      console.log(`✅ ${documentsWithEmbeddings.length} yeni chunk veritabanına eklendi`);
      console.log(`📊 Güncel durum: ${newStats.documentCount} döküman, ${newStats.uniqueFiles} dosya`);
      console.log(`⏱️ Yükleme süresi: ${Date.now() - loadStartMs} ms`);
      
      return documentsWithEmbeddings;
    } catch (error) {
      console.error('❌ Klasörden içe aktarma hatası:', error);
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
      const queryStartMs = Date.now();
      
      const {
        topK = config.rag.topKResults,
        includeMetadata = true,
        temperature = 0.2
      } = options;
      
      console.log(`❓ Soru: "${userQuestion}"`);
      
      // 1. Kullanıcı sorgusu için embedding oluştur
      const queryEmbedding = await this.openrouter.createEmbedding(userQuestion);
      
      // 2. Vector search ile en yakın dökümanları bul
      let relevantDocs = await this.vectorDB.vectorSearch(queryEmbedding, topK);
      
      // 3. Keyword matching ile ek sonuçlar bul
      const keywordResults = await this.keywordSearch(userQuestion, topK);
      
      // 4. Sonuçları birleştir ve sırala
      relevantDocs = this.mergeAndRankResults(relevantDocs, keywordResults, topK);
      
      if (relevantDocs.length === 0) {
        console.log('⚠️ Hiç ilgili döküman bulunamadı, fallback kullanılıyor');
        const { support } = require('./config');
        return await this.openrouter.hrChatCompletion(
          userQuestion,
          support.fallbackMessage
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
      const elapsedMs = Date.now() - queryStartMs;
      const perfNote = `\n\n[⏱️ ${elapsedMs} ms'de yanıtlandı | chunkSize=${config.rag.chunkSize} | topK=${topK}]`;
      
      // 5. Response objesi oluştur
      const result = {
        question: userQuestion,
        answer: `${response}${perfNote}`,
        sources: relevantDocs.map(doc => ({
          content: doc.content.substring(0, 200) + '...',
          category: doc.metadata?.category || 'unknown',
          source: doc.metadata?.source || 'unknown',
          score: doc.score || 0
        })),
        metadata: {
          retrievedDocuments: relevantDocs.length,
          totalTokensUsed: this.textProcessor.getTokenCount(context + userQuestion + response),
          responseTimeMs: elapsedMs,
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
        answer: require('./config').support.fallbackMessage,
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
   * Keyword-based search ile ek sonuçlar bul
   */
  async keywordSearch(query, topK) {
    try {
      const keywords = this.extractKeywords(query.toLowerCase());
      const allDocs = await this.vectorDB.getAllDocuments();
      
      const scoredDocs = allDocs.map(doc => {
        let score = 0;
        const docText = doc.content.toLowerCase();
        
        // Her keyword için puan ver
        keywords.forEach(keyword => {
          if (docText.includes(keyword)) {
            score += 1;
          }
        });
        
        // Uzunluk bonusu (daha detaylı dökümanlar)
        if (doc.content.length > 200) {
          score += 0.5;
        }
        
        return { ...doc, score };
      });
      
      // Score'a göre sırala ve topK kadar döndür
      return scoredDocs
        .filter(doc => doc.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
        
    } catch (error) {
      console.error('❌ Keyword search hatası:', error);
      return [];
    }
  }

  /**
   * Query'den anahtar kelimeleri çıkar
   */
  extractKeywords(query) {
    const stopwords = ['nasıl', 'nedir', 'hangi', 'kaç', 'ne', 'ile', 've', 'veya', 'ama', 'fakat', 'ancak', 'çünkü', 'eğer', 'ise', 'de', 'da', 'te', 'ta', 'mi', 'mı', 'mu', 'mü'];
    
    return query
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopwords.includes(word))
      .map(word => word.replace(/[^\wçğıöşüÇĞIİÖŞÜ]/g, ''));
  }

  /**
   * Vector search ve keyword search sonuçlarını birleştir ve sırala
   */
  mergeAndRankResults(vectorResults, keywordResults, topK) {
    const allDocs = new Map();
    
    // Vector search sonuçlarını ekle
    vectorResults.forEach((doc, index) => {
      allDocs.set(doc._id || doc.id || index, {
        ...doc,
        finalScore: (doc.score || 0) * 0.7 + (vectorResults.length - index) * 0.3
      });
    });
    
    // Keyword search sonuçlarını ekle
    keywordResults.forEach((doc, index) => {
      const existing = allDocs.get(doc._id || doc.id || `kw_${index}`);
      if (existing) {
        existing.finalScore = Math.max(existing.finalScore, (doc.score || 0) * 0.5);
      } else {
        allDocs.set(doc._id || doc.id || `kw_${index}`, {
          ...doc,
          finalScore: (doc.score || 0) * 0.5
        });
      }
    });
    
    // Final score'a göre sırala ve topK kadar döndür
    return Array.from(allDocs.values())
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, topK);
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

      // OCR sistem durumunu kontrol et
      let ocrStatus = {
        qwenVL: { status: 'not_available', message: 'Yüklenmemiş' }
      };

      // Qwen2.5-VL OCR API durumu (Ana OCR)
      try {
        const LocalQwenVL = require('./utils/localQwenVL');
        const qwenVL = new LocalQwenVL(config.ocr?.qwenVL?.apiUrl);
        const health = await qwenVL.checkHealth();
        ocrStatus.qwenVL = {
          status: health.status === 'healthy' ? 'ready' : 'error',
          message: health.message || 'Bilinmiyor',
          modelLoaded: health.modelLoaded,
          device: health.device,
          config: qwenVL.getConfig()
        };
      } catch (e) {
        ocrStatus.qwenVL = { status: 'error', message: e.message };
      }



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
        ocr: ocrStatus,
        status: this.isInitialized ? 'ready' : 'not_initialized',
        ocrPriority: ['qwen2.5-vl']
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
