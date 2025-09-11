const OllamaClient = require('./utils/ollama');
const MongoDBVectorDB = require('./utils/mongodb');
const TextProcessor = require('./utils/textProcessor');
const config = require('./config');

class HRRAGSystem {
  constructor() {
    this.ollama = new OllamaClient();
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
      const embeddings = await this.ollama.createEmbeddings(contents);
      
      // Duplicate content'leri filtrele
      const uniqueProcedures = this.removeDuplicateContent(procedures);
      
      // Unique procedures için embedding oluştur
      const uniqueContents = uniqueProcedures.map(p => p.content);
      const uniqueEmbeddings = await this.ollama.createEmbeddings(uniqueContents);
      
      // Embedding'leri prosedürlerle birleştir
      const documentsWithEmbeddings = uniqueProcedures.map((procedure, index) => ({
        ...procedure,
        embedding: uniqueEmbeddings[index] || new Array(100).fill(0), // Eksik embedding için fallback
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
      const embeddings = await this.ollama.createEmbeddings(contents);

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
        temperature = 0.2,
        chatHistory = []
      } = options;
      
      console.log(`❓ Soru: "${userQuestion}"`);
      
      // 1. Query expansion (synonym ve related terms)
      const expandedQuery = await this.expandQuery(userQuestion);
      console.log(`🔍 Genişletilmiş sorgu: "${expandedQuery}"`);
      
      // 2. Kullanıcı sorgusu için embedding oluştur
      const queryEmbedding = await this.ollama.createEmbedding(expandedQuery);
      
      // 3. Vector search ile en yakın dökümanları bul (fazla al, sonra filtrele)
      let vectorResults = await this.vectorDB.vectorSearch(queryEmbedding, topK * 2);
      
      // 4. BM25 keyword matching ile ek sonuçlar
      const keywordResults = await this.advancedKeywordSearch(userQuestion, topK * 2);
      
      // 5. Hybrid search: Vector + Keyword results
      let hybridResults = this.advancedHybridSearch(vectorResults, keywordResults, topK);
      
      // 6. Re-ranking with context awareness
      let relevantDocs = await this.reRankResults(hybridResults, userQuestion, chatHistory, topK);
      
      if (relevantDocs.length === 0) {
        console.log('⚠️ Hiç ilgili döküman bulunamadı, fallback kullanılıyor');
        const { support } = require('./config');
        return {
          question: userQuestion,
          answer: support.fallbackMessage,
          sources: [],
          metadata: { fallback: true, timestamp: new Date() }
        };
      }

      // 7. CHUNK LOGGING: Seçilen chunk'ları detaylı logla
      this.logSelectedChunks(relevantDocs, userQuestion);
      
      // 8. Context oluştur (semantic diversity ile)
      const context = this.createOptimizedContext(relevantDocs);
      
      console.log(`📋 ${relevantDocs.length} ilgili döküman bulundu`);
      console.log(`📝 Context uzunluğu: ${this.textProcessor.getTokenCount(context)} token`);
      
      // 4. LLM ile üretken cevap üret (chat history ile)
      const response = await this.ollama.hrChatCompletionWithHistory(
        userQuestion, 
        context, 
        chatHistory
      );
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
      const embeddings = await this.ollama.createEmbeddings(contents);
      
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
          embedding: config.ollama.embeddingModel,
          chat: config.ollama.model
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
   * Duplicate content'leri kaldır
   */
  removeDuplicateContent(documents) {
    const seen = new Map();
    const unique = [];
    
    for (const doc of documents) {
      // Content'i normalize et ve hash oluştur
      const normalizedContent = doc.content
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\säçğıöşü]/gi, '')
        .trim();
      
      // Çok kısa content'leri atla
      if (normalizedContent.length < 20) continue;
      
      // İlk 100 karakteri key olarak kullan (benzer content'leri yakala)
      const contentKey = normalizedContent.substring(0, 100);
      
      if (!seen.has(contentKey)) {
        seen.set(contentKey, true);
        unique.push(doc);
        console.log(`✅ Benzersiz chunk: ${doc.content.substring(0, 50)}...`);
      } else {
        console.log(`🗑️ Duplicate atlandı: ${doc.content.substring(0, 50)}...`);
      }
    }
    
    console.log(`📊 ${documents.length} → ${unique.length} (${documents.length - unique.length} duplicate kaldırıldı)`);
    return unique;
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

  /**
   * Query expansion with synonyms and related terms
   */
  async expandQuery(query) {
    const synonymMap = {
      'maaş': ['ücret', 'bordro', 'gelir', 'kazanç'],
      'izin': ['tatil', 'raporlu', 'istirahat'],
      'çalışan': ['personel', 'işçi', 'memur', 'elemanlar'],
      'şirket': ['kurum', 'firma', 'organizasyon', 'iş yeri'],
      'başvuru': ['müracaat', 'talep', 'form'],
      'saat': ['zaman', 'süre', 'vardiya'],
      'departman': ['bölüm', 'birim', 'ekip'],
      'yönetici': ['müdür', 'amir', 'baş']
    };

    let expandedQuery = query;
    const words = query.toLowerCase().split(/\s+/);
    
    words.forEach(word => {
      if (synonymMap[word]) {
        const synonyms = synonymMap[word].slice(0, 2);
        expandedQuery += ' ' + synonyms.join(' ');
      }
    });

    return expandedQuery;
  }

  /**
   * Advanced BM25-like keyword search
   */
  async advancedKeywordSearch(query, topK) {
    try {
      const allDocs = await this.vectorDB.getAllDocuments();
      if (!allDocs || allDocs.length === 0) return [];

      const queryTerms = this.extractKeywords(query.toLowerCase());
      const avgDocLength = allDocs.reduce((sum, doc) => sum + doc.content.length, 0) / allDocs.length;
      
      const scoredDocs = allDocs.map(doc => {
        const docText = doc.content.toLowerCase();
        const docLength = doc.content.length;
        const k1 = 1.5, b = 0.75;
        
        let score = 0;
        queryTerms.forEach(term => {
          const tf = (docText.match(new RegExp(term, 'g')) || []).length;
          const idf = Math.log((allDocs.length + 1) / (allDocs.filter(d => 
            d.content.toLowerCase().includes(term)).length + 1));
          score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
        });

        if (doc.metadata?.category && queryTerms.some(term => 
          doc.metadata.category.toLowerCase().includes(term))) {
          score += 0.5;
        }

        return { ...doc, score };
      });

      return scoredDocs
        .filter(doc => doc.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
        
    } catch (error) {
      console.error('❌ Advanced keyword search hatası:', error);
      return [];
    }
  }

  /**
   * Advanced hybrid search
   */
  advancedHybridSearch(vectorResults, keywordResults, topK) {
    const combinedMap = new Map();
    const vectorWeight = 0.7, keywordWeight = 0.3;

    vectorResults.forEach(doc => {
      const key = doc._id?.toString() || doc.content.substring(0, 50);
      combinedMap.set(key, {
        ...doc,
        finalScore: doc.score * vectorWeight,
        source: 'vector'
      });
    });

    keywordResults.forEach(doc => {
      const key = doc._id?.toString() || doc.content.substring(0, 50);
      if (combinedMap.has(key)) {
        const existing = combinedMap.get(key);
        existing.finalScore += doc.score * keywordWeight;
        existing.source = 'hybrid';
      } else {
        combinedMap.set(key, {
          ...doc,
          finalScore: doc.score * keywordWeight,
          source: 'keyword'
        });
      }
    });

    return Array.from(combinedMap.values())
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, topK);
  }

  /**
   * Advanced re-ranking
   */
  async reRankResults(results, query, chatHistory, topK) {
    const contextTerms = this.extractContextCues(query, chatHistory);
    
    const reRankedResults = results.map(doc => {
      let reRankScore = doc.finalScore || doc.score;
      
      contextTerms.forEach(({ term, importance }) => {
        if (doc.content.toLowerCase().includes(term.toLowerCase())) {
          reRankScore += 0.1 * importance;
        }
      });
      
      if (doc.createdAt) {
        const daysDiff = (Date.now() - new Date(doc.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff < 30) reRankScore += 0.05;
      }
      
      if (doc.content.length < 50) {
        reRankScore *= 0.8;
      }

      return { ...doc, reRankScore };
    });

    return reRankedResults
      .sort((a, b) => b.reRankScore - a.reRankScore)
      .slice(0, topK);
  }

  /**
   * Extract context cues
   */
  extractContextCues(query, chatHistory) {
    const cues = [];
    
    this.extractKeywords(query).forEach(term => {
      cues.push({ term, importance: 0.8 });
    });

    const historyText = chatHistory
      .filter(msg => msg.role === 'user')
      .map(msg => msg.content)
      .join(' ');
    
    this.extractKeywords(historyText).forEach(term => {
      if (!cues.find(c => c.term === term)) {
        cues.push({ term, importance: 0.4 });
      }
    });

    return cues;
  }

  /**
   * Create optimized context
   */
  createOptimizedContext(relevantDocs) {
    const categoryMap = new Map();
    
    relevantDocs.forEach((doc, index) => {
      const category = doc.metadata?.category || 'general';
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category).push({ ...doc, originalIndex: index });
    });

    let diverseChunks = [];
    categoryMap.forEach((chunks, category) => {
      const sortedChunks = chunks.sort((a, b) => 
        (b.reRankScore || b.finalScore || b.score) - 
        (a.reRankScore || a.finalScore || a.score));
      diverseChunks.push(...sortedChunks.slice(0, 2));
    });

    diverseChunks.sort((a, b) => 
      (b.reRankScore || b.finalScore || b.score) - 
      (a.reRankScore || a.finalScore || a.score));

    return diverseChunks
      .map((doc, index) => `[KAYNAK ${index + 1}] ${doc.content}`)
      .join('\n\n');
  }

  /**
   * Log selected chunks
   */
  logSelectedChunks(chunks, query) {
    console.log(`\n🎯 ===== SEÇILEN TOP-${chunks.length} CHUNK'LAR =====`);
    console.log(`📝 Sorgu: "${query}"`);
    console.log(`🔍 Toplam chunk: ${chunks.length}`);
    
    chunks.forEach((chunk, index) => {
      console.log(`\n📄 CHUNK ${index + 1}/${chunks.length}:`);
      console.log(`   📊 Skor: ${(chunk.reRankScore || chunk.finalScore || chunk.score)?.toFixed(4) || 'N/A'}`);
      
      if (chunk.metrics) {
        console.log(`   📐 Similarity Metrics:`);
        console.log(`      • Cosine: ${chunk.metrics.cosine?.toFixed(3) || 'N/A'}`);
        console.log(`      • Euclidean: ${chunk.metrics.euclidean?.toFixed(3) || 'N/A'}`);
        console.log(`      • Jaccard: ${chunk.metrics.jaccard?.toFixed(3) || 'N/A'}`);
      }
      
      console.log(`   🏷️  Kategori: ${chunk.metadata?.category || 'Bilinmeyen'}`);
      console.log(`   📂 Kaynak: ${chunk.metadata?.source || 'N/A'}`);
      console.log(`   🔤 Uzunluk: ${chunk.content?.length || 0} karakter`);
      console.log(`   📋 İçerik: "${chunk.content?.substring(0, 150)}..."`);
      
      if (chunk.source) {
        console.log(`   🔍 Arama türü: ${chunk.source}`);
      }
    });
    
    console.log(`\n✅ ===== CHUNK LOG TAMAMLANDI =====\n`);
  }
}

module.exports = HRRAGSystem;
