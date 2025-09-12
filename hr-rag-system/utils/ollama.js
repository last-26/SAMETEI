const axios = require('axios');
const natural = require('natural');
const config = require('../config');

class OllamaClient {
  constructor() {
    this.baseURL = config.ollama.baseURL;
    this.model = config.ollama.model;
    this.embeddingModel = config.ollama.embeddingModel;
    
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 0, // Timeout kaldırıldı - GPU'da model yüklenmesi uzun sürebilir
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Local TF-IDF embedding kullanarak metin vektörüne dönüştür
   */
  async createEmbedding(text) {
    try {
      if (!text || text.trim().length === 0) {
        throw new Error('Metin boş olamaz');
      }

      // Metni küçük harfe çevir ve temizle
      const cleanText = text.toLowerCase()
        .replace(/[^\w\süçöğıa-z]/gi, ' ') // Türkçe karakterleri koru
        .replace(/\s+/g, ' ')
        .trim();

      // Natural kütüphanesi ile tokenize et
      const tokenizer = new natural.WordTokenizer();
      const tokens = tokenizer.tokenize(cleanText);
      
      if (!tokens || tokens.length === 0) {
        console.warn('⚠️ No tokens extracted from text, creating default embedding');
        // Return standard length vector for consistency
        return new Array(100).fill(0.01);
      }

      // TF-IDF vektörü oluştur (basit implementasyon)
      const vocabulary = [...new Set(tokens)]; // Benzersiz kelimeler
      
      // Ensure minimum vector length for consistency
      const minVectorLength = 100;
      const vectorLength = Math.max(vocabulary.length, minVectorLength);
      const vector = new Array(vectorLength).fill(0);
      
      // Her kelimenin frekansını hesapla
      const termFreq = {};
      tokens.forEach(token => {
        termFreq[token] = (termFreq[token] || 0) + 1;
      });

      // Vektörü doldur
      vocabulary.forEach((word, index) => {
        if (index < vector.length) {
          const tf = termFreq[word] || 0;
          const normalizedTf = tf / tokens.length; // Normalize et
          vector[index] = normalizedTf;
        }
      });

      console.log(`🔍 Created embedding: length=${vector.length}, type=${typeof vector}, isArray=${Array.isArray(vector)}`);
      
      // Return only the vector array, not wrapped in an object
      return vector;
    } catch (error) {
      console.error('❌ Embedding oluşturma hatası:', error);
      // Return consistent fallback embedding
      return new Array(100).fill(0.01);
    }
  }

  /**
   * Birden fazla metin için embedding oluştur
   */
  async createEmbeddings(texts) {
    console.log(`📊 ${texts.length} metin için embedding oluşturuluyor...`);
    const embeddings = [];
    
    for (let i = 0; i < texts.length; i++) {
      try {
        const embeddingVector = await this.createEmbedding(texts[i]);
        
        // Validate the embedding is an array
        if (!Array.isArray(embeddingVector)) {
          console.warn(`⚠️ Embedding ${i+1} is not an array, converting...`);
          embeddings.push(new Array(100).fill(0.01));
        } else {
          embeddings.push(embeddingVector);
        }
        
        if ((i + 1) % 10 === 0) {
          console.log(`✅ ${i + 1}/${texts.length} embedding oluşturuldu`);
        }
      } catch (error) {
        console.error(`❌ ${i + 1}. metin için embedding oluşturulamadı:`, error.message);
        // Hata durumunda consistent fallback vektör ekle
        embeddings.push(new Array(100).fill(0.01));
      }
    }

    console.log(`✅ Toplam ${embeddings.length} embedding oluşturuldu`);
    console.log(`🔍 First embedding check: type=${typeof embeddings[0]}, isArray=${Array.isArray(embeddings[0])}, length=${embeddings[0]?.length}`);
    return embeddings;
  }

  /**
   * Ollama ile chat completion
   */
  async createChatCompletion(messages, temperature = 0.3) {
    const retryCfg = config.ollama.retry;
    let attempt = 0;
    let delay = retryCfg.initialDelayMs;

    while (attempt <= retryCfg.maxRetries) {
      try {
        // Ollama API formatına çevir
        const prompt = this.formatMessagesForOllama(messages);
        
        const response = await this.client.post('/api/generate', {
          model: this.model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: temperature,
            num_predict: 1000, // Daha kısa response (loop'u önlemek için)
            repeat_penalty: 1.2, // Tekrarları cezalandır
            repeat_last_n: 64, // Son 64 token'ı kontrol et
            top_p: 0.9, // Daha fokuslu yanıtlar
            stop: ["[TABLO]", "|", "```", "---"] // Stop tokens ekle
          }
        });

        if (response.data && response.data.response) {
          return response.data.response;
        }
        throw new Error('Ollama response format is invalid');
      } catch (error) {
        attempt++;
        console.error(`❌ Ollama API hatası (Deneme ${attempt}/${retryCfg.maxRetries + 1}):`, error.message);
        
        if (attempt > retryCfg.maxRetries) {
          throw new Error(`Ollama bağlantısı başarısız. Lütfen Ollama servisinin çalıştığından ve modelinizin yüklendiğinden emin olun: ${error.message}`);
        }
        
        await new Promise(r => setTimeout(r, delay));
        delay *= retryCfg.backoffFactor;
      }
    }
  }

