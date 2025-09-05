/**
 * TEK TİP TABLO TESTİ - Sadece bir output
 */

const EnhancedDotOCR = require('./utils/enhancedDotOCR');

async function testSingleTableOutput(imagePath = null) {
  console.log('🎯 TEK TİP TABLO TESTİ');
  console.log('='.repeat(50));

  const ocr = new EnhancedDotOCR({
    enablePreprocessing: true,
    maxRetries: 1,
    tryRotations: false, // Rotasyon devre dışı - sadece tek output
    fallbackStrategies: [] // Çoklu strateji devre dışı - sadece tek output
  });

  // Test görüntüsü belirle
  let testImage;
  if (imagePath) {
    if (imagePath.includes('/') || imagePath.includes('\\')) {
      testImage = imagePath;
    } else {
      testImage = `./temp/${imagePath}`;
    }
  } else {
    testImage = './temp/1.png';
  }

  // Dosya kontrolü
  const fs = require('fs');
  if (!fs.existsSync(testImage)) {
    console.log(`❌ Dosya bulunamadı: ${testImage}`);
    return;
  }

  try {
    console.log(`📷 Metin test ediliyor: ${testImage}`);
    console.log('📊 Sadece bir output üretilecek');
    console.log('📸 Orijinal görüntü kullanılıyor (preprocessing kaldırıldı)');
    console.log('📋 Farklı yönlerdeki metinler okunacak');
    console.log('🛡️ Genel metin çıkarımı için çoklu strateji desteği');
    console.log('⏳ İşlem başlatılıyor...\n');

    const result = await ocr.extractTextSmart(testImage, 'text_only');

    console.log('='.repeat(50));
    if (result.success) {
      console.log('✅ METİN ÇIKARIMI BAŞARILI!');
          console.log(`📊 Güven skoru: ${result.confidence}% (${result.preprocessingApplied ? 'Rotation uygulandı' : 'Orijinal'})`);
    console.log(`📏 Metin uzunluğu: ${result.text.length} karakter`);
    console.log(`🔧 Kullanılan yöntem: ${result.method || 'single_direct'}`);
      console.log('\n📋 ÇIKARILAN METİNLER:');
      console.log('='.repeat(60));

      // Metinleri satır satır göster
      const lines = result.text.split('\n');
      lines.forEach((line, index) => {
        console.log(`${index + 1}. ${line}`);
      });

      console.log('='.repeat(60));
      console.log('\n💡 METİN OKUMA:');
      console.log('   • Genel metin çıkarım stratejileri uygulandı');
      console.log('   • Birden fazla yöntemle metin yakalama denenildi');
      console.log('   • En iyi sonuç otomatik seçildi');
      console.log('   • Türkçe karakter desteği');

      // Ham metni dosyaya kaydet
      const fs = require('fs');
      const outputFile = `metin_sonucu_${Date.now()}.txt`;
      fs.writeFileSync(outputFile, result.text, 'utf8');

      console.log('\n📝 HAM METİN (Excel\'e yapıştırılabilir):');
      console.log('-'.repeat(50));
      console.log(result.text);
      console.log('-'.repeat(50));
      console.log(`💾 Sonuç dosyaya kaydedildi: ${outputFile}`);
      console.log('   📋 Bu dosyayı Excel\'e açıp TAB ile ayrılmış veriler olarak içe aktarabilirsiniz.');

    } else {
      console.log(`❌ HATA: ${result.error}`);
    }

  } catch (error) {
    console.log(`❌ EXCEPTION: ${error.message}`);
  }
}

// Ana çalıştırma
if (require.main === module) {
  const imageArg = process.argv[2];
  testSingleTableOutput(imageArg).catch(console.error);
}

module.exports = { testSingleTableOutput };
