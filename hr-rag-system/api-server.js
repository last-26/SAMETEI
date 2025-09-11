const express = require('express');
const cors = require('cors');
const HRRAGSystem = require('./ragSystem');
const config = require('./config');

const app = express();
const ragSystem = new HRRAGSystem();

// Preflight OPTIONS request'leri handle et
app.options('*', cors());

// Middleware
app.use(cors({
  origin: ['http://localhost:3080', 'http://127.0.0.1:3080', 'http://localhost:3000', 'http://127.0.0.3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`\n🔍 ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log(`📍 Origin: ${req.headers.origin || 'No origin'}`);
  console.log(`🌐 Host: ${req.headers.host || 'No host'}`);
  console.log(`🔗 Referer: ${req.headers.referer || 'No referer'}`);
  console.log(`📱 User-Agent: ${req.headers['user-agent'] || 'No user-agent'}`);
  console.log(`🔑 Authorization: ${req.headers.authorization ? 'Present' : 'None'}`);
  console.log(`📦 Content-Type: ${req.headers['content-type'] || 'No content-type'}`);
  console.log(`📏 Content-Length: ${req.headers['content-length'] || 'No content-length'}`);
  
  // LibreChat request'lerini detaylı logla (sadece chat akışı)
  if (req.path === '/chat/completions' || req.path === '/v1/chat/completions') {
    console.log(`🤖 LIBRECHAT ${req.path.toUpperCase()} REQUEST:`);
    console.log('  Headers:', JSON.stringify(req.headers, null, 2));
    console.log('  Body:', JSON.stringify(req.body, null, 2));
    console.log('  Query:', JSON.stringify(req.query, null, 2));
  }
  
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'SAMETEI HR RAG API',
    initialized: ragSystem.isInitialized
  });
});

// System stats
app.get('/stats', async (req, res) => {
  try {
    const stats = await ragSystem.getSystemStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Ana RAG query endpoint'i
 * POST /query
 */
app.post('/query', async (req, res) => {
  try {
    const { question, options = {} } = req.body;
    
    if (!question || typeof question !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Geçerli bir soru gönderilmedi'
      });
    }
    
    if (question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Boş soru gönderilemez'
      });
    }
    
    console.log(`❓ Gelen soru: "${question}"`);
    
    const startTime = Date.now();
    const result = await ragSystem.query(question, options);
    const responseTime = Date.now() - startTime;
    
    // Response'a metadata ekle
    result.metadata = {
      ...result.metadata,
      responseTime: responseTime,
      apiVersion: '1.0.0'
    };
    
    console.log(`✅ Cevap üretildi (${responseTime}ms)`);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('❌ Query API hatası:', error);
    
    res.status(500).json({
      success: false,
      error: 'Bir hata oluştu, lütfen daha sonra tekrar deneyin',
      message: error.message
    });
  }
});

// Chat başlık sistemi - Manuel indeksleme
let chatCounter = 0;

// Chat başlığı oluştur
function generateChatTitle() {
  chatCounter++;
  return `hr-chatbot #${chatCounter}`;
}

// Chat başlığı endpoint'i
app.get('/chat-title', (req, res) => {
  const title = generateChatTitle();
  console.log(`📝 Yeni chat başlığı oluşturuldu: ${title}`);
  
  res.json({
    success: true,
    title: title
  });
});

// OpenAI uyumlu modeller listesi
app.get(['/v1/models', '/models'], (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'sametei-hr-assistant', object: 'model', owned_by: 'sametei' },
    ],
  });
});

/**
 * LibreChat uyumlu chat completion endpoint'i
 * POST /chat/completions ve /v1/chat/completions (alias)
 */
app.post(['/chat/completions', '/v1/chat/completions'], async (req, res) => {
  try {
    const { messages, model, stream } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages array is required',
          type: 'invalid_request_error',
        },
      });
    }
    
    // Son kullanıcı mesajını al
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    
    if (!lastUserMessage) {
      return res.status(400).json({
        error: {
          message: 'No user message found',
          type: 'invalid_request_error'
        }
      });
    }

    // Chat history'yi hazırla (sadece user ve assistant mesajları)
    const chatHistory = messages.filter(m => 
      (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim()
    );
    
    console.log(`🤖 LibreChat query: "${lastUserMessage.content}"`);

    // Başlık üretimi isteklerini algıla ve hızlı yanıt ver
    const isTitleRequest = typeof lastUserMessage.content === 'string'
      && lastUserMessage.content.toLowerCase().includes('sohbet için en fazla 5 kelimelik');

    if (isTitleRequest) {
      const title = generateChatTitle();
      console.log(`📝 Başlık üretimi isteği algılandı: ${title}`);
      
      // Hızlı başlık yanıtı
      const response = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'sametei-hr-assistant',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: title,
            },
            text: title,
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          total_tokens: 60,
        },
      };

      if (stream === true) {
        // Stream yanıtı
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const streamId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        // Role chunk
        const roleChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: model || 'sametei-hr-assistant',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        // Content chunk
        const contentChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: model || 'sametei-hr-assistant',
          choices: [{ index: 0, delta: { content: title }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

        // Stop chunk
        const stopChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: model || 'sametei-hr-assistant',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        console.log(`✅ Başlık yanıtı gönderildi: ${title}`);
        return;
      }

      // Non-stream JSON
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.status(200).json(response);
      console.log(`✅ Başlık yanıtı gönderildi: ${title}`);
      return;
    }
    
    // RAG ile cevap üret (chat history ile)
    const ragResult = await ragSystem.query(lastUserMessage.content, {
      chatHistory: chatHistory
    });
    
    // OpenAI-uyumlu yanıt nesnesi
    const response = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'sametei-hr-assistant',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: ragResult.answer,
          },
          // Geriye dönük uyumluluk: bazı istemciler text alanını okur
          text: ragResult.answer,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: ragResult.metadata?.totalTokensUsed || 0,
        completion_tokens: ragResult.metadata?.completionTokens || 0,
        total_tokens:
          (ragResult.metadata?.totalTokensUsed || 0) +
          (ragResult.metadata?.completionTokens || 0),
      },
    };
    
    if (stream === true) {
      // OpenAI style event stream: first chunk sets role, next chunk(s) stream content, then stop
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      // 1) role chunk
      const roleChunk = {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: model || 'sametei-hr-assistant',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      // 2) content chunk
      const contentChunk = {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: model || 'sametei-hr-assistant',
        choices: [
          {
            index: 0,
            delta: { content: ragResult.answer },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

      // 3) stop chunk
      const stopChunk = {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: model || 'sametei-hr-assistant',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`✅ Streamed response sent (${ragResult.answer.length} chars)`);
      return;
    }

    // Non-stream JSON
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json(response);
    console.log(`✅ LibreChat response sent: ${ragResult.answer.substring(0, 100)}...`);
    
  } catch (error) {
    console.error('❌ Chat completion API hatası:', error);
    
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'api_error',
        details: error.message
      }
    });
  }
});

