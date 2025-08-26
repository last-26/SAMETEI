const HRRAGSystem = require('./ragSystem');
const path = require('path');

async function loadProcedures() {
  try {
    console.log('🚀 HR prosedürleri yükleniyor...');
    
    const ragSystem = new HRRAGSystem();
    await ragSystem.initialize();
    
    // Prosedür klasörünü yükle
    const dirPath = path.join(__dirname, 'data', 'procedures');
    console.log(`📁 Klasör: ${dirPath}`);
    const result = await ragSystem.loadDocumentsFromDir(dirPath);
    
    console.log(`✅ ${result.length} HR prosedürü başarıyla yüklendi!`);
    
    // Stats kontrol et
    const stats = await ragSystem.getSystemStats();
    console.log('📊 Sistem istatistikleri:', JSON.stringify(stats, null, 2));
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Hata:', error);
    process.exit(1);
  }
}

loadProcedures();
