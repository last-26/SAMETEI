/**
 * DOT-OCR Basit Manuel Test
 * Terminalden tek tek test etmek için
 */

const LocalDotOCR = require('./utils/localDotOCR');
const path = require('path');
const fs = require('fs');

async function testSingleImage() {
  console.log('🧪 DOT-OCR TEK GÖRÜNTÜ TESTİ');
  console.log('='.repeat(50));

  const dotOCR = new LocalDotOCR();

  // Test edilecek görüntü
  const testImages = [
    './temp/1.png',
    './temp/2.png',
    './temp/3.PNG',
    './temp/4.png'
  ];

  for (const imagePath of testImages) {
    if (fs.existsSync(imagePath)) {
      console.log(`\n📷 Test ediliyor: ${path.basename(imagePath)}`);

      try {
        console.log('⏳ İşlem başlatılıyor...');
        const startTime = Date.now();

        const result = await dotOCR.extractFromImage(imagePath, 'table_text_tsv');

        const elapsed = Date.now() - startTime;

        if (result.success) {
          console.log('✅ BAŞARILI!');
          console.log(`📊 Karakter: ${result.text.length}`);
          console.log(`⏱️ Süre: ${elapsed}ms`);
          console.log(`🎯 Cihaz: ${result.device}`);
          console.log('\n📝 SONUÇ:');
          console.log('-'.repeat(40));
          console.log(result.text.substring(0, 300));
          if (result.text.length > 300) console.log('...');
          console.log('-'.repeat(40));
          break;
        } else {
          console.log(`❌ HATA: ${result.error}`);
        }
      } catch (error) {
        console.log(`❌ EXCEPTION: ${error.message}`);
      }

      break; // Sadece ilk görüntüyü test et
    }
  }
}

// Ana test
if (require.main === module) {
  testSingleImage().catch(console.error);
}

module.exports = { testSingleImage };
