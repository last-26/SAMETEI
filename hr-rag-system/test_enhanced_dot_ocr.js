/**
 * Gelişmiş DOT-OCR Test Sistemi
 * Akıllı görüntü işleme ve çoklu strateji testi
 */

const EnhancedDotOCR = require('./utils/enhancedDotOCR');
const path = require('path');
const fs = require('fs');

class EnhancedDotOCRTest {
  constructor() {
    this.enhancedOCR = new EnhancedDotOCR({
      enablePreprocessing: true,
      maxRetries: 2,
      fallbackStrategies: ['preprocessing', 'alternative_type', 'retry']
    });
  }

  /**
   * Tek görüntü için akıllı test
   */
  async testSmartExtraction() {
    console.log('🧠 AKILLI DOT-OCR TESTİ');
    console.log('='.repeat(60));

    const testImages = [
      './temp/1.png',
      './temp/2.png',
      './temp/3.PNG',
      './temp/4.png'
    ];

    for (const imagePath of testImages) {
      if (fs.existsSync(imagePath)) {
        console.log(`\n🎯 Test ediliyor: ${path.basename(imagePath)}`);
        console.log('-'.repeat(50));

        try {
          const result = await this.enhancedOCR.extractTextSmart(imagePath, 'table_text_tsv');

          if (result.success) {
            console.log('✅ BAŞARILI!');
            console.log(`📊 Güven skoru: ${result.confidence}%`);
            console.log(`📏 Metin uzunluğu: ${result.text.length} karakter`);
            console.log(`⏱️ İşlem süresi: ${result.elapsedMs}ms`);
            console.log(`🔧 Kullanılan strateji sayısı: ${result.strategiesUsed}`);
            console.log(`🔍 Ön işleme uygulandı: ${result.preprocessingApplied}`);

            console.log('\n📝 ÇIKARILAN METİN:');
            console.log('='.repeat(50));

            // Metni temiz ve okunabilir şekilde göster
            const cleanText = result.text
              .replace(/\\n/g, '\n')  // JSON escape'lerini gerçek newline'a çevir
              .replace(/\\t/g, '\t'); // Tab karakterlerini düzelt

            // İlk 500 karakteri göster
            const preview = cleanText.substring(0, 500);
            console.log(preview);

            if (cleanText.length > 500) {
              console.log('\n[... devam ediyor ...]');
            }

            console.log('='.repeat(50));

            // Güven skoruna göre değerlendirme
            if (result.confidence >= 80) {
              console.log('🎉 MUHTEŞEM SONUÇ!');
            } else if (result.confidence >= 60) {
              console.log('👍 İYİ SONUÇ');
            } else {
              console.log('⚠️ ORTALAMA SONUÇ - İyileştirme gerekebilir');
            }

          } else {
            console.log(`❌ BAŞARISIZ: ${result.error}`);
          }

        } catch (error) {
          console.log(`❌ HATA: ${error.message}`);
        }

        // Testler arasında bekleme
        console.log('\n⏳ Sonraki test için 2 saniye bekleniyor...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        break; // Sadece ilk başarılı görüntüyü test et
      }
    }
  }

  /**
   * Sistem durumu kontrolü
   */
  async testSystemStatus() {
    console.log('\n🔍 SİSTEM DURUM KONTROLÜ');
    console.log('='.repeat(60));

    try {
      const status = await this.enhancedOCR.getSystemStatus();

      console.log(`📊 Genel durum: ${status.status}`);
      console.log(`🤖 DOT-OCR durumu: ${status.dotOCR.status}`);
      console.log(`⚙️ Ön işleme: ${status.preprocessing.enabled ? 'Aktif' : 'Pasif'}`);
      console.log(`🔄 Fallback stratejileri: ${status.preprocessing.strategies.join(', ')}`);

      console.log('\n🛠️ KAPASİTELER:');
      Object.entries(status.capabilities).forEach(([key, value]) => {
        console.log(`   ${key}: ${value ? '✅' : '❌'}`);
      });

      console.log('\n📋 YAPILANDIRMA:');
      console.log(`   Model yolu: ${status.config.modelPath}`);
      console.log(`   Python yolu: ${status.config.pythonPath}`);
      console.log(`   Timeout: ${status.config.maxRetries * 30} saniye`);

      return status.status === 'ready';

    } catch (error) {
      console.log(`❌ Sistem kontrolü hatası: ${error.message}`);
      return false;
    }
  }

  /**
   * Farklı çıkarım türlerini karşılaştırma testi
   */
  async testComparison() {
    console.log('\n🔄 ÇIKARIM TÜRLERİ KARŞILAŞTIRMASI');
    console.log('='.repeat(60));

    const testImage = './temp/1.png';
    if (!fs.existsSync(testImage)) {
      console.log('⚠️ Test görüntüsü bulunamadı');
      return;
    }

    const extractionTypes = ['text_only', 'form', 'table_text_tsv'];
    const results = [];

    for (const extType of extractionTypes) {
      console.log(`\n🔍 Test ediliyor: ${extType.toUpperCase()}`);

      try {
        const result = await this.enhancedOCR.extractWithRetry(testImage, extType, 1);

        if (result.success) {
          const confidence = this.enhancedOCR.calculateConfidence(result);
          console.log(`✅ Başarılı - Güven: ${confidence}%, Uzunluk: ${result.text.length}`);

          results.push({
            type: extType,
            confidence: confidence,
            length: result.text.length,
            success: true
          });
        } else {
          console.log(`❌ Başarısız: ${result.error}`);
          results.push({
            type: extType,
            confidence: 0,
            length: 0,
            success: false
          });
        }

      } catch (error) {
        console.log(`❌ Hata: ${error.message}`);
        results.push({
          type: extType,
          confidence: 0,
          length: 0,
          success: false
        });
      }

      // Kısa bekleme
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Sonuçları karşılaştır
    console.log('\n📊 KARŞILAŞTIRMA SONUÇLARI:');
    console.log('='.repeat(60));
    console.log('Tür'.padEnd(15), 'Güven'.padEnd(8), 'Uzunluk'.padEnd(10), 'Durum');
    console.log('-'.repeat(60));

    results.forEach(result => {
      console.log(
        result.type.padEnd(15),
        `${result.confidence}%`.padEnd(8),
        result.length.toString().padEnd(10),
        result.success ? '✅' : '❌'
      );
    });

    // En iyi sonucu öner
    const bestResult = results
      .filter(r => r.success)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (bestResult) {
      console.log(`\n🎯 EN İYİ SONUÇ: ${bestResult.type} (${bestResult.confidence}% güven)`);
    }
  }

  /**
   * Tüm testleri çalıştır
   */
  async runAllTests() {
    console.log('🚀 GELİŞMİŞ DOT-OCR TESTLERİ BAŞLATILIYOR...\n');

    try {
      // 1. Sistem durumu kontrolü
      const systemReady = await this.testSystemStatus();

      if (!systemReady) {
        console.log('\n❌ Sistem hazır değil, testler durduruldu');
        return;
      }

      // 2. Akıllı çıkarım testi
      await this.testSmartExtraction();

      // 3. Karşılaştırma testi
      await this.testComparison();

      console.log('\n' + '='.repeat(60));
      console.log('✅ TÜM TESTLER TAMAMLANDI');
      console.log('='.repeat(60));
      console.log('\n💡 İPUÇLARI:');
      console.log('   • Renkli arka planlı görüntüler için ön işleme aktif');
      console.log('   • Güven skoru >80% çok iyi sonuç demek');
      console.log('   • Farklı çıkarım türleri farklı sonuçlar verebilir');
      console.log('   • Sistem otomatik olarak en iyi sonucu seçer');

    } catch (error) {
      console.error('\n❌ Test hatası:', error);
    }
  }
}

// Ana test
if (require.main === module) {
  const tester = new EnhancedDotOCRTest();
  tester.runAllTests().catch(console.error);
}

module.exports = EnhancedDotOCRTest;
