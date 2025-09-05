#!/usr/bin/env python3
"""
Genel rotation script for OCR preprocessing
"""

import sys
import cv2
import numpy as np
import os

def rotate_image(image_path, output_path, degrees):
    """Görüntüyü belirtilen derecede döndürür"""
    try:
        # Windows yollarını düzelt
        image_path = image_path.replace('\\', '/')
        output_path = output_path.replace('\\', '/')

        print(f"İşleniyor: {image_path} -> {output_path} ({degrees}°)")

        # Görüntüyü oku
        image = cv2.imread(image_path)
        if image is None:
            print(f"Hata: Görüntü okunamadı: {image_path}")
            return False

        # Dereceyi normalize et
        degrees = int(degrees)

        # Rotation uygula
        if degrees == 90:
            rotated = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
            print("90° saat yönü rotation uygulandı")
        elif degrees == -90 or degrees == 270:
            rotated = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
            print("-90° saat tersi rotation uygulandı")
        elif degrees == 180:
            rotated = cv2.rotate(image, cv2.ROTATE_180)
            print("180° rotation uygulandı")
        else:
            # Genel rotation için (45°, 135°, vb.)
            height, width = image.shape[:2]
            center = (width // 2, height // 2)

            # Rotation matrix oluştur
            rotation_matrix = cv2.getRotationMatrix2D(center, degrees, 1.0)

            # Yeni boyutları hesapla
            cos = np.abs(rotation_matrix[0, 0])
            sin = np.abs(rotation_matrix[0, 1])

            new_width = int((height * sin) + (width * cos))
            new_height = int((height * cos) + (width * sin))

            rotation_matrix[0, 2] += (new_width / 2) - center[0]
            rotation_matrix[1, 2] += (new_height / 2) - center[1]

            rotated = cv2.warpAffine(image, rotation_matrix, (new_width, new_height))
            print(f"{degrees}° özel rotation uygulandı")

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
    if len(sys.argv) != 4:
        print("Kullanım: python rotate_image.py <input_image> <output_image> <degrees>")
        print("Örnek: python rotate_image.py image.png rotated.png 90")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    degrees = sys.argv[3]

    if not os.path.exists(input_path):
        print(f"Hata: Girdi dosyası bulunamadı: {input_path}")
        sys.exit(1)

    try:
        degrees_int = int(degrees)
    except ValueError:
        print(f"Hata: Geçersiz derece değeri: {degrees}")
        sys.exit(1)

    success = rotate_image(input_path, output_path, degrees_int)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
