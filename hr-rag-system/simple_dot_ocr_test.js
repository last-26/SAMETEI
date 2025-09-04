/**
 * BASİT DOT-OCR TESTİ
 * Doğrudan ve temiz sonuç verir
 */

const EnhancedDotOCR = require('./utils/enhancedDotOCR');

async function simpleTest(imagePath = null) {
  console.log('🚀 BASİT DOT-OCR TESTİ');
  console.log('='.repeat(50));

  const ocr = new EnhancedDotOCR({
    enablePreprocessing: true, // Grayscale aktif
    maxRetries: 1
  });

  // Komut satırı argümanından veya varsayılan yoldan dosya yolu belirle
  let testImage;

  if (imagePath) {
    // Eğer tam yol verilmişse direkt kullan
    if (imagePath.includes('/') || imagePath.includes('\\')) {
      testImage = imagePath;
    } else {
      // Sadece dosya adı verilmişse temp klasörüne ekle
      testImage = `./temp/${imagePath}`;
    }
  } else {
    // Hiç argüman verilmemişse varsayılan kullan
    testImage = './temp/1.png';
  }

  // Dosya varlığını kontrol et
  const fs = require('fs');
  if (!fs.existsSync(testImage)) {
    console.log(`❌ HATA: Dosya bulunamadı: ${testImage}`);
    console.log('\n📋 KULLANIM ÖRNEKLERİ:');
    console.log('  node simple_dot_ocr_test.js              # temp/1.png kullan');
    console.log('  node simple_dot_ocr_test.js TESTT.png    # temp/TESTT.png kullan');
    console.log('  node simple_dot_ocr_test.js /path/image.png  # Tam yol kullan');
    console.log('\n📁 TEMP KLASÖRÜ İÇERİĞİ:');

    // temp klasöründeki dosyaları listele
    try {
      const tempFiles = fs.readdirSync('./temp');
      const imageFiles = tempFiles.filter(file =>
        file.toLowerCase().endsWith('.png') ||
        file.toLowerCase().endsWith('.jpg') ||
        file.toLowerCase().endsWith('.jpeg')
      );

      if (imageFiles.length > 0) {
        console.log('🎯 Mevcut görüntüler:');
        imageFiles.forEach(file => console.log(`   - ${file}`));
      } else {
        console.log('⚠️ temp klasöründe görüntü dosyası bulunamadı');
      }
    } catch (e) {
      console.log('⚠️ temp klasörü okunamadı');
    }

    return;
  }

  try {
    console.log(`📷 Test görüntüsü: ${testImage}`);
    console.log('🎨 Önce grayscale uygulanacak');
    console.log('📖 Dikey metinler için özel talimatlar eklendi');
    console.log('⏳ OCR başlatılıyor...\n');

    const result = await ocr.extractTextSmart(testImage, 'text_only');

    console.log('='.repeat(50));
    if (result.success) {
      console.log('✅ BAŞARILI!');
      console.log(`📊 Güven skoru: ${result.confidence}%`);
      console.log(`📏 Metin uzunluğu: ${result.text.length} karakter`);
      console.log('\n📝 ÇIKARILAN METİN:');
      console.log('-'.repeat(50));
      console.log(result.text);
      console.log('-'.repeat(50));
    } else {
      console.log(`❌ HATA: ${result.error}`);
    }

  } catch (error) {
    console.log(`❌ EXCEPTION: ${error.message}`);
  }
}

// Ana çalıştırma
if (require.main === module) {
  // Komut satırı argümanını al (node simple_dot_ocr_test.js [dosya_adi])
  const imageArg = process.argv[2]; // İlk argüman
  simpleTest(imageArg).catch(console.error);
}

module.exports = { simpleTest };
