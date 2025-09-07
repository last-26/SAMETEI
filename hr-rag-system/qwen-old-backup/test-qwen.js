/**
 * Basit OCR testi - mevcut temp görüntüleri ile
 * Not: Qwen2.5-VL preprocessing aktif (sadece grayscale + 90° döndürme)
 */

const LocalQwenVL = require('./utils/localQwenVL');
const fs = require('fs');
const path = require('path');

async function testOCRSimple() {
  console.log('🚀 Basit OCR testi başlatılıyor...\n');
  
  // Local Qwen VL instance'ı oluştur
  const localQwenVL = new LocalQwenVL('http://localhost:8000');

  try {
    // 1. Sağlık kontrolü
    console.log('1️⃣ Sağlık kontrolü yapılıyor...');
    const health = await localQwenVL.checkHealth();
    console.log('Sağlık durumu:', health);
    
    if (health.status !== 'healthy') {
      console.log('❌ OCR sunucusu çalışmıyor:', health.error);
      return;
    }
    
    console.log('✅ OCR sunucusu çalışıyor!\n');
    
    // 2. Girdi dosyası: temp altındaki isim veya tam yol
    const tempDir = path.join(__dirname, 'temp');
    const arg = process.argv[2];
    if (!arg) {
      console.log('❌ Kullanım: node test-qwen.js <dosyaAdı.pdf|png|jpg>');
      return;
    }
    const promptType = process.argv[3] || 'table_text_with_notes';
    const isPdf = arg.toLowerCase().endsWith('.pdf');
    const candidateInTemp = path.join(tempDir, arg);
    const selectedPath = fs.existsSync(candidateInTemp) ? candidateInTemp : path.resolve(arg);
    let testImage = selectedPath;

    // Basit CLI opsiyonları: --strategy=auto --output=json --headers="Ad,Soyad,T.C. No"
    const cli = process.argv.slice(4).reduce((acc, token) => {
      const m = token.match(/^--([^=]+)=(.*)$/);
      if (m) acc[m[1]] = m[2];
      return acc;
    }, {});
    const options = {
      strategy: cli.strategy,
      output: cli.output,
      headers: cli.headers ? String(cli.headers).split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };

    // Eğer PDF verildiyse önce ilk sayfayı PNG'ye çevir
    if (isPdf) {
      console.log('\n📄 PDF tespit edildi, ilk sayfa PNG\'ye çevriliyor...');
      const { spawnSync } = require('child_process');
      const outPng = path.join(tempDir, `pdf_test_${Date.now()}.png`);
      const pyScript = `
import sys\nfrom pdf2image import convert_from_path\n\ntry:\n    images = convert_from_path(sys.argv[1], first_page=1, last_page=1, dpi=300)\n    if images:\n        images[0].save(sys.argv[2], 'PNG')\n        print(sys.argv[2])\n    else:\n        print('')\nexcept Exception as e:\n    print('')\n`;
      const tmpPy = path.join(tempDir, `toimg_${Date.now()}.py`);
      require('fs').writeFileSync(tmpPy, pyScript);
      const res = spawnSync('python', [tmpPy, path.resolve(selectedPath), outPng], { encoding: 'utf-8' });
      try { require('fs').unlinkSync(tmpPy); } catch {}
      if (res.stdout && require('fs').existsSync(outPng)) {
        testImage = outPng;
        console.log('✅ PDF dönüştürüldü:', path.basename(outPng));
      } else {
        console.error('❌ PDF dönüştürülemedi');
        return;
      }
    }

    console.log(`\n3️⃣ Test girdisi: ${path.basename(testImage)}`);
    
    // 4. OCR testi
    console.log(`\n4️⃣ OCR testi yapılıyor... (prompt: ${promptType})`);
    const ocrResult = await localQwenVL.extractFromImage(testImage, promptType, null, options);
    
    if (ocrResult.success) {
      console.log('✅ OCR başarılı!');
      console.log(`📝 Çıkarılan metin (${ocrResult.text.length} karakter):`);
      console.log('─'.repeat(50));
      console.log(ocrResult.text);
      console.log('─'.repeat(50));
    } else {
      console.log('❌ OCR başarısız:', ocrResult.error);
    }
    
  } catch (error) {
    console.error('❌ Test hatası:', error.message);
  }
}

// Testi çalıştır
testOCRSimple().then(() => {
  console.log('\n🎉 Test tamamlandı!');
  process.exit(0);
}).catch(error => {
  console.error('❌ Test başarısız:', error);
  process.exit(1);
});
