const HRRAGSystem = require('./ragSystem');
const path = require('path');

async function loadProcedures() {
  try {
    console.log('🚀 HR prosedürleri yükleniyor...');
    
    const ragSystem = new HRRAGSystem();
    await ragSystem.initialize();
    
    // CSV dosyasının yolunu belirle
    const csvPath = path.join(__dirname, '..', 'hr_procedures.csv');
    console.log(`📁 CSV dosyası: ${csvPath}`);
    
    // HR prosedürlerini yükle
    const result = await ragSystem.loadHRProcedures(csvPath);
    
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