/**
 * Knowledge base güncelleme
 * POST /update-knowledge
 */
app.post('/update-knowledge', async (req, res) => {
  try {
    const { documents, clearExisting = false } = req.body;
    
    if (clearExisting) {
      await ragSystem.clearKnowledgeBase();
      console.log('🗑️ Knowledge base temizlendi');
    }
    
    if (documents && documents.length > 0) {
      await ragSystem.updateKnowledgeBase(documents);
      console.log(`✅ ${documents.length} döküman eklendi`);
    }
    
    const stats = await ragSystem.getSystemStats();
    
    res.json({
      success: true,
      message: 'Knowledge base güncellendi',
      stats: stats.database
    });
    
  } catch (error) {
    console.error('❌ Knowledge update hatası:', error);
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Batch query endpoint
 * POST /batch-query
 */
app.post('/batch-query', async (req, res) => {
  try {
    const { questions } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({
        success: false,
        error: 'Questions array is required'
      });
    }
    
    console.log(`🔄 Batch query: ${questions.length} soru`);
    
    const results = await ragSystem.batchQuery(questions);
    
    res.json({
      success: true,
      data: results,
      metadata: {
        totalQuestions: questions.length,
        processedAt: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('❌ Batch query hatası:', error);
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'GET /stats', 
      'POST /query',
      'POST /chat/completions',
      'GET /chat-title',
      'POST /update-knowledge',
      'POST /batch-query'
    ]
  });
});

// Server başlatma
async function startServer() {
  try {
    console.log('🚀 SAMETEI HR RAG API Server başlatılıyor...');
    
    // RAG sistemini initialize et
    await ragSystem.initialize();
    
    const port = config.server.port;
    const host = config.server.host;
    
    app.listen(port, host, () => {
      console.log(`✅ Server başlatıldı: http://${host}:${port}`);
      console.log('📋 Mevcut endpoint\'ler:');
      console.log(`   - GET  /health              - Sistem durumu`);
      console.log(`   - GET  /stats               - Sistem istatistikleri`); 
      console.log(`   - POST /query               - RAG sorgu`);
      console.log(`   - POST /chat/completions    - LibreChat uyumlu`);
      console.log(`   - GET  /chat-title          - Chat başlığı oluştur`);
      console.log(`   - POST /update-knowledge    - Veri güncelleme`);
      console.log(`   - POST /batch-query         - Çoklu sorgu`);
      console.log('\n🎯 LibreChat entegrasyonu hazır!');
      
      // Server başladıktan sonra HR prosedürlerini yükle
      loadHRProceduresAfterStart();
    });
    
  } catch (error) {
    console.error('❌ Server başlatma hatası:', error);
    process.exit(1);
  }
}

// Server başladıktan sonra HR prosedürlerini yükle
async function loadHRProceduresAfterStart() {
  try {
    console.log('📚 Prosedür klasörü yükleniyor...');
    const path = require('path');
    const dirPath = path.join(__dirname, 'data', 'procedures');
    console.log(`📁 Klasör yolu: ${dirPath}`);

    const result = await ragSystem.loadDocumentsFromDir(dirPath);
    console.log(`✅ ${result.length} chunk içe aktarıldı!`);

    const stats = await ragSystem.getSystemStats();
    console.log(`📊 Yükleme sonrası döküman sayısı: ${stats.database.documentCount}`);
  } catch (error) {
    console.error('❌ Prosedür klasörü yükleme hatası:', error);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Server kapatılıyor...');
  await ragSystem.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Server sonlandırılıyor...');
  await ragSystem.shutdown();
  process.exit(0);
});

// Script olarak çalıştırılırsa server'ı başlat
if (require.main === module) {
  startServer();
}

module.exports = { app, ragSystem, startServer };
