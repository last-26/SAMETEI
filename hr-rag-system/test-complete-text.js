const HRRAGSystem = require('./ragSystem');
const path = require('path');

async function testCompleteText() {
  console.log('🎨 Tüm Metinler (Renkli Fontlar Dahil) Test Ediliyor...');
  
  try {
    const ragSystem = new HRRAGSystem();
    await ragSystem.initialize();
    
    // Test PDF'ini işle (renkli metinler olan PDF)
    const pdfPath = path.join(__dirname, 'data', 'Copilot_20250828_104812.pdf');
    console.log(`📄 Test PDF: ${path.basename(pdfPath)}`);
    
    if (!require('fs').existsSync(pdfPath)) {
      console.error('❌ Test PDF bulunamadı:', pdfPath);
      return;
    }
    
    // Vision OCR ile işle
    console.log('\n🔍 Tüm metinler (renkli fontlar dahil) ile işleniyor...');
    const chunks = await ragSystem.textProcessor.processDocument(pdfPath, { 
      source: 'test',
      type: 'form'
    });
    
    if (chunks.length > 0) {
      console.log(`✅ ${chunks.length} chunk oluşturuldu`);
      
      // İlk chunk'ı göster
      const firstChunk = chunks[0];
      console.log('\n📝 Tüm Metinler Çıktısı:');
      console.log('─'.repeat(80));
      console.log(firstChunk.content);
      console.log('─'.repeat(80));
      
      // Renkli metinleri kontrol et
      const content = firstChunk.content.toLowerCase();
      const colorWords = ['kırmızı', 'mavi', 'yeşil', 'sarı', 'yeşii', 'yeşei'];
      const foundColors = colorWords.filter(color => content.includes(color));
      
      console.log('\n🎨 Bulunan Renkli Metinler:');
      if (foundColors.length > 0) {
        foundColors.forEach(color => console.log(`  ✅ ${color.toUpperCase()}`));
      } else {
        console.log('  ❌ Renkli metinler bulunamadı');
      }
      
      // Metadata'yı göster
      console.log('\n📊 Metadata:');
      console.log(`OCR Provider: ${firstChunk.metadata.ocrProvider}`);
      console.log(`OCR Model: ${firstChunk.metadata.ocrModel}`);
      console.log(`Tokens Used: ${firstChunk.metadata.tokensUsed}`);
      console.log(`Karakter Sayısı: ${firstChunk.content.length}`);
      
    } else {
      console.log('⚠️ Hiç chunk oluşturulamadı');
    }
    
    await ragSystem.shutdown();
    console.log('\n🎉 Tüm metinler testi tamamlandı!');
    
  } catch (error) {
    console.error('❌ Test hatası:', error);
    process.exit(1);
  }
}

testCompleteText();
