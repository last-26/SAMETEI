#!/usr/bin/env python3
"""
90° rotation script for OCR preprocessing
"""

import sys
import cv2
import numpy as np
import os

def rotate_image_90_clockwise(image_path, output_path):
    """Görüntüyü 90° saat yönünde döndürür"""
    try:
        # Görüntüyü oku
        image = cv2.imread(image_path)
        if image is None:
            print(f"Hata: Görüntü okunamadı: {image_path}")
            return False

        # 90° saat yönünde döndür
        rotated = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)

        # Kaydet
        success = cv2.imwrite(output_path, rotated)
        if success:
            print(f"Başarılı: {output_path}")
            return True
        else:
            print(f"Hata: Görüntü kaydedilemedi: {output_path}")
            return False

    except Exception as e:
        print(f"Hata: {str(e)}")
        return False

def main():
    if len(sys.argv) != 3:
        print("Kullanım: python rotate_90.py <input_image> <output_image>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(input_path):
        print(f"Hata: Girdi dosyası bulunamadı: {input_path}")
        sys.exit(1)

    success = rotate_image_90_clockwise(input_path, output_path)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()

