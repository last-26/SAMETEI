/**
 * DOT-OCR Test Dosyası
 * GOT-OCR2 modelini test etmek için kullanılır
 */

const LocalDotOCR = require('../utils/localDotOCR');
const path = require('path');
const fs = require('fs');

class DotOCRTest {
  constructor() {
    this.dotOCR = new LocalDotOCR({
      modelPath: "C:\\Users\\samet\\Downloads\\GOT-OCR2_0",
      pythonPath: 'python',
      defaultExtractionType: 'table_text_tsv'
    });
  }

  /**
   * Gelişmiş görüntü testi - tüm temp görüntülerini test eder
   */
  async testBasicImage() {
    console.log('\n' + '='.repeat(50));
    console.log('🧪 DOT-OCR GÖRÜNTÜ TESTİ (TÜM TEMP GÖRÜNTÜLERİ)');
    console.log('='.repeat(50));

    const tempDir = path.join(__dirname, '..', 'temp');
    const testImages = [
      '1.png', '2.png', '3.PNG', '4.png',
      'rapor2.png', 'test_image.png'
    ];

    let successCount = 0;
    let totalTime = 0;

    for (const imageName of testImages) {
      const imagePath = path.join(tempDir, imageName);

      if (fs.existsSync(imagePath)) {
        console.log(`\n📷 Test ediliyor: ${imageName}`);

        // Farklı çıkarım türlerini test et
        const extractionTypes = ['table_text_tsv', 'text_only', 'form'];

        for (const extType of extractionTypes) {
          try {
            console.log(`🔍 ${extType} çıkarımı deneniyor...`);
            const startTime = Date.now();
            const result = await this.dotOCR.extractFromImage(imagePath, extType);
            const elapsed = Date.now() - startTime;

            if (result.success) {
              console.log('✅ Başarılı!');
              console.log(`📊 Karakter sayısı: ${result.text.length}`);
              console.log(`⏱️ İşlem süresi: ${elapsed}ms`);
              console.log(`🎯 Model: ${result.model}`);
              console.log(`🔧 Çıkarım türü: ${extType}`);

              console.log('\n📝 METİN ÖNİZLEMESİ:');
              console.log('-'.repeat(50));
              const preview = result.text.substring(0, 200).replace(/\n/g, ' | ');
              console.log(preview + (result.text.length > 200 ? '...' : ''));
              console.log('-'.repeat(50));

              successCount++;
              totalTime += elapsed;

              console.log(`🎉 ${imageName} - ${extType} BAŞARILI!`);
              break; // Bu görüntü için başarılı oldu, diğer türleri dene

            } else {
              console.log(`❌ ${extType} başarısız: ${result.error}`);
            }
          } catch (error) {
            console.log(`❌ ${extType} hatası: ${error.message}`);
          }
        }
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST SONUÇLARI:');
    console.log(`✅ Başarılı test sayısı: ${successCount}/${testImages.length}`);
    if (successCount > 0) {
      console.log(`⏱️ Ortalama işlem süresi: ${Math.round(totalTime / successCount)}ms`);
    }
    console.log('='.repeat(50));
  }

  /**
   * Farklı çıkarım türlerini test et
   */
  async testExtractionTypes() {
    console.log('\n' + '='.repeat(50));
    console.log('🔄 DOT-OCR ÇIKARIM TÜRLERİ TESTİ');
    console.log('='.repeat(50));

    const testImage = path.join(__dirname, '..', 'temp', 'rapor2.png');
    if (!fs.existsSync(testImage)) {
      console.log('⚠️ Test görüntüsü bulunamadı, atlanıyor');
      return;
    }

    const extractionTypes = ['table_text_tsv', 'form', 'text_only', 'structured'];

    for (const type of extractionTypes) {
      console.log(`\n🔍 Test ediliyor: ${type}`);
      try {
        const result = await this.dotOCR.extractFromImage(testImage, type);
        if (result.success) {
          console.log(`✅ ${type}: ${result.text.length} karakter`);
          console.log(`⏱️ Süre: ${result.elapsedMs}ms`);
        } else {
          console.log(`❌ ${type}: ${result.error}`);
        }
      } catch (error) {
        console.log(`❌ ${type} hatası: ${error.message}`);
      }

      // Kısa bekleme
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Servis durumu testi
   */
  async testServiceHealth() {
    console.log('\n' + '='.repeat(50));
    console.log('🏥 DOT-OCR SERVİS SAĞLIK TESTİ');
    console.log('='.repeat(50));

    try {
      const health = await this.dotOCR.checkHealth();
      console.log('📊 Servis durumu:', health);

      if (health.status === 'healthy') {
        console.log('✅ Servis çalışıyor');
      } else {
        console.log('❌ Servis çalışmıyor:', health.message);
      }
    } catch (error) {
      console.log('❌ Sağlık kontrolü hatası:', error.message);
    }
  }

  /**
   * Konfigürasyon testi
   */
  testConfiguration() {
    console.log('\n' + '='.repeat(50));
    console.log('⚙️ DOT-OCR KONFIGÜRASYON TESTİ');
    console.log('='.repeat(50));

    const config = this.dotOCR.getConfig();
    console.log('📋 Mevcut konfigürasyon:');
    console.log(JSON.stringify(config, null, 2));
  }

  /**
   * Tüm testleri çalıştır
   */
  async runAllTests() {
    console.log('🚀 DOT-OCR TESTLERİ BAŞLATILIYOR...');

    try {
      // Servis sağlık testi
      await this.testServiceHealth();

      // Konfigürasyon testi
      this.testConfiguration();

      // Basit görüntü testi
      await this.testBasicImage();

      // Çıkarım türleri testi
      await this.testExtractionTypes();

      console.log('\n' + '='.repeat(50));
      console.log('✅ TÜM TESTLER TAMAMLANDI');
      console.log('='.repeat(50));

    } catch (error) {
      console.error('❌ Test hatası:', error);
    }
  }
}

// Ana program
if (require.main === module) {
  const tester = new DotOCRTest();
  tester.runAllTests().catch(console.error);
}

module.exports = DotOCRTest;
