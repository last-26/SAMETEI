const HRRAGSystem = require('../ragSystem');

async function clearHRKnowledgeBase() {
  const ragSystem = new HRRAGSystem();
  
  try {
    console.log('🗑️ HR veritabanı temizleme işlemi başlatılıyor...');
    
    await ragSystem.initialize();
    
    const before = await ragSystem.getSystemStats();
    console.log(`📊 Mevcut döküman sayısı: ${before.database.documentCount}`);
    
    await ragSystem.clearKnowledgeBase();
    
    const after = await ragSystem.getSystemStats();
    console.log(`✅ Temizlik tamamlandı. Yeni döküman sayısı: ${after.database.documentCount}`);
  } catch (error) {
    console.error('❌ Temizlik işlemi hatası:', error);
    process.exit(1);
  } finally {
    await ragSystem.shutdown();
  }
}

// Script'i çalıştır
if (require.main === module) {
  clearHRKnowledgeBase()
    .then(() => {
      console.log('👋 İşlem tamamlandı.');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Kritik hata:', error);
      process.exit(1);
    });
}

module.exports = clearHRKnowledgeBase;
