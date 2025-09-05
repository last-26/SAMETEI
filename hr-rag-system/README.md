# SAMETEI HR-RAG System

🤖 LibreChat entegrasyonu ile çalışan AI destekli HR Asistan sistemi

## 🎯 Özellikler

- **RAG (Retrieval-Augmented Generation)** ile bağlamlı cevaplar
- **MongoDB Vector Database** ile hızlı arama
- **OpenRouter API** entegrasyonu (DeepSeek-V3)
- **LibreChat** uyumlu API endpoint'leri
- **Türkçe dil desteği** ve HR prosedürlerine odaklı
- **Qwen2.5-VL-3B-Instruct** entegrasyonu ile gelişmiş görüntü işleme
- **Çoklu OCR fallback sistemi** (Qwen2.5-VL → OpenRouter Vision → Tesseract)

## 🚀 Hızlı Başlangıç

### 1. Bağımlılıkları Yükle

```bash
cd hr-rag-system
npm install
```

### 2. Konfigürasyonu Kontrol Et

`config.js` dosyasında:
- MongoDB connection string
- OpenRouter API key
- RAG parametreleri

### 3. HR Prosedürlerini Yükle (PDF/DOCX/TXT/CSV)

1) Belgeleri klasöre kopyala:
```bash
hr-rag-system/data/procedures/
  ├── izin_yonetimi.pdf
  ├── yan_haklar.docx
  └── diger_talimatlar.txt
```

2) Ingest çalıştır:
```bash
npm run ingest
```

### 4. Sistemi Test Et

```bash
npm run test
```

### 5. Qwen2.5-VL Kurulumu

Qwen2.5-VL-3B-Instruct ile gelişmiş görüntü OCR için:

1. **Python Bağımlılıklarını Yükleyin**:
   ```bash
   pip install -r requirements.txt
   ```

2. **ENV/Config Ayarları**:
   `.env` (opsiyonel) veya ortam değişkenleri ile ayarlayın:
   ```bash
   # Model
   set QWEN_MODEL_ID=Qwen/Qwen2.5-VL-3B-Instruct
   set QWEN_LOCAL_FILES_ONLY=1

   # Görüntü çözünürlük sınırları
   set OCR_MIN_PIXELS=640*28*28
   set OCR_MAX_PIXELS=1024*28*28

   # Dikey yazı tespiti ve 90° döndürme
   # off|cv|vlm|hybrid  (önerilen: hybrid)
   set OCR_ROTATION_MODE=hybrid
   set OCR_ROTATE_MARGIN=0.12
   set OCR_PREPROCESS_ENABLED=1
   ```

3. **Qwen OCR Sunucusunu Başlatın**:
   ```bash
   python qwen_ocr_server.py
   # Sağlık: http://localhost:8000/health
   ```

4. **Qwen OCR'ı Test Edin**:
   ```bash
   # Dikey yazı örneği için test (otomatik 90° düzeltme)
   node test-qwen.js temp/a1.PNG auto --output=text
   node test-qwen.js temp/a2.PNG table_text_tsv
   ```

### 6. API Server'ı Başlat

```bash
npm start
```

## 📋 Available Scripts

- `npm start` - API server'ı başlat (port 3001)
- `npm run embed` - HR dökümanlarını embed et
- `npm run test` - RAG sistemini test et
- `npm run update` - Knowledge base'i güncelle

## 🔌 API Endpoints

### RAG Query
```bash
POST http://localhost:3001/query
{
  "question": "Yıllık izin hakkım nasıl hesaplanır?",
  "options": {
    "topK": 3
  }
}
```

### LibreChat Uyumlu
```bash
POST http://localhost:3001/chat/completions
{
  "model": "sametei-hr-assistant",
  "messages": [
    {"role": "user", "content": "Maaşım ne zaman yatırılır?"}
  ]
}
```

### Sistem İstatistikleri
```bash
GET http://localhost:3001/stats
```

## 🔧 LibreChat Entegrasyonu

### 1. Custom Endpoint Ekleme

`librechat.yaml` dosyasına:

```yaml
endpoints:
  custom:
    - name: "SAMETEI-HR"
      apiKey: "dummy-key"
      baseURL: "http://localhost:3001"
      models:
        default: ["sametei-hr-assistant"]
      modelDisplayLabel: "HR Asistanı"
```

### 2. Docker Compose Güncelleme

```yaml
services:
  hr-rag:
    build: ./hr-rag-system
    ports:
      - "3001:3001"
    environment:
      - MONGODB_URI=mongodb://chat-mongodb:27017/LibreChat
    depends_on:
      - chat-mongodb
```

## 📊 Sistem Mimarisi

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   LibreChat     │───▶│   RAG API        │───▶│   OpenRouter    │
│   Frontend      │    │   (Port 3001)    │    │   DeepSeek-V3   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │   MongoDB        │
                       │   Vector Store   │
                       └──────────────────┘
                                ▲
                                │
                    ┌───────────┴───────────┐
                    │                       │
          ┌─────────▼─────────┐   ┌─────────▼─────────┐
                              │   Qwen2.5-VL     │   │   OpenRouter      │
          │   (Local)        │   │   Vision OCR      │
          └───────────────────┘   └───────────────────┘
                    │                       │
                    └───────────┬───────────┘
                                ▼
                    ┌───────────┴───────────┐
                    │                       │
          ┌─────────▼─────────┐   ┌─────────▼─────────┐
          │   DOT-OCR        │   │   Tesseract      │
          │   (Backup)       │   │   (Fallback)     │
          └───────────────────┘   └───────────────────┘
