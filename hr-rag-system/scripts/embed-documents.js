const HRRAGSystem = require('../ragSystem');
const path = require('path');

async function embedHRDocuments() {
  const ragSystem = new HRRAGSystem();
  
  try {
    console.log('🚀 SAMETEI HR Dökümanları Embedding İşlemi Başlıyor...\n');
    
    // RAG sistemini başlat
    await ragSystem.initialize();
    
    // Mevcut veritabanını temizle (isteğe bağlı)
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      readline.question('❓ Mevcut HR veritabanını temizlemek istiyor musunuz? (y/N): ', resolve);
    });
    readline.close();
    
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      await ragSystem.clearKnowledgeBase();
      console.log('🗑️ Mevcut veriler temizlendi\n');
    }
    
    // HR prosedürlerini yükle
    const csvPath = path.join(__dirname, '../../hr_procedures.csv');
    console.log(`📂 CSV Dosyası: ${csvPath}\n`);
    
    await ragSystem.loadHRProcedures(csvPath);
    
    // Sistem istatistikleri
    console.log('\n📊 Sistem İstatistikleri:');
    const stats = await ragSystem.getSystemStats();
    console.log(JSON.stringify(stats, null, 2));
    
    // Test sorguları
    console.log('\n🧪 Test Sorguları Çalıştırılıyor...\n');
    
    const testQuestions = [
      "Yıllık izin hakkım nasıl hesaplanır?",
      "Fazla mesai ücreti nasıl ödenir?",
      "Uzaktan çalışma politikası nedir?",
      "Maaş ne zaman yatırılır?",
      "İK departmanı ile nasıl iletişim kurabilirim?"
    ];
    
    for (const question of testQuestions) {
      console.log(`\n❓ TEST: "${question}"`);
      console.log('─'.repeat(60));
      
      const result = await ragSystem.query(question);
      
      console.log(`💡 CEVAP: ${result.answer.substring(0, 200)}...`);
      console.log(`📋 Kaynak sayısı: ${result.sources.length}`);
      console.log(`🏷️ Kategoriler: ${result.sources.map(s => s.category).join(', ')}`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n✅ Embedding işlemi ve testler tamamlandı!');
    console.log('\n🎯 Sistem artık LibreChat entegrasyonu için hazır.');
    
  } catch (error) {
    console.error('❌ Embedding işlemi hatası:', error);
    process.exit(1);
  } finally {
    await ragSystem.shutdown();
  }
}

// Script'i çalıştır
if (require.main === module) {
  embedHRDocuments()
    .then(() => {
      console.log('\n👋 İşlem tamamlandı.');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Kritik hata:', error);
      process.exit(1);
    });
}

module.exports = embedHRDocuments;
