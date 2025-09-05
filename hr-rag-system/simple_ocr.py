#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Basit OCR - Qwen Modeli ile Görüntüden Metin Çıkarma
Kullanım: python simple_ocr.py <görüntü_dosyası>
"""

import os
import sys
import io
import base64
import logging
from PIL import Image
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
from qwen_vl_utils import process_vision_info
import torch

# Logging ayarları
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def load_model():
    """Qwen modelini yükle"""
    global model, processor, device

    try:
        # GPU kontrolü
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"Kullanılacak cihaz: {device}")

        # Model ID
        model_id = "Qwen/Qwen2.5-VL-3B-Instruct"

        # Processor yükle
        processor = AutoProcessor.from_pretrained(
            model_id,
            trust_remote_code=True,
            min_pixels=640 * 28 * 28,
            max_pixels=1024 * 28 * 28,
        )

        # Model yükle
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device_map="auto" if torch.cuda.is_available() else "cpu",
            trust_remote_code=True,
            low_cpu_mem_usage=True,
        )

        model.eval()
        logger.info("✅ Model başarıyla yüklendi!")
        return True

    except Exception as e:
        logger.error(f"❌ Model yükleme hatası: {e}")
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

def extract_text_from_image(image):
    """Görüntüden metin çıkar - basit yaklaşım"""
    try:
        # Base64'e çevir
        image_base64 = image_to_base64(image)
        if not image_base64:
            return None

        # Prompt - basit ve doğrudan
        prompt = "Bu görüntüdeki TÜM metni çıkar. Türkçe karakterleri koru (ğ, ü, ş, ı, ö, ç). Metni tam olarak, hiçbir kısaltma yapmadan çıkar."

        # Mesajları hazırla
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image", "image": image},
                ],
            }
        ]

        # Model ile çıkarım
        logger.info("🔍 OCR işlemi başlatılıyor...")

        # Chat template uygula
        prompt_text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )

        # Görsel girişleri işle
        image_inputs, video_inputs = process_vision_info(messages)

        # Tensorları hazırla
        inputs = processor(
            text=[prompt_text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)

        # Model çıkarımı
        with torch.no_grad():
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=1024,  # Yeterli uzunluk
                temperature=0.0,      # Deterministik
                do_sample=False,
                num_beams=1,          # Hızlı çıkarım
                eos_token_id=getattr(processor.tokenizer, 'eos_token_id', None),
                pad_token_id=getattr(processor.tokenizer, 'pad_token_id', None),
            )

        # Çıktıyı decode et
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]

        output_text = processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False
        )[0]

        logger.info("✅ OCR tamamlandı!")
        return output_text.strip()

    except Exception as e:
        logger.error(f"❌ OCR hatası: {e}")
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
    """Ana fonksiyon"""
    try:
        if len(sys.argv) < 2:
            print("Kullanım: python simple_ocr.py <görüntü_dosyası>")
            print("Örnek: python simple_ocr.py test.png")
            return

        image_name = sys.argv[1]
        image_path = os.path.join("temp", image_name)

        if not os.path.exists(image_path):
            print(f"❌ Dosya bulunamadı: {image_path}")
            return

        print("🚀 Basit OCR başlatılıyor...")
        print(f"📁 Görüntü: {image_path}")

        # Model yükle
        if not load_model():
            print("❌ Model yüklenemedi!")
            return

        # Görüntüyü işle
        image = preprocess_image(image_path)
        if not image:
            print("❌ Görüntü yüklenemedi!")
            return

        # OCR çıkarım
        raw_text = extract_text_from_image(image)
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

    except KeyboardInterrupt:
        print("\n⏹️ İşlem kullanıcı tarafından durduruldu")
    except Exception as e:
        print(f"❌ Beklenmeyen hata: {e}")

if __name__ == "__main__":
    main()
