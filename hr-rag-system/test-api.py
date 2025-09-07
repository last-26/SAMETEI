#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API Test Script - Qwen OCR API'yi test eder
"""

import requests
import base64
import time
from PIL import Image
import io

API_URL = "http://localhost:8000"

def image_to_base64(image_path):
    """Görüntüyü base64'e çevir"""
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def test_health():
    """API sağlık kontrolü"""
    print("🔍 API sağlık kontrolü yapılıyor...")
    try:
        response = requests.get(f"{API_URL}/health", timeout=10)
        if response.status_code == 200:
            data = response.json()
            print("✅ API durumu:", data)
            return data.get("model_loaded", False)
        else:
            print(f"❌ API yanıt vermiyor: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Bağlantı hatası: {e}")
        return False

def test_ocr(image_path):
    """OCR testi"""
    print(f"🖼️ OCR testi: {image_path}")

    try:
        # Görüntüyü base64'e çevir
        image_base64 = image_to_base64(image_path)

        # API isteği
        payload = {
            "image": image_base64,
            "prompt": "Bu görüntüdeki metni çıkar. Türkçe karakterleri koru.",
            "max_tokens": 512
        }

        start_time = time.time()
        response = requests.post(f"{API_URL}/ocr", json=payload, timeout=120)
        end_time = time.time()

        if response.status_code == 200:
            result = response.json()
            if result.get("success"):
                processing_time = result.get("processing_time", 0)
                text = result.get("text", "")

                print(".2f"                print("📝 Çıkarılan metin (ilk 200 karakter):")
                print("-" * 50)
                print(text[:200] + ("..." if len(text) > 200 else ""))
                print("-" * 50)

                return True
            else:
                print(f"❌ OCR başarısız: {result.get('error')}")
                return False
        else:
            print(f"❌ HTTP hatası: {response.status_code}")
            return False

    except Exception as e:
        print(f"❌ Test hatası: {e}")
        return False

def main():
    """Ana test fonksiyonu"""
    print("🚀 Qwen OCR API Test Başlatılıyor")
    print("=" * 50)

    # 1. Sağlık kontrolü
    if not test_health():
        print("❌ API hazır değil, test yapılamıyor")
        return

    print("\n" + "=" * 50)

    # 2. OCR testleri
    test_images = [
        "temp/1.png",
        "temp/2.PNG",
        "temp/3.PNG"
    ]

    successful_tests = 0

    for image_path in test_images:
        try:
            if test_ocr(image_path):
                successful_tests += 1
            print()
        except FileNotFoundError:
            print(f"⚠️ Dosya bulunamadı: {image_path}")
            print()

    print("=" * 50)
    print(f"📊 Test Sonuçları: {successful_tests}/{len(test_images)} başarılı")

    if successful_tests > 0:
        print("✅ API sistemi çalışıyor!")
    else:
        print("❌ API sistemi sorunlu")

if __name__ == "__main__":
    main()
