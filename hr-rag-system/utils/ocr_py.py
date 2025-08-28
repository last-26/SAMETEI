import os
import sys
import json
import tempfile
from typing import Dict, Any

try:
    from pdf2image import convert_from_path
    from PIL import Image
    import pytesseract
    import cv2
    import numpy as np
except Exception as e:
    print(json.dumps({"success": False, "error": f"ImportError: {e}"}))
    sys.exit(1)


def deskew_image(gray: np.ndarray) -> np.ndarray:
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLines(edges, 1, np.pi / 180, 200)
    if lines is None:
        return gray
    angles = []
    for rho, theta in lines[:,0,:]:
        angle = (theta - np.pi/2) * 180/np.pi
        if -15 < angle < 15:
            angles.append(angle)
    if not angles:
        return gray
    median_angle = float(np.median(angles))
    (h, w) = gray.shape[:2]
    M = cv2.getRotationMatrix2D((w//2, h//2), median_angle, 1.0)
    return cv2.warpAffine(gray, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def remove_form_lines(gray: np.ndarray) -> np.ndarray:
    thr = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 21, 10)
    horizontal = thr.copy()
    cols = horizontal.shape[1]
    horizontal_size = max(20, cols // 30)
    horizontalStructure = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_size, 1))
    horizontal = cv2.erode(horizontal, horizontalStructure)
    horizontal = cv2.dilate(horizontal, horizontalStructure)
    vertical = thr.copy()
    rows = vertical.shape[0]
    vertical_size = max(20, rows // 30)
    verticalStructure = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_size))
    vertical = cv2.erode(vertical, verticalStructure)
    vertical = cv2.dilate(vertical, verticalStructure)
    mask = cv2.bitwise_or(horizontal, vertical)
    cleaned = cv2.bitwise_and(gray, gray, mask=cv2.bitwise_not(mask))
    return cleaned


def preprocess_image_for_ocr(pil_image: Image.Image) -> Image.Image:
    img = np.array(pil_image)
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    else:
        gray = img

    # Orientation tespiti (OSD) – başarısızsa atla
    try:
        osd = pytesseract.image_to_osd(Image.fromarray(gray))
        if 'Rotate: 90' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)
        elif 'Rotate: 180' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_180)
        elif 'Rotate: 270' in osd:
            gray = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
    except Exception:
        pass

    gray = deskew_image(gray)
    gray = remove_form_lines(gray)

    # Kontrast ve gürültü azaltma
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    denoised = cv2.fastNlMeansDenoising(enhanced, h=8)

    # Adaptif threshold (formlar için iyi)
    binary = cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11)
    kernel = np.ones((1,1), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return Image.fromarray(binary)


def ocr_pdf_to_text(pdf_path: str, lang: str = "tur+eng", dpi: int = 300) -> Dict[str, Any]:
    images = convert_from_path(pdf_path, dpi=dpi, fmt="PNG")
    texts = []
    for im in images:
        processed = preprocess_image_for_ocr(im)
        cfg_base = f"--oem 3 -l {lang} -c preserve_interword_spaces=1 -c tessedit_char_blacklist=|~`^*{}<> -c tessedit_char_whitelist=0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZçğıöşüÇĞİÖŞÜ-_/.:()[],'\""
        candidates = []
        try:
            candidates.append(pytesseract.image_to_string(processed, config=cfg_base + ' --psm 6'))
        except Exception:
            pass
        try:
            candidates.append(pytesseract.image_to_string(processed, config=cfg_base + ' --psm 4'))
        except Exception:
            pass
        best = max(candidates, key=lambda s: len(s.strip())) if candidates else ''
        texts.append(best.strip())
    full_text = "\n\n".join(texts)
    return {"success": True, "text": full_text, "total_pages": len(images)}


def main():
    try:
        pdf_path = sys.argv[1]
        lang = os.environ.get("TESSERACT_LANG", "tur+eng")
        dpi = int(os.environ.get("OCR_DPI", "300"))
        if not os.path.exists(pdf_path):
            print(json.dumps({"success": False, "error": f"File not found: {pdf_path}"}))
            return
        result = ocr_pdf_to_text(pdf_path, lang=lang, dpi=dpi)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()


