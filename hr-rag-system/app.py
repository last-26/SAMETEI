#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR İstemci Uygulaması - API üzerinden Qwen Modeli ile Görüntüden Metin Çıkarma
Kullanım: python app.py <görüntü_dosyası>
API: http://localhost:8000
"""

import os
import sys
import io
import base64
import logging
import requests
from PIL import Image

# Logging ayarları
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# API ayarları
API_BASE_URL = "http://localhost:8000"
API_TIMEOUT = 300  # 5 dakika timeout

def check_api_health():
    """API sağlık kontrolü"""
    try:
        response = requests.get(f"{API_BASE_URL}/health", timeout=10)
        if response.status_code == 200:
            data = response.json()
            if data.get("model_loaded"):
                logger.info("✅ API servisi çalışıyor ve model yüklü")
                return True
            else:
                logger.warning("⚠️ API servisi çalışıyor ama model yüklenmemiş")
                return False
        else:
            logger.error(f"❌ API sağlık kontrolü başarısız: {response.status_code}")
            return False
    except Exception as e:
        logger.error(f"❌ API bağlantı hatası: {e}")
        return False

def preprocess_image(image_path):
    """Görüntüyü basit ön işleme"""
    try:
        # Görüntüyü aç
        image = Image.open(image_path)

        # EXIF yönünü düzelt
        try:
            from PIL import ImageOps
            image = ImageOps.exif_transpose(image)
        except:
            pass

        logger.info(f"📷 Görüntü yüklendi: {image.size}")
        return image

    except Exception as e:
        logger.error(f"❌ Görüntü yükleme hatası: {e}")
        return None

def image_to_base64(image):
    """Görüntüyü base64'e çevir"""
    try:
        # RGB'ye çevir
        if image.mode != 'RGB':
            image = image.convert('RGB')

        # Buffer'a kaydet
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG')
        buffer.seek(0)

        # Base64'e çevir
        image_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
        return image_base64

    except Exception as e:
        logger.error(f"❌ Base64 çevirme hatası: {e}")
        return None

def extract_text_from_image_api(image):
    """API üzerinden görüntüden metin çıkar"""
    try:
        # Base64'e çevir
        image_base64 = image_to_base64(image)
        if not image_base64:
            return None

        # Prompt
        prompt = "Bu görüntüdeki TÜM metni çıkar. Türkçe karakterleri koru (ğ, ü, ş, ı, İ, ö, ç). Metni tam olarak, hiçbir kısaltma yapmadan çıkar."

        # API isteği hazırla
        payload = {
            "image": image_base64,
            "prompt": prompt,
            "max_tokens": 1024
        }

        logger.info("🔍 API üzerinden OCR işlemi başlatılıyor...")

        # API çağrısı
        response = requests.post(
            f"{API_BASE_URL}/ocr",
            json=payload,
            timeout=API_TIMEOUT
        )

        if response.status_code == 200:
            result = response.json()
            if result.get("success"):
                processing_time = result.get("processing_time", 0)
                logger.info(".2f"
                return result.get("text", "").strip()
            else:
                logger.error(f"❌ API OCR hatası: {result.get('error', 'Bilinmeyen hata')}")
                return None
        else:
            logger.error(f"❌ API yanıt hatası: {response.status_code} - {response.text}")
            return None

    except requests.exceptions.Timeout:
        logger.error("❌ API timeout hatası")
        return None
    except Exception as e:
        logger.error(f"❌ API çağrı hatası: {e}")
        return None

def clean_output_text(text):
    """Çıktı metnini basit temizleme"""
    if not text:
        return ""

    import re

    # Gereksiz başlangıç metinlerini temizle
    text = re.sub(r"^Here is the extracted.*?:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^Extracted text:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^The extracted.*?:\s*", "", text, flags=re.IGNORECASE)

    # Code block'lardan çıkar
    fence = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")
    match = fence.search(text)
    if match:
        text = match.group(1).strip()

    # Fazla boşlukları temizle
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()

def main():
    """Ana fonksiyon - API üzerinden çalışır"""
    try:
        if len(sys.argv) < 2:
            print("Kullanım: python app.py <görüntü_dosyası>")
            print("Örnek: python app.py test.png")
            print("\nNot: API servisinin çalışıyor olması gerekir")
            print("API başlatmak için: python api.py")
            return

        image_name = sys.argv[1]
        image_path = os.path.join("temp", image_name)

        if not os.path.exists(image_path):
            print(f"❌ Dosya bulunamadı: {image_path}")
            return

        print("🚀 OCR İstemci başlatılıyor...")
        print(f"📁 Görüntü: {image_path}")
        print(f"🔗 API URL: {API_BASE_URL}")

        # API sağlık kontrolü
        print("🔍 API bağlantısı kontrol ediliyor...")
        if not check_api_health():
            print("❌ API servisi çalışmıyor veya model yüklenmemiş!")
            print("API'yi başlatmak için: python api.py")
            return

        # Görüntüyü işle
        image = preprocess_image(image_path)
        if not image:
            print("❌ Görüntü yüklenemedi!")
            return

        # API üzerinden OCR çıkarım
        raw_text = extract_text_from_image_api(image)
        if not raw_text:
            print("❌ OCR başarısız!")
            return

        # Temizle
        clean_text = clean_output_text(raw_text)

        # Sonucu göster
        print("\n" + "="*50)
        print("📝 ÇIKARILAN METİN:")
        print("="*50)
        print(clean_text)
        print("="*50)
        print(f"📊 Karakter sayısı: {len(clean_text)}")

        # Dosyaya kaydet
        output_file = os.path.splitext(image_path)[0] + "_ocr.txt"
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(clean_text)

        print(f"💾 Sonuç kaydedildi: {output_file}")
        print("✅ OCR işlemi başarıyla tamamlandı!")

    except KeyboardInterrupt:
        print("\n⏹️ İşlem kullanıcı tarafından durduruldu")
    except Exception as e:
        print(f"❌ Beklenmeyen hata: {e}")
        print("💡 İpucu: API servisinin çalıştığından emin olun (python api.py)")

if __name__ == "__main__":
    main()
