const HRRAGSystem = require('../ragSystem');

async function testRAGSystem() {
  const ragSystem = new HRRAGSystem();
  
  try {
    console.log('🧪 SAMETEI HR RAG System Test Başlıyor...\n');
    
    // Sistemi başlat
    await ragSystem.initialize();
    
    // Sistem durumunu kontrol et
    const stats = await ragSystem.getSystemStats();
    console.log('📊 Sistem Durumu:');
    console.log(`   - Toplam döküman: ${stats.database.documentCount}`);
    console.log(`   - Embedding boyutu: ${stats.database.embeddingDimension || 'N/A'}`);
    console.log(`   - Durum: ${stats.status}\n`);
    
    if (stats.database.documentCount === 0) {
      console.log('⚠️  Hiç döküman bulunamadı. Önce embed-documents.js çalıştırın.\n');
      return;
    }
    
    // Test soruları
    const testCases = [
      {
        category: "İzin Yönetimi",
        questions: [
          "Yıllık izin hakkım nasıl hesaplanır?",
          "5 yıl çalıştım, kaç gün iznim var?",
          "Hastalık izni için ne yapmam gerekiyor?",
          "Evlilik izni kaç gün?",
          "Doğum izni süresi ne kadar?"
        ]
      },
      {
        category: "Bordro ve Ödemeler", 
        questions: [
          "Maaşım ne zaman yatırılır?",
          "Avans alabilir miyim?",
          "Fazla mesai ücreti nasıl hesaplanır?",
          "Kıdem tazminatı nasıl ödenir?",
          "Prim ödemeleri ne zaman yapılır?"
        ]
      },
      {
        category: "Çalışma Koşulları",
        questions: [
          "Uzaktan çalışma yapabilir miyim?",
          "Esnek çalışma saatleri var mı?",
          "Part-time çalışma mümkün mü?",
          "Çekirdek çalışma saatleri nedir?",
          "Ofis kuralları nelerdir?"
        ]
      },
      {
        category: "Yan Haklar",
        questions: [
          "Sağlık sigortam ne kapsar?",
          "Yemek kartı limiti nedir?",
          "Ulaşım desteği var mı?",
          "Çocuk yardımı alabilir miyim?",
          "Telefon desteği nasıl sağlanır?"
        ]
      },
      {
        category: "Edge Cases",
        questions: [
          "Python programlama nasıl öğrenirim?", // İlgisiz soru
          "Merhaba, nasılsın?", // Genel sohbet
          "Şirkette kaç kişi çalışıyor?", // Bilgi yok
          "", // Boş soru
          "İK departmanı nerede?" // Genel bilgi
        ]
      }
    ];
    
    let totalTests = 0;
    let successfulTests = 0;
    
    for (const testCase of testCases) {
      console.log(`\n🏷️ Kategori: ${testCase.category}`);
      console.log('═'.repeat(50));
      
      for (const question of testCase.questions) {
        totalTests++;
        
        try {
          console.log(`\n❓ Soru: "${question}"`);
          
          const startTime = Date.now();
          const result = await ragSystem.query(question);
          const responseTime = Date.now() - startTime;
          
          if (result.error) {
            console.log(`❌ HATA: ${result.error}`);
          } else {
            console.log(`💡 Cevap: ${result.answer.substring(0, 150)}...`);
            console.log(`📊 Kaynak: ${result.sources.length} döküman`);
            console.log(`⏱️  Süre: ${responseTime}ms`);
            console.log(`🏷️ Kategoriler: ${result.sources.map(s => s.category).slice(0, 3).join(', ')}`);
            
            if (result.sources.length > 0) {
              successfulTests++;
              console.log(`✅ BAŞARILI`);
            } else {
              console.log(`⚠️ Kaynak bulunamadı`);
            }
          }
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 1500));
          
        } catch (error) {
          console.log(`❌ Test hatası: ${error.message}`);
        }
      }
    }
    
    // Test sonuçları
    console.log('\n' + '═'.repeat(60));
    console.log('📈 TEST SONUÇLARI');
    console.log('═'.repeat(60));
    console.log(`📝 Toplam test: ${totalTests}`);
    console.log(`✅ Başarılı: ${successfulTests}`);
    console.log(`❌ Başarısız: ${totalTests - successfulTests}`);
    console.log(`📊 Başarı oranı: ${Math.round((successfulTests / totalTests) * 100)}%`);
    
    // Performans testi
    console.log('\n🚀 Performans Testi...');
    const perfQuestion = "Yıllık izin hakkım var mı?";
    const perfTimes = [];
    
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await ragSystem.query(perfQuestion);
      const time = Date.now() - start;
      perfTimes.push(time);
      
      process.stdout.write(`⏱️ ${i + 1}/5: ${time}ms `);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const avgTime = Math.round(perfTimes.reduce((a, b) => a + b, 0) / perfTimes.length);
    console.log(`\n📊 Ortalama yanıt süresi: ${avgTime}ms`);
    
    console.log('\n✅ Tüm testler tamamlandı!');
    
  } catch (error) {
    console.error('❌ Test hatası:', error);
  } finally {
    await ragSystem.shutdown();
  }
}

// Script'i çalıştır
if (require.main === module) {
  testRAGSystem()
    .then(() => {
      console.log('\n👋 Test tamamlandı.');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Test hatası:', error);
      process.exit(1);
    });
}

module.exports = testRAGSystem;
