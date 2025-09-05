/**
 * DOT-OCR Sistem Durum Kontrolü
 * Entegrasyonun çalışıp çalışmadığını kontrol eder
 */

const LocalDotOCR = require('./utils/localDotOCR');
const fs = require('fs');
const path = require('path');

async function checkSystemStatus() {
  console.log('🔍 DOT-OCR SİSTEM DURUM KONTROLÜ');
  console.log('='.repeat(50));

  try {
    // 1. DOT-OCR servisi kontrolü
    console.log('\n1️⃣ DOT-OCR Servis Durumu:');
    const dotOCR = new LocalDotOCR();

    const health = await dotOCR.checkHealth();
    console.log(`📊 Servis durumu: ${health.status}`);
    console.log(`💬 Mesaj: ${health.message}`);

    if (health.status !== 'healthy') {
      console.log('❌ DOT-OCR servisi çalışmıyor!');
      return false;
    }

    // 2. Konfigürasyon kontrolü
    console.log('\n2️⃣ Konfigürasyon:');
    const config = dotOCR.getConfig();
    console.log(`📁 Model yolu: ${config.modelPath}`);
    console.log(`🐍 Python yolu: ${config.pythonPath}`);
    console.log(`🔧 Varsayılan tip: ${config.defaultExtractionType}`);

    // 3. Model dosyası kontrolü
    console.log('\n3️⃣ Model Dosyaları:');
    const modelPath = config.modelPath;
    if (fs.existsSync(modelPath)) {
      const files = fs.readdirSync(modelPath);
      console.log(`✅ Model klasörü mevcut: ${files.length} dosya`);
      console.log(`📋 İlk 5 dosya: ${files.slice(0, 5).join(', ')}`);
    } else {
      console.log(`❌ Model klasörü bulunamadı: ${modelPath}`);
      return false;
    }

    // 4. Test görüntüleri kontrolü
    console.log('\n4️⃣ Test Görüntüleri:');
    const tempDir = path.join(__dirname, 'temp');
    const testImages = ['1.png', '2.png', '3.PNG', '4.png'];

    let availableImages = [];
    for (const img of testImages) {
      if (fs.existsSync(path.join(tempDir, img))) {
        availableImages.push(img);
      }
    }

    if (availableImages.length > 0) {
      console.log(`✅ ${availableImages.length} test görüntüsü mevcut:`);
      console.log(`📷 ${availableImages.join(', ')}`);
    } else {
      console.log('⚠️ Test görüntüsü bulunamadı');
    }

    // 5. Python kontrolü
    console.log('\n5️⃣ Python ve PyTorch Kontrolü:');
    const { spawn } = require('child_process');

    console.log('🔍 PyTorch versiyonu kontrol ediliyor...');
    const python = spawn('python', ['-c', 'import torch; print("PyTorch:", torch.__version__); print("CUDA:", torch.cuda.is_available())']);

    python.stdout.on('data', (data) => {
      console.log('✅ ' + data.toString().trim());
    });

    python.stderr.on('data', (data) => {
      console.log('⚠️ ' + data.toString().trim());
    });

    python.on('close', (code) => {
      if (code === 0) {
        console.log('\n🎉 SİSTEM HAZIR - DOT-OCR entegrasyonu tamam!');
        console.log('💡 Test etmek için: node test_dot_ocr_simple.js');
      } else {
        console.log('\n❌ Python/PyTorch sorunu var!');
      }
    });

  } catch (error) {
    console.log('\n❌ DOT-OCR sistemi çalışmıyor!');
    console.log(`🔍 Hata: ${error.message}`);
    return false;
  }
}

// Ana kontrol
if (require.main === module) {
  checkSystemStatus().catch(console.error);
}

module.exports = { checkSystemStatus };
