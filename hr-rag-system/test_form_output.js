/**
 * DOT-OCR Form Testi - Daha iyi çıktı formatı
 */

const LocalDotOCR = require('./utils/localDotOCR');

async function testFormExtraction() {
  console.log('🧪 DOT-OCR FORM TESTİ');
  console.log('='.repeat(50));

  const dotOCR = new LocalDotOCR();
  const imagePath = './temp/1.png';

  try {
    console.log(`📷 Test görüntüsü: ${imagePath}`);
    console.log('⏳ Form çıkarımı başlatılıyor...\n');

    const result = await dotOCR.extractFromImage(imagePath, 'form');

    if (result.success) {
      console.log('✅ BAŞARILI!');
      console.log(`📊 Karakter sayısı: ${result.text.length}`);
      console.log(`⏱️ Süre: ${result.elapsedMs}ms`);
      console.log(`🎯 Model: ${result.model}`);
      console.log(`🔧 Çıkarım türü: ${result.extractionType}`);
      console.log('\n' + '='.repeat(60));
      console.log('📝 ÇIKARILAN METİN:');
      console.log('='.repeat(60));

      // Metni satır satır böl ve göster
      const lines = result.text.split('\\n');
      lines.forEach((line, index) => {
        console.log(`${(index + 1).toString().padStart(2, ' ')}: ${line}`);
      });

      console.log('='.repeat(60));
      console.log('\n💡 İPUCU: Gerçek uygulamada bu metin otomatik olarak');
      console.log('   yeni satırlara bölünür ve işlenir.');

    } else {
      console.log(`❌ HATA: ${result.error}`);
    }

  } catch (error) {
    console.log(`❌ EXCEPTION: ${error.message}`);
  }
}

// Ana test
if (require.main === module) {
  testFormExtraction().catch(console.error);
}

module.exports = { testFormExtraction };
