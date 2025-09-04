#!/usr/bin/env python3
"""
Kontrast Geliştirme Scripti
DOT-OCR için görüntü kontrastını optimize eder
"""

import sys
import cv2
import numpy as np
from PIL import Image, ImageEnhance
import os

def enhance_contrast(input_path, output_path):
    try:
        # Görüntüyü yükle
        image = cv2.imread(input_path)
        if image is None:
            print(f"Hata: Görüntü yüklenemedi: {input_path}")
            return False

        # Basit grayscale dönüşümü (çok daha yumuşak)
        if len(image.shape) == 3:
            # Renkli görüntü ise basit grayscale yap
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image

        # Hafif kontrast artırma (CLAHE) – yerel kontrastı güçlendirir
        try:
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            gray = clahe.apply(gray)
        except Exception:
            # CLAHE yoksa normalize ile devam
            gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)

        # Unsharp mask (çok hafif keskinleştirme)
        blurred = cv2.GaussianBlur(gray, (0, 0), 1.0)
        sharp = cv2.addWeighted(gray, 1.5, blurred, -0.5, 0)

        # İnce çizgileri birleştirmek için küçük closing (aşırıya kaçmadan)
        kernel = np.ones((2, 2), np.uint8)
        sharp = cv2.morphologyEx(sharp, cv2.MORPH_CLOSE, kernel, iterations=1)

        # Binary threshold yerine adaptive threshold (daha yumuşak)
        # Bu adım tamamen kaldırıldı - sadece grayscale kalacak

        # Sonucu kaydet
        cv2.imwrite(output_path, sharp)
        print(f"Basit grayscale uygulandı: {output_path}")
        return True

    except Exception as e:
        print(f"Basitleştirilmiş kontrast hatası: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Kullanım: python enhance_contrast.py <input_path> <output_path>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(input_path):
        print(f"Girdi dosyası bulunamadı: {input_path}")
        sys.exit(1)

    success = enhance_contrast(input_path, output_path)
    sys.exit(0 if success else 1)
