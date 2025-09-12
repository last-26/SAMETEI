const { MongoClient } = require('mongodb');
const config = require('../config');
const crypto = require('crypto');
const fs = require('fs');

class MongoDBVectorDB {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.uri = config.mongodb.uri;
    this.dbName = config.mongodb.database;
    this.collectionName = config.mongodb.collection;
    
    // In-memory storage için
    this.inMemoryStorage = [];
    this.useInMemory = config.mongodb.useInMemory || false;
  }

  /**
   * MongoDB'ye bağlan
   */
  async connect() {
    try {
      if (this.useInMemory) {
        console.log('💾 In-memory storage kullanılıyor (MongoDB bağlantısı atlandı)');
        return;
      }
      
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.collection = this.db.collection(this.collectionName);
      
      console.log(`✅ MongoDB bağlandı: ${this.dbName}/${this.collectionName}`);
      
      // Vector search index'i oluştur (eğer yoksa)
      await this.createIndexes();
      
    } catch (error) {
      console.error('❌ MongoDB bağlantı hatası:', error);
      console.log('💾 In-memory storage\'a geçiliyor...');
      this.useInMemory = true;
    }
  }

  /**
   * Gerekli index'leri oluştur
   */
  async createIndexes() {
    try {
      if (this.useInMemory) return;
      
      const indexes = await this.collection.listIndexes().toArray();
      const searchIndexExists = indexes.some(index => index.name === 'hr_search_index');
      
      if (!searchIndexExists) {
        // Text index yerine daha güvenli index'ler oluştur
        await this.collection.createIndex(
          { 
            content: 1,
            'metadata.category': 1,
            'metadata.source': 1,
            createdAt: -1
          },
          { name: 'hr_search_index' }
        );
        
        console.log('✅ MongoDB search index oluşturuldu');
      }
    } catch (error) {
      console.warn('⚠️ Index oluşturulamadı (normal MongoDB kullanıyor olabilirsiniz):', error.message);
    }
  }

  /**
   * HR bilgilerini veritabanına kaydet
   */
  async insertKnowledge(documents) {
    try {
      if (this.useInMemory) {
        // In-memory storage'a ekle
        this.inMemoryStorage.push(...documents);
        console.log(`✅ ${documents.length} HR dökümanı in-memory storage'a eklendi`);
        return { insertedCount: documents.length };
      }
      
      const result = await this.collection.insertMany(documents);
      console.log(`✅ ${result.insertedCount} HR dökümanı eklendi`);
      return result;
    } catch (error) {
      console.error('❌ Döküman ekleme hatası:', error);
      throw error;
    }
  }

  /**
   * Tüm dökümanları getir (keyword search için)
   */
  async getAllDocuments() {
    try {
      if (this.useInMemory) {
        return this.inMemoryStorage;
      }
      
      const documents = await this.collection.find({}).toArray();
      return documents;
    } catch (error) {
      console.error('❌ Döküman getirme hatası:', error);
      return [];
    }
  }

  /**
   * MULTI-SIMILARITY VECTOR SEARCH - Çoklu benzerlik metriği ile arama
   */
  async multiSimilaritySearch(queryEmbedding, limit = 3) {
    if (!config.rag.enableMultiSimilarity) {
      return this.vectorSearch(queryEmbedding, limit);
    }
    
    try {
      console.log(`🔍 Multi-similarity search: Query embedding type=${typeof queryEmbedding}, isArray=${Array.isArray(queryEmbedding)}`);
      
      const results = await this.vectorSearch(queryEmbedding, limit * 2);
      
      if (!results || results.length === 0) {
        console.warn('⚠️ No results from vector search for multi-similarity');
        return [];
      }

      console.log(`🔍 Multi-similarity: Processing ${results.length} documents`);
      
      // Multi-similarity scoring with detailed logging
      const rescored = results.map((doc, index) => {
        if (!doc.embedding) {
          console.warn(`⚠️ Document ${index} has no embedding`);
          return { ...doc, score: 0.1, metrics: this.fallbackSimilarity() };
        }
        
        // Debug first document's embedding
        if (index === 0) {
          console.log(`🔍 First doc embedding type=${typeof doc.embedding}, isArray=${Array.isArray(doc.embedding)}`);
          if (Array.isArray(doc.embedding)) {
            console.log(`🔍 First doc embedding length=${doc.embedding.length}, first value=${doc.embedding[0]}`);
          }
        }
        
        const similarities = this.calculateAdvancedSimilarity(queryEmbedding, doc.embedding);
        
        // Use config metrics if available, otherwise fallback
        let combinedScore;
        if (config.rag.similarityMetrics) {
          const metrics = config.rag.similarityMetrics;
          combinedScore = 
            (similarities.cosine * metrics.cosine) +
            (similarities.euclidean * metrics.euclidean) +
            (similarities.jaccard * metrics.jaccard) +
            (similarities.manhattan * metrics.manhattan);
        } else {
          combinedScore = similarities.finalScore || 0.1;
        }
        
        return {
          ...doc,
          score: isNaN(combinedScore) ? 0.1 : combinedScore,
          metrics: similarities
        };
      });
      
      console.log(`✅ Multi-similarity: Rescored ${rescored.length} documents`);
      
      return rescored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
        
    } catch (error) {
      console.error('❌ Multi-similarity search error:', error.message);
      console.log('🔄 Falling back to regular vector search');
      return this.vectorSearch(queryEmbedding, limit);
    }
  }

  /**
   * Traditional vector search (fallback)
   */
  async vectorSearch(queryEmbedding, limit = 3) {
    try {
      if (this.useInMemory) {
        // In-memory similarity search
        return this.inMemorySimilaritySearch(queryEmbedding, limit);
      }
      
      // MongoDB Atlas Vector Search kullanıyorsak
      if (this.isAtlasCluster()) {
        const pipeline = [
          {
            $vectorSearch: {
              queryVector: queryEmbedding,
              path: 'embedding',
              numCandidates: limit * 4,
              limit: limit
            }
          },
          {
            $project: {
              content: 1,
              metadata: 1,
              score: { $meta: 'vectorSearchScore' }
            }
          }
        ];
        
        const results = await this.collection.aggregate(pipeline).toArray();
        return results;
      }
      
      // Normal MongoDB için alternatif arama - embedding array'i string'e çevir
      const queryString = Array.isArray(queryEmbedding) ? queryEmbedding.join(' ') : String(queryEmbedding);
      return await this.textSearch(queryString, limit);
      
    } catch (error) {
      console.error('❌ Vector search hatası:', error);
      
      // Hata durumunda in-memory search'e geç
      if (!this.useInMemory) {
        console.log('💾 In-memory search\'e geçiliyor...');
        this.useInMemory = true;
        return this.inMemorySimilaritySearch(queryEmbedding, limit);
      }
      
      return [];
    }
  }

  /**
   * Advanced similarity metrics
   */
  calculateAdvancedSimilarity(queryEmbedding, docEmbedding) {
    try {
      // === EMBEDDING VALIDATION ===
      const validatedQuery = this.validateAndNormalizeEmbedding(queryEmbedding, 'query');
      const validatedDoc = this.validateAndNormalizeEmbedding(docEmbedding, 'document');
      
      if (!validatedQuery || !validatedDoc) {
        console.warn('⚠️ Invalid embeddings detected, using fallback similarity');
        return this.fallbackSimilarity();
      }

      // === SIMILARITY CALCULATIONS ===
      const cosineSim = this.cosineSimilarity(validatedQuery, validatedDoc);
      const euclideanDist = this.euclideanDistance(validatedQuery, validatedDoc);
      const euclideanSim = 1 / (1 + euclideanDist);
      const jaccardSim = this.jaccardSimilarity(validatedQuery, validatedDoc);
      const manhattanDist = this.manhattanDistance(validatedQuery, validatedDoc);
      const manhattanSim = 1 / (1 + manhattanDist);
      const pearsonSim = this.pearsonCorrelation(validatedQuery, validatedDoc);
      
      // === WEIGHTED COMBINATION ===
      let finalScore;
      if (config.rag.enableMultiSimilarity && config.rag.similarityMetrics) {
        const metrics = config.rag.similarityMetrics;
        finalScore = (cosineSim * metrics.cosine) + 
                    (euclideanSim * metrics.euclidean) + 
                    (jaccardSim * metrics.jaccard) + 
                    (manhattanSim * metrics.manhattan);
      } else {
        finalScore = (cosineSim * 0.5) + (euclideanSim * 0.25) + (jaccardSim * 0.15) + (manhattanSim * 0.1);
      }

      return {
        finalScore: isNaN(finalScore) ? 0 : finalScore,
        cosine: isNaN(cosineSim) ? 0 : cosineSim,
        euclidean: isNaN(euclideanSim) ? 0 : euclideanSim,
        jaccard: isNaN(jaccardSim) ? 0 : jaccardSim,
        manhattan: isNaN(manhattanSim) ? 0 : manhattanSim,
        pearson: isNaN(pearsonSim) ? 0 : pearsonSim
      };
    } catch (error) {
      console.error('❌ Advanced similarity calculation error:', error.message);
      return this.fallbackSimilarity();
    }
  }

  /**
   * Validate and normalize embedding vectors
   */
  validateAndNormalizeEmbedding(embedding, type = 'unknown') {
    if (!embedding) {
      console.warn(`⚠️ ${type} embedding is null/undefined`);
      return null;
    }

    // Convert different formats to array
    let normalizedEmbedding;
    
    if (Array.isArray(embedding)) {
      normalizedEmbedding = embedding;
    } else if (typeof embedding === 'string') {
      try {
        normalizedEmbedding = JSON.parse(embedding);
      } catch (e) {
        // String might be space or comma separated numbers
        normalizedEmbedding = embedding.split(/[\s,]+/).map(x => parseFloat(x)).filter(x => !isNaN(x));
      }
    } else if (typeof embedding === 'object' && embedding.embedding) {
      // If embedding is wrapped in an object (like {embedding: [...], usage: {...}})
      normalizedEmbedding = embedding.embedding;
    } else if (typeof embedding === 'object' && embedding.data) {
      // Alternative object format
      normalizedEmbedding = embedding.data;
    } else {
      console.warn(`⚠️ ${type} embedding has unexpected type:`, typeof embedding);
      return null;
    }

    // Validate array
    if (!Array.isArray(normalizedEmbedding) || normalizedEmbedding.length === 0) {
      console.warn(`⚠️ ${type} embedding is not a valid array`);
      return null;
    }

    // Validate numbers
    const validNumbers = normalizedEmbedding.every(x => typeof x === 'number' && !isNaN(x));
    if (!validNumbers) {
      console.warn(`⚠️ ${type} embedding contains non-numeric values`);
      return null;
    }

    return normalizedEmbedding;
  }

  /**
   * Fallback similarity when calculations fail
   */
  fallbackSimilarity() {
    return {
      finalScore: 0.1, // Small non-zero score
      cosine: 0.1,
      euclidean: 0.1,
      jaccard: 0.1,
      manhattan: 0.1,
      pearson: 0.1
    };
  }

  /**
   * Manhattan distance calculation
   */
  manhattanDistance(vec1, vec2) {
    try {
      if (!Array.isArray(vec1) || !Array.isArray(vec2) || vec1.length !== vec2.length) {
        return Infinity;
      }
      return vec1.reduce((sum, v, i) => sum + Math.abs(v - vec2[i]), 0);
    } catch (error) {
      console.warn('⚠️ Manhattan distance calculation failed:', error.message);
      return Infinity;
    }
  }

  /**
   * Pearson correlation coefficient
   */
  pearsonCorrelation(vec1, vec2) {
    try {
      if (!Array.isArray(vec1) || !Array.isArray(vec2) || vec1.length !== vec2.length) {
        return 0;
      }
      
      const n = vec1.length;
      if (n === 0) return 0;
      
      const sum1 = vec1.reduce((s, v) => s + v, 0);
      const sum2 = vec2.reduce((s, v) => s + v, 0);
      const sum1Sq = vec1.reduce((s, v) => s + v * v, 0);
      const sum2Sq = vec2.reduce((s, v) => s + v * v, 0);
      const pSum = vec1.reduce((s, v, i) => s + v * vec2[i], 0);
      
      const numerator = pSum - (sum1 * sum2 / n);
      const denominator = Math.sqrt((sum1Sq - sum1 * sum1 / n) * (sum2Sq - sum2 * sum2 / n));
      
      return denominator === 0 ? 0 : Math.max(-1, Math.min(1, numerator / denominator));
    } catch (error) {
      console.warn('⚠️ Pearson correlation calculation failed:', error.message);
      return 0;
    }
  }

  euclideanDistance(vec1, vec2) {
    try {
      if (!Array.isArray(vec1) || !Array.isArray(vec2) || vec1.length !== vec2.length) {
        return Infinity;
      }
      let sum = 0;
      for (let i = 0; i < vec1.length; i++) {
        sum += Math.pow(vec1[i] - vec2[i], 2);
      }
      return Math.sqrt(sum);
    } catch (error) {
      console.warn('⚠️ Euclidean distance calculation failed:', error.message);
      return Infinity;
    }
  }

  cosineSimilarity(vec1, vec2) {
    try {
      if (!Array.isArray(vec1) || !Array.isArray(vec2) || vec1.length !== vec2.length) {
        return 0;
      }
      
      const dotProduct = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
      const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
      const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0));
      
      if (norm1 === 0 || norm2 === 0) return 0;
      return Math.max(-1, Math.min(1, dotProduct / (norm1 * norm2)));
    } catch (error) {
      console.warn('⚠️ Cosine similarity calculation failed:', error.message);
      return 0;
    }
  }

  jaccardSimilarity(vec1, vec2) {
    try {
      if (!Array.isArray(vec1) || !Array.isArray(vec2) || vec1.length !== vec2.length) {
        console.warn('⚠️ Invalid vectors for Jaccard similarity');
        return 0;
      }
      
      // Convert to binary vectors (non-zero elements)
      const set1 = new Set(vec1.map((v, i) => v !== 0 ? i : null).filter(v => v !== null));
      const set2 = new Set(vec2.map((v, i) => v !== 0 ? i : null).filter(v => v !== null));
      
      const intersection = new Set([...set1].filter(x => set2.has(x)));
      const union = new Set([...set1, ...set2]);
      
      return union.size > 0 ? intersection.size / union.size : 0;
    } catch (error) {
      console.warn('⚠️ Jaccard similarity calculation failed:', error.message);
      return 0;
    }
  }

  /**
   * Advanced In-memory similarity search with multiple metrics
   */
  inMemorySimilaritySearch(queryEmbedding, limit = 3) {
    if (this.inMemoryStorage.length === 0) {
      return [];
    }
    
    // Advanced similarity hesapla
    const similarities = this.inMemoryStorage.map(doc => {
      const simMetrics = this.calculateAdvancedSimilarity(queryEmbedding, doc.embedding);
      return {
        ...doc,
        score: simMetrics.finalScore,
        metrics: {
          cosine: simMetrics.cosine,
          euclidean: simMetrics.euclidean,
          jaccard: simMetrics.jaccard
        }
      };
    });
    
    // Similarity'ye göre sırala ve limit kadar döndür
    return similarities
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Cosine similarity hesapla
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      return 0;
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) {
      return 0;
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Text search (MongoDB için)
   */
  async textSearch(queryText, limit = 3) {
    try {
      // $text operatörü yerine $regex kullan (text index gerektirmez)
      const results = await this.collection.find({
        $or: [
          { content: { $regex: queryText, $options: 'i' } },
          { title: { $regex: queryText, $options: 'i' } },
          { metadata: { $regex: queryText, $options: 'i' } }
        ]
      })
      .limit(limit)
      .toArray();
      
      return results.map(doc => ({
        ...doc,
        score: 0.8 // Text search için sabit score
      }));
      
    } catch (error) {
      console.error('❌ Text search hatası:', error);
      return [];
    }
  }

  /**
   * Knowledge base'i temizle
   */
  async clearKnowledgeBase() {
    try {
      if (this.useInMemory) {
        this.inMemoryStorage = [];
        console.log('✅ In-memory storage temizlendi');
        return;
      }
      
      const result = await this.collection.deleteMany({});
      console.log(`✅ ${result.deletedCount} döküman silindi`);
      return result;
    } catch (error) {
      console.error('❌ Knowledge base temizleme hatası:', error);
      throw error;
    }
  }

  /**
   * Sistem istatistikleri
   */
  async getStats() {
    try {
      if (this.useInMemory) {
        return {
          documentCount: this.inMemoryStorage.length,
          storageType: 'in-memory',
          embeddingDimension: this.inMemoryStorage.length > 0 ? this.inMemoryStorage[0].embedding?.length || 0 : 0
        };
      }
      
      const documentCount = await this.collection.countDocuments();
      const sampleDoc = await this.collection.findOne();
      
      return {
        documentCount,
        storageType: 'mongodb',
        embeddingDimension: sampleDoc?.embedding?.length || 0
      };
    } catch (error) {
      console.error('❌ Stats hatası:', error);
      return {
        documentCount: 0,
        storageType: 'error',
        embeddingDimension: 0
      };
    }
  }

  /**
   * MongoDB Atlas cluster kontrolü
   */
  isAtlasCluster() {
    return this.uri.includes('mongodb.net') || this.uri.includes('mongodb+srv');
  }

  /**
   * Bağlantıyı kapat
   */
  async close() {
    try {
      if (this.client) {
        await this.client.close();
        console.log('📝 MongoDB bağlantısı kapatıldı');
      }
    } catch (error) {
      console.error('❌ Bağlantı kapatma hatası:', error);
    }
  }

  /**
   * Shutdown
   */
  async shutdown() {
    await this.close();
  }

  /**
   * Dosya hash'ini hesapla
   */
  calculateFileHash(filePath) {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const hashSum = crypto.createHash('md5');
      hashSum.update(fileBuffer);
      return hashSum.digest('hex');
    } catch (error) {
      console.error(`❌ Dosya hash hesaplama hatası: ${filePath}`, error.message);
      return null;
    }
  }

  /**
   * Dosya zaten yüklenmiş mi kontrol et
   */
  async isFileAlreadyLoaded(filePath) {
    try {
      if (this.useInMemory) {
        const fileName = require('path').basename(filePath);
        return this.inMemoryStorage.some(doc => 
          doc.metadata?.sourceFile === fileName
        );
      }

      const fileName = require('path').basename(filePath);
      const existingDoc = await this.collection.findOne({
        'metadata.sourceFile': fileName
      });

      return !!existingDoc;
    } catch (error) {
      console.error('❌ Dosya kontrol hatası:', error.message);
      return false;
    }
  }

  /**
   * Yeni dosyaları tespit et
   */
  async getNewFiles(dirPath) {
    try {
      const supported = ['.pdf', '.docx', '.txt', '.csv'];
      const files = fs.readdirSync(dirPath)
        .filter(f => supported.includes(require('path').extname(f).toLowerCase()))
        .map(f => require('path').join(dirPath, f));

      const newFiles = [];
      for (const file of files) {
        const isLoaded = await this.isFileAlreadyLoaded(file);
        if (!isLoaded) {
          newFiles.push(file);
        }
      }

      return newFiles;
    } catch (error) {
      console.error('❌ Yeni dosya tespit hatası:', error.message);
      return [];
    }
  }

  /**
   * Veritabanı istatistikleri
   */
  async getDatabaseStats() {
    try {
      if (this.useInMemory) {
        return {
          documentCount: this.inMemoryStorage.length,
          uniqueFiles: new Set(this.inMemoryStorage.map(d => d.metadata?.sourceFile)).size
        };
      }

      const documentCount = await this.collection.countDocuments();
      const uniqueFiles = await this.collection.distinct('metadata.sourceFile');
      
      return {
        documentCount,
        uniqueFiles: uniqueFiles.length
      };
    } catch (error) {
      console.error('❌ Veritabanı istatistik hatası:', error.message);
      return { documentCount: 0, uniqueFiles: 0 };
    }
  }
}

module.exports = MongoDBVectorDB;
