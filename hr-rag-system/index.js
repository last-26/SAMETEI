const { app, ragSystem, startServer } = require('./api-server');

// Ana entry point - API server'ı başlat
console.log('🎯 SAMETEI HR-RAG System');
console.log('💼 LibreChat entegrasyonu ile HR asistan sistemi');
console.log('─'.repeat(50));

// Server'ı başlat
startServer().catch(error => {
  console.error('❌ Server başlatma hatası:', error);
  process.exit(1);
});

// Export edilen modules
module.exports = {
  app,
  ragSystem,
  HRRAGSystem: require('./ragSystem'),
  OpenRouterClient: require('./utils/openrouter'),
  MongoDBVectorDB: require('./utils/mongodb'),
  TextProcessor: require('./utils/textProcessor'),
  config: require('./config')
};
