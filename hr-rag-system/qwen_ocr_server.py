#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qwen2.5-VL-3B-Instruct OCR Server
Sadece görüntüden metin çıkarma için optimize edilmiş
"""

import os
import io
import base64
import logging
from typing import Optional
from PIL import Image
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
from transformers.generation.stopping_criteria import StoppingCriteriaList
from qwen_vl_utils import process_vision_info
import uvicorn

# Logging ayarları
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(title="Qwen2.5-VL OCR API")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request/Response modelleri
class OCRRequest(BaseModel):
    image: str  # Base64 encoded image
    prompt: str = "Extract all text from this image accurately. Pay special attention to Turkish characters (ğ, ü, ş, ı, ö, ç). Return only the extracted text."

class OCRResponse(BaseModel):
    success: bool
    text: Optional[str] = None
    error: Optional[str] = None

# Global değişkenler
model = None
processor = None
device = None

def load_model():
    """Modeli yükle"""
    global model, processor, device
    
    # Model yolu
    model_path = r"C:\Users\samet\.cache\huggingface\hub\models--Qwen--Qwen2.5-VL-3B-Instruct\snapshots\66285546d2b821cf421d4f5eb2576359d3770cd3"
    
    try:
        logger.info(f"Model yükleniyor: {model_path}")
        
        # CUDA varsa kullan, yoksa CPU
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"Cihaz: {device}")
        
        # Processor'ı yükle
        # Daha düşük çözünürlükle çalışarak hız/Vram iyileştirmesi (ENV ile ayarlanabilir)
        min_pixels = int(os.getenv("OCR_MIN_PIXELS", 640 * 28 * 28))
        max_pixels = int(os.getenv("OCR_MAX_PIXELS", 1024 * 28 * 28))
        processor = AutoProcessor.from_pretrained(
            model_path,
            local_files_only=True,
            trust_remote_code=True,
            min_pixels=min_pixels,
            max_pixels=max_pixels,
        )
        
        # Modeli yükle
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_path,
            local_files_only=True,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device_map="auto" if torch.cuda.is_available() else "cpu",
            trust_remote_code=True,
            low_cpu_mem_usage=True
        )
        
        # Hız optimizasyonları
        try:
            torch.set_float32_matmul_precision('high')
        except Exception:
            pass
        if torch.cuda.is_available():
            try:
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.benchmark = True
            except Exception:
                pass

        # Modeli değerlendirme moduna al
        model.eval()
        
        logger.info("Model başarıyla yüklendi!")
        return True
        
    except Exception as e:
        logger.error(f"Model yükleme hatası: {e}")
        return False

@app.on_event("startup")
async def startup_event():
    """Uygulama başlatıldığında modeli yükle"""
    if not load_model():
        logger.error("Model yüklenemedi! Sunucu çalışmaya devam edecek ama tahmin yapamayacak.")

@app.get("/")
async def root():
    """API durumu"""
    return {
        "status": "running",
        "model_loaded": model is not None,
        "device": str(device) if device else "not loaded"
    }

@app.post("/ocr", response_model=OCRResponse)
async def extract_text_from_image(request: OCRRequest):
    """Görüntüden metin çıkarma (OCR)"""
    
    if model is None:
        return OCRResponse(
            success=False,
            error="Model henüz yüklenmedi"
        )
    
    try:
        logger.info("OCR isteği başlatılıyor...")
        
        # Base64'ten görüntüyü decode et
        image_data = base64.b64decode(request.image)
        image = Image.open(io.BytesIO(image_data))
        logger.info(f"Görüntü yüklendi: {image.size}")
        
        # Qwen2.5-VL için önerilen akış: messages + apply_chat_template + process_vision_info
        # Görsel + talimat: metne ağırlık verilerek tabloyu doğal dile dönüştürme
        # İstemciden gelen prompt'u doğrudan kullanıyoruz (rag_policy_* gibi)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": request.prompt},
                    {"type": "image", "image": image},
                ],
            }
        ]

        logger.info("Chat template uygulanıyor...")
        texts = [
            processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
        ]

        logger.info("Görüntü girdileri hazırlanıyor (process_vision_info)...")
        image_inputs, video_inputs = process_vision_info(messages)

        logger.info("Processor ile tensorlar hazırlanıyor...")
        inputs = processor(
            text=texts,
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)
        logger.info(f"Inputs hazırlandı: {list(inputs.keys())}")
        
        # Qwen2.5-VL için generate metodu kullan
        with torch.no_grad():
            logger.info("Model generate başlatılıyor...")
            # Generate metodu ile text üret
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=512,  # Büyük tablolar için biraz daha geniş çıktı
                temperature=0.0,
                do_sample=False,
                use_cache=True,
                eos_token_id=getattr(processor.tokenizer, 'eos_token_id', None),
                pad_token_id=getattr(processor.tokenizer, 'pad_token_id', None),
            )
            logger.info(f"Generated IDs: {generated_ids is not None}, Shape: {generated_ids.shape if generated_ids is not None else 'None'}")
            
            # Decode output
            if generated_ids is not None and inputs.input_ids is not None:
                logger.info("Output decode ediliyor...")
                try:
                    generated_ids_trimmed = [
                        out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
                    ]
                    output_text = processor.batch_decode(
                        generated_ids_trimmed,
                        skip_special_tokens=True,
                        clean_up_tokenization_spaces=False
                    )[0]
                    logger.info(f"Decoded text: {output_text[:200]}...")
                except Exception as decode_error:
                    logger.error(f"Decode hatası: {decode_error}")
                    output_text = f"[Decode hatası: {decode_error}]"
            else:
                output_text = "[Model generate edemedi]"
                logger.error("Generated IDs veya input_ids None!")
        
        # Şimdilik basit bir response döndür
        if output_text.strip():
            return OCRResponse(
                success=True,
                text=output_text.strip()
            )
        else:
            return OCRResponse(
                success=True,
                text="[OCR işlemi tamamlandı - metin çıkarılamadı]"
            )
        
    except Exception as e:
        logger.error(f"OCR hatası: {e}")
        return OCRResponse(
            success=False,
            error=str(e)
        )

@app.get("/health")
async def health_check():
    """Sağlık kontrolü"""
    return {
        "status": "healthy" if model is not None else "model_not_loaded",
        "model_loaded": model is not None,
        "device": str(device) if device else None
    }

if __name__ == "__main__":
    # Sunucuyu başlat
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )
