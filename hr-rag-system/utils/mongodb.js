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
   * Vector similarity search (MongoDB Atlas Vector Search)
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
   * In-memory similarity search
   */
  inMemorySimilaritySearch(queryEmbedding, limit = 3) {
    if (this.inMemoryStorage.length === 0) {
      return [];
    }
    
    // Cosine similarity hesapla
    const similarities = this.inMemoryStorage.map(doc => {
      const similarity = this.cosineSimilarity(queryEmbedding, doc.embedding);
      return {
        ...doc,
        score: similarity
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