  /**
   * Messages'ları Ollama prompt formatına çevir
   */
  formatMessagesForOllama(messages) {
    let prompt = '';
    
    for (const message of messages) {
      if (message.role === 'system') {
        prompt += `System: ${message.content}\n\n`;
      } else if (message.role === 'user') {
        prompt += `User: ${message.content}\n\n`;
      } else if (message.role === 'assistant') {
        prompt += `Assistant: ${message.content}\n\n`;
      }
    }
    
    prompt += 'Assistant:';
    return prompt;
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

Lütfen kısa, öz ve anlaşılır cevaplar ver. Türkçe yanıt ver.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userQuery }
    ];

    return await this.createChatCompletion(messages, 0.2);
  }

  /**
   * Chat history ile üretken HR yanıtı
   */
  async hrChatCompletionWithHistory(userQuery, context = '', chatHistory = []) {
    const fallback = `${require('../config').support.fallbackMessage}`;
    
    const systemPrompt = `Sen yaratıcı ve akıllı bir HR (İnsan Kaynakları) asistanısın.
    
Görevlerin:
- Çalışanların HR sorularını YARATİCİ ve KAPSAMLI şekilde yanıtlamak
- Şirket bilgilerini kullanarak ÜRETİCİ çözümler önermek
- Önceki konuşma geçmişini dikkate alarak TUTARLI cevaplar vermek
- Her zaman nazik, yardımcı ve profesyonel olmak

YAKLAŞIMIN:
1. Şirket bilgilerini temel al ama sadece kopyalama
2. Bilgileri analiz edip YARATICI öneriler sun
3. Çalışanın özel durumuna göre KİŞİSELLEŞTİR
4. Eksik bilgi varsa mantıklı ÇIKARSAMALAR yap
5. Önceki mesajlarla BAĞLANTI kur

ÖNEMLİ: Bilgi yoksa: "${fallback}"

ŞİRKET BİLGİLERİ:
${context}

Lütfen DETAYLI, YARATICI ve FAYDALI cevaplar ver. Türkçe yanıt ver.`;

    // Chat history'yi messages'a dönüştür
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // Önceki konuşmaları ekle (son 6 mesaj - memory limit)
    const recentHistory = chatHistory.slice(-6);
    messages.push(...recentHistory);
    
    // Son kullanıcı mesajını ekle
    messages.push({ role: 'user', content: userQuery });

    console.log(`🧠 ${messages.length} mesajlı chat history ile yanıt üretiliyor...`);
    
    return await this.createChatCompletion(messages, 0.3); // Biraz daha yaratıcı
  }

  /**
   * ANTI-REPETITION Chat Completion - Dynamic prompting for diverse responses
   */
  async antiRepetitionChatCompletion(userQuery, context = '', chatHistory = [], dynamicPrompt = '', options = {}) {
    const fallback = `${require('../config').support.fallbackMessage}`;
    
    // Dynamic prompt kullan, yoksa default'a geri dön
    let systemPrompt = dynamicPrompt;
    
    if (!systemPrompt || systemPrompt.trim().length === 0) {
      systemPrompt = `Sen yaratıcı ve akıllı bir HR asistanısın. Farklı perspektiflerden yanıtlar ver.`;
    }
    
    // Context'i prompt'a ekle
    systemPrompt += `\n\nŞİRKET BİLGİLERİ:\n${context}\n\nÖNEMLİ: Bilgi yoksa: "${fallback}"\n\nTürkçe yanıt ver.`;
    
    // Messages array oluştur
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // Chat history ekle (son 6 mesaj)
    if (chatHistory && chatHistory.length > 0) {
      const recentHistory = chatHistory.slice(-6);
      messages.push(...recentHistory);
    }
    
    // Current query ekle
    messages.push({ role: 'user', content: userQuery });
    
    console.log(`🔒 Anti-repetition chat completion: ${messages.length} mesaj, strategy=${options.strategy || 'normal'}`);
    
    // Temperature'ı dynamic olarak ayarla
    let temperature = options.temperature || 0.3;
    if (options.strategy === 'aggressive_diversification') {
      temperature = 0.8; // Daha yaratıcı
    } else if (options.strategy === 'moderate_diversification') {
      temperature = 0.5; // Orta seviye yaratıcılık
    }
    
    return await this.createChatCompletion(messages, temperature);
  }

  /**
   * Ollama servisinin sağlığını kontrol et
   */
  async checkHealth() {
    try {
      const response = await this.client.get('/api/tags');
      
      // Model listesinde bizim modelimiz var mı kontrol et
      if (response.data && response.data.models) {
        const models = response.data.models.map(m => m.name);
        if (models.includes(this.model)) {
          console.log(`✅ Ollama servisi çalışıyor, model "${this.model}" yüklü`);
          return true;
        } else {
          console.warn(`⚠️  Model "${this.model}" Ollama'da bulunamadı. Yüklü modeller:`, models);
          return false;
        }
      }
      
      console.log('✅ Ollama servisi çalışıyor');
      return true;
    } catch (error) {
      console.error('❌ Ollama servisi çalışmıyor:', error.message);
      console.log('💡 Ollama\'yı başlatmak için: ollama serve');
      console.log(`💡 Model indirmek için: ollama pull ${this.model}`);
      return false;
    }
  }
}

module.exports = OllamaClient;
