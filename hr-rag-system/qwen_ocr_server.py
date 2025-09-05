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
import json
import re
from PIL import Image
from PIL import ImageOps
import torch
import numpy as np
import cv2
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
    # Genel amaçlı strateji ve çıktı seçenekleri
    # strategy: text|table|form|key_value|auto
    strategy: str = "text"
    # output: text|markdown|json
    output: str = "text"
    # Opsiyonel tablo başlıkları veya KV anahtar listesi (auto/table/form için ipucu olarak)
    headers: Optional[list[str]] = None
    # Yerleşimi koru: satır sonlarını ve görsel sırayı mümkün olduğunca koru
    preserve_layout: bool = True
    # Tablo dışında kalan tüm metni de dahil et (table modunda notlar)
    include_notes: bool = False

class OCRResponse(BaseModel):
    success: bool
    text: Optional[str] = None
    error: Optional[str] = None

# Global değişkenler
model = None
processor = None
device = None
model_id_loaded = None

def strtobool(value: str, default: bool = False) -> bool:
    try:
        return str(value).strip().lower() in ("1", "true", "yes", "y", "on")
    except Exception:
        return default

def get_env_int(name: str, default_value: int) -> int:
    try:
        return int(os.getenv(name, str(default_value)))
    except Exception:
        return default_value

def get_env_bool(name: str, default_value: bool) -> bool:
    return strtobool(os.getenv(name, "1" if default_value else "0"), default=default_value)

def run_model_with_messages(messages, max_new_tokens: int = 768):
    """Utility: run model.generate for given chat messages and decode text."""
    try:
        prompt_text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        image_inputs, video_inputs = process_vision_info(messages)
        inputs = processor(
            text=[prompt_text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)
        with torch.no_grad():
            out_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=0.0,
                do_sample=False,
                num_beams=1,
                early_stopping=True,
                eos_token_id=getattr(processor.tokenizer, 'eos_token_id', None),
                pad_token_id=getattr(processor.tokenizer, 'pad_token_id', None),
            )
        trimmed = [out[len(in_ids):] for in_ids, out in zip(inputs.input_ids, out_ids)]
        out_text = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        return out_text
    except Exception as e:
        logger.error(f"run_model_with_messages hatası: {e}")
        return ""

def remove_placeholders(text: str) -> str:
    t = text
    # [Blank space], [blank], [empty], [space] gibi uydurma yer tutucuları temizle
    t = re.sub(r"\[(?:blank\s*space|blank|empty|space)\]", "", t, flags=re.IGNORECASE)
    # Fazla boşlukları toparla
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()

def _normalize_label(s: str) -> str:
    # Checkbox/ikon ve noktalama temizliği
    s = s.replace('☑', ' ').replace('□', ' ').replace('✅', ' ')
    s = re.sub(r"[:.]+$", "", s.strip())
    s = re.sub(r"\s+", " ", s)
    return s.lower()

def _is_value_line(s: str) -> bool:
    t = s.strip()
    if not t:
        return True
    # Yalnız rakamlar, tarih yer tutucu veya çizgiler
    return bool(re.match(r"^[\s0-9\-_.\/]+$", t))

KNOWN_LABELS = {
    _normalize_label(x) for x in [
        'X Şirketi', 'İzin Talep Formu',
        'Form No', 'Personel No', 'Ad Soyadı', 'Departman',
        'İzin Başlangıç Tarihi', 'İzin Bitiş Tarihi', 'İzin Türü',
        'Yıllık İzin', 'Mazeret İzni', 'Sağlık İzni', 'Diğer',
        'Okuma Test Tablosu', 'İmza (Personel)', 'İmza (Yönetici)', 'Tarih'
    ]
}

