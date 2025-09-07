# Qwen OCR API Sistemi

## 🚀 Kurulum ve Kullanım

### 1. Gerekli Paketleri Yükleyin
```bash
pip install -r requirements.txt
```

### 2. API Sunucusunu Başlatın
```bash
# Terminal 1: API Sunucusu
python api.py
```

### 3. OCR İstemci Uygulamasını Çalıştırın
```bash
# Terminal 2: İstemci Uygulaması
python app.py 1.png
```

## 📁 Dosya Yapısı

```
├── api.py              # Sürekli çalışan API servisi (model yüklü)
├── app.py              # İstemci uygulaması (API üzerinden çalışır)
├── temp/               # Test görüntüleri
├── requirements.txt    # Gerekli Python paketleri
└── README-API.md      # Bu dosya
```

## 🔧 Nasıl Çalışır?

### API Servisi (`api.py`)
- ✅ Sürekli çalışır
- ✅ Model bir kez yüklenir
- ✅ GPU memory optimize edilmiş
- ✅ RESTful API endpoints
- ✅ Port: 8000

### İstemci Uygulaması (`app.py`)
- ✅ API'ye bağlanır
- ✅ Görüntü işler
- ✅ OCR sonuçlarını alır
- ✅ Dosyaya kaydeder

## 📡 API Endpoints

### Sağlık Kontrolü
```bash
GET http://localhost:8000/health
```

### OCR İşlemi
```bash
POST http://localhost:8000/ocr
Content-Type: application/json

{
  "image": "base64_encoded_image",
  "prompt": "Görüntüdeki metni çıkar",
  "max_tokens": 1024
}
```

## 💡 Kullanım Örnekleri

### Temel Kullanım
```bash
# API sunucusunu başlat
python api.py

# Başka terminalde istemciyi çalıştır
python app.py 1.png
```

### Farklı Görüntülerle Test
```bash
python app.py test.png
python app.py document.jpg
python app.py form.jpeg
```

## ⚡ Avantajlar

### Önceki Sistem (app.py direkt model yüklerdi):
- ❌ Her çalıştırmada model yüklenir (2-3 dakika)
- ❌ GPU memory her seferinde yeniden ayrılır
- ❌ Yavaş başlangıç

### Yeni Sistem (API + İstemci):
- ✅ Model bir kez yüklenir, sürekli çalışır
- ✅ Hızlı OCR işlemleri
- ✅ GPU memory optimize kullanımı
- ✅ Çoklu istemci desteği
- ✅ Paralel işlemler

## 🔍 Sorun Giderme

### API Çalışmıyor
```bash
# Sağlık kontrolü
curl http://localhost:8000/health

# Manuel test
curl -X POST http://localhost:8000/ocr \
  -H "Content-Type: application/json" \
  -d '{"image": "test", "prompt": "test"}'
```

### GPU Memory Hatası
- `api.py`'de GPU memory fraction'ı düşürün
- Sistem belleğini artırın
- Gereksiz process'leri kapatın

### Bağlantı Hatası
- API'nin çalıştığından emin olun
- Firewall ayarlarını kontrol edin
- Port çakışması olup olmadığını kontrol edin

## 📊 Performance Karşılaştırması

| Metrik | Eski Sistem | Yeni Sistem |
|--------|-------------|-------------|
| İlk Çalıştırma | 3-4 dakika | 3-4 dakika |
| Sonraki Çalıştırmalar | 3-4 dakika | 10-30 saniye |
| GPU Memory | Her seferinde | Sürekli optimize |
| Çoklu İşlemler | ❌ | ✅ |

## 🎯 Sonuç

Artık Qwen OCR sistemi çok daha verimli! Model bir kez yükleniyor ve sürekli hizmet veriyor. İstemciler API üzerinden hızlıca OCR işlemleri yapabiliyor.
