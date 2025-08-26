const axios = require('axios');
const natural = require('natural');
const config = require('../config');

class OpenRouterClient {
  constructor() {
    this.apiKey = config.openrouter.apiKey;
    this.baseURL = config.openrouter.baseURL;
    this.embeddingModel = config.openrouter.embeddingModel;
    this.chatModel = config.openrouter.chatModel;
    
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'SAMETEI HR RAG System'
      }
    });
  }

  /**
   * Local TF-IDF embedding kullanarak metin vektörüne dönüştür
   */
  async createEmbedding(text) {
    try {
      // Text preprocessing
      const cleanText = text.toLowerCase()
        .replace(/[^\w\sçğıöşüÇĞIİÖŞÜ]/g, ' ')  // Türkçe karakterleri koru
        .replace(/\s+/g, ' ')
        .trim();
      
      // Tokenize - basit split kullan
      const tokens = cleanText.split(' ').filter(token => token.length > 0);
      
      // Stopword'leri filtrele (Türkçe + İngilizce)
      const stopwordsTr = ['ve', 'ile', 'bir', 'bu', 'şu', 'o', 'da', 'de', 'ta', 'te', 'ya', 'ye', 'mi', 'mu', 'mı', 'mü'];
      const stopwordsEn = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'cannot', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their'];
      const allStopwords = [...stopwordsTr, ...stopwordsEn];
      
      const filteredTokens = tokens.filter(token => 
        token.length > 2 && !allStopwords.includes(token)
      );
      
      // Basit term frequency vektörü oluştur
      const termFreq = {};
      filteredTokens.forEach(token => {
        termFreq[token] = (termFreq[token] || 0) + 1;
      });
      
      // Sabit boyutlu vektör oluştur (200 boyutlu)
      const vectorSize = 200;
      const vector = new Array(vectorSize).fill(0);
      
      Object.keys(termFreq).forEach((term, index) => {
        if (index < vectorSize) {
          // Term'i hash'le ve vektör pozisyonuna map et
          const hash = this.hashString(term) % vectorSize;
          vector[hash] += termFreq[term];
        }
      });
      
      // Normalize et
      const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
      if (magnitude > 0) {
        for (let i = 0; i < vector.length; i++) {
          vector[i] /= magnitude;
        }
      }
      
      console.log(`📊 Local embedding oluşturuldu: ${text.substring(0, 50)}... -> ${vector.length}D vector`);
      return vector;
      
    } catch (error) {
      console.error('❌ Local embedding hatası:', error.message);
      // Fallback: random vector
      return new Array(200).fill(0).map(() => Math.random() - 0.5);
    }
  }

  /**
   * String hash fonksiyonu
   */
  hashString(str) {
    let hash = 0;
    if (str.length === 0) return hash;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32-bit integer'a dönüştür
    }
    return Math.abs(hash);
  }

  /**
   * Batch embedding işlemi (çoklu metinler için)
   */
  async createEmbeddings(texts) {
    const embeddings = [];
    
    console.log(`🔄 ${texts.length} metin için local embedding oluşturuluyor...`);
    
    for (let i = 0; i < texts.length; i++) {
      try {
        const embedding = await this.createEmbedding(texts[i]);
        embeddings.push(embedding);
        
        // Progress göstergesi
        if ((i + 1) % 10 === 0) {
          console.log(`📊 Progress: ${i + 1}/${texts.length} embedding tamamlandı`);
        }
        
      } catch (error) {
        console.error(`❌ Embedding error at index ${i}:`, error.message);
        // Hata durumunda fallback embedding ekle
        embeddings.push(new Array(200).fill(0).map(() => Math.random() - 0.5));
      }
    }
    
    console.log(`✅ Toplam ${embeddings.length} embedding oluşturuldu`);
    return embeddings;
  }

  /**
   * Chat completion (RAG ile birleştirilmiş prompt)
   */
  async createChatCompletion(messages, temperature = 0.3) {
    const retryCfg = require('../config').openrouter.retry;
    let attempt = 0;
    let modelToUse = this.chatModel;
    let delay = retryCfg.initialDelayMs;

    while (true) {
      try {
        const response = await this.client.post('/chat/completions', {
          model: modelToUse,
          messages: messages,
          temperature: temperature,
          max_tokens: 2000,
          stream: false
        });

        if (response.data && response.data.choices && response.data.choices.length > 0) {
          return response.data.choices[0].message.content;
        }
        throw new Error('Chat completion response format is invalid');
      } catch (error) {
        const status = error.response?.status;
        const isRateLimit = status === 429;
        const canRetry = attempt < retryCfg.maxRetries;
        if (isRateLimit && canRetry) {
          attempt += 1;
          await new Promise(r => setTimeout(r, delay));
          delay *= retryCfg.backoffFactor;
          continue;
        }
        // Son bir deneme: fallback modele geç
        if (isRateLimit && modelToUse !== retryCfg.fallbackModel) {
          modelToUse = retryCfg.fallbackModel;
          attempt = 0;
          delay = retryCfg.initialDelayMs;
          continue;
        }
        console.error('Chat Completion Error:', error.response?.data || error.message);
        throw error;
      }
    }
  }

  /**
   * HR Asistanı için özelleştirilmiş chat completion
   */
  async hrChatCompletion(userQuery, context = '') {
    const fallback = `${require('../config').support.fallbackMessage}`;
    const systemPrompt = `Sen bir HR (İnsan Kaynakları) asistanısın.

Görevin:
- Çalışanların HR sorularını yanıtlamak
- Her zaman nazik, yardımcı ve profesyonel olmak
- Sadece aşağıdaki şirket bilgilerini kullanarak cevap vermek

ÖNEMLİ: Eğer sorulan konu aşağıdaki bilgilerde yoksa, lütfen şu mesajı ver: "${fallback}".

ŞİRKET BİLGİLERİ:
${context}

Lütfen kısa, öz ve anlaşılır cevaplar ver.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userQuery }
    ];

    return await this.createChatCompletion(messages, 0.2);
  }
}

module.exports = OpenRouterClient;