def deduplicate_notes_lines(notes_text: str) -> str:
    if not notes_text:
        return notes_text
    seen = set()
    out_lines = []
    skip_next_value = False
    for raw in notes_text.splitlines():
        line = raw.rstrip()
        base = _normalize_label(line)
        is_label_like = base in KNOWN_LABELS or base.startswith('yıllık') or base.startswith('mazeret') \
            or base.startswith('sağlık') or base.startswith('diğer')

        if is_label_like:
            if base in seen:
                skip_next_value = True
                continue  # duplicate label satırı at
            seen.add(base)
            out_lines.append(line)
            skip_next_value = False
        else:
            if skip_next_value and _is_value_line(line):
                # yinelenen etiketin hemen ardındaki değer satırını at
                continue
            skip_next_value = False
            out_lines.append(line)

    # Art arda duplicate başlıkların kalması durumunda ikinci tur sadeleştirme
    result = []
    seen_once = set()
    for l in out_lines:
        b = _normalize_label(l)
        if b in KNOWN_LABELS:
            if b in seen_once:
                continue
            seen_once.add(b)
        result.append(l)
    return "\n".join(result).strip()

def run_model_focus_keywords(pil_img: Image.Image, keywords: list[str], max_new_tokens: int | None = None) -> str:
    try:
        if max_new_tokens is None:
            max_new_tokens = get_env_int("OCR_FOCUS_MAXTOK", 128)
        kw = ", ".join(keywords)
        msg = (
            f"Return ONLY the exact text lines from the image that contain any of these keywords: {kw}. "
            "Preserve the original line text exactly; one line per match; no extra commentary."
        )
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": msg},
                    {"type": "image", "image": pil_img},
                ],
            }
        ]
        raw = run_model_with_messages(messages, max_new_tokens=max_new_tokens)
        return raw.strip()
    except Exception:
        return ""

def remove_lines_if_present(second_block: str, first_block: str, extra_labels: list[str] | None = None) -> str:
    """Remove lines from second_block that already appear in first_block or match extra label patterns."""
    if not second_block:
        return second_block
    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s.strip().lower())
    set_first = set([norm(ln) for ln in first_block.splitlines() if ln.strip()]) if first_block else set()
    lines = []
    for ln in second_block.splitlines():
        lns = ln.strip()
        if not lns:
            lines.append(ln)
            continue
        if norm(lns) in set_first:
            continue
        if extra_labels:
            lowered = lns.lower()
            if any(lbl.lower() in lowered for lbl in extra_labels):
                # bu etiketleri ikinci bloktan sil (ör: "Okuma Test Tablosu")
                continue
        lines.append(ln)
    # Fazla boş satırları sadeleştir
    out = "\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()

def keep_only_table_section(text: str, output_mode: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    om = (output_mode or "text").lower()
    if om == "text":
        # TSV bekleniyor: en az bir TAB içeren satırlar kalsın
        kept = [ln for ln in t.splitlines() if "\t" in ln]
        # Tablo dışı tek-sütun başlıkları (ör. Form No.) ele
        kept = [ln for ln in kept if ln.count("\t") >= 1]
        return "\n".join(kept).strip()
    if om == "markdown":
        # GitHub markdown tablosu deseni
        if re.search(r"^\|.*\|\n\|[\-:| ]+\|", t):
            return t
        return ""
    if om == "json":
        s = t.lstrip()
        if s.startswith("[") or s.startswith("{"):
            return t
        return ""
    return t

# --- JSON-first table extraction helpers ---
def extract_table_json_text(pil_img: Image.Image) -> str:
    prompt = (
        "Extract ONLY the grid table as a JSON array of row objects. "
        "Keys must be the column headers in reading order. "
        "Join multi-line cells with '; '. Return ONLY JSON without code fences or explanations."
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image", "image": pil_img},
            ],
        }
    ]
    raw = run_model_with_messages(messages, max_new_tokens=get_env_int("OCR_TABLE_MAXTOK", 1024))
    return remove_placeholders(raw or "").strip()

def json_to_tsv(json_text: str) -> str:
    try:
        data = json.loads(json_text)
        if isinstance(data, dict):
            # tek satır da olsa diziye sar
            data = [data]
        if not isinstance(data, list) or not data:
            return ""
        # Sütun başlıklarını ilk satırın anahtar sırasından al
        first = data[0]
        if not isinstance(first, dict):
            return ""
        headers = list(first.keys())
        def stringify(v):
            if v is None:
                return ""
            return str(v).replace("\n", " ").strip()
        rows = ["\t".join(headers)]
        for row in data:
            line = [stringify(row.get(h, "")) for h in headers]
            rows.append("\t".join(line))
        return "\n".join(rows).strip()
    except Exception:
        return ""

