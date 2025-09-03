#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR debug testi
"""

import requests
import base64
from PIL import Image
import io

def test_ocr_debug():
    # Basit bir test görüntüsü oluştur
    img = Image.new('RGB', (100, 100), color='white')
    
    # Base64'e çevir
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    img_str = base64.b64encode(buffer.getvalue()).decode()
    
    # API'ye istek gönder
    url = "http://localhost:8000/ocr"
    data = {
        "image": img_str,
        "prompt": "Extract all text from this image."
    }
    
    try:
        print("OCR API'ye istek gönderiliyor...")
        response = requests.post(url, json=data, timeout=60)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
    except Exception as e:
        print(f"Hata: {e}")

if __name__ == "__main__":
    test_ocr_debug()
