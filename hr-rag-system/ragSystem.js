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
    
    // === ANTI-REPETITION SYSTEM ===
    this.responseMemory = []; // Son N cevabı sakla
    this.usedChunks = new Map(); // Kullanılan chunk'ları track et
    this.conversationContext = {
      lastTopics: [],
      questionTypes: [],
      responsePatterns: []
    };
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
        topK = config.rag.finalTopK,
        includeMetadata = true,
        temperature = 0.2,
        chatHistory = []
      } = options;
      
      console.log(`❓ Soru: "${userQuestion}"`);
      
      // === STAGE 0: ANTI-REPETITION ANALYSIS ===
      const antiRepetition = await this.analyzeRepetitionRisk(userQuestion, chatHistory);
      console.log(`🔒 Anti-repetition analysis: Risk=${antiRepetition.riskLevel}, Strategy=${antiRepetition.strategy}`);
      
      // === STAGE 1: ADVANCED QUERY EXPANSION ===
      const expandedQuery = await this.advancedExpandQuery(userQuestion, chatHistory);
      console.log(`🔍 Genişletilmiş sorgu: "${expandedQuery}"`);
      
      // === STAGE 2: PARALLEL RETRIEVAL ===
      const queryEmbedding = await this.ollama.createEmbedding(expandedQuery);
      
      // İlk retrieval - geniş ağ (paralel)
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorDB.multiSimilaritySearch(queryEmbedding, config.rag.initialTopK),
        this.enhancedKeywordSearch(userQuestion, expandedQuery, config.rag.initialTopK)
      ]);
      
      console.log(`📊 İlk retrieval: ${vectorResults.length} vector, ${keywordResults.length} keyword sonuç`);
      
      // === STAGE 3: ENHANCED HYBRID SEARCH ===
      let hybridResults = this.enhancedHybridSearch(vectorResults, keywordResults, config.rag.hybridTopK);
      console.log(`🔄 Hibrit arama: ${hybridResults.length} sonuç birleştirildi`);
      
      // === STAGE 4: PRE-RERANK SELECTION (Hibrit'ten en iyi chunk'ları seç) ===
      const preRerankResults = hybridResults
        .sort((a, b) => (b.finalScore + (b.hybridBonus || 0)) - (a.finalScore + (a.hybridBonus || 0)))
        .slice(0, config.rag.preRerankTopK);
      console.log(`📋 Pre-rerank selection: ${preRerankResults.length} kaliteli chunk seçildi`);
      
      // === STAGE 5: FINAL PRECISION RE-RANKING (Son aşama, az chunk üzerinde) ===
      let relevantDocs = await this.finalPrecisionReRanking(preRerankResults, userQuestion, chatHistory, expandedQuery, topK, antiRepetition);
      console.log(`🎯 Final precision re-ranking: ${relevantDocs.length} ultra-kaliteli sonuç`);
      
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
      
      // === STAGE 5: ADVANCED CONTEXT CREATION ===
      const context = this.createAdvancedContext(relevantDocs, userQuestion, chatHistory);
      
      const contextTokens = this.textProcessor.getTokenCount(context);
      console.log(`🏆 ${relevantDocs.length} ULTRA-PRECISION döküman → ${contextTokens}/${config.rag.maxContextLength} token context`);
      
      // === STAGE 6: ANTI-REPETITION CONTEXT-AWARE GENERATION ===
      const dynamicPrompt = this.generateAntiRepetitionPrompt(userQuestion, antiRepetition, chatHistory);
      const response = await this.ollama.antiRepetitionChatCompletion(
        userQuestion, 
        context, 
        chatHistory,
        dynamicPrompt,
        { 
          maxTokens: config.rag.maxContextLength, 
          temperature,
          strategy: antiRepetition.strategy
        }
      );
      const elapsedMs = Date.now() - queryStartMs;
      
      // === STAGE 7: RESPONSE VALIDATION & MEMORY UPDATE ===
      const validatedResponse = this.validateAndUpdateMemory(response, userQuestion, relevantDocs, antiRepetition);
      const perfNote = `\n\n[⏱️ ${elapsedMs} ms'de yanıtlandı | chunks=${relevantDocs.length} | strategy=${antiRepetition.strategy}]`;
      
      // 5. Response objesi oluştur
      const result = {
        question: userQuestion,
        answer: `${validatedResponse}${perfNote}`,
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
  /**
   * ADVANCED QUERY EXPANSION - Çoklu genişletme stratejisi
   */
  async advancedExpandQuery(query, chatHistory = []) {
    if (!config.rag.enableAdvancedExpansion) {
      return query;
    }

    let expandedQuery = query;
    const expansion = config.rag.expansionMethods;
    
    // === 1. SYNONYM EXPANSION ===
    if (expansion.synonyms) {
      expandedQuery = this.synonymExpansion(expandedQuery);
    }
    
    // === 2. MORPHOLOGICAL EXPANSION (Türkçe) ===
    if (expansion.morphological) {
      expandedQuery = this.morphologicalExpansion(expandedQuery);
    }
    
    // === 3. CONTEXTUAL EXPANSION (Chat History) ===
    if (expansion.contextual && chatHistory.length > 0) {
      expandedQuery = this.contextualExpansion(expandedQuery, chatHistory);
    }
    
    // === 4. SEMANTIC EXPANSION ===
    if (expansion.semantic) {
      expandedQuery = await this.semanticExpansion(expandedQuery);
    }
    
    // Expansion limit kontrolü
    const expandedTerms = expandedQuery.split(/\s+/).length;
    const originalTerms = query.split(/\s+/).length;
    
    if (expandedTerms > originalTerms + config.rag.maxExpansionTerms) {
      const limitedTerms = expandedQuery.split(/\s+/).slice(0, originalTerms + config.rag.maxExpansionTerms);
      expandedQuery = limitedTerms.join(' ');
    }
    
    return expandedQuery;
  }

  /**
   * Synonym-based expansion
   */
  synonymExpansion(query) {
    const synonymMap = {
      // HR Terimleri
      'maaş': ['ücret', 'bordro', 'gelir', 'kazanç', 'ödeme'],
      'izin': ['tatil', 'raporlu', 'istirahat', 'izinli'],
      'çalışan': ['personel', 'işçi', 'memur', 'elemanlar', 'kadro'],
      'şirket': ['kurum', 'firma', 'organizasyon', 'iş yeri', 'işletme'],
      'başvuru': ['müracaat', 'talep', 'form', 'dilekçe'],
      'departman': ['bölüm', 'birim', 'ekip', 'kısım'],
      'yönetici': ['müdür', 'amir', 'baş', 'şef'],
      'saat': ['zaman', 'süre', 'vardiya', 'mesai'],
      
      // İş Süreçleri
      'işe alım': ['istihdam', 'ise başlama', 'personel alımı'],
      'terfi': ['yükselme', 'promosyon', 'kariyer'],
      'eğitim': ['kurs', 'seminer', 'öğretim', 'gelişim'],
      'performans': ['başarı', 'verimlilik', 'etkinlik'],
      'disiplin': ['ceza', 'uyarı', 'yaptırım'],
      
      // Haklar ve Yükümlülükler
      'hak': ['yetki', 'imkan', 'imtiyaz'],
      'yükümlülük': ['görev', 'sorumluluk', 'vazife'],
      'güvenlik': ['emniyet', 'korunma', 'sigorta']
    };

    let expandedQuery = query;
    const words = query.toLowerCase().split(/\s+/);
    
    words.forEach(word => {
      const cleanWord = word.replace(/[^\wçğıöşüÇĞIİÖŞÜ]/g, '');
      if (synonymMap[cleanWord]) {
        const synonyms = synonymMap[cleanWord].slice(0, 3); // Max 3 synonym
        expandedQuery += ' ' + synonyms.join(' ');
      }
    });

    return expandedQuery;
  }

  /**
   * Morphological expansion for Turkish
   */
  morphologicalExpansion(query) {
    // Türkçe kökleri ve çekimli hallerini genişlet
    const morphMap = {
      'çalış': ['çalışma', 'çalışan', 'çalışır', 'çalıştır'],
      'iş': ['işle', 'işçi', 'işlem', 'işletme'],
      'öde': ['ödeme', 'öder', 'ödendi', 'ödeyici'],
      'başla': ['başlangıç', 'başlatır', 'başlar'],
      'bitir': ['bitiş', 'bitiren', 'biter']
    };

    let expandedQuery = query;
    Object.keys(morphMap).forEach(root => {
      if (query.toLowerCase().includes(root)) {
        expandedQuery += ' ' + morphMap[root].slice(0, 2).join(' ');
      }
    });

    return expandedQuery;
  }

  /**
   * Contextual expansion from chat history
   */
  contextualExpansion(query, chatHistory) {
    const historyText = chatHistory
      .filter(msg => msg.role === 'user')
      .slice(-3) // Son 3 mesaj
      .map(msg => msg.content)
      .join(' ');
    
    const contextTerms = this.extractKeywords(historyText);
    const relevantTerms = contextTerms
      .filter(term => !query.toLowerCase().includes(term))
      .slice(0, 3);
    
    return query + ' ' + relevantTerms.join(' ');
  }

  /**
   * Semantic expansion using embeddings
   */
  async semanticExpansion(query) {
    try {
      // HR domain'ine özel semantik genişletme terimleri
      const semanticMap = {
        'maaş': ['özlük hakları', 'finansal', 'ekonomik'],
        'izin': ['çalışma süresi', 'dinlenme', 'yıllık'],
        'performans': ['değerlendirme', 'başarı kriterleri', 'hedef'],
        'eğitim': ['gelişim', 'yetkinlik', 'sertifikasyon']
      };

      let expandedQuery = query;
      const words = query.toLowerCase().split(/\s+/);
      
      words.forEach(word => {
        const cleanWord = word.replace(/[^\wçğıöşüÇĞIİÖŞÜ]/g, '');
        if (semanticMap[cleanWord]) {
          expandedQuery += ' ' + semanticMap[cleanWord].slice(0, 2).join(' ');
        }
      });

      return expandedQuery;
    } catch (error) {
      console.error('❌ Semantic expansion hatası:', error);
      return query;
    }
  }

  /**
   * ENHANCED KEYWORD SEARCH - Gelişmiş BM25 + TF-IDF hibrit
   */
  async enhancedKeywordSearch(originalQuery, expandedQuery, topK) {
    try {
      const allDocs = await this.vectorDB.getAllDocuments();
      if (!allDocs || allDocs.length === 0) return [];

      // Orijinal ve genişletilmiş query'den terimler çıkar
      const originalTerms = this.extractKeywords(originalQuery.toLowerCase());
      const expandedTerms = this.extractKeywords(expandedQuery.toLowerCase());
      const allTerms = [...new Set([...originalTerms, ...expandedTerms])];
      
      const avgDocLength = allDocs.reduce((sum, doc) => sum + doc.content.length, 0) / allDocs.length;
      const { bm25_k1, bm25_b, bm25_k3 } = config.rag;
      
      const scoredDocs = allDocs.map(doc => {
        const docText = doc.content.toLowerCase();
        const docLength = doc.content.length;
        let totalScore = 0;
        
        // === BM25 SCORING ===
        allTerms.forEach(term => {
          const tf = (docText.match(new RegExp(term, 'g')) || []).length;
          const docFreq = allDocs.filter(d => d.content.toLowerCase().includes(term)).length;
          const idf = Math.log((allDocs.length - docFreq + 0.5) / (docFreq + 0.5));
          
          // BM25 formülü
          const bm25Score = idf * ((tf * (bm25_k1 + 1)) / 
            (tf + bm25_k1 * (1 - bm25_b + bm25_b * (docLength / avgDocLength))));
          
          // Orijinal query terimleri için bonus
          const termWeight = originalTerms.includes(term) ? 1.5 : 1.0;
          totalScore += bm25Score * termWeight;
        });
        
        // === ADDITIONAL SCORING FACTORS ===
        
        // 1. Metadata category matching
        if (doc.metadata?.category) {
          allTerms.forEach(term => {
            if (doc.metadata.category.toLowerCase().includes(term)) {
              totalScore += 0.8; // Category match bonus
            }
          });
        }
        
        // 2. Title/header matching (first 100 chars)
        const docStart = docText.substring(0, 100);
        allTerms.forEach(term => {
          if (docStart.includes(term)) {
            totalScore += 0.6; // Header match bonus
          }
        });
        
        // 3. Exact phrase matching
        if (docText.includes(originalQuery.toLowerCase())) {
          totalScore += 1.2; // Exact phrase bonus
        }
        
        // 4. Document quality indicators
        if (doc.content.length > 200 && doc.content.length < 2000) {
          totalScore += 0.3; // Optimal length bonus
        }
        
        // 5. Recency bonus
        if (doc.createdAt) {
          const daysSince = (Date.now() - new Date(doc.createdAt).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < 30) totalScore += 0.4;
          else if (daysSince < 90) totalScore += 0.2;
        }

        return { ...doc, score: totalScore };
      });

      return scoredDocs
        .filter(doc => doc.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
        
    } catch (error) {
      console.error('❌ Enhanced keyword search hatası:', error);
      return [];
    }
  }

  /**
   * ENHANCED HYBRID SEARCH - Çoklu algoritma kombinasyonu
   */
  enhancedHybridSearch(vectorResults, keywordResults, topK) {
    const combinedMap = new Map();
    const weights = config.rag;
    
    // Normalize scores
    const normalizeScores = (results) => {
      if (results.length === 0) return results;
      const maxScore = Math.max(...results.map(r => r.score || 0));
      return results.map(r => ({
        ...r,
        normalizedScore: maxScore > 0 ? (r.score || 0) / maxScore : 0
      }));
    };
    
    const normalizedVector = normalizeScores(vectorResults);
    const normalizedKeyword = normalizeScores(keywordResults);
    
    // === VECTOR SEARCH RESULTS ===
    normalizedVector.forEach((doc, index) => {
      const key = doc._id?.toString() || doc.content.substring(0, 50);
      const positionBonus = Math.max(0, (normalizedVector.length - index) / normalizedVector.length * 0.2);
      
      combinedMap.set(key, {
        ...doc,
        finalScore: (doc.normalizedScore || 0) * weights.vectorWeight + positionBonus,
        sources: ['vector']
      });
    });

    // === KEYWORD SEARCH RESULTS ===
    normalizedKeyword.forEach((doc, index) => {
      const key = doc._id?.toString() || doc.content.substring(0, 50);
      const positionBonus = Math.max(0, (normalizedKeyword.length - index) / normalizedKeyword.length * 0.2);
      const keywordScore = (doc.normalizedScore || 0) * weights.keywordWeight + positionBonus;
      
      if (combinedMap.has(key)) {
        const existing = combinedMap.get(key);
        existing.finalScore += keywordScore;
        existing.sources.push('keyword');
        existing.hybridBonus = 0.15; // Hibrit bonus
      } else {
        combinedMap.set(key, {
          ...doc,
          finalScore: keywordScore,
          sources: ['keyword']
        });
      }
    });
    
    // === SEMANTIC DIVERSITY CHECK ===
    const results = Array.from(combinedMap.values());
    const diversifiedResults = this.ensureSemanticDiversity(results);
    
    return diversifiedResults
      .sort((a, b) => (b.finalScore + (b.hybridBonus || 0)) - (a.finalScore + (a.hybridBonus || 0)))
      .slice(0, topK);
  }

  /**
   * Semantic diversity sağlama
   */
  ensureSemanticDiversity(results) {
    if (!config.rag.enableSemanticDiversity) return results;
    
    const diversified = [];
    const threshold = config.rag.diversityThreshold;
    const maxPerCategory = config.rag.maxChunksPerCategory;
    const categoryCount = {};
    
    results.forEach(doc => {
      // Category-based diversity
      const category = doc.metadata?.category || 'unknown';
      if (!categoryCount[category]) categoryCount[category] = 0;
      
      if (categoryCount[category] >= maxPerCategory) {
        return; // Skip this document
      }
      
      // Content-based similarity check
      let isTooSimilar = false;
      for (const existingDoc of diversified) {
        const similarity = this.calculateContentSimilarity(doc.content, existingDoc.content);
        if (similarity > threshold) {
          isTooSimilar = true;
          break;
        }
      }
      
      if (!isTooSimilar) {
        diversified.push(doc);
        categoryCount[category]++;
      }
    });
    
    return diversified;
  }

  /**
   * Content similarity calculation (simple)
   */
  calculateContentSimilarity(content1, content2) {
    const words1 = new Set(content1.toLowerCase().split(/\s+/));
    const words2 = new Set(content2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size; // Jaccard similarity
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
   * FINAL PRECISION RE-RANKING - Az ama ultra-kaliteli chunk'lar için optimize edilmiş re-ranking
   */
  async finalPrecisionReRanking(results, originalQuery, chatHistory, expandedQuery, topK, antiRepetition = null) {
    if (!results || results.length === 0) return [];
    
    console.log(`🎯 Final precision re-ranking başlıyor: ${results.length} kaliteli doküman`);
    
    // Bu noktada zaten hibrit aramadan gelen kaliteli chunk'lar var
    // Sadece fine-tuning yapacağız, ağır re-ranking değil
    
    let precisionResults = [...results];
    
    // === PRECISION STAGE 1: QUERY-DOCUMENT RELEVANCE ===
    precisionResults = this.precisionStage1_queryRelevance(precisionResults, originalQuery, expandedQuery);
    
    // === PRECISION STAGE 2: CONTEXT COHERENCE ===
    precisionResults = this.precisionStage2_contextCoherence(precisionResults, originalQuery, chatHistory);
    
    // === PRECISION STAGE 3: CONTENT QUALITY ===
    precisionResults = this.precisionStage3_contentQuality(precisionResults);
    
    // === PRECISION STAGE 4: ANTI-REPETITION FILTERING ===
    if (antiRepetition && config.rag.enableAntiRepetition) {
      precisionResults = this.applyAntiRepetitionFiltering(precisionResults, antiRepetition);
    }
    
    // Final ultra-precision selection
    const ultraPrecisionResults = precisionResults
      .sort((a, b) => b.precisionScore - a.precisionScore)
      .slice(0, config.rag.finalTopK);  // En iyi 3 chunk
    
    console.log(`✅ Final precision re-ranking tamamlandı: ${ultraPrecisionResults.length} ultra-kaliteli chunk`);
    
    // Debug logging
    if (config.rag.enableChunkLogging) {
      ultraPrecisionResults.forEach((chunk, i) => {
        console.log(`🏆 ULTRA-PRECISION CHUNK ${i + 1}: Score=${chunk.precisionScore.toFixed(4)}`);
      });
    }
    
    return ultraPrecisionResults;
  }

  /**
   * Precision Stage 1: Query-Document Relevance
   */
  precisionStage1_queryRelevance(results, originalQuery, expandedQuery) {
    const originalTerms = this.extractKeywords(originalQuery.toLowerCase());
    const expandedTerms = this.extractKeywords(expandedQuery.toLowerCase());
    
    return results.map(doc => {
      let relevanceScore = doc.finalScore || doc.score || 0;
      const docText = doc.content.toLowerCase();
      
      // Exact phrase matching (en yüksek bonus)
      if (docText.includes(originalQuery.toLowerCase())) {
        relevanceScore += 1.5;
      }
      
      // Original query terms (yüksek ağırlık)
      let termMatchCount = 0;
      originalTerms.forEach(term => {
        const matches = (docText.match(new RegExp(term, 'g')) || []).length;
        termMatchCount += matches;
        relevanceScore += matches * 0.4;
      });
      
      // Term coverage bonus
      const termCoverage = termMatchCount / originalTerms.length;
      relevanceScore += termCoverage * 0.8;
      
      // Document start relevance (title/header area)
      const docStart = docText.substring(0, 150);
      originalTerms.forEach(term => {
        if (docStart.includes(term)) {
          relevanceScore += 0.6;
        }
      });
      
      return {
        ...doc,
        precisionScore: relevanceScore,
        termCoverage,
        termMatchCount
      };
    });
  }

  /**
   * Precision Stage 2: Context Coherence
   */
  precisionStage2_contextCoherence(results, originalQuery, chatHistory) {
    const contextCues = this.extractAdvancedContextCues(originalQuery, chatHistory);
    
    return results.map(doc => {
      let coherenceScore = doc.precisionScore || 0;
      const docText = doc.content.toLowerCase();
      
      // Intent alignment
      if (contextCues.intent && contextCues.intent.keywords) {
        contextCues.intent.keywords.forEach(keyword => {
          if (docText.includes(keyword.toLowerCase())) {
            coherenceScore += 0.4 * contextCues.intent.confidence;
          }
        });
      }
      
      // Category alignment
      if (doc.metadata?.category && contextCues.categories.includes(doc.metadata.category)) {
        coherenceScore += 0.6;
      }
      
      // Chat history coherence
      let historyAlignment = 0;
      contextCues.historyTerms.forEach(({ term, importance }) => {
        if (docText.includes(term.toLowerCase())) {
          historyAlignment += importance * 0.2;
        }
      });
      coherenceScore += historyAlignment;
      
      return {
        ...doc,
        precisionScore: coherenceScore,
        historyAlignment
      };
    });
  }

  /**
   * Precision Stage 3: Content Quality Assessment
   */
  precisionStage3_contentQuality(results) {
    return results.map(doc => {
      let qualityScore = doc.precisionScore || 0;
      const content = doc.content;
      const contentLength = content.length;
      
      // Optimal length bonus (ne çok kısa, ne çok uzun)
      if (contentLength >= 100 && contentLength <= 1200) {
        qualityScore += 0.3;
      } else if (contentLength < 50) {
        qualityScore *= 0.7; // Çok kısa content cezası
      }
      
      // Structure quality (sentences, paragraphs)
      const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
      if (sentences.length >= 2 && sentences.length <= 8) {
        qualityScore += 0.25; // Good structure bonus
      }
      
      // Information density (kelime çeşitliliği)
      const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const uniqueWords = new Set(words);
      const diversity = uniqueWords.size / words.length;
      if (diversity > 0.4) {
        qualityScore += 0.2; // High information density bonus
      }
      
      // Official source bonus
      if (doc.metadata?.type === 'policy' || doc.metadata?.type === 'procedure') {
        qualityScore += 0.4;
      }
      
      // Recency bonus (daha recent content'e bonus)
      if (doc.createdAt) {
        const daysSince = (Date.now() - new Date(doc.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < 30) qualityScore += 0.3;
        else if (daysSince < 90) qualityScore += 0.15;
      }
      
      return {
        ...doc,
        precisionScore: qualityScore,
        contentQuality: {
          length: contentLength,
          sentences: sentences.length,
          diversity: diversity
        }
      };
    });
  }

  /**
   * Stage 1: Keyword matching bonus
   */
  stage1_keywordMatching(results, originalQuery, expandedQuery, weight) {
    const originalTerms = this.extractKeywords(originalQuery.toLowerCase());
    const expandedTerms = this.extractKeywords(expandedQuery.toLowerCase());
    
    return results.map(doc => {
      let keywordScore = doc.finalScore || doc.score || 0;
      const docText = doc.content.toLowerCase();
      
      // Original query terms (highest weight)
      originalTerms.forEach(term => {
        const count = (docText.match(new RegExp(term, 'g')) || []).length;
        keywordScore += count * 0.3;
      });
      
      // Expanded query terms (moderate weight)
      expandedTerms.forEach(term => {
        if (!originalTerms.includes(term)) {
          const count = (docText.match(new RegExp(term, 'g')) || []).length;
          keywordScore += count * 0.15;
        }
      });
      
      // Exact phrase bonus
      if (docText.includes(originalQuery.toLowerCase())) {
        keywordScore += 0.8;
      }
      
      return {
        ...doc,
        reRankScore: keywordScore,
        stage1Score: keywordScore * weight
      };
    });
  }

  /**
   * Stage 2: Semantic similarity re-scoring
   */
  async stage2_semanticSimilarity(results, originalQuery, weight) {
    try {
      const queryEmbedding = await this.ollama.createEmbedding(originalQuery);
      
      return results.map(doc => {
        let semanticScore = doc.reRankScore || 0;
        
        if (doc.embedding && queryEmbedding) {
          // Multiple similarity metrics
          const similarities = this.calculateMultipleSimilarities(queryEmbedding, doc.embedding);
          
          // Weighted combination of similarity metrics
          const combinedSimilarity = 
            similarities.cosine * 0.4 +
            similarities.euclidean * 0.3 +
            similarities.jaccard * 0.3;
          
          semanticScore += combinedSimilarity * 1.2;
        }
        
        return {
          ...doc,
          reRankScore: semanticScore,
          stage2Score: semanticScore * weight
        };
      });
    } catch (error) {
      console.error('❌ Stage 2 semantic re-ranking hatası:', error);
      return results.map(doc => ({
        ...doc,
        stage2Score: (doc.reRankScore || 0) * weight
      }));
    }
  }

  /**
   * Stage 3: Context relevance scoring
   */
  stage3_contextRelevance(results, originalQuery, chatHistory, weight) {
    const contextCues = this.extractAdvancedContextCues(originalQuery, chatHistory);
    
    return results.map(doc => {
      let contextScore = doc.reRankScore || 0;
      const docText = doc.content.toLowerCase();
      
      // Chat history relevance
      contextCues.historyTerms.forEach(({ term, importance }) => {
        if (docText.includes(term.toLowerCase())) {
          contextScore += 0.2 * importance;
        }
      });
      
      // Intent matching
      if (contextCues.intent) {
        const intentKeywords = contextCues.intent.keywords || [];
        intentKeywords.forEach(keyword => {
          if (docText.includes(keyword.toLowerCase())) {
            contextScore += 0.25;
          }
        });
      }
      
      // Document metadata relevance
      if (doc.metadata) {
        if (doc.metadata.category && contextCues.categories.includes(doc.metadata.category)) {
          contextScore += 0.3;
        }
        
        if (doc.metadata.source && contextCues.preferredSources.includes(doc.metadata.source)) {
          contextScore += 0.15;
        }
      }
      
      return {
        ...doc,
        reRankScore: contextScore,
        stage3Score: contextScore * weight
      };
    });
  }

  /**
   * Stage 4: Result diversity optimization
   */
  stage4_resultDiversity(results, weight) {
    const diversityMap = new Map();
    const penaltyThreshold = 0.7; // Similar content penalty threshold
    
    return results.map((doc, index) => {
      let diversityScore = doc.reRankScore || 0;
      
      // Position-based bonus (earlier results get slight bonus)
      const positionBonus = Math.max(0, (results.length - index) / results.length * 0.1);
      diversityScore += positionBonus;
      
      // Content diversity penalty
      let diversityPenalty = 0;
      for (let i = 0; i < index; i++) {
        const similarity = this.calculateContentSimilarity(doc.content, results[i].content);
        if (similarity > penaltyThreshold) {
          diversityPenalty += 0.2 * similarity;
        }
      }
      
      diversityScore -= diversityPenalty;
      
      // Category diversity bonus
      const category = doc.metadata?.category || 'unknown';
      const categoryCount = diversityMap.get(category) || 0;
      if (categoryCount === 0) {
        diversityScore += 0.15; // First in category bonus
      } else if (categoryCount < 2) {
        diversityScore += 0.05; // Second in category small bonus
      }
      diversityMap.set(category, categoryCount + 1);
      
      return {
        ...doc,
        reRankScore: diversityScore,
        stage4Score: diversityScore * weight,
        diversityPenalty
      };
    });
  }

  /**
   * Calculate multiple similarity metrics
   */
  calculateMultipleSimilarities(vec1, vec2) {
    if (!config.rag.enableMultiSimilarity) {
      return { cosine: this.cosineSimilarity(vec1, vec2), euclidean: 0, jaccard: 0 };
    }
    
    const metrics = config.rag.similarityMetrics;
    return {
      cosine: this.cosineSimilarity(vec1, vec2) * metrics.cosine,
      euclidean: this.euclideanSimilarity(vec1, vec2) * metrics.euclidean,
      jaccard: this.jaccardSimilarity(vec1, vec2) * metrics.jaccard,
      manhattan: this.manhattanSimilarity(vec1, vec2) * metrics.manhattan
    };
  }

  euclideanSimilarity(vec1, vec2) {
    const distance = Math.sqrt(vec1.reduce((sum, v, i) => sum + Math.pow(v - vec2[i], 2), 0));
    return 1 / (1 + distance); // Convert distance to similarity
  }

  jaccardSimilarity(vec1, vec2) {
    const set1 = new Set(vec1.map((v, i) => v > 0 ? i : null).filter(v => v !== null));
    const set2 = new Set(vec2.map((v, i) => v > 0 ? i : null).filter(v => v !== null));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  manhattanSimilarity(vec1, vec2) {
    const distance = vec1.reduce((sum, v, i) => sum + Math.abs(v - vec2[i]), 0);
    return 1 / (1 + distance); // Convert distance to similarity
  }

  cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
    const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
    const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0));
    return norm1 && norm2 ? dotProduct / (norm1 * norm2) : 0;
  }

  /**
   * ADVANCED CONTEXT CUES EXTRACTION - Gelişmiş bağlam ipucu çıkarımı
   */
  extractAdvancedContextCues(query, chatHistory) {
    const cues = {
      historyTerms: [],
      intent: null,
      categories: [],
      preferredSources: [],
      urgency: 'normal',
      domain: 'hr'
    };
    
    // === QUERY TERMS ===
    this.extractKeywords(query).forEach(term => {
      cues.historyTerms.push({ term, importance: 1.0, source: 'current_query' });
    });

    // === CHAT HISTORY ANALYSIS ===
    if (chatHistory.length > 0) {
      const historyText = chatHistory
        .filter(msg => msg.role === 'user')
        .slice(-3) // Son 3 mesaj
        .map(msg => msg.content)
        .join(' ');

      this.extractKeywords(historyText).forEach(term => {
        if (!cues.historyTerms.some(cue => cue.term === term)) {
          cues.historyTerms.push({ term, importance: 0.6, source: 'chat_history' });
        }
      });
    }
    
    // === INTENT DETECTION ===
    cues.intent = this.detectUserIntent(query, chatHistory);
    
    // === CATEGORY PREDICTION ===
    cues.categories = this.predictRelevantCategories(query, chatHistory);
    
    // === SOURCE PREFERENCE ===
    cues.preferredSources = this.determinePreferredSources(query);
    
    // === URGENCY DETECTION ===
    cues.urgency = this.detectUrgency(query);

    return cues;
  }

  /**
   * Detect user intent from query
   */
  detectUserIntent(query, chatHistory = []) {
    const lowerQuery = query.toLowerCase();
    
    // Intent patterns
    const intentPatterns = {
      'information_seeking': ['nedir', 'ne demek', 'açıkla', 'bilgi', 'öğren', 'nasıl'],
      'procedure_inquiry': ['nasıl yapılır', 'adım', 'prosedür', 'süreç', 'işlem'],
      'policy_question': ['kural', 'politika', 'yönetmelik', 'yasak', 'izin'],
      'calculation': ['hesapla', 'kaç', 'ne kadar', 'miktar', 'ücret', 'maaş'],
      'troubleshooting': ['sorun', 'problem', 'hata', 'çözüm', 'yardım'],
      'comparison': ['fark', 'karşılaştır', 'hangisi', 'seçenek'],
      'deadline': ['tarih', 'zaman', 'ne zaman', 'süre', 'deadline']
    };
    
    let detectedIntent = 'general';
    let confidence = 0;
    
    Object.keys(intentPatterns).forEach(intent => {
      const matches = intentPatterns[intent].filter(pattern => lowerQuery.includes(pattern));
      if (matches.length > confidence) {
        detectedIntent = intent;
        confidence = matches.length;
      }
    });
    
    return {
      type: detectedIntent,
      confidence: confidence / 10, // Normalize to 0-1
      keywords: intentPatterns[detectedIntent] || []
    };
  }

  /**
   * Predict relevant categories based on query content
   */
  predictRelevantCategories(query, chatHistory = []) {
    const lowerQuery = query.toLowerCase();
    const categories = [];
    
    const categoryKeywords = {
      'hr_policy': ['politika', 'kural', 'yönetmelik', 'prosedür'],
      'salary_benefits': ['maaş', 'ücret', 'bordro', 'prim', 'tazminat'],
      'leave_vacation': ['izin', 'tatil', 'rapor', 'hastalık'],
      'recruitment': ['işe alım', 'mülakat', 'başvuru', 'cv'],
      'performance': ['performans', 'değerlendirme', 'hedef', 'başarı'],
      'training': ['eğitim', 'kurs', 'seminer', 'gelişim'],
      'discipline': ['disiplin', 'ceza', 'uyarı', 'ihlal'],
      'security': ['güvenlik', 'erişim', 'şifre', 'veri'],
      'travel': ['seyahat', 'konaklama', 'harcırah', 'yolluk'],
      'office_management': ['ofis', 'masa', 'ekipman', 'rezervasyon']
    };
    
    Object.keys(categoryKeywords).forEach(category => {
      const matches = categoryKeywords[category].filter(keyword => lowerQuery.includes(keyword));
      if (matches.length > 0) {
        categories.push(category);
      }
    });
    
    return categories.length > 0 ? categories : ['general'];
  }

  /**
   * Determine preferred document sources
   */
  determinePreferredSources(query) {
    const lowerQuery = query.toLowerCase();
    const sources = [];
    
    // Resmi döküman gerektiren sorgular
    if (['politika', 'kural', 'yönetmelik', 'prosedür'].some(term => lowerQuery.includes(term))) {
      sources.push('official_policy', 'procedure_manual');
    }
    
    // Pratik bilgi gerektiren sorgular
    if (['nasıl', 'adım', 'örnek'].some(term => lowerQuery.includes(term))) {
      sources.push('guideline', 'faq', 'example');
    }
    
    return sources.length > 0 ? sources : ['any'];
  }

  /**
   * Detect urgency level from query
   */
  detectUrgency(query) {
    const lowerQuery = query.toLowerCase();
    
    if (['acil', 'hemen', 'ivedi', 'bugün'].some(term => lowerQuery.includes(term))) {
      return 'high';
    }
    
    if (['yakında', 'kısa sürede', 'en kısa zamanda'].some(term => lowerQuery.includes(term))) {
      return 'medium';
    }
    
    return 'normal';
  }

  // ================================
  // ANTI-REPETITION SYSTEM METHODS
  // ================================

  /**
   * Analyze repetition risk based on chat history and previous responses
   */
  async analyzeRepetitionRisk(userQuestion, chatHistory) {
    if (!config.rag.enableAntiRepetition) {
      return { riskLevel: 'low', strategy: 'none' };
    }

    const analysis = {
      riskLevel: 'low',
      strategy: 'normal',
      factors: {
        similarQuestions: 0,
        recentSimilarity: 0,
        topicStagnation: 0,
        chunkReuse: 0
      }
    };

    // === 1. SIMILAR QUESTION ANALYSIS ===
    if (chatHistory.length > 1) {
      const recentQuestions = chatHistory
        .filter(msg => msg.role === 'user')
        .slice(-3)
        .map(msg => msg.content);

      analysis.factors.similarQuestions = this.calculateQuestionSimilarity(userQuestion, recentQuestions);
    }

    // === 2. RESPONSE MEMORY ANALYSIS ===
    if (this.responseMemory.length > 0) {
      analysis.factors.recentSimilarity = this.calculateResponseSimilarity(userQuestion);
    }

    // === 3. TOPIC STAGNATION CHECK ===
    analysis.factors.topicStagnation = this.checkTopicStagnation(userQuestion, chatHistory);

    // === 4. CHUNK REUSE ANALYSIS ===
    analysis.factors.chunkReuse = this.calculateChunkReuseRisk(userQuestion);

    // === RISK LEVEL CALCULATION ===
    const totalRisk = Object.values(analysis.factors).reduce((sum, val) => sum + val, 0) / 4;
    
    if (totalRisk > 0.7) {
      analysis.riskLevel = 'high';
      analysis.strategy = 'aggressive_diversification';
    } else if (totalRisk > 0.4) {
      analysis.riskLevel = 'medium';
      analysis.strategy = 'moderate_diversification';
    } else {
      analysis.riskLevel = 'low';
      analysis.strategy = 'normal';
    }

    console.log(`🔒 Repetition Risk Analysis: ${JSON.stringify(analysis.factors)}`);
    return analysis;
  }

  /**
   * Calculate question similarity with recent questions
   */
  calculateQuestionSimilarity(currentQuestion, recentQuestions) {
    if (!recentQuestions.length) return 0;

    let maxSimilarity = 0;
    const currentWords = new Set(this.extractKeywords(currentQuestion.toLowerCase()));

    recentQuestions.forEach(oldQuestion => {
      const oldWords = new Set(this.extractKeywords(oldQuestion.toLowerCase()));
      const intersection = new Set([...currentWords].filter(x => oldWords.has(x)));
      const union = new Set([...currentWords, ...oldWords]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;
      
      maxSimilarity = Math.max(maxSimilarity, similarity);
    });

    return maxSimilarity;
  }

  /**
   * Calculate similarity with previous responses
   */
  calculateResponseSimilarity(userQuestion) {
    if (!this.responseMemory.length) return 0;

    const questionWords = new Set(this.extractKeywords(userQuestion.toLowerCase()));
    let avgSimilarity = 0;
    
    this.responseMemory.slice(-3).forEach(memory => {
      const responseWords = new Set(this.extractKeywords(memory.response.toLowerCase()));
      const intersection = new Set([...questionWords].filter(x => responseWords.has(x)));
      const union = new Set([...questionWords, ...responseWords]);
      
      if (union.size > 0) {
        avgSimilarity += intersection.size / union.size;
      }
    });

    return this.responseMemory.length > 0 ? avgSimilarity / Math.min(3, this.responseMemory.length) : 0;
  }

  /**
   * Check if conversation is stuck on same topic
   */
  checkTopicStagnation(userQuestion, chatHistory) {
    if (chatHistory.length < 4) return 0;

    const recentTopics = chatHistory
      .slice(-6)
      .filter(msg => msg.role === 'user')
      .map(msg => this.extractMainTopic(msg.content));

    const uniqueTopics = new Set(recentTopics);
    return uniqueTopics.size < 2 ? 0.8 : 0.2; // If less than 2 unique topics, high stagnation
  }

  /**
   * Calculate chunk reuse risk
   */
  calculateChunkReuseRisk(userQuestion) {
    const queryWords = this.extractKeywords(userQuestion.toLowerCase());
    let reuseScore = 0;
    
    queryWords.forEach(word => {
      if (this.usedChunks.has(word)) {
        const usage = this.usedChunks.get(word);
        reuseScore += usage.count * 0.1; // Each reuse increases risk
      }
    });

    return Math.min(reuseScore, 1.0); // Cap at 1.0
  }

  /**
   * Extract main topic from text
   */
  extractMainTopic(text) {
    const words = this.extractKeywords(text.toLowerCase());
    // Simple topic extraction - return first meaningful word
    const topicWords = ['maaş', 'izin', 'çalışan', 'eğitim', 'performans', 'güvenlik', 'seyahat'];
    
    for (const word of words) {
      if (topicWords.includes(word)) {
        return word;
      }
    }
    
    return words[0] || 'genel';
  }

  /**
   * Apply anti-repetition filtering to chunks
   */
  applyAntiRepetitionFiltering(chunks, antiRepetition) {
    if (antiRepetition.riskLevel === 'low') {
      return chunks; // No filtering needed
    }

    console.log(`🔒 Anti-repetition filtering: ${antiRepetition.strategy} strategy`);

    let filtered = [...chunks];

    // === CHUNK USAGE PENALTY ===
    filtered = filtered.map(chunk => {
      let penalty = 0;
      const chunkWords = this.extractKeywords(chunk.content.toLowerCase());
      
      chunkWords.forEach(word => {
        if (this.usedChunks.has(word)) {
          const usage = this.usedChunks.get(word);
          penalty += usage.count * config.rag.diversityEnforcement;
        }
      });

      return {
        ...chunk,
        precisionScore: (chunk.precisionScore || 0) - penalty,
        antiRepetitionPenalty: penalty
      };
    });

    // === DIVERSITY ENFORCEMENT ===
    if (antiRepetition.riskLevel === 'high') {
      // Aggressive diversification - prefer less used chunks
      filtered = filtered.map(chunk => {
        const diversityBonus = this.calculateDiversityBonus(chunk);
        return {
          ...chunk,
          precisionScore: (chunk.precisionScore || 0) + diversityBonus
        };
      });
    }

    return filtered.sort((a, b) => b.precisionScore - a.precisionScore);
  }

  /**
   * Calculate diversity bonus for chunk
   */
  calculateDiversityBonus(chunk) {
    // Prefer chunks from different categories than recently used ones
    const category = chunk.metadata?.category;
    if (!category) return 0;

    const recentCategories = this.responseMemory
      .slice(-2)
      .flatMap(memory => memory.usedCategories || []);

    return recentCategories.includes(category) ? 0 : 0.3; // Bonus for different category
  }

  /**
   * Generate anti-repetition prompt based on analysis
   */
  generateAntiRepetitionPrompt(userQuestion, antiRepetition, chatHistory) {
    const basePrompt = `Sen bir HR uzmanısın ve aşağıdaki soruya yanıt veriyorsun.`;
    
    if (antiRepetition.riskLevel === 'low') {
      return basePrompt + ` Doğru ve açık bir şekilde yanıtla.`;
    }

    let diversificationPrompt = basePrompt;

    switch (antiRepetition.strategy) {
      case 'aggressive_diversification':
        diversificationPrompt += ` 
        ÖNEMLİ: Bu soru daha önce benzer sorularla yanıtlandı. 
        - Farklı bir perspektif sun
        - Yeni örnekler ver
        - Alternatif yaklaşımlar öner
        - Önceki yanıtlarını tekrar ETME
        - Konu hakkında yeni bilgiler paylaş`;
        break;
        
      case 'moderate_diversification':
        diversificationPrompt += ` 
        NOT: Bu konuda daha önce bilgi verildi. 
        - Mevcut bilgiyi genişlet
        - Ek detaylar ekle
        - Farklı açılardan değerlendir`;
        break;
    }

    // Chat history context
    if (chatHistory.length > 2) {
      const lastAssistantMsg = chatHistory.filter(msg => msg.role === 'assistant').pop();
      if (lastAssistantMsg) {
        diversificationPrompt += `\n\nÖnceki yanıtın: "${lastAssistantMsg.content.substring(0, 200)}..."\nBu yanıttan FARKLI bir bakış açısı sun.`;
      }
    }

    return diversificationPrompt;
  }

  /**
   * Validate response and update memory
   */
  validateAndUpdateMemory(response, userQuestion, usedChunks, antiRepetition) {
    // === RESPONSE SIMILARITY CHECK ===
    if (this.responseMemory.length > 0 && config.rag.enableAntiRepetition) {
      const lastResponse = this.responseMemory[this.responseMemory.length - 1];
      const similarity = this.calculateTextSimilarity(response, lastResponse.response);
      
      if (similarity > config.rag.repetitionThreshold) {
        console.log(`⚠️ High response similarity detected (${similarity.toFixed(3)}), adding variation`);
        // Add variation suffix
        response += "\n\n*Bu konuda farklı açılardan daha detaylı bilgi almak isterseniz, spesifik sorular sorabilirsiniz.*";
      }
    }

    // === UPDATE MEMORY ===
    const memory = {
      question: userQuestion,
      response: response,
      usedChunks: usedChunks.map(chunk => ({
        id: chunk._id || chunk.content.substring(0, 50),
        category: chunk.metadata?.category,
        score: chunk.precisionScore || chunk.score
      })),
      usedCategories: [...new Set(usedChunks.map(chunk => chunk.metadata?.category).filter(Boolean))],
      timestamp: new Date(),
      antiRepetitionStrategy: antiRepetition.strategy
    };

    // Add to memory
    this.responseMemory.push(memory);
    
    // Keep only last N responses
    if (this.responseMemory.length > config.rag.repetitionMemorySize) {
      this.responseMemory = this.responseMemory.slice(-config.rag.repetitionMemorySize);
    }

    // === UPDATE CHUNK USAGE TRACKING ===
    usedChunks.forEach(chunk => {
      const chunkWords = this.extractKeywords(chunk.content.toLowerCase());
      chunkWords.forEach(word => {
        if (this.usedChunks.has(word)) {
          const usage = this.usedChunks.get(word);
          usage.count += 1;
          usage.lastUsed = new Date();
        } else {
          this.usedChunks.set(word, { count: 1, lastUsed: new Date() });
        }
      });
    });

    // Clean old chunk usage data (older than 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const [word, usage] of this.usedChunks.entries()) {
      if (usage.lastUsed < oneHourAgo) {
        this.usedChunks.delete(word);
      }
    }

    console.log(`🔒 Memory updated: ${this.responseMemory.length} responses, ${this.usedChunks.size} tracked chunks`);
    return response;
  }

  /**
   * Calculate text similarity between two texts
   */
  calculateTextSimilarity(text1, text2) {
    const words1 = new Set(this.extractKeywords(text1.toLowerCase()));
    const words2 = new Set(this.extractKeywords(text2.toLowerCase()));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * ADVANCED CONTEXT CREATION - 8K token optimized context with intelligent chunking
   */
  createAdvancedContext(relevantDocs, userQuestion, chatHistory = []) {
    const maxContextTokens = config.rag.maxContextLength;
    let currentTokens = 0;
    let contextParts = [];
    
    // === CONTEXT PRIORITY SYSTEM ===
    const prioritizedDocs = this.prioritizeDocumentsForContext(relevantDocs, userQuestion, chatHistory);
    
    // === SMART CONTEXT BUILDING ===
    for (const doc of prioritizedDocs) {
      const docContent = this.enhanceDocumentForContext(doc, userQuestion);
      const docTokens = this.textProcessor.getTokenCount(docContent);
      
      // Token limit kontrolü
      if (currentTokens + docTokens > maxContextTokens) {
        // Remaining space'e sığacak şekilde kısalt
        const remainingTokens = maxContextTokens - currentTokens;
        if (remainingTokens > 50) { // Minimum meaningful chunk size
          const truncatedContent = this.intelligentTruncate(docContent, remainingTokens);
          contextParts.push(truncatedContent);
          currentTokens += this.textProcessor.getTokenCount(truncatedContent);
        }
        break;
      }
      
      contextParts.push(docContent);
      currentTokens += docTokens;
    }
    
    // === CONTEXT ENHANCEMENT ===
    const enhancedContext = this.enhanceContextWithMetadata(contextParts, userQuestion, chatHistory);
    
    console.log(`📝 Context oluşturuldu: ${currentTokens}/${maxContextTokens} token`);
    return enhancedContext;
  }

  /**
   * Prioritize documents for context building
   */
  prioritizeDocumentsForContext(docs, userQuestion, chatHistory) {
    const queryTerms = this.extractKeywords(userQuestion.toLowerCase());
    
    return docs.map(doc => {
      let priority = doc.reRankScore || doc.finalScore || doc.score || 0;
      
      // === QUERY RELEVANCE BOOST ===
      queryTerms.forEach(term => {
        const termCount = (doc.content.toLowerCase().match(new RegExp(term, 'g')) || []).length;
        priority += termCount * 0.1;
      });
      
      // === CONTENT QUALITY INDICATORS ===
      const contentLength = doc.content.length;
      if (contentLength > 100 && contentLength < 1500) {
        priority += 0.2; // Optimal length bonus
      }
      
      // === METADATA RELEVANCE ===
      if (doc.metadata) {
        if (doc.metadata.category) priority += 0.15;
        if (doc.metadata.source) priority += 0.1;
        if (doc.metadata.type === 'policy' || doc.metadata.type === 'procedure') {
          priority += 0.25; // Official document bonus
        }
      }
      
      return { ...doc, contextPriority: priority };
    }).sort((a, b) => b.contextPriority - a.contextPriority);
  }

  /**
   * Enhance document content for context
   */
  enhanceDocumentForContext(doc, userQuestion) {
    let enhancedContent = doc.content;
    
    // === METADATA INTEGRATION ===
    let metadata = '';
    if (doc.metadata) {
      if (doc.metadata.category) metadata += `[KATEGORİ: ${doc.metadata.category}] `;
      if (doc.metadata.source) metadata += `[KAYNAK: ${doc.metadata.source}] `;
    }
    
    // === RELEVANCE HIGHLIGHTING ===
    const queryTerms = this.extractKeywords(userQuestion.toLowerCase());
    queryTerms.forEach(term => {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      enhancedContent = enhancedContent.replace(regex, `**${term}**`);
    });
    
    return metadata + enhancedContent;
  }

  /**
   * Intelligent content truncation while preserving meaning
   */
  intelligentTruncate(content, maxTokens) {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
    let truncated = '';
    let tokens = 0;
    
    for (const sentence of sentences) {
      const sentenceTokens = this.textProcessor.getTokenCount(sentence);
      if (tokens + sentenceTokens > maxTokens) {
        break;
      }
      truncated += sentence + '. ';
      tokens += sentenceTokens;
    }
    
    return truncated.trim() + (truncated.length < content.length ? '...' : '');
  }

  /**
   * Enhance context with metadata and structure
   */
  enhanceContextWithMetadata(contextParts, userQuestion, chatHistory) {
    let context = '';
    
    // === CONTEXT HEADER ===
    context += `=== HR KNOWLEDGE BASE CONTEXT ===\n`;
    context += `Soru: "${userQuestion}"\n`;
    if (chatHistory.length > 0) {
      const recentContext = chatHistory.slice(-2).map(h => h.content).join(' | ');
      context += `Önceki Context: ${recentContext}\n`;
    }
    context += `\n=== RELEVANT DOCUMENTS ===\n\n`;
    
    // === DOCUMENT SECTIONS ===
    contextParts.forEach((part, index) => {
      context += `📄 DOCUMENT ${index + 1}:\n${part}\n\n`;
    });
    
    return context;
  }

  /**
   * Log selected chunks
   */
  logSelectedChunks(chunks, query) {
    console.log(`\n🏆 ===== ULTRA-PRECISION TOP-${chunks.length} CHUNK'LAR =====`);
    console.log(`📝 Sorgu: "${query}"`);
    console.log(`🎯 Final precision chunks: ${chunks.length}`);
    
    chunks.forEach((chunk, index) => {
      console.log(`\n🏅 ULTRA-CHUNK ${index + 1}/${chunks.length}:`);
      const mainScore = chunk.precisionScore || chunk.reRankScore || chunk.finalScore || chunk.score;
      console.log(`   🎯 Precision Score: ${mainScore?.toFixed(4) || 'N/A'}`);
      
      if (chunk.termCoverage !== undefined) {
        console.log(`   📊 Term Coverage: ${(chunk.termCoverage * 100).toFixed(1)}%`);
        console.log(`   🔤 Term Matches: ${chunk.termMatchCount || 0}`);
      }
      
      if (chunk.contentQuality) {
        console.log(`   📈 Content Quality:`);
        console.log(`      • Length: ${chunk.contentQuality.length} chars`);
        console.log(`      • Sentences: ${chunk.contentQuality.sentences}`);
        console.log(`      • Diversity: ${(chunk.contentQuality.diversity * 100).toFixed(1)}%`);
      }
      
      if (chunk.historyAlignment) {
        console.log(`   🧠 History Alignment: ${chunk.historyAlignment.toFixed(3)}`);
      }
      
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