```

## 📈 Performans

- **Ortalama yanıt süresi**: ~2-3 saniye
- **Embedding boyutu**: 1536 (OpenAI text-embedding-3-small)
- **Desteklenen döküman sayısı**: Sınırsız
- **Eş zamanlı sorgu**: ✅ Desteklenir

### OCR Performans Karşılaştırması

| OCR Yöntemi | Doğruluk | Hız | GPU | Durum |
|-------------|----------|-----|-----|--------|
| **Qwen2.5-VL-3B** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ✅ | **AKTİF - ANA SİSTEM** |
| OpenRouter Vision | ⭐⭐⭐⭐ | ⭐⭐ | ❌ | Fallback |
| DOT-OCR (GOT-OCR2) | ⭐⭐⭐⭐ | ⭐⭐⭐ | ✅ | Backup'da |
| Tesseract | ⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ | Fallback |

**📊 Qwen2.5-VL Avantajları:**
- Görsel anlayışı çok güçlü (tablolar, grafikler, formlar)
- Türkçe karakterleri mükemmel tanır
- Çoklu çıktı formatı (text, markdown, JSON)
- Auto-döküman sınıflandırma
- **Şu anda aktif sistem**

## 🛠️ Geliştirme

### Yeni HR Prosedürü Ekleme

1. Yeni PDF/DOCX/TXT dosyanı `hr-rag-system/data/procedures` klasörüne koy
2. `npm run ingest` çalıştır
3. Test et: `npm run test`

### Custom Model Ekleme

`config.js` dosyasında:
```javascript
openrouter: {
  chatModel: 'anthropic/claude-3-haiku', // Farklı model
  embeddingModel: 'text-embedding-3-large' // Daha büyük embedding
}
```

## 📝 Veri Formatı

### HR Prosedürü CSV Formatı (opsiyonel)
```csv
soru,kategori,cevap,anahtar_kelimeler
"İzin nasıl alınır?","İzin Yönetimi","15 gün önceden...","izin,başvuru"
```

### MongoDB Document Formatı
```javascript
{
  content: "Belge chunk içeriği...",
  embedding: [0.1, 0.2, ...], // 1536 boyutlu
  metadata: {
    source: "izin_yonetimi.pdf",
    category: "izin-yönetimi",
    keywords: "izin,başvuru",
    chunkIndex: 0,
    createdAt: ISODate()
  }
}
```

## ⚡ Troubleshooting

### MongoDB Bağlantı Hatası
```bash
# MongoDB servisini kontrol et
docker ps | grep mongo

# Connection string'i kontrol et
mongo mongodb://127.0.0.1:27017/LibreChat
```

### OpenRouter API Hatası
```bash
# API key'i test et
curl -H "Authorization: Bearer YOUR_KEY" \
  https://openrouter.ai/api/v1/models
```

### Embedding İşlemi Yavaş
- Batch size'ı azalt (config.js)
- Rate limiting süresini artır
- Daha küçük embedding modeli kullan

### Qwen2.5-VL Çalışmıyor
```bash
# Model yolunu kontrol et (ENV ile)
python - <<PY
import os; print('MODEL_ID=', os.getenv('QWEN_MODEL_ID')); print('MODEL_PATH=', os.getenv('QWEN_MODEL_PATH'))
PY

# Python sunucusunu kontrol et
python qwen_ocr_server.py

# JavaScript testi çalıştır
node test-qwen.js temp/1.png table_text_tsv

# GPU/CUDA kontrolü
python -c "import torch; print('CUDA:', torch.cuda.is_available())"
```

### Qwen2.5-VL Hız Sorunu
- GPU belleği yetersizse CPU kullan
- Görüntü boyutunu azalt (config.js)
- min_pixels/max_pixels ayarlarını düşür

## 🔒 Güvenlik

- API key'ler environment variable'larda
- MongoDB access control
- Rate limiting aktif
- Input sanitization

## 📞 Destek

- **Geliştirici**: SAMETEI Teknik Ekip
- **E-posta**: dev@sametei.com
- **Versiyon**: 1.1.0 (DOT-OCR Entegre)
- **DOT-OCR Model**: GOT-OCR2

---

💡 **İpucu**: Sistem artık Qwen2.5-VL-3B-Instruct öncelikli çalışıyor. DOT-OCR backup'da saklanıyor!

## 🔄 Qwen2.5-VL Kullanım Örnekleri

### Basit Kullanım
```javascript
const LocalQwenVL = require('./utils/localQwenVL');
const qwenVL = new LocalQwenVL();

const result = await qwenVL.extractFromImage('path/to/image.png', 'table_text_tsv');
console.log(result.text);
```

### Farklı Çıkarım Türleri
```javascript
// Tablo çıkarımı (TSV formatında)
const tableResult = await qwenVL.extractFromImage(imagePath, 'table_text_tsv');

// Form çıkarımı
const formResult = await qwenVL.extractFromImage(imagePath, 'form');

// Özel prompt ile
const customResult = await qwenVL.extractFromImage(imagePath, 'table_text_tsv', {
  customPrompt: 'Bu tabloyu sadece değerler olarak çıkar...'
});
```
