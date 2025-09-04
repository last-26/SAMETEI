#!/usr/bin/env python3
"""
DOT-OCR Service (GOT-OCR2) - Python servis modülü
Gelişmiş görüntü OCR işleme için tasarlandı
"""

import os
import sys
import json
import torch
import tempfile
from PIL import Image
from transformers import AutoModel, AutoTokenizer
import argparse
import logging
import time

# Logging konfigürasyonu
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class DotOCRService:
    def __init__(self, model_path=None):
        """
        DOT-OCR Service başlatıcı

        Args:
            model_path (str): GOT-OCR2 model dizini yolu
        """
        self.model_path = model_path or r"C:\Users\samet\Downloads\GOT-OCR2_0"
        self.model = None
        self.tokenizer = None
        self.is_initialized = False
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'

        logger.info(f"DOT-OCR Service başlatılıyor. Cihaz: {self.device}")

    def initialize_model(self):
        """GOT-OCR2 modelini yükle ve başlat"""
        try:
            if not os.path.isdir(self.model_path):
                raise FileNotFoundError(f"Model dizini bulunamadı: {self.model_path}")

            logger.info("Model yükleniyor...")

            # Tokenizer yükleme
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_path,
                local_files_only=True,
                trust_remote_code=True
            )

            # Model yükleme
            self.model = AutoModel.from_pretrained(
                self.model_path,
                local_files_only=True,
                trust_remote_code=True,
                torch_dtype=torch.float16 if self.device == 'cuda' else torch.float32,
                device_map=self.device
            ).eval()

            # Generation config ayarları - Timeout kaldırıldı
            if hasattr(self.model, 'generation_config') and self.model.generation_config is not None:
                self.model.generation_config.use_cache = False
                # self.model.generation_config.max_new_tokens = 1024  # Kaldırıldı - sınırsız
                self.model.generation_config.temperature = 0.0
                self.model.generation_config.do_sample = False
                self.model.generation_config.repetition_penalty = 1.0
                # GOT-OCR2 için özel ayarlar
                if hasattr(self.model.generation_config, 'pad_token_id'):
                    pass  # Zaten ayarlandı
                if hasattr(self.model.generation_config, 'eos_token_id'):
                    pass  # Zaten ayarlandı

                # Pad/EOS token ayarları
                eos_id = self.tokenizer.eos_token_id or self.tokenizer.convert_tokens_to_ids('</s>')
                if self.tokenizer.pad_token_id is None and eos_id is not None:
                    self.tokenizer.pad_token = self.tokenizer.eos_token or '</s>'

                pad_id = self.tokenizer.pad_token_id or eos_id
                if pad_id is not None:
                    self.model.generation_config.pad_token_id = pad_id
                    self.model.generation_config.eos_token_id = eos_id

            # Config ayarları
            if hasattr(self.model, 'config') and self.model.config is not None:
                self.model.config.use_cache = False
                if pad_id is not None:
                    self.model.config.pad_token_id = pad_id
                    self.model.config.eos_token_id = eos_id

            self.is_initialized = True
            logger.info("✅ Model başarıyla yüklendi!")
            logger.info(f"📍 Cihaz: {self.device}")
            if self.device == 'cuda':
                logger.info(f"🎮 GPU: {torch.cuda.get_device_name(0)}")

            return True

        except Exception as e:
            logger.error(f"❌ Model yükleme hatası: {e}")
            return False

    def _resize_image(self, image_path, long_edge_max=1600):
        """Görüntüyü hız optimizasyonu için yeniden boyutlandır"""
        try:
            img = Image.open(image_path).convert('RGB')
            w, h = img.size
            long_edge = max(w, h)

            if long_edge <= long_edge_max:
                return image_path

            scale = long_edge_max / float(long_edge)
            new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
            img = img.resize((new_w, new_h))

            # Geçici dosya oluştur
            temp_dir = os.path.join(os.path.dirname(image_path), "_runtime")
            os.makedirs(temp_dir, exist_ok=True)
            temp_path = os.path.join(temp_dir, f"resized_{int(time.time())}.png")
            img.save(temp_path, format='PNG')

            return temp_path

        except Exception as e:
            logger.warning(f"Görüntü yeniden boyutlandırma hatası: {e}")
            return image_path

    def _get_extraction_prompt(self, extraction_type='table_text_tsv'):
        """Basitleştirilmiş prompt - doğal metin çıkarımı"""
        base_prompt = (
            "Bu görüntüdeki TÜM metinleri oku ve çıkar. "
            "Tablolar, formlar, dikey yazılmış metinler varsa hepsini oku ama kelimeleri ASLA harflere bölme. "
            "Dikey sütunlar varsa sütun-sütun oku fakat kelimeleri bölmeden ve satır sonlarında kelimeleri parçalama. "
            "Renkli arka planlı metinleri de ihmal etme. "
            "Gri veya farklı tonlardaki metinleri de oku. "
            "Metni doğal, okunabilir ve kelime sınırları korunmuş şekilde çıkar. "
            "Hiçbir metni atlama."
        )

        if extraction_type == 'table_text_tsv':
            return base_prompt + " Tablo yapısını mantıklı şekilde koru."
        elif extraction_type == 'form':
            return base_prompt + " Form alanlarını ve değerlerini açık şekilde belirt."
        elif extraction_type == 'text_only':
            return base_prompt + (
                " Her metin BLOĞUNU ayrı satırda döndür. "
                "Bir blok içindeki kelimeleri birleştir ama farklı bölgeler birbirine yapışmasın."
            )
        else:
            return base_prompt

    def extract_text(self, image_path, extraction_type='table_text_tsv', custom_prompt=None):
        """
        Görüntüden metin çıkar

        Args:
            image_path (str): Görüntü dosya yolu
            extraction_type (str): Çıkarım türü
            custom_prompt (str): Özel prompt (varsa)

        Returns:
            dict: Çıkarım sonucu
        """
        try:
            if not self.is_initialized:
                if not self.initialize_model():
                    return {
                        'success': False,
                        'error': 'Model başlatılamadı',
                        'text': ''
                    }

            # Görüntü kontrolü
            if not os.path.exists(image_path):
                return {
                    'success': False,
                    'error': f'Görüntü bulunamadı: {image_path}',
                    'text': ''
                }

            logger.info(f"📷 Görüntü yükleniyor: {os.path.basename(image_path)}")

            # Görüntü yükleme kontrolü
            _ = Image.open(image_path)

            # Hız optimizasyonları
            if torch.cuda.is_available():
                torch.set_float32_matmul_precision('high')
                try:
                    torch.backends.cuda.matmul.allow_tf32 = True
                except:
                    pass

            # Görüntüyü yeniden boyutlandır
            resized_path = self._resize_image(image_path, long_edge_max=1600)

            # Prompt oluştur
            prompt = custom_prompt or self._get_extraction_prompt(extraction_type)

            logger.info(f"🔍 OCR işlemi başlatılıyor ({extraction_type})...")

            start_time = time.time()

            with torch.inference_mode():
                try:
                    # GOT-OCR2 için basit metin çıkarımı
                    result = self.model.chat(
                        self.tokenizer,
                        resized_path,
                        question=prompt
                    )
                except TypeError:
                    try:
                        result = self.model.chat(
                            self.tokenizer,
                            resized_path,
                            question=prompt
                        )
                    except TypeError:
                        # Son çare: prompt'suz
                        result = self.model.chat(
                            self.tokenizer,
                            resized_path,
                            ocr_type='ocr'
                        )

            processing_time = time.time() - start_time

            # Geçici dosyayı temizle
            if resized_path != image_path and os.path.exists(resized_path):
                try:
                    os.unlink(resized_path)
                    # _runtime klasörünü de temizle
                    runtime_dir = os.path.dirname(resized_path)
                    if os.path.exists(runtime_dir) and not os.listdir(runtime_dir):
                        os.rmdir(runtime_dir)
                except:
                    pass

            logger.info(f"✅ OCR tamamlandı: {len(result)} karakter, {processing_time:.2f}s")

            return {
                'success': True,
                'text': result,
                'extraction_type': extraction_type,
                'processing_time': processing_time,
                'model': 'GOT-OCR2',
                'device': self.device
            }

        except Exception as e:
            logger.error(f"❌ OCR hatası: {e}")
            return {
                'success': False,
                'error': str(e),
                'text': '',
                'extraction_type': extraction_type
            }

def main():
    """Komut satırı arayüzü"""
    parser = argparse.ArgumentParser(description='DOT-OCR Service')
    parser.add_argument('image_path', help='İşlenecek görüntü dosyası')
    parser.add_argument('--type', default='table_text_tsv',
                       choices=['table_text_tsv', 'form', 'text_only', 'structured'],
                       help='Çıkarım türü')
    parser.add_argument('--model-path', help='GOT-OCR2 model dizini yolu')
    parser.add_argument('--custom-prompt', help='Özel prompt')
    parser.add_argument('--output', '-o', help='Çıktı dosyası (JSON)')

    args = parser.parse_args()

    # Servis başlat
    service = DotOCRService(args.model_path)

    # OCR işle
    result = service.extract_text(
        args.image_path,
        args.type,
        args.custom_prompt
    )

    # Sonuç
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"Sonuç {args.output} dosyasına kaydedildi")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