# --- Rotation helpers ---
def _pil_to_cv_gray(img: Image.Image):
    if img.mode != 'L':
        img = img.convert('L')
    return np.array(img)

def _score_horizontal_alignment(gray: np.ndarray) -> float:
    try:
        # Sobel kenarları: x yönünde güçlü kenarlar -> yatay metin
        sobel_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        sx = float(np.mean(np.abs(sobel_x)))
        sy = float(np.mean(np.abs(sobel_y)))
        return sx / (sy + 1e-6)
    except Exception:
        return 1.0

def detect_rotation_cv(pil_img: Image.Image):
    """Return ('left'|'right'|'no', {orig, left, right}) by comparing horizontal alignment score."""
    gray = _pil_to_cv_gray(pil_img)
    score_o = _score_horizontal_alignment(gray)

    left_img = pil_img.rotate(90, expand=True)
    right_img = pil_img.rotate(-90, expand=True)
    score_l = _score_horizontal_alignment(_pil_to_cv_gray(left_img))
    score_r = _score_horizontal_alignment(_pil_to_cv_gray(right_img))

    scores = {"orig": score_o, "left": score_l, "right": score_r}
    best = max(scores, key=scores.get)
    margin = float(os.getenv("OCR_ROTATE_MARGIN", "0.12"))
    if best == "orig":
        return "no", scores
    if scores[best] - score_o >= margin:
        return best, scores
    return "no", scores

def detect_rotation_vlm(pil_img: Image.Image):
    """Ask the model briefly whether the image is rotated left/right/no."""
    try:
        cls_messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Is the image rotated by 90 degrees? Answer with one word: left, right, or no."},
                    {"type": "image", "image": pil_img},
                ],
            }
        ]
        cls_text = processor.apply_chat_template(cls_messages, tokenize=False, add_generation_prompt=True)
        img_inputs, vid_inputs = process_vision_info(cls_messages)
        cls_inputs = processor(
            text=[cls_text],
            images=img_inputs,
            videos=vid_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)
        with torch.no_grad():
            out_ids = model.generate(**cls_inputs, max_new_tokens=2, temperature=0.0, do_sample=False)
        trimmed = [out[len(inp):] for inp, out in zip(cls_inputs.input_ids, out_ids)]
        pred = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0].strip().lower()
        if "left" in pred:
            return "left"
        if "right" in pred:
            return "right"
        return "no"
    except Exception:
        return "no"

# --- OCR-probe helpers ---
TURKISH_CHARS = "ğüşıöçĞÜŞİÖÇ"

def score_text_quality(text: str) -> float:
    try:
        t = (text or "").strip()
        if not t:
            return 0.0
        # Bonus: Türkçe harfler
        turkish_bonus = len([c for c in t if c in TURKISH_CHARS]) * 2.0
        # Kelime uzunluk toplamı (>=2)
        words = re.findall(r"[A-Za-z" + TURKISH_CHARS + r"]{2,}", t)
        length_score = float(sum(len(w) for w in words))
        # Boşluk sayısı (satır içi akıcılık)
        space_score = float(t.count(" ")) * 0.5
        return length_score + space_score + turkish_bonus
    except Exception:
        return 0.0

def ocr_probe_once(pil_img: Image.Image, max_new_tokens: int = 48) -> str:
    try:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        "Read a few words from this image. Return ONLY plain text, no explanations."
                    )},
                    {"type": "image", "image": pil_img},
                ],
            }
        ]
        prompt = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        img_inputs, vid_inputs = process_vision_info(messages)
        inputs = processor(
            text=[prompt],
            images=img_inputs,
            videos=vid_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)
        with torch.no_grad():
            out_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=0.0,
                do_sample=False,
                num_beams=1,
                early_stopping=True,
            )
        trimmed = [out[len(in_ids):] for in_ids, out in zip(inputs.input_ids, out_ids)]
        out_text = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        return out_text.strip()
    except Exception:
        return ""

def detect_rotation_probe(pil_img: Image.Image, max_new_tokens: int, margin: float):
    """Compare OCR-probe quality among orig/left/right and decide."""
    candidates = {
        "orig": pil_img,
        "left": pil_img.rotate(90, expand=True),
        "right": pil_img.rotate(-90, expand=True),
    }
    scores = {}
    for k, v in candidates.items():
        text = ocr_probe_once(v, max_new_tokens=max_new_tokens)
        scores[k] = score_text_quality(text)
    best = max(scores, key=scores.get)
    if best == "orig":
        return "no", scores
    if scores[best] - scores["orig"] >= float(margin):
        return best, scores
    return "no", scores

def load_model():
    """Modeli yükle"""
    global model, processor, device

    # Model kimliği/yolu ENV ile yapılandırılabilir
    # Öncelik: QWEN_MODEL_PATH (tam dosya yolu) > QWEN_MODEL_ID (HF id)
    env_model_path = os.getenv("QWEN_MODEL_PATH", "").strip()
    env_model_id = os.getenv("QWEN_MODEL_ID", "Qwen/Qwen2.5-VL-3B-Instruct").strip()
    local_files_only = strtobool(os.getenv("QWEN_LOCAL_FILES_ONLY", "1"), default=True)
    model_source = env_model_path or env_model_id

    try:
        logger.info(f"Model yükleniyor: {model_source} (local_files_only={local_files_only})")

        # CUDA varsa kullan, yoksa CPU
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"Cihaz: {device}")

        # Processor'ı yükle
        # Daha düşük çözünürlükle çalışarak hız/Vram iyileştirmesi (ENV ile ayarlanabilir)
        min_pixels = int(os.getenv("OCR_MIN_PIXELS", 640 * 28 * 28))
        max_pixels = int(os.getenv("OCR_MAX_PIXELS", 1024 * 28 * 28))
        processor = AutoProcessor.from_pretrained(
            model_source,
            local_files_only=local_files_only,
            trust_remote_code=True,
            min_pixels=min_pixels,
            max_pixels=max_pixels,
        )

        # Modeli yükle - GPU kullanım optimizasyonu
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_source,
            local_files_only=local_files_only,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device_map="auto" if torch.cuda.is_available() else "cpu",
            trust_remote_code=True,
            low_cpu_mem_usage=True,
            # GPU optimizasyonları - %85'e göre optimize edilmiş
            max_memory={0: "5.1GB", "cpu": "8GB"} if torch.cuda.is_available() else None,
            offload_folder="./offload" if torch.cuda.is_available() else None,
        )

        # GPU kullanım optimizasyonları
        if torch.cuda.is_available():
            try:
                # GPU memory fraction ayarı - direkt kodda belirlenmiş
                gpu_fraction = 0.85  # %85 GPU kullanımı - dengeli oran
                torch.cuda.set_per_process_memory_fraction(gpu_fraction)

                torch.set_float32_matmul_precision('high')
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.benchmark = True
                torch.backends.cudnn.allow_tf32 = True

                # Memory ayarları - direkt kodda optimize edilmiş
                os.environ['PYTORCH_CUDA_ALLOC_CONF'] = "max_split_size_mb:256,garbage_collection_threshold:0.6,expandable_segments:True"

                logger.info(f"GPU optimizasyonları aktif edildi - Memory fraction: {gpu_fraction}")
                logger.info(f"GPU memory: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f}GB")
            except Exception as e:
                logger.warning(f"GPU optimizasyonu hatası: {e}")
        else:
            logger.info("CUDA bulunamadı, CPU kullanılıyor")

        # Modeli değerlendirme moduna al
        model.eval()

        logger.info("Model başarıyla yüklendi!")
        global model_id_loaded
        model_id_loaded = model_source
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
        "device": str(device) if device else "not loaded",
        "model": model_id_loaded,
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
        # EXIF yönünü düzelt (telefon kamera görüntüleri)
        try:
            image = ImageOps.exif_transpose(image)
        except Exception:
            pass
        logger.info(f"Görüntü yüklendi: {image.size}")

        # 0) Görüntü preprocessing - sadece grayscale (isteğe bağlı)
        preprocess_enabled = strtobool(os.getenv("OCR_PREPROCESS_ENABLED", "1"))
        if preprocess_enabled and image.mode != 'L':
            image = image.convert('L')
            logger.info("Grayscale uygulandı")

        # 1) Dikey yazı tespiti ve 90° döndürme (mod: off|cv|vlm|hybrid)
        rot_mode = (os.getenv("OCR_ROTATION_MODE", "cv") or "cv").lower()
        if rot_mode != "off":
            decision = "no"
            # CV kararı
            if rot_mode in ("cv", "hybrid"):
                decision, scores = detect_rotation_cv(image)
                logger.info(f"CV rotasyon kararı: {decision} | skorlar={scores}")
            # VLM kararı
            if (rot_mode in ("vlm", "hybrid")) and decision == "no":
                decision = detect_rotation_vlm(image)
                logger.info(f"VLM rotasyon kararı: {decision}")
            # OCR-probe (orig/left/right kısa çıkarım karşılaştırması)
            probe_enabled = strtobool(os.getenv("OCR_ROTATION_PROBE", "0"))
            enforce_probe = strtobool(os.getenv("OCR_ROTATION_ENFORCE_PROBE", "0"))
            if probe_enabled and (decision == "no" or enforce_probe):
                probe_tokens = get_env_int("OCR_ROTATION_PROBE_MAXTOK", 64)
                probe_margin = float(os.getenv("OCR_ROTATE_PROBE_MARGIN", "0.2"))
                probe_decision, probe_scores = detect_rotation_probe(image, probe_tokens, probe_margin)
                logger.info(f"PROBE rotasyon kararı: {probe_decision} | skorlar={probe_scores}")
                if probe_decision != "no":
                    decision = probe_decision
            if decision == "left":
                image = image.rotate(90, expand=True)
                logger.info("90° döndürme: left")
            elif decision == "right":
                image = image.rotate(-90, expand=True)
                logger.info("90° döndürme: right")

        # 2) Strateji belirleme (auto ise kısa sınıflandırma)
        strategy = (request.strategy or "text").lower()
        output_mode = (request.output or "text").lower()

        def classify_document() -> str:
            try:
                cls_messages = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": (
                                "Classify the document type among: text, table, form, key_value. "
                                "Return only one of these words."
                            )},
                            {"type": "image", "image": image},
                        ],
                    }
                ]
                cls_text = processor.apply_chat_template(cls_messages, tokenize=False, add_generation_prompt=True)
                cls_inputs = processor(text=[cls_text], images=process_vision_info(cls_messages)[0], videos=process_vision_info(cls_messages)[1], padding=True, return_tensors="pt").to(device)
                with torch.no_grad():
                    out_ids = model.generate(**cls_inputs, max_new_tokens=8, temperature=0.0, do_sample=False)
                trimmed = [out[len(inp):] for inp, out in zip(cls_inputs.input_ids, out_ids)]
                pred = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
                pred = pred.strip().lower()
                for c in ["text", "table", "form", "key_value"]:
                    if c in pred:
                        return c
                return "text"
            except Exception as _:
                return "text"

        if strategy == "auto":
            strategy = classify_document()
            logger.info(f"Auto strategy seçildi: {strategy}")

        # 2) Prompt inşası
        def build_prompt() -> str:
            # Metin odaklı
            if strategy == "text":
                return request.prompt or (
                    "Extract ALL readable text from the image with NO omissions. Preserve Turkish characters (ğ, ü, ş, ı, İ, ö, ç). "
                    + ("Preserve original line breaks and reading order. Do NOT merge separate lines into a single line. " if request.preserve_layout else "")
                    + "Include every visible label, heading, punctuation, checkbox symbol (use '☑' for checked, '☐' for unchecked). "
                    + "If a field is blank, output '/' for its value. Return ONLY plain text lines in reading order."
                )
            # Tablo odaklı
            if strategy == "table":
                if output_mode == "markdown":
                    headers = request.headers or []
                    head_info = f" Use these headers and order if visible: {', '.join(headers)}." if headers else ""
                    return (
                        ("First, list ALL non-table text lines exactly as they appear, one per line, preserving order. "
                         "Include every label (e.g., signatures, dates). Then a blank line. " if request.include_notes else "") +
                        "Extract ONLY the grid table area as a GitHub Markdown table (no headings or labels outside the grid). " + head_info +
                        " Start with a header row and separator row. Join multi-line cells with '; '. No extra commentary."
                    )
                if output_mode == "json":
                    return (
                        ("First, list ALL non-table text lines exactly as they appear, one per line, preserving order. "
                         "Include every label (e.g., signatures, dates). Then a blank line. " if request.include_notes else "") +
                        "Extract ONLY the grid table area as a JSON array of row objects (no headings or labels outside the grid). Keys should be inferred from header cells. "
                        "Join multi-line cells with '; '. Return valid JSON without code fences."
                    )
                # text (TSV)
                return (
                    ("First, list ALL non-table text lines exactly as they appear, one per line, preserving order. "
                     "Include every label (e.g., signatures, dates). Then a blank line. " if request.include_notes else "") +
                    "Extract ONLY the grid table area as clean TSV text (columns separated by TAB, one row per line). First line is header. Do NOT include headings or labels outside the grid (e.g., 'Okuma Test Tablosu')."
                )
            # Form/Key-Value odaklı
            if strategy in ("form", "key_value"):
                if output_mode == "json":
                    keys_hint = f" Prioritize these keys if found: {', '.join(request.headers)}." if request.headers else ""
                    return (
                        "Extract key-value pairs from the document as a JSON object. "
                        "Use keys exactly as appears on the document; preserve Turkish characters." + keys_hint +
                        " Return ONLY valid JSON without code fences."
                    )
                # markdown/text
                return (
                    "Extract key-value pairs as lines in the format 'Key: Value'. "
                    + ("Preserve original visual order (top-to-bottom, left-to-right). Keep one field per line; do NOT place multiple fields on the same line. Do NOT merge lines or reflow text. " if request.preserve_layout else "")
                    + "Include every label even if the value is blank (use '/'). Preserve Turkish characters."
                )
            # Varsayılan
            return request.prompt

        user_text = build_prompt()
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image", "image": image},
                ],
            }
        ]

        # Strategy table ise her zaman iki aşamalı çalış: önce tam metin, sonra sıkı tablo-only
        notes_text = None
        if strategy == "table":
            logger.info("include_notes aktif: Önce tam metin PASS çalıştırılıyor")
            notes_prompt = (
                "Return ONLY the non-table text lines (outside the grid table area). "
                "Exclude any text inside cells of the table. "
                "Preserve line breaks and reading order. "
                "Include footnotes, headings outside the grid, signatures and dates if present. "
                "If a field is blank, output '/'. Return ONLY plain text."
            )
            note_msgs = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": notes_prompt},
                        {"type": "image", "image": image},
                    ],
                }
            ]
            notes_max = get_env_int("OCR_NOTES_MAXTOK", 1024)
            notes_raw = run_model_with_messages(note_msgs, max_new_tokens=notes_max)
            # Aynı temizlikten geçir
            def strip_code_fences_local(text: str) -> str:
                t = text.strip()
                fence = re.compile(r"^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$")
                m = fence.match(t)
                return m.group(1).strip() if m else t
            notes_text = strip_code_fences_local(notes_raw)
            notes_text = remove_placeholders(notes_text)
            # Katı tekrar temizliği
            notes_text = deduplicate_notes_lines(notes_text)

            # Notlarda "imza" satırları yoksa hedefli anahtar kelime taraması yap ve ekle
            if get_env_bool("OCR_ENABLE_SIGNATURE_PROBE", False):
                if not re.search(r"imza|signature", notes_text, flags=re.IGNORECASE):
                    probe = run_model_focus_keywords(image, ["İmza", "Imza", "Signature", "Yönetici", "Personel"], max_new_tokens=get_env_int("OCR_FOCUS_MAXTOK", 160))
                    probe = remove_placeholders(probe)
                    if probe:
                        # Duplicate satırları notlardan çıkar
                        lines_existing = set([ln.strip() for ln in notes_text.splitlines() if ln.strip()])
                        probe_lines = [ln for ln in probe.splitlines() if ln.strip() and ln.strip() not in lines_existing]
                        if probe_lines:
                            notes_text = (notes_text + "\n" + "\n".join(probe_lines)).strip()

            # İkinci PASS için sıkı TABLO-ONLY prompt kullan
            strict_table_prompt = (
                "Extract ONLY the grid table area as clean TSV text (columns separated by TAB, one row per line). "
                "First line is header. Do NOT include any headings or labels outside the grid. Return ONLY the TSV."
            )
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": strict_table_prompt},
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

        # Qwen2.5-VL için generate metodu kullan - GPU optimizasyonu ile
        with torch.no_grad():
            logger.info("Model generate başlatılıyor...")
            try:
                # GPU memory'yi optimize et
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()

                # Generate metodu ile text üret - GPU optimizasyonları
                main_max_tokens = get_env_int("OCR_MAIN_MAXTOK", 1024)
                generated_ids = model.generate(
                    **inputs,
                    max_new_tokens=main_max_tokens,
                    temperature=0.0,
                    do_sample=False,  # Deterministik output
                    use_cache=True,
                    eos_token_id=getattr(processor.tokenizer, 'eos_token_id', None),
                    pad_token_id=getattr(processor.tokenizer, 'pad_token_id', None),
                    # GPU optimizasyonları
                    num_beams=1,  # Beam search kapalı - daha hızlı
                    early_stopping=True,
                )

                # GPU cache'i temizle
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

            except RuntimeError as e:
                if "out of memory" in str(e).lower():
                    logger.warning("GPU out of memory hatası - cache temizleniyor")
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    raise HTTPException(status_code=503, detail="GPU memory yetersiz, lütfen daha sonra tekrar deneyin")
                else:
                    raise e
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

        # 3) Çıktı temizleme ve doğrulama
        def strip_code_fences(text: str) -> str:
            t = text.strip()

            # Qwen'in açıklama metinlerini kaldır
            t = re.sub(r"^Here is the extracted.*?:\s*", "", t, flags=re.IGNORECASE)
            t = re.sub(r"^Extracted text:\s*", "", t, flags=re.IGNORECASE)
            t = re.sub(r"^The extracted.*?:\s*", "", t, flags=re.IGNORECASE)

            # Code block'lardan içeriği çıkar
            fence = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")
            m = fence.search(t)
            if m:
                return m.group(1).strip()

            # Alternatif: Tüm metni code block içinde ara
            fence_full = re.compile(r"^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$")
            m_full = fence_full.match(t)
            if m_full:
                return m_full.group(1).strip()

            return t

        def clean_text(text: str) -> str:
            t = text.replace("\u200b", "").replace("\ufeff", "")

            # Fazla whitespace'leri temizle
            t = re.sub(r"[ \t]+", " ", t)
            t = re.sub(r"\n{3,}", "\n\n", t)

            # Baş ve sondaki whitespace'leri temizle
            t = t.strip()

            # Boş satırları temizle (ama tablo yapısını bozma)
            lines = t.split('\n')
            cleaned_lines = []
            for line in lines:
                if line.strip():  # Boş olmayan satırları al
                    cleaned_lines.append(line.rstrip())

            return '\n'.join(cleaned_lines)

        processed = clean_text(strip_code_fences(output_text))
        processed = remove_placeholders(processed)

        # include_notes ise ön metin + boş satır + tablo/çıktı şeklinde birleştir
        if strategy == "table":
            # 1) JSON-first tablo çıkarımı
            json_text = extract_table_json_text(image)
            table_only = ""
            if json_text and (output_mode == "json"):
                table_only = keep_only_table_section(json_text, "json")
            elif json_text:
                # JSON'u istenen formata dönüştür
                if output_mode == "text":
                    table_only = json_to_tsv(json_text)
                elif output_mode == "markdown":
                    # Basit TSV -> Markdown çeviri
                    tsv = json_to_tsv(json_text)
                    if tsv:
                        lines = tsv.splitlines()
                        hdr = [c.strip() for c in lines[0].split("\t")]
                        md = "| " + " | ".join(hdr) + " |\n" + "| " + " | ".join(["---"]) * len(hdr) + " |\n"
                        for ln in lines[1:]:
                            cols = [c.strip() for c in ln.split("\t")]
                            md += "| " + " | ".join(cols) + " |\n"
                        table_only = md.strip()
            # 2) JSON başarısız ise mevcut TSV yoluna düş
            if not table_only:
                table_only = keep_only_table_section(processed, output_mode)
            # Eğer tablo üretilemediyse, daha da sıkı bir TSV promptu ile tekrar dene
            if not table_only:
                strict_tsv_prompt = (
                    "Return ONLY the table as TSV. Use TAB (\t) between columns and one row per line. "
                    "Start with header row. Do NOT output any explanations, labels, or notes. TSV only."
                )
                strict_msgs = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": strict_tsv_prompt},
                            {"type": "image", "image": image},
                        ],
                    }
                ]
                strict_raw = run_model_with_messages(strict_msgs, max_new_tokens=get_env_int("OCR_TABLE_MAXTOK", 1024))
                strict_raw = remove_placeholders(strict_raw)
                table_only = keep_only_table_section(strict_raw, output_mode)
            # Header yoksa başlığı küçük bir sorgu ile al ve ekle
            def ensure_tsv_header(table_tsv: str) -> str:
                if not table_tsv:
                    return table_tsv
                first = table_tsv.splitlines()[0]
                if re.search(r"\d|TL|EUR", first, flags=re.IGNORECASE):
                    header_prompt = (
                        "Return ONLY the column headers of the grid table as a single TSV line (left to right). "
                        "No extra text."
                    )
                    hdr_msgs = [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": header_prompt},
                                {"type": "image", "image": image},
                            ],
                        }
                    ]
                    hdr_raw = run_model_with_messages(hdr_msgs, max_new_tokens=120)
                    hdr_raw = remove_placeholders(hdr_raw)
                    if "\t" in hdr_raw and not re.search(r"\d|TL|EUR", hdr_raw, flags=re.IGNORECASE):
                        lines = table_tsv.splitlines()
                        table_tsv = (hdr_raw.strip() + "\n" + "\n".join(lines)).strip()
                return table_tsv
            if output_mode == "text" and table_only:
                table_only = ensure_tsv_header(table_only)
            # Not istenmiyorsa final çıktı sadece tablo olsun
            if not request.include_notes:
                processed = table_only or processed
            else:
                # Notlar varsa artık TABLODAN SONRA yaz
                head = (notes_text or "").strip()
                if table_only and head:
                    processed = table_only + "\n\n" + head
                elif table_only:
                    processed = table_only
                else:
                    processed = head or processed

        if output_mode == "json":
            try:
                obj = json.loads(processed)
                processed = json.dumps(obj, ensure_ascii=False)
            except Exception:
                # JSON oluşturulamadı; ham metni döndür
                logger.warning("JSON doğrulama başarısız; ham metin döndürülüyor.")
        elif output_mode == "markdown" and strategy == "table":
            if not re.search(r"^\|.*\|\n\|[\-:| ]+\|", processed):
                logger.warning("Markdown tablo deseni tespit edilemedi; ham metin döndürülüyor.")

        # Yanıt
        if processed:
            return OCRResponse(success=True, text=processed)
        else:
            return OCRResponse(success=True, text="[OCR işlemi tamamlandı - metin çıkarılamadı]")

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
        "device": str(device) if device else None,
        "model": model_id_loaded,
    }

if __name__ == "__main__":
    # Sunucuyu başlat
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )
